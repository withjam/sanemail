import assert from "node:assert/strict";
import test from "node:test";
import { classifyMessage } from "../apps/api/src/classifier.mjs";
import { buildDemoMessages, DEMO_MESSAGE_COUNT } from "../apps/api/src/demo-data.mjs";

const account = {
  id: "gmail:demo@example.com",
  provider: "gmail",
  email: "demo@example.com",
  demo: true,
};

test("builds a deterministic 200-message golden demo mailbox", () => {
  const messages = buildDemoMessages(account);
  const ids = new Set(messages.map((message) => message.id));
  const threads = new Set(messages.map((message) => message.providerThreadId));
  const subjects = new Set(messages.map((message) => message.subject));
  const listMessages = messages.filter((message) => message.headers["list-unsubscribe"]);
  const spamMessages = messages.filter((message) => message.sourceLabels.includes("SPAM"));

  assert.equal(messages.length, DEMO_MESSAGE_COUNT);
  assert.equal(ids.size, DEMO_MESSAGE_COUNT);
  assert.equal(threads.size < messages.length, true);
  assert.equal(subjects.has("Can you review the lease renewal today?"), true);
  assert.equal(subjects.has("Flight check-in opens tomorrow"), true);
  assert.equal(subjects.has("Verify your account immediately"), true);
  assert.equal(listMessages.length >= 80, true);
  assert.equal(spamMessages.length >= 20, true);
});

test("golden demo mailbox covers major classifier paths", () => {
  const counts = buildDemoMessages(account).reduce((result, message) => {
    const classification = classifyMessage(message, account);
    result[classification.category] = (result[classification.category] || 0) + 1;
    return result;
  }, {});

  assert.equal(counts["Needs Reply"] >= 20, true);
  assert.equal(counts.FYI >= 80, true);
  assert.equal(counts["Junk Review"] >= 20, true);
  assert.equal(counts["All Mail"] >= 20, true);
});
