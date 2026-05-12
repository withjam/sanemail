import assert from "node:assert/strict";
import test from "node:test";
import { getClassifiedMessages } from "../apps/api/src/classifier.mjs";

test("getClassifiedMessages with null account includes every connected source", () => {
  const a1 = { id: "gmail:a@example.com", provider: "gmail", email: "a@example.com" };
  const a2 = { id: "gmail:b@example.com", provider: "gmail", email: "b@example.com" };
  const now = new Date().toISOString();
  const store = {
    accounts: [a1, a2],
    messages: [
      {
        id: "gmail:a@example.com:message:m1",
        accountId: a1.id,
        subject: "Only primary before fix",
        from: "Sender <s@example.com>",
        to: "a@example.com",
        date: now,
        bodyText: "Body A",
        sourceLabels: ["INBOX"],
        headers: { from: "Sender <s@example.com>", to: "a@example.com", cc: "" },
      },
      {
        id: "gmail:b@example.com:message:m2",
        accountId: a2.id,
        subject: "Second mailbox",
        from: "Other <o@example.com>",
        to: "b@example.com",
        date: now,
        bodyText: "Body B",
        sourceLabels: ["INBOX"],
        headers: { from: "Other <o@example.com>", to: "b@example.com", cc: "" },
      },
    ],
    feedback: [],
  };

  const primaryOnly = getClassifiedMessages(store, a1);
  assert.equal(primaryOnly.length, 1);
  assert.equal(primaryOnly[0].subject, "Only primary before fix");

  const combined = getClassifiedMessages(store, null);
  assert.equal(combined.length, 2);
  const subjects = new Set(combined.map((m) => m.subject));
  assert.ok(subjects.has("Only primary before fix"));
  assert.ok(subjects.has("Second mailbox"));
});
