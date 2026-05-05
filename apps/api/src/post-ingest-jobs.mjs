import { loadConfig } from "./config.mjs";
import { enqueueJob } from "./queue.mjs";

export async function maybeEnqueuePostIngestClassification(account, config = loadConfig()) {
  if (!account || !config.queue.autoPostIngestJobs) return null;

  return enqueueJob("classification.batch", {
    userId: account.id,
    accountId: account.id,
    classifierVersion: config.storage.driver === "postgres" ? "postgres-v0" : "local-json-v0",
    reason: "post_ingest",
    maxBatchSize: config.queue.classificationBatchSize,
    requestedAt: new Date().toISOString(),
  });
}
