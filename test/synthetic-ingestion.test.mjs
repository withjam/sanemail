import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("synthetic ingestion writes a fast pending batch before classification runs", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sanemail-synthetic-ingestion-"));
  const previous = {
    dataDir: process.env.DATA_DIR,
    storeDriver: process.env.STORE_DRIVER,
    queueDriver: process.env.QUEUE_DRIVER,
    appSecret: process.env.APP_SECRET,
    ollamaClassify: process.env.AI_OLLAMA_CLASSIFY_MESSAGES,
  };

  process.env.DATA_DIR = dataDir;
  process.env.STORE_DRIVER = "json";
  process.env.QUEUE_DRIVER = "local-json";
  process.env.APP_SECRET = "synthetic-ingestion-test-secret";
  process.env.AI_OLLAMA_CLASSIFY_MESSAGES = "false";

  try {
    const store = await import("../apps/api/src/store.mjs");
    const synthetic = await import("../apps/api/src/synthetic-ingestion.mjs");
    const pipeline = await import("../apps/api/src/ai/pipeline.mjs");
    await store.clearLocalData();

    const userId = "test-user-synth";
    await store.ensureUserRecord(userId, "synth@example.com");
    const ingested = await synthetic.synthesizeIngestionBatch({ userId });
    const snapshot = await store.readStore();
    const pending = store.classificationBacklogSummaryFromStore(snapshot, ingested.account.id);

    assert.equal(ingested.result.count >= 3, true);
    assert.equal(ingested.result.count <= 6, true);
    assert.equal(ingested.analytics.classificationSkipped, true);
    assert.equal(ingested.analytics.briefingSkipped, true);
    assert.equal(snapshot.messages.length, ingested.result.count);
    assert.equal(snapshot.aiRuns.length, 0);
    assert.equal(pending.backlog, ingested.result.count);
    assert.equal(pending.pending, ingested.result.count);

    const run = await pipeline.runClassificationBatch({
      userId,
      limit: 10,
      trigger: "test:classification-batch",
    });
    const classifiedSnapshot = await store.readStore();
    const classified = store.classificationBacklogSummaryFromStore(
      classifiedSnapshot,
      ingested.account.id,
    );

    assert.equal(run.kind, "classification-batch");
    assert.equal(run.metrics.messagesProcessed, ingested.result.count);
    assert.equal(run.output.briefing, undefined);
    assert.equal(classified.backlog, 0);
    assert.equal(classified.classified, ingested.result.count);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      const envKey = {
        dataDir: "DATA_DIR",
        storeDriver: "STORE_DRIVER",
        queueDriver: "QUEUE_DRIVER",
        appSecret: "APP_SECRET",
        ollamaClassify: "AI_OLLAMA_CLASSIFY_MESSAGES",
      }[key];
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
