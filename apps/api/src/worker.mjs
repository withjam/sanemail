import { pathToFileURL } from "node:url";
import { run, runOnce } from "graphile-worker";
import { loadConfig } from "./config.mjs";
import { claimNextJob, completeJob, failJob } from "./queue.mjs";
import { runAiLoop } from "./ai/pipeline.mjs";

const jobNames = [
  "source.sync",
  "classification.batch",
  "brief.generate",
  "message-types.discover",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleClassificationBatch(job) {
  const payload = job.payload || {};
  const run = await runAiLoop({
    limit: payload.maxBatchSize,
    mode: "iterative",
    trigger: "queue:classification.batch",
  });

  return {
    runId: run.id,
    messagesProcessed: run.metrics?.messagesProcessed || 0,
    briefingGenerated: Boolean(run.output?.briefing),
  };
}

async function handleSourceSync(job) {
  return {
    status: "deferred",
    reason:
      "Source sync jobs need the durable connector tables; current Gmail sync still runs through the API endpoint.",
    sourceConnectionId: job.payload?.sourceConnectionId || job.payload?.accountId || null,
  };
}

async function handleBriefGenerate(job) {
  const payload = job.payload || {};
  const run = await runAiLoop({
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
      await handleSourceSync({ name: "source.sync", payload });
    },
    classification_batch: async (payload) => {
      await handleClassificationBatch({ name: "classification.batch", payload });
    },
    brief_generate: async (payload) => {
      await handleBriefGenerate({ name: "brief.generate", payload });
    },
    message_types_discover: async (payload) => {
      await handleMessageTypesDiscover({ name: "message-types.discover", payload });
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

export async function runWorkerLoop() {
  const config = loadConfig();
  if (isGraphileDriver(config)) {
    console.log("SaneMail Graphile Worker running against Postgres");
    const runner = await run(graphileOptions(config), graphileTaskList());
    await runner.promise;
    return;
  }

  const pollIntervalMs = config.queue.pollIntervalMs;
  console.log(`SaneMail local queue worker polling every ${pollIntervalMs}ms`);

  while (true) {
    const result = await runWorkerOnce();
    if (!result.processed) await sleep(pollIntervalMs);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--once")) {
    const result = await runWorkerOnce();
    console.log(JSON.stringify(result, null, 2));
  } else {
    await runWorkerLoop();
  }
}
