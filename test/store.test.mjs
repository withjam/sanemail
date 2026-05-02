import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("stores accounts, messages, threads, and feedback in an isolated data dir", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sanemail-store-"));
  process.env.DATA_DIR = dataDir;

  const store = await import(`../apps/api/src/store.mjs?dataDir=${encodeURIComponent(dataDir)}`);
  await store.clearLocalData();

  const account = await store.upsertAccount({
    id: "gmail:test@example.com",
    provider: "gmail",
    email: "test@example.com",
  });

  const firstSync = await store.upsertSyncedMessages(account, [
    {
      id: `${account.id}:message:one`,
      accountId: account.id,
      provider: "gmail",
      providerMessageId: "one",
      providerThreadId: "thread-one",
      sourceLabels: ["INBOX"],
      subject: "Hello",
      from: "Alex <alex@example.com>",
      to: "test@example.com",
      date: new Date().toISOString(),
      snippet: "Hello there",
      bodyText: "Hello there",
      headers: { to: "test@example.com" },
    },
  ]);

  const secondSync = await store.upsertSyncedMessages(account, [
    {
      id: `${account.id}:message:one`,
      accountId: account.id,
      provider: "gmail",
      providerMessageId: "one",
      providerThreadId: "thread-one",
      sourceLabels: ["INBOX"],
      subject: "Hello again",
      from: "Alex <alex@example.com>",
      to: "test@example.com",
      date: new Date().toISOString(),
      snippet: "Hello again",
      bodyText: "Hello again",
      headers: { to: "test@example.com" },
    },
  ]);

  await store.saveFeedback(`${account.id}:message:one`, "important");
  const snapshot = await store.readStore();

  assert.equal(firstSync.inserted, 1);
  assert.equal(secondSync.updated, 1);
  assert.equal(snapshot.accounts.length, 1);
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.messages[0].subject, "Hello again");
  assert.equal(snapshot.threads.length, 1);
  assert.equal(snapshot.feedback[0].kind, "important");

  await rm(dataDir, { recursive: true, force: true });
});
