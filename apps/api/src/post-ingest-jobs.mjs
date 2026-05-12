import { loadConfig } from "./config.mjs";
import { enqueueJob } from "./queue.mjs";
import { isQueueAutomationEnabledForSource } from "./queue-runtime.mjs";

export async function maybeEnqueuePostIngestClassification(account, config = loadConfig()) {
  if (!account) return null;
  if (!(await isQueueAutomationEnabledForSource(account.id))) return null;

  const userId = account.userId || account.id;
  return enqueueJob("classification.batch", {
    userId,
    accountId: account.id,
    classifierVersion: config.storage.driver === "postgres" ? "postgres-v0" : "local-json-v0",
    reason: "post_ingest",
    maxBatchSize: config.queue.classificationBatchSize,
    requestedAt: new Date().toISOString(),
  });
}
