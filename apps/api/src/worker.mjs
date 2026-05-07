import { pathToFileURL } from "node:url";
import { run, runOnce } from "graphile-worker";
import { assertProductionConfig, loadConfig } from "./config.mjs";
import { claimNextJob, completeJob, failJob } from "./queue.mjs";
import { runClassificationBatch, runDailyBrief } from "./ai/pipeline.mjs";
import { syncSourceConnection } from "./source-sync.mjs";
import { maybeEnqueuePostIngestClassification } from "./post-ingest-jobs.mjs";

const jobNames = [
  "source.sync",
  "classification.batch",
  "brief.generate",
  "message-types.discover",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireJobUserId(job) {
  const userId = job.payload?.userId;
  if (!userId) {
    throw new Error(`Job ${job.name} is missing required userId in payload`);
  }
  return userId;
}

async function handleClassificationBatch(job) {
  const payload = job.payload || {};
  const userId = requireJobUserId(job);
  const run = await runClassificationBatch({
    userId,
    limit: payload.maxBatchSize,
    trigger: "queue:classification.batch",
  });

  return {
    runId: run.id,
    messagesProcessed: run.metrics?.messagesProcessed || 0,
    briefingGenerated: Boolean(run.output?.briefing),
  };
}

async function handleSourceSync(job) {
  const payload = job.payload || {};
  const userId = requireJobUserId(job);
  const { account, result, provider, trigger } = await syncSourceConnection({
    userId,
    sourceConnectionId: payload.sourceConnectionId,
    accountId: payload.accountId,
    provider: payload.provider,
    trigger: payload.trigger || "manual",
    cursorHint: payload.cursorHint || "latest",
  });
  const queued = await maybeEnqueuePostIngestClassification(account);

  return {
    status: "synced",
    sourceConnectionId: account.id,
    provider,
    trigger,
    result,
    ...(queued ? { queued } : {}),
  };
}

async function handleBriefGenerate(job) {
  const payload = job.payload || {};
  const userId = requireJobUserId(job);
  const run = await runDailyBrief({
    userId,
    mode: "iterative",
    trigger: `queue:brief.generate:${payload.scopeType || "all_sources"}`,
  });

  return {
    runId: run.id,
    messageIds: run.output?.briefing?.messageIds || [],
  };
}

async function handleMessageTypesDiscover(job) {
  return {
    status: "deferred",
    reason:
      "Type discovery needs durable message_type tables; classification batches can still emit candidate suggestions.",
    userId: job.payload?.userId || null,
  };
}

export async function handleJob(job) {
  if (job.name === "source.sync") return handleSourceSync(job);
  if (job.name === "classification.batch") return handleClassificationBatch(job);
  if (job.name === "brief.generate") return handleBriefGenerate(job);
  if (job.name === "message-types.discover") return handleMessageTypesDiscover(job);
  throw new Error(`No local worker handler for job: ${job.name}`);
}

function graphileTaskList() {
  return {
    source_sync: async (payload) => {
      return handleSourceSync({ name: "source.sync", payload });
    },
    classification_batch: async (payload) => {
      return handleClassificationBatch({ name: "classification.batch", payload });
    },
    brief_generate: async (payload) => {
      return handleBriefGenerate({ name: "brief.generate", payload });
    },
    message_types_discover: async (payload) => {
      return handleMessageTypesDiscover({ name: "message-types.discover", payload });
    },
  };
}

function graphileOptions(config) {
  const connectionString = config.queue.databaseUrl || config.database.url;
  if (!connectionString) {
    throw new Error(
      "Graphile Worker selected, but DATABASE_URL or POSTGRES_HOST/POSTGRES_PASSWORD is not configured.",
    );
  }

  return {
    connectionString,
    concurrency: 1,
    noHandleSignals: false,
  };
}

function isGraphileDriver(config) {
  return ["graphile", "graphile-worker", "postgres", "postgres-queue"].includes(
    config.queue.driver,
  );
}

export async function runWorkerOnce() {
  const config = loadConfig();
  if (isGraphileDriver(config)) {
    await runOnce(graphileOptions(config), graphileTaskList());
    return { processed: true, driver: "graphile-worker" };
  }

  const job = await claimNextJob({ names: jobNames });
  if (!job) return { processed: false };

  try {
    const result = await handleJob(job);
    await completeJob(job.id, result);
    return { processed: true, job, result };
  } catch (error) {
    await failJob(job.id, error);
    return { processed: true, job, error };
  }
}

let stopRequested = false;

export function requestWorkerStop() {
  stopRequested = true;
}

export async function runWorkerLoop() {
  const config = loadConfig();
  assertProductionConfig(config);
  if (isGraphileDriver(config)) {
    console.log("SaneMail Graphile Worker running against Postgres");
    const runner = await run(graphileOptions(config), graphileTaskList());
    const handleSignal = async () => {
      stopRequested = true;
      try {
        await runner.stop();
      } catch (error) {
        console.error("graceful worker stop failed:", error);
      }
    };
    process.once("SIGTERM", handleSignal);
    process.once("SIGINT", handleSignal);
    await runner.promise;
    return;
  }

  const pollIntervalMs = config.queue.pollIntervalMs;
  console.log(`SaneMail local queue worker polling every ${pollIntervalMs}ms`);
  const handleSignal = () => {
    stopRequested = true;
  };
  process.once("SIGTERM", handleSignal);
  process.once("SIGINT", handleSignal);

  while (!stopRequested) {
    const result = await runWorkerOnce();
    if (!result.processed && !stopRequested) await sleep(pollIntervalMs);
  }
  console.log("worker loop exiting cleanly");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--once")) {
    const result = await runWorkerOnce();
    console.log(JSON.stringify(result, null, 2));
  } else {
    await runWorkerLoop();
  }
}
