import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { decryptJson, encryptJson } from "./security.mjs";

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
const storePath = path.join(dataDir, "sanemail.json");

let postgresStorePromise;

function usePostgresStore() {
  return loadConfig().storage.driver === "postgres";
}

async function postgresStore() {
  if (!postgresStorePromise) {
    postgresStorePromise = import("./postgres-store.mjs");
  }
  return postgresStorePromise;
}

function emptyStore() {
  return {
    schemaVersion: 1,
    oauthStates: [],
    users: [],
    accounts: [],
    messages: [],
    threads: [],
    classificationState: [],
    feedback: [],
    events: [],
    queueJobs: [],
    aiRuns: [],
    inboxBriefings: [],
    verificationRuns: [],
  };
}

async function ensureDataDir() {
  await mkdir(dataDir, { recursive: true });
}

function decryptAccountSecrets(account) {
  if (!account?.authEncrypted) return account;

  const tokens = decryptJson(account.authEncrypted, { purpose: "oauth_tokens" }) || {};
  return {
    ...account,
    accessToken: tokens.accessToken || "",
    refreshToken: tokens.refreshToken || "",
    tokenExpiresAt: tokens.tokenExpiresAt || account.tokenExpiresAt || "",
  };
}

function encryptAccountSecrets(account) {
  if (!account) return account;

  const { accessToken, refreshToken, ...rest } = account;
  const hasTokenFields = accessToken !== undefined || refreshToken !== undefined;

  if (!hasTokenFields) return rest;

  const tokenExpiresAt = account.tokenExpiresAt || rest.tokenExpiresAt || "";
  return {
    ...rest,
    tokenExpiresAt,
    authEncrypted: encryptJson(
      {
        accessToken: accessToken || "",
        refreshToken: refreshToken || "",
        tokenExpiresAt,
      },
      { purpose: "oauth_tokens" },
    ),
  };
}

function hydrateStoreSecrets(store) {
  return {
    ...store,
    accounts: (store.accounts || []).map(decryptAccountSecrets),
  };
}

function sealStoreSecrets(store) {
  return {
    ...store,
    accounts: (store.accounts || []).map(encryptAccountSecrets),
  };
}

async function readJsonStoreRaw() {
  await ensureDataDir();

  try {
    const raw = await readFile(storePath, "utf8");
    return { ...emptyStore(), ...JSON.parse(raw) };
  } catch (error) {
    if (error.code === "ENOENT") return emptyStore();
    throw error;
  }
}

function messageInputHash(message = {}) {
  return crypto.createHash("sha256").update(JSON.stringify({
    subject: message.subject,
    from: message.from,
    to: message.to,
    date: message.date,
    snippet: message.snippet,
    bodyText: message.bodyText,
    labels: message.sourceLabels || [],
  })).digest("hex");
}

function messagePriorityAt(message = {}) {
  return message.date || (Number(message.internalDate)
    ? new Date(Number(message.internalDate)).toISOString()
    : new Date().toISOString());
}

function updateJsonClassificationState(store, account, message) {
  store.classificationState ||= [];
  const inputHash = messageInputHash(message);
  const priorityAt = messagePriorityAt(message);
  const now = new Date().toISOString();
  const existing = store.classificationState.find((item) => item.messageId === message.id);

  if (!existing) {
    store.classificationState.push({
      messageId: message.id,
      userId: account.id,
      accountId: account.id,
      state: "pending",
      priorityAt,
      attemptCount: 0,
      nextAttemptAt: now,
      inputHash,
      createdAt: now,
      updatedAt: now,
    });
    return;
  }

  existing.userId = existing.userId || account.id;
  existing.accountId = existing.accountId || account.id;
  existing.priorityAt = priorityAt;
  existing.nextAttemptAt = existing.nextAttemptAt || now;
  if (existing.inputHash !== inputHash) {
    existing.state = existing.state === "pending" ? "pending" : "stale";
    existing.inputHash = inputHash;
    delete existing.lastClassifiedAt;
    delete existing.currentClassification;
  }
  existing.updatedAt = now;
}

export async function readStore() {
  if (usePostgresStore()) return (await postgresStore()).readStore();
  return hydrateStoreSecrets(await readJsonStoreRaw());
}

function filterStoreToUser(store, userId) {
  if (!userId) return store;
  const accountIds = new Set(
    (store.accounts || [])
      .filter((account) => accountBelongsToUser(account, userId))
      .map((account) => account.id),
  );
  return {
    ...store,
    accounts: (store.accounts || []).filter((account) => accountBelongsToUser(account, userId)),
    messages: (store.messages || []).filter((message) => accountIds.has(message.accountId)),
    threads: (store.threads || []).filter((thread) => accountIds.has(thread.accountId)),
    classificationState: (store.classificationState || []).filter(
      (row) => row.userId === userId || accountIds.has(row.accountId),
    ),
    feedback: (store.feedback || []).filter(
      (row) => row.userId === userId || (!row.userId && accountIds.has(row.accountId)),
    ),
    aiRuns: (store.aiRuns || []).filter(
      (run) => !run.input?.accountId || accountIds.has(run.input.accountId),
    ),
    inboxBriefings: (store.inboxBriefings || []).filter(
      (briefing) => !briefing.accountId || accountIds.has(briefing.accountId),
    ),
    queueJobs: (store.queueJobs || []).filter((job) => !job.userId || job.userId === userId),
  };
}

function accountBelongsToUser(account, userId) {
  if (!account) return false;
  if (account.userId) return account.userId === userId;
  // Legacy single-tenant fallback: accounts without an explicit userId belong
  // to the dev user when the JSON store is in single-user mode. We treat any
  // such account as belonging to the requested user so existing data does not
  // disappear after the refactor; multi-tenant data must always set userId.
  return true;
}

export async function readStoreFor(userId) {
  if (!userId) {
    throw new Error("readStoreFor requires a userId");
  }
  if (usePostgresStore()) return (await postgresStore()).readStoreFor(userId);
  return filterStoreToUser(await readStore(), userId);
}

export async function ensureUserRecord(userId, email = null) {
  if (!userId) throw new Error("ensureUserRecord requires a userId");
  if (usePostgresStore()) return (await postgresStore()).ensureUserRecord(userId, email);
  return mutateStore((store) => {
    store.users ||= [];
    const index = store.users.findIndex((user) => user.id === userId);
    const now = new Date().toISOString();
    if (index === -1) {
      store.users.push({
        id: userId,
        primaryEmail: email,
        createdAt: now,
        updatedAt: now,
      });
    } else if (email && !store.users[index].primaryEmail) {
      store.users[index] = { ...store.users[index], primaryEmail: email, updatedAt: now };
    }
    return { id: userId, primaryEmail: email };
  });
}

export async function getPrimarySourceConnection(userId) {
  if (!userId) throw new Error("getPrimarySourceConnection requires a userId");
  if (usePostgresStore()) return (await postgresStore()).getPrimarySourceConnection(userId);
  const store = await readStore();
  const accounts = (store.accounts || []).filter((account) => accountBelongsToUser(account, userId));
  return accounts[0] || null;
}

export async function writeStore(store) {
  if (usePostgresStore()) {
    throw new Error("writeStore is not available with STORE_DRIVER=postgres.");
  }
  await ensureDataDir();
  const tmpPath = `${storePath}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(sealStoreSecrets(store), null, 2)}\n`);
  await rename(tmpPath, storePath);
}

export async function mutateStore(mutator) {
  const store = await readStore();
  const result = await mutator(store);
  await writeStore(store);
  return result;
}

export async function saveOAuthState(state, userId) {
  if (!userId) throw new Error("saveOAuthState requires a userId");
  if (usePostgresStore()) return (await postgresStore()).saveOAuthState(state, userId);
  return mutateStore((store) => {
    store.oauthStates = store.oauthStates.filter(
      (entry) => Date.now() - entry.createdAt < 10 * 60 * 1000,
    );
    store.oauthStates.push({ state, userId, createdAt: Date.now() });
  });
}

export async function consumeOAuthState(state) {
  if (usePostgresStore()) return (await postgresStore()).consumeOAuthState(state);
  return mutateStore((store) => {
    const entry = (store.oauthStates || []).find((item) => item.state === state);
    store.oauthStates = (store.oauthStates || []).filter((item) => item.state !== state);
    if (!entry) return { ok: false, userId: null };
    return { ok: true, userId: entry.userId || null };
  });
}

export async function upsertAccount(account) {
  if (usePostgresStore()) return (await postgresStore()).upsertAccount(account);
  return mutateStore((store) => {
    const index = store.accounts.findIndex((item) => item.id === account.id);
    const existing = index >= 0 ? store.accounts[index] : {};
    const merged = {
      ...existing,
      ...account,
      updatedAt: new Date().toISOString(),
    };

    if (index >= 0) store.accounts[index] = merged;
    else store.accounts.push({ ...merged, createdAt: new Date().toISOString() });

    return merged;
  });
}

export async function getPrimaryAccount() {
  if (usePostgresStore()) return (await postgresStore()).getPrimaryAccount();
  const store = await readStore();
  return store.accounts[0] || null;
}

export async function upsertSyncedMessages(account, messages) {
  if (usePostgresStore()) return (await postgresStore()).upsertSyncedMessages(account, messages);
  return mutateStore((store) => {
    let inserted = 0;
    let updated = 0;

    for (const message of messages) {
      const index = store.messages.findIndex((item) => item.id === message.id);
      if (index >= 0) {
        store.messages[index] = {
          ...store.messages[index],
          ...message,
          updatedAt: new Date().toISOString(),
        };
        updated += 1;
      } else {
        store.messages.push({
          ...message,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        inserted += 1;
      }
      updateJsonClassificationState(store, account, message);

      const threadId = `${account.id}:thread:${message.providerThreadId}`;
      const threadIndex = store.threads.findIndex((item) => item.id === threadId);
      const thread = {
        id: threadId,
        accountId: account.id,
        provider: "gmail",
        providerThreadId: message.providerThreadId,
        subject: message.subject,
        lastMessageAt: message.date || message.internalDate || message.syncedAt,
        updatedAt: new Date().toISOString(),
      };

      if (threadIndex >= 0) {
        const existing = store.threads[threadIndex];
        const existingTime = new Date(existing.lastMessageAt || 0).getTime();
        const messageTime = new Date(thread.lastMessageAt || 0).getTime();
        store.threads[threadIndex] = {
          ...existing,
          ...thread,
          lastMessageAt:
            messageTime > existingTime ? thread.lastMessageAt : existing.lastMessageAt,
        };
      } else {
        store.threads.push({ ...thread, createdAt: new Date().toISOString() });
      }
    }

    store.events.push({
      type: "sync.completed",
      accountId: account.id,
      inserted,
      updated,
      count: messages.length,
      createdAt: new Date().toISOString(),
    });

    return { inserted, updated, count: messages.length };
  });
}

export async function saveFeedback(messageId, kind) {
  if (usePostgresStore()) return (await postgresStore()).saveFeedback(messageId, kind);
  return mutateStore((store) => {
    const message = (store.messages || []).find((item) => item.id === messageId);
    const account = message
      ? (store.accounts || []).find((item) => item.id === message.accountId)
      : null;
    const ownerUserId = account?.userId || null;
    store.feedback.push({
      id: crypto.randomUUID(),
      messageId,
      userId: ownerUserId,
      kind,
      createdAt: new Date().toISOString(),
    });
  });
}

export async function recordAiRun(run) {
  if (usePostgresStore()) return (await postgresStore()).recordAiRun(run);
  return mutateStore((store) => {
    store.aiRuns = [
      run,
      ...store.aiRuns.filter((item) => item.id !== run.id),
    ].slice(0, 100);

    if (run.output?.briefing) {
      const createdAt = new Date().toISOString();
      store.inboxBriefings = [
        {
          id: `brief_${crypto.randomUUID()}`,
          accountId: run.input?.accountId || null,
          runId: run.id,
          trigger: run.trigger,
          provider: run.provider,
          ...run.output.briefing,
          createdAt,
        },
        ...(store.inboxBriefings || []).filter((item) => item.runId !== run.id),
      ].slice(0, 50);
    }

    if (run.kind === "classification-batch") {
      const classifiedAt = run.completedAt || new Date().toISOString();
      store.classificationState ||= [];
      for (const decision of run.output?.decisions || []) {
        let state = store.classificationState.find((item) => item.messageId === decision.messageId);
        if (!state) {
          const message = (store.messages || []).find((item) => item.id === decision.messageId) || {};
          state = {
            messageId: decision.messageId,
            userId: run.input?.accountId || message.accountId || null,
            accountId: run.input?.accountId || message.accountId || null,
            createdAt: classifiedAt,
          };
          store.classificationState.push(state);
        }
        state.state = "classified";
        state.lastClassifiedAt = classifiedAt;
        state.classifierVersion = run.provider?.classificationModel || run.provider?.model || "deterministic";
        state.inputHash = decision.instrumentation?.inputHash || state.inputHash || "";
        state.currentClassification = {
          runId: run.id,
          category: decision.category,
          needsReply: decision.needsReply,
          possibleJunk: decision.possibleJunk,
          automated: decision.automated,
          confidence: decision.confidence,
          score: decision.recsysScore,
        };
        state.updatedAt = classifiedAt;
        delete state.lastError;
      }
    }

    store.events.push({
      type: "ai.run.completed",
      runId: run.id,
      kind: run.kind,
      status: run.status,
      messagesProcessed: run.metrics?.messagesProcessed || 0,
      createdAt: new Date().toISOString(),
    });
    return run;
  });
}

const backlogStates = new Set(["pending", "stale", "failed"]);

function classificationRowsForStore(store, accountId) {
  const stateByMessageId = new Map((store.classificationState || []).map((item) => [item.messageId, item]));
  return (store.messages || [])
    .filter((message) => !accountId || message.accountId === accountId)
    .map((message) => {
      const existing = stateByMessageId.get(message.id);
      if (existing) {
        return {
          ...existing,
          accountId: existing.accountId || message.accountId,
          userId: existing.userId || message.accountId,
          priorityAt: existing.priorityAt || messagePriorityAt(message),
          inputHash: existing.inputHash || messageInputHash(message),
        };
      }
      return {
        messageId: message.id,
        accountId: message.accountId,
        userId: message.accountId,
        state: "pending",
        priorityAt: messagePriorityAt(message),
        attemptCount: 0,
        nextAttemptAt: new Date(0).toISOString(),
        inputHash: messageInputHash(message),
      };
    });
}

function priorityMs(row) {
  const ms = new Date(row.priorityAt || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function nextAttemptMs(row) {
  const ms = new Date(row.nextAttemptAt || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export function classificationBacklogSummaryFromStore(store, accountId) {
  const rows = classificationRowsForStore(store, accountId);
  const counts = {
    total: rows.length,
    pending: 0,
    stale: 0,
    failed: 0,
    classified: 0,
    backlog: 0,
  };
  let newestPriorityAt = null;
  let oldestPriorityAt = null;

  for (const row of rows) {
    const state = row.state || "pending";
    if (Object.prototype.hasOwnProperty.call(counts, state)) counts[state] += 1;
    if (backlogStates.has(state)) {
      counts.backlog += 1;
      if (!newestPriorityAt || priorityMs(row) > new Date(newestPriorityAt).getTime()) {
        newestPriorityAt = row.priorityAt || null;
      }
      if (!oldestPriorityAt || priorityMs(row) < new Date(oldestPriorityAt).getTime()) {
        oldestPriorityAt = row.priorityAt || null;
      }
    }
  }

  return {
    ...counts,
    newestPriorityAt,
    oldestPriorityAt,
  };
}

export function selectMessagesForClassificationBatch(store, account, limit) {
  const messageById = new Map(
    (store.messages || [])
      .filter((message) => !account?.id || message.accountId === account.id)
      .map((message) => [message.id, message]),
  );
  const rows = classificationRowsForStore(store, account?.id)
    .filter((row) => backlogStates.has(row.state || "pending"))
    .filter((row) => row.state !== "failed" || nextAttemptMs(row) <= Date.now())
    .sort((a, b) => priorityMs(b) - priorityMs(a));

  return rows
    .map((row) => messageById.get(row.messageId))
    .filter(Boolean)
    .slice(0, limit || undefined);
}

export async function getClassificationBacklogSummary(accountId) {
  const store = await readStore();
  return classificationBacklogSummaryFromStore(store, accountId);
}

export function latestInboxBriefing(store, scopeId) {
  // The store is already user-scoped when read via readStoreFor(); scopeId is
  // accepted for backward compatibility and as a defensive filter when callers
  // pass an accountId rather than relying on the store's user-scope.
  return [...(store.inboxBriefings || [])]
    .filter((briefing) => !scopeId || !briefing.accountId || briefing.accountId === scopeId)
    .sort(
      (a, b) =>
        new Date(b.generatedAt || b.createdAt || 0).getTime() -
        new Date(a.generatedAt || a.createdAt || 0).getTime(),
    )[0] || null;
}

export async function listAiRuns(limit = 50) {
  if (usePostgresStore()) return (await postgresStore()).listAiRuns(limit);
  const store = await readStore();
  return [...store.aiRuns]
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
    .slice(0, limit);
}

export async function listAiRunsFor(userId, limit = 50) {
  if (!userId) throw new Error("listAiRunsFor requires a userId");
  if (usePostgresStore()) return (await postgresStore()).listAiRunsFor(userId, limit);
  const store = await readStoreFor(userId);
  return [...(store.aiRuns || [])]
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
    .slice(0, limit);
}

export async function saveVerificationRun(run) {
  if (usePostgresStore()) return (await postgresStore()).saveVerificationRun(run);
  return mutateStore((store) => {
    store.verificationRuns = [
      run,
      ...store.verificationRuns.filter((item) => item.id !== run.id),
    ].slice(0, 100);
    store.events.push({
      type: "ai.verification.completed",
      runId: run.id,
      suiteId: run.suiteId,
      status: run.status,
      score: run.score,
      createdAt: new Date().toISOString(),
    });
    return run;
  });
}

export async function listVerificationRuns(limit = 50) {
  if (usePostgresStore()) return (await postgresStore()).listVerificationRuns(limit);
  const store = await readStore();
  return [...store.verificationRuns]
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
    .slice(0, limit);
}

export async function clearLocalData() {
  if (usePostgresStore()) return (await postgresStore()).clearLocalData();
  await writeStore(emptyStore());
}

export async function clearUserData(userId) {
  if (!userId) throw new Error("clearUserData requires a userId");
  if (usePostgresStore()) return (await postgresStore()).clearUserData(userId);

  return mutateStore((store) => {
    const accountIds = new Set(
      (store.accounts || [])
        .filter((account) => accountBelongsToUser(account, userId))
        .map((account) => account.id),
    );
    store.accounts = (store.accounts || []).filter(
      (account) => !accountBelongsToUser(account, userId),
    );
    store.messages = (store.messages || []).filter((message) => !accountIds.has(message.accountId));
    store.threads = (store.threads || []).filter((thread) => !accountIds.has(thread.accountId));
    store.classificationState = (store.classificationState || []).filter(
      (row) => row.userId !== userId && !accountIds.has(row.accountId),
    );
    store.feedback = (store.feedback || []).filter((row) => row.userId !== userId);
    store.aiRuns = (store.aiRuns || []).filter(
      (run) => !run.input?.accountId || !accountIds.has(run.input.accountId),
    );
    store.inboxBriefings = (store.inboxBriefings || []).filter(
      (briefing) => !briefing.accountId || !accountIds.has(briefing.accountId),
    );
    store.queueJobs = (store.queueJobs || []).filter((job) => job.userId !== userId);
    store.users = (store.users || []).filter((user) => user.id !== userId);
  });
}
