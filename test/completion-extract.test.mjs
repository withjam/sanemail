import assert from "node:assert/strict";
import test from "node:test";
import { extractCompletionEvents } from "../apps/api/src/completion-extract.mjs";
import { buildHomeTabs } from "../apps/api/src/server.mjs";

const at = new Date(Date.now() - 60 * 60 * 1000).toISOString();

test("extractCompletionEvents detects common completion phrases", () => {
  const text = "Good news — your check has cleared and the payment was posted.";
  const events = extractCompletionEvents(text, at);
  assert.ok(events.some((e) => e.phrase === "Check cleared"));
  assert.ok(events.some((e) => e.phrase === "Payment posted"));
  assert.equal(events.every((e) => e.occurredAt === new Date(at).toISOString()), true);
});

test("buildHomeTabs includes completed tab for recent completion signals", () => {
  const decisions = new Map([
    [
      "m1",
      {
        messageId: "m1",
        extracted: {
          completions: [{ phrase: "Package delivered", occurredAt: at }],
        },
      },
    ],
  ]);
  const messages = [
    {
      id: "m1",
      subject: "Delivered",
      date: at,
      sane: { possibleJunk: false, needsReply: false, todayScore: 10 },
    },
  ];
  const tabs = buildHomeTabs(messages, decisions);
  assert.equal(tabs.completed.length, 1);
  assert.equal(tabs.completed[0].id, "m1");
});
