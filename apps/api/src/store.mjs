import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
const storePath = path.join(dataDir, "sanemail.json");

function emptyStore() {
  return {
    schemaVersion: 1,
    oauthStates: [],
    accounts: [],
    messages: [],
    threads: [],
    feedback: [],
    events: [],
    aiRuns: [],
    verificationRuns: [],
  };
}

async function ensureDataDir() {
  await mkdir(dataDir, { recursive: true });
}

export async function readStore() {
  await ensureDataDir();

  try {
    const raw = await readFile(storePath, "utf8");
    return { ...emptyStore(), ...JSON.parse(raw) };
  } catch (error) {
    if (error.code === "ENOENT") return emptyStore();
    throw error;
  }
}

export async function writeStore(store) {
  await ensureDataDir();
  const tmpPath = `${storePath}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`);
  await rename(tmpPath, storePath);
}

export async function mutateStore(mutator) {
  const store = await readStore();
  const result = await mutator(store);
  await writeStore(store);
  return result;
}

export async function saveOAuthState(state) {
  return mutateStore((store) => {
    store.oauthStates = store.oauthStates.filter(
      (entry) => Date.now() - entry.createdAt < 10 * 60 * 1000,
    );
    store.oauthStates.push({ state, createdAt: Date.now() });
  });
}

export async function consumeOAuthState(state) {
  return mutateStore((store) => {
    const found = store.oauthStates.some((entry) => entry.state === state);
    store.oauthStates = store.oauthStates.filter((entry) => entry.state !== state);
    return found;
  });
}

export async function upsertAccount(account) {
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
  const store = await readStore();
  return store.accounts[0] || null;
}

export async function upsertSyncedMessages(account, messages) {
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
  return mutateStore((store) => {
    store.aiRuns = [
      run,
      ...store.aiRuns.filter((item) => item.id !== run.id),
    ].slice(0, 100);
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

export async function listAiRuns(limit = 50) {
  const store = await readStore();
  return [...store.aiRuns]
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
    .slice(0, limit);
}

export async function saveVerificationRun(run) {
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
  const store = await readStore();
  return [...store.verificationRuns]
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
    .slice(0, limit);
}

export async function clearLocalData() {
  await writeStore(emptyStore());
}
