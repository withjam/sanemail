import assert from "node:assert/strict";
import test from "node:test";
import { buildDemoMessages } from "../apps/api/src/demo-data.mjs";
import { runAiLoopOnMessages } from "../apps/api/src/ai/pipeline.mjs";
import { getPromptRecords, renderPrompt } from "../apps/api/src/ai/prompts.mjs";
import { runSyntheticVerification } from "../apps/api/src/ai/verification.mjs";

const account = {
  id: "gmail:demo@example.com",
  provider: "gmail",
  email: "demo@example.com",
  demo: true,
};

test("prompt registry exposes stable prompt hashes and rendering", () => {
  const prompts = getPromptRecords();
  const triage = prompts.find((prompt) => prompt.id === "mail-triage");
  const rendered = renderPrompt("mail-triage", {
    subject: "Hello",
    from: "Alex <alex@example.com>",
    to: "demo@example.com",
    labels: ["INBOX"],
    snippet: "Could you review this?",
    bodyText: "Could you review this?",
  });

  assert.ok(triage);
  assert.match(triage.hash, /^[a-f0-9]{64}$/);
  assert.equal(rendered.hash, triage.hash);
  assert.match(rendered.user, /Could you review this/);
});

test("AI loop creates instrumented decisions over synthetic mail", () => {
  const messages = buildDemoMessages(account);
  const run = runAiLoopOnMessages({ account, messages, trigger: "test" });
  const decisions = new Map(run.output.decisions.map((decision) => [decision.messageId, decision]));
  const lease = decisions.get("gmail:demo@example.com:message:demo-lease-review");
  const scam = decisions.get("gmail:demo@example.com:message:demo-security-scam");

  assert.equal(run.status, "succeeded");
  assert.equal(run.metrics.messagesProcessed, 12);
  assert.equal(run.promptRefs.length, 3);
  assert.equal(run.spans.some((span) => span.name === "model.mock_inference"), true);
  assert.equal(lease.category, "Needs Reply");
  assert.equal(lease.extracted.actions.includes("review"), true);
  assert.equal(lease.extracted.deadlines.includes("tomorrow afternoon"), true);
  assert.equal(scam.category, "Junk Review");
  assert.equal(scam.possibleJunk, true);
  assert.equal(run.output.topTodayMessageIds.includes(scam.messageId), false);
});

test("synthetic verification suite passes with the local AI loop", async () => {
  const run = await runSyntheticVerification({ persist: false });

  assert.equal(run.status, "passed");
  assert.equal(run.summary.failedCases, 0);
  assert.equal(run.score, 1);
});
