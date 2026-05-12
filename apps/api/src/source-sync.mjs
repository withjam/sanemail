import { loadConfig } from "./config.mjs";
import { syncMockSource } from "./demo-data.mjs";
import {
  GmailHistoryExpiredError,
  maxHistoryIdFromMessages,
  refreshAccessToken,
  syncBackfillOlderMessages,
  syncIncrementalFromHistory,
  syncRecentMessages,
} from "./gmail.mjs";
import {
  getPrimarySourceConnection,
  readStoreFor,
  upsertAccount,
  upsertSyncedMessages,
} from "./store.mjs";

function accountHasSyncedMessages(store, accountId) {
  return (store?.messages || []).some((message) => message?.accountId === accountId);
}

function oldestMessageDateForStore(store, accountId) {
  const messages = (store?.messages || []).filter((message) => message?.accountId === accountId);
  let oldestMs = null;
  let oldestIso = null;
  for (const message of messages) {
    const candidate = message.date || (message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null);
    if (!candidate) continue;
    const ms = new Date(candidate).getTime();
    if (!Number.isFinite(ms)) continue;
    if (oldestMs === null || ms < oldestMs) {
      oldestMs = ms;
      oldestIso = new Date(ms).toISOString();
    }
  }
  return oldestIso;
}

function accountNeedsRefresh(account) {
  if (!account?.accessToken) return true;
  if (!account.tokenExpiresAt) return false;
  return new Date(account.tokenExpiresAt).getTime() - Date.now() < 60_000;
}

async function findAccount({ userId, sourceConnectionId, accountId, provider } = {}) {
  if (!userId) throw new Error("findAccount requires a userId");
  const id = sourceConnectionId || accountId;
  if (!id && !provider) return getPrimarySourceConnection(userId);

  const store = await readStoreFor(userId);
  const accounts = store.accounts || [];
  return accounts.find((account) => {
    if (id && account.id === id) return true;
    if (provider && account.provider === provider) return true;
    return false;
  }) || null;
}

async function freshGmailAccount(config, account) {
  if (!account) throw new Error("No Gmail account is connected.");
  if (!accountNeedsRefresh(account)) return account;

  const refreshed = await refreshAccessToken(config, account);
  return upsertAccount({ ...refreshed, userId: account.userId });
}

export async function syncSourceConnection({
  userId,
  sourceConnectionId,
  accountId,
  provider,
  trigger = "manual",
  cursorHint = "latest",
} = {}) {
  if (!userId) throw new Error("syncSourceConnection requires a userId");
  const config = loadConfig();
  const account = await findAccount({ userId, sourceConnectionId, accountId, provider });
  const sourceProvider = provider || account?.provider;

  if (sourceProvider === "mock" || sourceConnectionId?.startsWith("mock:")) {
    const { account: mockAccount, result } = await syncMockSource({ userId });
    return {
      account: mockAccount,
      result,
      provider: "mock",
      trigger,
    };
  }

  const gmailAccount = await freshGmailAccount(config, account);
  if (gmailAccount.provider !== "gmail") {
    throw new Error(`Unsupported source provider for sync: ${gmailAccount.provider || sourceProvider}`);
  }

  if (cursorHint === "backfill_older") {
    const store = await readStoreFor(userId);
    const oldestIso = oldestMessageDateForStore(store, gmailAccount.id);
    if (!oldestIso) {
      throw new Error("Cannot backfill older messages until at least one Gmail message is synced.");
    }
    const cutoffMs = Date.now() - (config.sync.backfillCutoffDays || 90) * 24 * 60 * 60 * 1000;
    const oldestMs = new Date(oldestIso).getTime();
    if (Number.isFinite(oldestMs) && oldestMs <= cutoffMs) {
      return {
        account: gmailAccount,
        result: { inserted: 0, updated: 0, count: 0 },
        provider: "gmail",
        trigger,
      };
    }
    // Move the boundary slightly earlier to avoid re-fetching the current oldest.
    const beforeDate = new Date(new Date(oldestIso).getTime() - 1000);
    const messages = await syncBackfillOlderMessages(config, gmailAccount, { beforeDate });
    const result = await upsertSyncedMessages(gmailAccount, messages);
    const nextCursor =
      maxHistoryIdFromMessages(messages) || gmailAccount.historyId;
    if (nextCursor) {
      await upsertAccount({ ...gmailAccount, historyId: String(nextCursor) });
    }
    return {
      account: gmailAccount,
      result,
      provider: "gmail",
      trigger,
    };
  }

  const store = await readStoreFor(userId);
  const hasSyncedMail = accountHasSyncedMessages(store, gmailAccount.id);
  let messages = [];
  let mailboxHistoryIdForCursor = null;

  const canTryIncremental =
    config.sync.gmailIncremental &&
    hasSyncedMail &&
    gmailAccount.historyId &&
    cursorHint === "latest";

  if (canTryIncremental) {
    try {
      const incremental = await syncIncrementalFromHistory(
        gmailAccount,
        String(gmailAccount.historyId),
      );
      messages = incremental.messages;
      mailboxHistoryIdForCursor = incremental.mailboxHistoryId || null;
      // deletedIds reserved for soft-delete / tombstone handling (Phase A follow-up).
    } catch (error) {
      if (error instanceof GmailHistoryExpiredError) {
        messages = await syncRecentMessages(config, gmailAccount);
        mailboxHistoryIdForCursor = maxHistoryIdFromMessages(messages);
      } else {
        throw error;
      }
    }
  } else {
    messages = await syncRecentMessages(config, gmailAccount);
    mailboxHistoryIdForCursor = maxHistoryIdFromMessages(messages);
  }

  const result = await upsertSyncedMessages(gmailAccount, messages);
  const nextCursor =
    mailboxHistoryIdForCursor ||
    maxHistoryIdFromMessages(messages) ||
    gmailAccount.historyId;
  if (nextCursor) {
    await upsertAccount({ ...gmailAccount, historyId: String(nextCursor) });
  }

  return {
    account: gmailAccount,
    result,
    provider: "gmail",
    trigger,
  };
}
