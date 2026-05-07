import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("user A cannot see user B's accounts, messages, briefings, or feedback", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sanemail-isolation-"));
  process.env.DATA_DIR = dataDir;
  process.env.STORE_DRIVER = "json";
  process.env.APP_SECRET = "isolation-test-secret-not-for-production-use";

  try {
    const store = await import(
      `../apps/api/src/store.mjs?isolation=${encodeURIComponent(dataDir)}`
    );
    await store.clearLocalData();

    const userA = "user-a";
    const userB = "user-b";

    await store.ensureUserRecord(userA, "alice@example.com");
    await store.ensureUserRecord(userB, "bob@example.com");

    const accountA = await store.upsertAccount({
      id: `gmail:${userA}:alice`,
      userId: userA,
      provider: "gmail",
      email: "alice@example.com",
    });
    const accountB = await store.upsertAccount({
      id: `gmail:${userB}:bob`,
      userId: userB,
      provider: "gmail",
      email: "bob@example.com",
    });

    await store.upsertSyncedMessages(accountA, [
      {
        id: `${accountA.id}:msg:a1`,
        accountId: accountA.id,
        provider: "gmail",
        providerMessageId: "a1",
        providerThreadId: "thread-a1",
        sourceLabels: ["INBOX"],
        subject: "Alice top secret",
        from: "Carol <carol@example.com>",
        to: "alice@example.com",
        date: new Date().toISOString(),
        snippet: "for alice eyes only",
        bodyText: "for alice eyes only",
        headers: { to: "alice@example.com" },
      },
    ]);
    await store.upsertSyncedMessages(accountB, [
      {
        id: `${accountB.id}:msg:b1`,
        accountId: accountB.id,
        provider: "gmail",
        providerMessageId: "b1",
        providerThreadId: "thread-b1",
        sourceLabels: ["INBOX"],
        subject: "Bob private",
        from: "Dan <dan@example.com>",
        to: "bob@example.com",
        date: new Date().toISOString(),
        snippet: "for bob eyes only",
        bodyText: "for bob eyes only",
        headers: { to: "bob@example.com" },
      },
    ]);

    await store.saveFeedback(`${accountA.id}:msg:a1`, "important");
    await store.saveFeedback(`${accountB.id}:msg:b1`, "junk");

    await store.recordAiRun({
      id: "airun_alice",
      kind: "daily-brief",
      trigger: "test",
      provider: { name: "deterministic", model: "test", temperature: 0 },
      input: { accountId: accountA.id },
      output: {
        briefing: {
          text: "alice brief",
          generatedAt: new Date().toISOString(),
          source: "ai-loop",
          model: "test",
          counts: {},
          messageIds: [`${accountA.id}:msg:a1`],
        },
      },
      metrics: { messagesProcessed: 1 },
    });
    await store.recordAiRun({
      id: "airun_bob",
      kind: "daily-brief",
      trigger: "test",
      provider: { name: "deterministic", model: "test", temperature: 0 },
      input: { accountId: accountB.id },
      output: {
        briefing: {
          text: "bob brief",
          generatedAt: new Date().toISOString(),
          source: "ai-loop",
          model: "test",
          counts: {},
          messageIds: [`${accountB.id}:msg:b1`],
        },
      },
      metrics: { messagesProcessed: 1 },
    });

    const aliceStore = await store.readStoreFor(userA);
    const bobStore = await store.readStoreFor(userB);

    // Account isolation
    assert.equal(aliceStore.accounts.length, 1);
    assert.equal(aliceStore.accounts[0].id, accountA.id);
    assert.equal(bobStore.accounts.length, 1);
    assert.equal(bobStore.accounts[0].id, accountB.id);

    // Primary source connection helper
    const aliceConn = await store.getPrimarySourceConnection(userA);
    const bobConn = await store.getPrimarySourceConnection(userB);
    assert.equal(aliceConn.id, accountA.id);
    assert.equal(bobConn.id, accountB.id);

    // Messages do not leak across users
    assert.equal(aliceStore.messages.length, 1);
    assert.equal(aliceStore.messages[0].subject, "Alice top secret");
    assert.equal(bobStore.messages.length, 1);
    assert.equal(bobStore.messages[0].subject, "Bob private");

    // Feedback is per-user
    const aliceFeedback = aliceStore.feedback;
    const bobFeedback = bobStore.feedback;
    assert.equal(aliceFeedback.length, 1);
    assert.equal(aliceFeedback[0].messageId, `${accountA.id}:msg:a1`);
    assert.equal(bobFeedback.length, 1);
    assert.equal(bobFeedback[0].messageId, `${accountB.id}:msg:b1`);

    // AI runs and briefings are per-user
    const aliceRuns = await store.listAiRunsFor(userA, 10);
    const bobRuns = await store.listAiRunsFor(userB, 10);
    assert.equal(aliceRuns.length, 1);
    assert.equal(aliceRuns[0].id, "airun_alice");
    assert.equal(bobRuns.length, 1);
    assert.equal(bobRuns[0].id, "airun_bob");

    assert.equal(aliceStore.inboxBriefings.length, 1);
    assert.equal(aliceStore.inboxBriefings[0].text, "alice brief");
    assert.equal(bobStore.inboxBriefings.length, 1);
    assert.equal(bobStore.inboxBriefings[0].text, "bob brief");

    // Clearing user A's data leaves user B intact
    await store.clearUserData(userA);
    const aliceAfter = await store.readStoreFor(userA);
    const bobAfter = await store.readStoreFor(userB);
    assert.equal(aliceAfter.accounts.length, 0);
    assert.equal(aliceAfter.messages.length, 0);
    assert.equal(bobAfter.accounts.length, 1);
    assert.equal(bobAfter.messages.length, 1);
  } finally {
    delete process.env.DATA_DIR;
    delete process.env.STORE_DRIVER;
    delete process.env.APP_SECRET;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("readStoreFor and clearUserData both require a userId", async () => {
  const store = await import("../apps/api/src/store.mjs");
  await assert.rejects(() => store.readStoreFor(), /userId/);
  await assert.rejects(() => store.clearUserData(), /userId/);
  await assert.rejects(() => store.ensureUserRecord(), /userId/);
  await assert.rejects(() => store.getPrimarySourceConnection(), /userId/);
});

test("saveOAuthState requires userId and consumeOAuthState returns it", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sanemail-oauth-state-"));
  process.env.DATA_DIR = dataDir;
  process.env.STORE_DRIVER = "json";

  try {
    const store = await import(
      `../apps/api/src/store.mjs?oauth-state=${encodeURIComponent(dataDir)}`
    );
    await store.clearLocalData();

    await assert.rejects(() => store.saveOAuthState("state-1"), /userId/);

    await store.saveOAuthState("state-2", "user-x");
    const consumed = await store.consumeOAuthState("state-2");
    assert.equal(consumed.ok, true);
    assert.equal(consumed.userId, "user-x");

    const reused = await store.consumeOAuthState("state-2");
    assert.equal(reused.ok, false);
    assert.equal(reused.userId, null);
  } finally {
    delete process.env.DATA_DIR;
    delete process.env.STORE_DRIVER;
    await rm(dataDir, { recursive: true, force: true });
  }
});
