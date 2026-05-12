import crypto from "node:crypto";
import pg from "pg";
import { makeWorkerUtils } from "graphile-worker";
import { loadConfig } from "./config.mjs";
import { mutateStore, readStore } from "./store.mjs";

const activeStatuses = new Set(["pending", "running"]);
const graphileTaskNames = {
  "source.sync": "source_sync",
  "classification.batch": "classification_batch",
  "message-types.discover": "message_types_discover",
  "brief.generate": "brief_generate",
};
const publicJobNames = Object.fromEntries(
  Object.entries(graphileTaskNames).map(([name, taskName]) => [taskName, name]),
);

let graphileUtilsPromise;
let graphilePool;

function nowIso() {
  return new Date().toISOString();
}

function dueAtMs(job) {
  const ms = new Date(job.runAt || job.createdAt || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function jobCreatedAtMs(job) {
  const ms = new Date(job.createdAt || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function queueDriver() {
  return loadConfig().queue.driver;
}

function isGraphileDriver(driver = queueDriver()) {
  return ["graphile", "graphile-worker", "postgres", "postgres-queue"].includes(driver);
}

function databaseUrl() {
  const config = loadConfig();
  const url = config.queue.databaseUrl || config.database.url;
  if (!url) {
    throw new Error(
      "Postgres queue selected, but DATABASE_URL or POSTGRES_HOST/POSTGRES_PASSWORD is not configured.",
    );
  }
  return url;
}

function graphileTaskName(name) {
  return graphileTaskNames[name] || name.replace(/[^a-zA-Z0-9_]/g, "_");
}

function publicJobName(taskName) {
  return publicJobNames[taskName] || taskName;
}

async function graphileUtils() {
  if (!graphileUtilsPromise) {
    graphileUtilsPromise = (async () => {
      const utils = await makeWorkerUtils({ connectionString: databaseUrl() });
      await utils.migrate();
      return utils;
    })();
  }

  return graphileUtilsPromise;
}

function graphileQueueName(options = {}) {
  return options.queue === "default" ? undefined : options.queue;
}

async function graphilePoolInstance() {
  if (!graphilePool) {
    graphilePool = new pg.Pool({ connectionString: databaseUrl() });
  }
  return graphilePool;
}

function graphileJobStatus(job) {
  if (job.locked_at) return "running";
  if (job.last_error && Number(job.attempts || 0) >= Number(job.max_attempts || 0)) return "dead";
  return "pending";
}

function graphileJobSummary(job, payload = {}) {
  return {
    id: String(job.id),
    name: publicJobName(job.task_identifier),
    key: job.key || "",
    queue: job.queue_name || "default",
    status: graphileJobStatus(job),
    payload,
    attempts: Number(job.attempts || 0),
    maxAttempts: Number(job.max_attempts || 0),
    runAt: new Date(job.run_at).toISOString(),
    createdAt: new Date(job.created_at).toISOString(),
    updatedAt: job.updated_at ? new Date(job.updated_at).toISOString() : undefined,
    failedAt: job.last_error ? new Date(job.updated_at || job.created_at).toISOString() : undefined,
    lastError: job.last_error || undefined,
  };
}

export function defaultJobKey(name, payload = {}) {
  if (name === "source.sync") {
    return [
      name,
      payload.sourceConnectionId || payload.accountId || "unknown-source",
      payload.trigger || "manual",
      payload.cursorHint || "latest",
    ].join(":");
  }

  if (name === "classification.batch") {
    return [
      name,
      payload.userId || payload.accountId || "default-user",
      payload.classifierVersion || "current",
    ].join(":");
  }

  if (name === "message-types.discover") {
    return [
      name,
      payload.userId || payload.accountId || "default-user",
      payload.taxonomyVersion || "current",
    ].join(":");
  }

  if (name === "brief.generate") {
    return [
      name,
      payload.userId || payload.accountId || "default-user",
      payload.scopeType || "all_sources",
      payload.sourceConnectionId || "all",
    ].join(":");
  }

  return `${name}:${crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

export async function enqueueJob(name, payload = {}, options = {}) {
  if (isGraphileDriver()) {
    const key = options.key || defaultJobKey(name, payload);
    const utils = await graphileUtils();
    const job = await utils.addJob(graphileTaskName(name), payload, {
      jobKey: key,
      jobKeyMode: options.jobKeyMode || "replace",
      maxAttempts: options.maxAttempts || 5,
      queueName: graphileQueueName(options),
      runAt: options.runAt ? new Date(options.runAt) : undefined,
    });
    return {
      job: graphileJobSummary(job, payload),
      enqueued: true,
    };
  }

  const key = options.key || defaultJobKey(name, payload);
  const createdAt = nowIso();
  const runAt = options.runAt || createdAt;

  return mutateStore((store) => {
    store.queueJobs ||= [];
    const existing = store.queueJobs.find(
      (job) => job.key === key && activeStatuses.has(job.status),
    );

    if (existing) {
      existing.payload = { ...existing.payload, ...payload };
      existing.updatedAt = createdAt;
      existing.runAt = dueAtMs(existing) <= dueAtMs({ runAt }) ? existing.runAt : runAt;
      return { job: existing, enqueued: false };
    }

    const job = {
      id: `job_${crypto.randomUUID()}`,
      name,
      key,
      queue: options.queue || "default",
      status: "pending",
      payload,
      attempts: 0,
      maxAttempts: options.maxAttempts || 5,
      runAt,
      createdAt,
      updatedAt: createdAt,
    };
    store.queueJobs.push(job);

    store.events.push({
      type: "queue.job.enqueued",
      jobId: job.id,
      name,
      key,
      createdAt,
    });

    return { job, enqueued: true };
  });
}

export async function claimNextJob({ names, queue = "default" } = {}) {
  if (isGraphileDriver()) {
    throw new Error("claimNextJob is only available for the local-json queue driver.");
  }

  const nameSet = names?.length ? new Set(names) : null;
  const claimedAt = nowIso();
  const nowMs = Date.now();

  return mutateStore((store) => {
    store.queueJobs ||= [];
    const job = store.queueJobs
      .filter((item) => item.queue === queue)
      .filter((item) => item.status === "pending")
      .filter((item) => !nameSet || nameSet.has(item.name))
      .filter((item) => dueAtMs(item) <= nowMs)
      .sort((a, b) => {
        const dueDelta = dueAtMs(a) - dueAtMs(b);
        if (dueDelta !== 0) return dueDelta;
        return jobCreatedAtMs(a) - jobCreatedAtMs(b);
      })[0];

    if (!job) return null;

    job.status = "running";
    job.attempts = (job.attempts || 0) + 1;
    job.lockedAt = claimedAt;
    job.updatedAt = claimedAt;
    return job;
  });
}

export async function completeJob(jobId, result = {}) {
  if (isGraphileDriver()) {
    return null;
  }

  const completedAt = nowIso();
  return mutateStore((store) => {
    const job = (store.queueJobs || []).find((item) => item.id === jobId);
    if (!job) return null;

    job.status = "succeeded";
    job.result = result;
    job.completedAt = completedAt;
    job.updatedAt = completedAt;
    store.events.push({
      type: "queue.job.completed",
      jobId,
      name: job.name,
      createdAt: completedAt,
    });
    return job;
  });
}

export async function failJob(jobId, error, options = {}) {
  if (isGraphileDriver()) {
    return null;
  }

  const failedAt = nowIso();
  const message = error instanceof Error ? error.message : String(error);
  const baseDelayMs = options.baseDelayMs || 30_000;

  return mutateStore((store) => {
    const job = (store.queueJobs || []).find((item) => item.id === jobId);
    if (!job) return null;

    const maxAttempts = options.maxAttempts || job.maxAttempts || 5;
    const exhausted = (job.attempts || 0) >= maxAttempts;
    job.lastError = message;
    job.updatedAt = failedAt;
    job.failedAt = failedAt;

    if (exhausted) {
      job.status = "dead";
    } else {
      const delayMs = Math.min(60 * 60 * 1000, baseDelayMs * 2 ** Math.max(0, job.attempts - 1));
      job.status = "pending";
      job.runAt = new Date(Date.now() + delayMs).toISOString();
      delete job.lockedAt;
    }

    store.events.push({
      type: exhausted ? "queue.job.dead" : "queue.job.retry_scheduled",
      jobId,
      name: job.name,
      error: message,
      createdAt: failedAt,
    });
    return job;
  });
}

export async function listQueueJobs(limit = 50) {
  if (isGraphileDriver()) {
    await graphileUtils();
    const pool = await graphilePoolInstance();
    const result = await pool.query(
      `select id, queue_name, task_identifier, run_at, attempts, max_attempts,
              last_error, created_at, updated_at, key, locked_at, payload
         from graphile_worker.jobs
        order by run_at desc, created_at desc
        limit $1`,
      [limit],
    );
    return result.rows.map((job) =>
      graphileJobSummary(job, typeof job.payload === "object" && job.payload ? job.payload : {}),
    );
  }

  const store = await readStore();
  return [...(store.queueJobs || [])]
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
    .slice(0, limit);
}
