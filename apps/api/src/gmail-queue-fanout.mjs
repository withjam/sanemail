import { loadConfig } from "./config.mjs";
import { enqueueJob } from "./queue.mjs";
import { listUserIdsWithActiveGmailSources, readStoreFor } from "./store.mjs";

/**
 * Enqueue one `source.sync` job per connected Gmail (non-demo) for this user.
 * Each job is deduped separately by graphile/local job key (per source + trigger).
 */
export async function enqueueGmailSyncForAllConnections(userId, { trigger = "poll" } = {}) {
  if (!userId) throw new Error("enqueueGmailSyncForAllConnections requires userId");
  const store = await readStoreFor(userId);
  const gmailAccounts = (store.accounts || []).filter(
    (a) => a && a.provider === "gmail" && !a.demo,
  );
  const results = [];
  const requestedAt = new Date().toISOString();
  for (const account of gmailAccounts) {
    const queued = await enqueueJob("source.sync", {
      userId,
      sourceConnectionId: account.id,
      provider: "gmail",
      trigger,
      cursorHint: "latest",
      requestedAt,
    });
    results.push({
      sourceConnectionId: account.id,
      email: account.email || "",
      queued,
    });
  }
  return { sources: gmailAccounts.length, results };
}

let gmailPollTimer = null;

export function stopGmailAutoPollTimer() {
  if (gmailPollTimer) {
    clearInterval(gmailPollTimer);
    gmailPollTimer = null;
  }
}

async function tickGmailAutoPoll() {
  const userIds = await listUserIdsWithActiveGmailSources();
  for (const userId of userIds) {
    try {
      await enqueueGmailSyncForAllConnections(userId, { trigger: "poll" });
    } catch (error) {
      console.error(`[gmail-auto-poll] user ${userId}:`, error);
    }
  }
}

/** When QUEUE_GMAIL_AUTO_POLL_INTERVAL_MS > 0, periodically enqueue sync for every Gmail on every active user. */
export function startGmailAutoPollTimerIfConfigured() {
  stopGmailAutoPollTimer();
  const config = loadConfig();
  const ms = config.queue.gmailAutoPollIntervalMs;
  if (!Number.isFinite(ms) || ms < 15_000) return;

  gmailPollTimer = setInterval(() => {
    void tickGmailAutoPoll();
  }, ms);
  if (typeof gmailPollTimer.unref === "function") {
    gmailPollTimer.unref();
  }
  console.log(`[gmail-auto-poll] enabled every ${ms}ms for all users with Gmail`);
}
