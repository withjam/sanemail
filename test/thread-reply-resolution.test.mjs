import test from "node:test";
import assert from "node:assert/strict";
import { buildThreadReplyResolvedMessageIds } from "../apps/api/src/ai/pipeline.mjs";

const account = { id: "acct1", email: "me@example.com" };

test("buildThreadReplyResolvedMessageIds marks inbound before later sent in same thread", () => {
  const messages = [
    {
      id: "m-in",
      accountId: "acct1",
      providerThreadId: "t1",
      sourceLabels: ["INBOX"],
      from: "Other <o@example.com>",
      date: "2026-01-01T10:00:00.000Z",
    },
    {
      id: "m-sent",
      accountId: "acct1",
      providerThreadId: "t1",
      sourceLabels: ["SENT"],
      from: "me@example.com",
      date: "2026-01-01T11:00:00.000Z",
    },
  ];
  const resolved = buildThreadReplyResolvedMessageIds(messages, account);
  assert.ok(resolved.has("m-in"));
  assert.ok(!resolved.has("m-sent"));
});

test("buildThreadReplyResolvedMessageIds ignores empty thread id", () => {
  const messages = [
    {
      id: "m1",
      accountId: "acct1",
      providerThreadId: "",
      sourceLabels: ["INBOX"],
      from: "Other <o@example.com>",
      date: "2026-01-01T10:00:00.000Z",
    },
    {
      id: "m2",
      accountId: "acct1",
      providerThreadId: "",
      sourceLabels: ["SENT"],
      from: "me@example.com",
      date: "2026-01-01T11:00:00.000Z",
    },
  ];
  const resolved = buildThreadReplyResolvedMessageIds(messages, account);
  assert.equal(resolved.size, 0);
});
