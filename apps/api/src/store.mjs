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
    accounts: [],
    messages: [],
    threads: [],
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

export async function readStore() {
  if (usePostgresStore()) return (await postgresStore()).readStore();
  return hydrateStoreSecrets(await readJsonStoreRaw());
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

export async function saveOAuthState(state) {
  if (usePostgresStore()) return (await postgresStore()).saveOAuthState(state);
  return mutateStore((store) => {
    store.oauthStates = store.oauthStates.filter(
      (entry) => Date.now() - entry.createdAt < 10 * 60 * 1000,
    );
    store.oauthStates.push({ state, createdAt: Date.now() });
  });
}

export async function consumeOAuthState(state) {
  if (usePostgresStore()) return (await postgresStore()).consumeOAuthState(state);
  return mutateStore((store) => {
    const found = store.oauthStates.some((entry) => entry.state === state);
    store.oauthStates = store.oauthStates.filter((entry) => entry.state !== state);
    return found;
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
    store.feedback.push({
      id: crypto.randomUUID(),
      messageId,
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

export function latestInboxBriefing(store, accountId) {
  return [...(store.inboxBriefings || [])]
    .filter((briefing) => !accountId || !briefing.accountId || briefing.accountId === accountId)
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
