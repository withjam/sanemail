import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("source.sync worker can manually sync the mock source without chaining jobs", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sanemail-source-sync-"));
  const previousDataDir = process.env.DATA_DIR;
  const previousStoreDriver = process.env.STORE_DRIVER;
  const previousQueueDriver = process.env.QUEUE_DRIVER;
  const previousAutoJobs = process.env.QUEUE_AUTO_POST_INGEST_JOBS;
  const previousAppSecret = process.env.APP_SECRET;

  process.env.DATA_DIR = dataDir;
  process.env.STORE_DRIVER = "json";
  process.env.QUEUE_DRIVER = "local-json";
  process.env.QUEUE_AUTO_POST_INGEST_JOBS = "false";
  process.env.APP_SECRET = "source-sync-test-secret";

  try {
    const store = await import(`../apps/api/src/store.mjs?sourceSync=${encodeURIComponent(dataDir)}`);
    const queue = await import(`../apps/api/src/queue.mjs?sourceSync=${encodeURIComponent(dataDir)}`);
    const worker = await import(`../apps/api/src/worker.mjs?sourceSync=${encodeURIComponent(dataDir)}`);
    await store.clearLocalData();

    const userId = "test-user-source-sync";
    await store.ensureUserRecord(userId, "test@example.com");
    await queue.enqueueJob("source.sync", {
      userId,
      sourceConnectionId: `mock:demo:${userId}`,
      provider: "mock",
      trigger: "manual",
      requestedAt: new Date().toISOString(),
    });

    const processed = await worker.runWorkerOnce();
    const snapshot = await store.readStore();
    const jobs = await queue.listQueueJobs();

    assert.equal(processed.processed, true);
    assert.equal(processed.result.status, "synced");
    assert.equal(processed.result.result.count, 200);
    assert.equal(snapshot.accounts[0].provider, "mock");
    assert.equal(snapshot.messages.length, 200);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].name, "source.sync");
    assert.equal(jobs[0].status, "succeeded");
  } finally {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousStoreDriver === undefined) delete process.env.STORE_DRIVER;
    else process.env.STORE_DRIVER = previousStoreDriver;
    if (previousQueueDriver === undefined) delete process.env.QUEUE_DRIVER;
    else process.env.QUEUE_DRIVER = previousQueueDriver;
    if (previousAutoJobs === undefined) delete process.env.QUEUE_AUTO_POST_INGEST_JOBS;
    else process.env.QUEUE_AUTO_POST_INGEST_JOBS = previousAutoJobs;
    if (previousAppSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = previousAppSecret;

    await rm(dataDir, { recursive: true, force: true });
  }
});
