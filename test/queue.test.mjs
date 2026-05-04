import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("local queue dedupes active jobs, completes work, and dead-letters exhausted jobs", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sanemail-queue-"));
  process.env.DATA_DIR = dataDir;

  const store = await import(`../apps/api/src/store.mjs?queueStore=${encodeURIComponent(dataDir)}`);
  const queue = await import(`../apps/api/src/queue.mjs?queue=${encodeURIComponent(dataDir)}`);
  await store.clearLocalData();

  const first = await queue.enqueueJob("classification.batch", {
    userId: "gmail:test@example.com",
    classifierVersion: "local-json-v0",
    reason: "post_ingest",
    requestedAt: new Date().toISOString(),
  });
  const second = await queue.enqueueJob("classification.batch", {
    userId: "gmail:test@example.com",
    classifierVersion: "local-json-v0",
    reason: "post_ingest",
    maxBatchSize: 10,
    requestedAt: new Date().toISOString(),
  });
  const claimed = await queue.claimNextJob({ names: ["classification.batch"] });
  await queue.completeJob(claimed.id, { ok: true });
  const jobs = await queue.listQueueJobs();

  assert.equal(first.enqueued, true);
  assert.equal(second.enqueued, false);
  assert.equal(first.job.id, second.job.id);
  assert.equal(claimed.status, "running");
  assert.equal(claimed.attempts, 1);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "succeeded");
  assert.deepEqual(jobs[0].result, { ok: true });

  await queue.enqueueJob(
    "brief.generate",
    {
      userId: "gmail:test@example.com",
      scopeType: "all_sources",
      trigger: "manual",
      requestedAt: new Date().toISOString(),
    },
    { maxAttempts: 1 },
  );
  const failedClaim = await queue.claimNextJob({ names: ["brief.generate"] });
  await queue.failJob(failedClaim.id, new Error("model unavailable"), { maxAttempts: 1 });
  const finalJobs = await queue.listQueueJobs();

  assert.equal(finalJobs.length, 2);
  assert.equal(finalJobs[0].status, "dead");
  assert.equal(finalJobs[0].lastError, "model unavailable");

  await rm(dataDir, { recursive: true, force: true });
});
