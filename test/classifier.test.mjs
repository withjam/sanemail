import assert from "node:assert/strict";
import test from "node:test";
import { applyFeedbackToClassification, classifyMessage } from "../apps/api/src/classifier.mjs";

const account = { email: "me@example.com" };

function message(overrides = {}) {
  return {
    subject: "Hello",
    from: "Alex <alex@example.com>",
    to: "me@example.com",
    date: new Date().toISOString(),
    snippet: "",
    bodyText: "",
    sourceLabels: ["INBOX"],
    headers: {
      from: "Alex <alex@example.com>",
      to: "me@example.com",
      cc: "",
      "list-unsubscribe": "",
    },
    ...overrides,
  };
}

test("classifies direct action language as needing reply", () => {
  const result = classifyMessage(
    message({
      subject: "Can you review this?",
      bodyText: "Could you review this and let me know your thoughts?",
    }),
    account,
  );

  assert.equal(result.category, "Needs Reply");
  assert.equal(result.needsReply, true);
  assert.equal(result.direct, true);
});

test("keeps automated list mail out of Today", () => {
  const result = classifyMessage(
    message({
      subject: "Monthly account update",
      from: "Updates <updates@example.com>",
      headers: {
        from: "Updates <updates@example.com>",
        to: "me@example.com",
        cc: "",
        "list-unsubscribe": "<mailto:unsubscribe@example.com>",
      },
    }),
    account,
  );

  assert.equal(result.category, "FYI");
  assert.equal(result.automated, true);
  assert.equal(result.needsReply, false);
});

test("routes scam-like mail to junk review", () => {
  const result = classifyMessage(
    message({
      subject: "Verify your account immediately",
      from: "Security Alert <security-alert@example-login.test>",
      bodyText: "Urgent action required. Your password expires today.",
    }),
    account,
  );

  assert.equal(result.category, "Junk Review");
  assert.equal(result.possibleJunk, true);
});

test("done feedback clears an item from needing attention", () => {
  const initial = classifyMessage(
    message({
      subject: "Can you review this?",
      bodyText: "Could you review this and let me know your thoughts?",
    }),
    account,
  );
  const result = applyFeedbackToClassification(initial, [
    {
      id: "feedback-one",
      messageId: "message-one",
      kind: "done",
      createdAt: new Date().toISOString(),
    },
  ]);

  assert.equal(result.needsReply, false);
  assert.equal(result.category, "All Mail");
  assert.equal(result.feedbackState.addressed, true);
});
