import { access } from "node:fs/promises";
import { loadConfig } from "./config.mjs";
import { listQueueJobs } from "./queue.mjs";
import {
  isQueueAutomationEnabledForSource,
  queueRuntimeFilePath,
  readQueueRuntimePrefs,
  writeQueueRuntimePrefs,
  writeSourceAutomationOverride,
} from "./queue-runtime.mjs";
import { readStoreFor } from "./store.mjs";

function booleanEnv(name) {
  return ["1", "true", "yes", "on"].includes(String(process.env[name] || "").toLowerCase());
}

export function allowQueueRuntimeControl(config) {
  if (config.env !== "production") return true;
  return booleanEnv("QUEUE_RUNTIME_CONTROL_ENABLED");
}

export async function buildQueueAutomationResponse(userId) {
  const config = loadConfig();
  const prefs = await readQueueRuntimePrefs();
  const filePath = queueRuntimeFilePath();
  let runtimeFileExists = false;
  try {
    await access(filePath);
    runtimeFileExists = true;
  } catch {
    runtimeFileExists = false;
  }

  const store = userId ? await readStoreFor(userId) : { accounts: [] };
  const accounts = (store.accounts || []).filter(Boolean);
  const sources = [];
  for (const account of accounts) {
    const automationEffective = await isQueueAutomationEnabledForSource(account.id);
    const override = Object.prototype.hasOwnProperty.call(prefs.automationBySource, account.id)
      ? prefs.automationBySource[account.id]
      : null;
    sources.push({
      sourceConnectionId: account.id,
      provider: account.provider,
      email: account.email || "",
      automationRuntimeOverride: override,
      automationEffective,
    });
  }

  const automationEnabled = sources.some((row) => row.automationEffective);

  const jobLimit = 100;
  const jobs = await listQueueJobs(jobLimit);
  const byStatus = { pending: 0, running: 0, succeeded: 0, dead: 0 };
  for (const job of jobs) {
    if (Object.prototype.hasOwnProperty.call(byStatus, job.status)) {
      byStatus[job.status] += 1;
    }
  }

  const jobsForSource = (sourceConnectionId) =>
    jobs.filter((job) => {
      const sid = job.payload?.sourceConnectionId || job.payload?.accountId;
      return sid === sourceConnectionId;
    });

  const sourcesWithJobs = sources.map((row) => {
    const subset = jobsForSource(row.sourceConnectionId);
    const localByStatus = { pending: 0, running: 0, succeeded: 0, dead: 0 };
    for (const job of subset) {
      if (Object.prototype.hasOwnProperty.call(localByStatus, job.status)) {
        localByStatus[job.status] += 1;
      }
    }
    return {
      ...row,
      jobsSample: {
        limit: jobLimit,
        byStatus: localByStatus,
        recent: subset.slice(0, 10),
      },
    };
  });

  return {
    automationEnabled,
    sources: sourcesWithJobs,
    runtimeFile: {
      path: filePath,
      exists: runtimeFileExists,
      automationEnabled: prefs.automationEnabled,
      automationBySource: prefs.automationBySource,
      updatedAt: prefs.updatedAt,
    },
    envDefault: config.queue.autoPostIngestJobs,
    controlWritable: allowQueueRuntimeControl(config),
    queue: {
      driver: config.queue.driver,
      pollIntervalMs: config.queue.pollIntervalMs,
      classificationBatchSize: config.queue.classificationBatchSize,
    },
    worker: {
      hint:
        "Run `bun run worker` in another terminal, or start dev with QUEUE_WORKER_ENABLED=true so scripts/dev.mjs spawns the worker.",
    },
    jobsSample: {
      limit: jobLimit,
      byStatus,
      recent: jobs.slice(0, 20),
    },
  };
}

export async function setQueueAutomationEnabled(userId, { enabled, sourceConnectionId } = {}) {
  const config = loadConfig();
  if (!allowQueueRuntimeControl(config)) {
    const err = new Error(
      "Queue automation control is disabled in production unless QUEUE_RUNTIME_CONTROL_ENABLED=true.",
    );
    err.code = "queue_control_forbidden";
    throw err;
  }

  if (typeof enabled !== "boolean") {
    const err = new Error("Request body must include boolean `enabled`.");
    err.code = "invalid_body";
    throw err;
  }

  if (sourceConnectionId) {
    const store = await readStoreFor(userId);
    const owned = (store.accounts || []).some((a) => a?.id === sourceConnectionId);
    if (!owned) {
      const err = new Error("Unknown or inaccessible source_connection_id for this user.");
      err.code = "unknown_source";
      throw err;
    }
    await writeSourceAutomationOverride(sourceConnectionId, enabled);
  } else {
    await writeQueueRuntimePrefs({ automationEnabled: enabled });
  }

  return buildQueueAutomationResponse(userId);
}
