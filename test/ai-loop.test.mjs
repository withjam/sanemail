import assert from "node:assert/strict";
import test from "node:test";
import { buildDemoMessages, DEMO_MESSAGE_COUNT } from "../apps/api/src/demo-data.mjs";
import { getAiEvalRecords } from "../apps/api/src/ai/evals.mjs";
import {
  evaluateGoldenPromptRecords,
  getGoldenPreviousBriefing,
  getGoldenPromptRecords,
} from "../apps/api/src/ai/golden-records.mjs";
import {
  buildBriefingContextForDecisions,
  runAiLoopOnMessages,
  selectMessagesForBriefing,
} from "../apps/api/src/ai/pipeline.mjs";
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
  const ollamaBoundPrompts = getPromptRecords({
    "mail-triage": {
      provider: "ollama",
      model: "deepseek-v4-pro:cloud",
      temperature: 0,
    },
  });
  const triage = prompts.find((prompt) => prompt.id === "mail-triage");
  const triageOllama = ollamaBoundPrompts.find((prompt) => prompt.id === "mail-triage");
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
  assert.match(triage.promptHash, /^[a-f0-9]{64}$/);
  assert.match(triage.modelBindingHash, /^[a-f0-9]{64}$/);
  assert.match(triage.contractHash, /^[a-f0-9]{64}$/);
  assert.equal(rendered.hash, triage.hash);
  assert.equal(rendered.contractHash, triage.contractHash);
  assert.equal(triageOllama.promptHash, triage.promptHash);
  assert.notEqual(triageOllama.modelBindingHash, triage.modelBindingHash);
  assert.notEqual(triageOllama.contractHash, triage.contractHash);
  assert.match(rendered.user, /Could you review this/);
});

test("eval registry covers every prompt contract", () => {
  const promptIds = getPromptRecords().map((prompt) => prompt.id);
  const evals = getAiEvalRecords();

  for (const promptId of promptIds) {
    assert.equal(
      evals.some((evalRecord) => evalRecord.promptIds.includes(promptId)),
      true,
      `${promptId} should have at least one eval`,
    );
  }
});

test("AI loop creates instrumented decisions over synthetic mail", () => {
  const messages = buildDemoMessages(account);
  const run = runAiLoopOnMessages({ account, messages, trigger: "test" });
  const decisions = new Map(run.output.decisions.map((decision) => [decision.messageId, decision]));
  const lease = decisions.get("gmail:demo@example.com:message:demo-lease-review");
  const scam = decisions.get("gmail:demo@example.com:message:demo-security-scam");

  assert.equal(run.status, "succeeded");
  assert.equal(run.metrics.messagesProcessed, DEMO_MESSAGE_COUNT);
  assert.equal(run.promptRefs.some((prompt) => prompt.id === "mail-message-classification"), true);
  assert.match(run.output.briefing.text, /mostly calm/);
  assert.match(run.output.briefing.text, /need your attention/i);
  assert.doesNotMatch(
    run.output.briefing.text,
    /visible messages|automated updates|previous briefing|carry forward|suspicious/i,
  );
  assert.equal(run.output.briefing.prompt.id, "mail-briefing-prose");
  assert.equal(run.output.briefing.counts.recent, 7);
  assert.equal(run.output.briefing.counts.last7Days, 75);
  assert.equal(run.output.briefing.callouts.length, 4);
  assert.equal(run.output.briefing.callouts[0].messageId, "gmail:demo@example.com:message:demo-lease-review");
  assert.equal(run.output.briefing.callouts[0].kind, "new_attention");
  assert.equal(run.output.briefing.callouts[0].label, "Needs attention");
  assert.equal(run.spans.some((span) => span.name === "model.mock_inference"), true);
  assert.equal(lease.category, "Needs Reply");
  assert.equal(lease.extracted.actions.includes("review"), true);
  assert.equal(lease.extracted.deadlines.includes("tomorrow afternoon"), true);
  assert.equal(scam.category, "Junk Review");
  assert.equal(scam.possibleJunk, true);
  assert.equal(run.output.topTodayMessageIds.includes(scam.messageId), false);
});

test("golden aggregate prompt records evaluate day summary and category breakdown", () => {
  const messages = buildDemoMessages(account);
  const run = runAiLoopOnMessages({ account, messages, trigger: "test" });
  const carryOverRun = runAiLoopOnMessages({
    account,
    messages,
    previousBriefing: getGoldenPreviousBriefing(),
    trigger: "test",
  });
  const records = getGoldenPromptRecords();
  const cases = evaluateGoldenPromptRecords(run, { carryOverRun });

  assert.deepEqual(
    records.map((record) => record.id),
    [
      "golden-day-summary-v1",
      "golden-day-summary-carryover-v1",
      "golden-category-breakdown-v1",
    ],
  );
  assert.equal(records.every((record) => /^[a-f0-9]{64}$/.test(record.hash)), true);
  assert.equal(cases.length, 3);
  assert.equal(cases.every((testCase) => testCase.passed), true);
  assert.match(carryOverRun.output.briefing.text, /mostly calm/);
  assert.doesNotMatch(carryOverRun.output.briefing.text, /previous briefing|carry forward/i);
  assert.equal(carryOverRun.output.briefing.counts.carriedOver, 2);
  assert.equal(carryOverRun.output.briefing.callouts.length, 4);
  assert.equal(carryOverRun.output.briefing.callouts[0].kind, "carry_over");
  assert.equal(carryOverRun.output.briefing.callouts[0].label, "Needs attention");
});

test("iterative briefing selects new messages plus unresolved previous callouts", () => {
  const baseTime = new Date("2026-05-03T16:00:00.000Z").getTime();
  const messages = buildDemoMessages(account, baseTime);
  const previousBriefing = {
    id: "brief_previous",
    generatedAt: new Date(baseTime - 2 * 60 * 60 * 1000).toISOString(),
    messageIds: [
      "gmail:demo@example.com:message:demo-school-form",
      "gmail:demo@example.com:message:golden-action-01-b",
    ],
    callouts: [
      {
        id: "callout-demo-school-form",
        messageId: "gmail:demo@example.com:message:demo-school-form",
        messageIds: ["gmail:demo@example.com:message:demo-school-form"],
      },
      {
        id: "callout-golden-action-01-b",
        messageId: "gmail:demo@example.com:message:golden-action-01-b",
        messageIds: ["gmail:demo@example.com:message:golden-action-01-b"],
      },
    ],
  };
  const feedback = [
    {
      id: "feedback-done",
      messageId: "gmail:demo@example.com:message:golden-action-01-b",
      kind: "done",
      createdAt: new Date(baseTime - 30 * 60 * 1000).toISOString(),
    },
  ];
  const selection = selectMessagesForBriefing({
    messages,
    feedback,
    previousBriefing,
    mode: "iterative",
    limit: 12,
  });

  assert.equal(selection.mode, "iterative");
  assert.equal(selection.since, previousBriefing.generatedAt);
  assert.equal(
    selection.selected.some((message) => message.id === "gmail:demo@example.com:message:demo-lease-review"),
    true,
  );
  assert.equal(
    selection.selected.some((message) => message.id === "gmail:demo@example.com:message:demo-school-form"),
    true,
  );
  assert.equal(
    selection.selected.some((message) => message.id === "gmail:demo@example.com:message:golden-action-01-b"),
    false,
  );
  assert.deepEqual(selection.resolvedPreviousMessageIds, [
    "gmail:demo@example.com:message:golden-action-01-b",
  ]);
});

test("daily brief cold-start context stays bounded while scoring hundreds of messages", () => {
  // Anchor relative to "now" so the recency window (24h for `recent`, 168h for
  // `last7Days`) keeps every fixture message in-window regardless of when the
  // test is run. A hardcoded date used to work, then rotted as the wall clock
  // moved past it.
  const baseTime = Date.now();
  const messages = Array.from({ length: 220 }, (_item, index) => ({
    id: `${account.id}:message:bulk-${index}`,
    accountId: account.id,
    provider: "gmail",
    threadId: `${account.id}:thread:bulk-${index}`,
    subject: `Please review contract ${index}`,
    from: `Alex ${index} <alex${index}@example.com>`,
    to: account.email,
    date: new Date(baseTime - index * 60 * 1000).toISOString(),
    internalDate: String(baseTime - index * 60 * 1000),
    snippet: "Could you review this today?",
    bodyText: "Could you review this today and let me know your thoughts?",
    sourceLabels: ["INBOX"],
    headers: { to: account.email },
  }));
  const run = runAiLoopOnMessages({
    account,
    messages,
    trigger: "test",
    kind: "daily-brief",
  });
  const context = buildBriefingContextForDecisions(
    run.output.decisions,
    null,
    run.output.briefing.memory,
  );

  assert.equal(run.metrics.messagesProcessed, 220);
  assert.equal(context.processingSummary.selectedMessages, 220);
  assert.equal(context.recentMessages.length, 80);
  assert.equal(context.attentionCandidates.length, 48);
  assert.equal(context.upcomingCandidates.length, 40);
  assert.equal(context.processingSummary.omitted.recentMessages > 0, true);
  assert.equal(context.processingSummary.omitted.attentionCandidates > 0, true);
});

test("classification batch runs do not write a daily briefing", () => {
  const messages = buildDemoMessages(account).slice(0, 12);
  const run = runAiLoopOnMessages({
    account,
    messages,
    trigger: "test:classification.batch",
    kind: "classification-batch",
    includeBriefing: false,
  });

  assert.equal(run.kind, "classification-batch");
  assert.equal(run.output.briefing, undefined);
  assert.equal(run.output.decisions.length, 12);
});

test("done feedback removes a previous briefing item from carry-over attention", () => {
  const messages = buildDemoMessages(account);
  const previousBriefing = {
    ...getGoldenPreviousBriefing(),
    callouts: [
      {
        id: "callout-demo-lease-review",
        messageId: "gmail:demo@example.com:message:demo-lease-review",
        messageIds: ["gmail:demo@example.com:message:demo-lease-review"],
      },
      {
        id: "callout-golden-action-01-b",
        messageId: "gmail:demo@example.com:message:golden-action-01-b",
        messageIds: ["gmail:demo@example.com:message:golden-action-01-b"],
      },
    ],
  };
  const run = runAiLoopOnMessages({
    account,
    messages,
    feedback: [
      {
        id: "feedback-done",
        messageId: "gmail:demo@example.com:message:demo-lease-review",
        kind: "done",
        createdAt: new Date().toISOString(),
      },
    ],
    previousBriefing,
    trigger: "test",
  });
  const calloutIds = run.output.briefing.callouts.map((callout) => callout.messageId);
  const leaseDecision = run.output.decisions.find(
    (decision) => decision.messageId === "gmail:demo@example.com:message:demo-lease-review",
  );

  assert.equal(leaseDecision.needsReply, false);
  assert.equal(leaseDecision.feedback.addressed, true);
  assert.equal(calloutIds.includes("gmail:demo@example.com:message:demo-lease-review"), false);
  assert.equal(calloutIds[0], "gmail:demo@example.com:message:golden-action-01-b");
  assert.equal(run.output.briefing.counts.carriedOver, 1);
});

test("synthetic verification suite passes with the local AI loop", async () => {
  const run = await runSyntheticVerification({ persist: false });

  assert.equal(run.status, "passed");
  assert.equal(run.summary.cases, 15);
  assert.equal(run.summary.failedCases, 0);
  assert.equal(run.score, 1);
});
