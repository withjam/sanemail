import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.mjs";

export function queueRuntimeFilePath() {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
  return path.join(dataDir, "queue-runtime.json");
}

function normalizePrefs(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  const updatedAt = typeof data.updatedAt === "string" ? data.updatedAt : null;
  const automationEnabled =
    typeof data.automationEnabled === "boolean" ? data.automationEnabled : null;
  const automationBySource = {};
  const rawBy = data.automationBySource;
  if (rawBy && typeof rawBy === "object" && !Array.isArray(rawBy)) {
    for (const [key, value] of Object.entries(rawBy)) {
      if (typeof value === "boolean") automationBySource[key] = value;
    }
  }
  return { automationEnabled, automationBySource, updatedAt };
}

/**
 * @returns {{ automationEnabled: boolean | null, automationBySource: Record<string, boolean>, updatedAt: string | null }}
 *   `automationEnabled: null` means no legacy global override — use env or per-source map.
 */
export async function readQueueRuntimePrefs() {
  try {
    const raw = await readFile(queueRuntimeFilePath(), "utf8");
    return normalizePrefs(JSON.parse(raw));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { automationEnabled: null, automationBySource: {}, updatedAt: null };
    }
    throw error;
  }
}

async function persistPrefs(prefs) {
  const filePath = queueRuntimeFilePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  const updatedAt = new Date().toISOString();
  const payload = {
    automationEnabled: prefs.automationEnabled,
    automationBySource: prefs.automationBySource,
    updatedAt,
  };
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { ...prefs, updatedAt };
}

/** Legacy global toggle only (merges with existing per-source map). */
export async function writeQueueRuntimePrefs({ automationEnabled }) {
  const prev = await readQueueRuntimePrefs();
  return persistPrefs({
    ...prev,
    automationEnabled:
      typeof automationEnabled === "boolean" ? automationEnabled : prev.automationEnabled,
  });
}

/** Set or clear per-source override. `enabled: null` removes the key (fall back to legacy / env). */
export async function writeSourceAutomationOverride(sourceConnectionId, enabled) {
  if (!sourceConnectionId) throw new Error("writeSourceAutomationOverride requires sourceConnectionId");
  const prev = await readQueueRuntimePrefs();
  const automationBySource = { ...prev.automationBySource };
  if (enabled === null) {
    delete automationBySource[sourceConnectionId];
  } else if (typeof enabled === "boolean") {
    automationBySource[sourceConnectionId] = enabled;
  } else {
    throw new Error("enabled must be boolean or null to clear override");
  }
  return persistPrefs({ ...prev, automationBySource });
}

/**
 * Effective post-ingest automation for a source.
 * Precedence: per-source override → legacy global override → QUEUE_AUTO_POST_INGEST_JOBS.
 */
export async function isQueueAutomationEnabledForSource(sourceConnectionId) {
  const prefs = await readQueueRuntimePrefs();
  if (sourceConnectionId && Object.prototype.hasOwnProperty.call(prefs.automationBySource, sourceConnectionId)) {
    return prefs.automationBySource[sourceConnectionId];
  }
  if (prefs.automationEnabled !== null) return prefs.automationEnabled;
  return loadConfig().queue.autoPostIngestJobs;
}

/** @deprecated Prefer isQueueAutomationEnabledForSource(accountId); kept for tests — legacy + env only (ignores per-source map). */
export async function isQueueAutomationEnabled() {
  const prefs = await readQueueRuntimePrefs();
  if (prefs.automationEnabled !== null) return prefs.automationEnabled;
  return loadConfig().queue.autoPostIngestJobs;
}
