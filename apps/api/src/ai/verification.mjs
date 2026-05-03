import crypto from "node:crypto";
import { buildDemoMessages } from "../demo-data.mjs";
import { saveVerificationRun } from "../store.mjs";
import {
  evaluateGoldenPromptRecords,
  getGoldenPreviousBriefing,
  getGoldenPromptRecords,
} from "./golden-records.mjs";
import { traceVerificationRun } from "./phoenix.mjs";
import { runAiLoopOnMessages } from "./pipeline.mjs";

const suite = {
  id: "synthetic-golden-mailbox-v1",
  title: "Synthetic personal golden mailbox",
  threshold: 1,
  cases: [
    {
      id: "lease-review-action",
      messageId: "gmail:demo@example.com:message:demo-lease-review",
      description: "Direct lease request should need a reply and expose a deadline.",
      expect: {
        category: "Needs Reply",
        needsReply: true,
        possibleJunk: false,
        actionIncludes: "review",
        deadlineIncludes: "tomorrow",
      },
    },
    {
      id: "school-form-action",
      messageId: "gmail:demo@example.com:message:demo-school-form",
      description: "School form should be treated as an action item.",
      expect: {
        category: "Needs Reply",
        needsReply: true,
        possibleJunk: false,
        actionIncludes: "sign",
        deadlineIncludes: "Friday",
      },
    },
    {
      id: "flight-automated",
      messageId: "gmail:demo@example.com:message:demo-flight",
      description: "Flight notification should be useful but automated.",
      expect: {
        category: "FYI",
        automated: true,
        needsReply: false,
        possibleJunk: false,
      },
    },
    {
      id: "security-scam",
      messageId: "gmail:demo@example.com:message:demo-security-scam",
      description: "Credential-themed urgent message should be routed to junk review.",
      expect: {
        category: "Junk Review",
        possibleJunk: true,
        needsReply: false,
      },
    },
    {
      id: "gift-card-spam",
      messageId: "gmail:demo@example.com:message:demo-gift-card",
      description: "SPAM-labeled gift card lure should stay out of Today.",
      expect: {
        category: "Junk Review",
        possibleJunk: true,
        suppressFromToday: true,
      },
    },
  ],
};

function includesNormalized(values, expected) {
  return values.some((value) => value.toLowerCase().includes(expected.toLowerCase()));
}

function evaluateCase(testCase, decision) {
  const checks = [];
  const expect = testCase.expect;

  for (const key of [
    "category",
    "needsReply",
    "possibleJunk",
    "automated",
    "suppressFromToday",
  ]) {
    if (key in expect) {
      checks.push({
        name: key,
        expected: expect[key],
        actual: decision?.[key],
        passed: decision?.[key] === expect[key],
      });
    }
  }

  if (expect.actionIncludes) {
    checks.push({
      name: "actionIncludes",
      expected: expect.actionIncludes,
      actual: decision?.extracted?.actions || [],
      passed: Boolean(decision && includesNormalized(decision.extracted.actions, expect.actionIncludes)),
    });
  }

  if (expect.deadlineIncludes) {
    checks.push({
      name: "deadlineIncludes",
      expected: expect.deadlineIncludes,
      actual: decision?.extracted?.deadlines || [],
      passed: Boolean(
        decision && includesNormalized(decision.extracted.deadlines, expect.deadlineIncludes),
      ),
    });
  }

  if (!decision) {
    checks.push({
      name: "decisionExists",
      expected: true,
      actual: false,
      passed: false,
    });
  }

  return {
    id: testCase.id,
    messageId: testCase.messageId,
    description: testCase.description,
    passed: checks.every((check) => check.passed),
    checks,
  };
}

export function getVerificationSuite() {
  return {
    ...suite,
    goldenRecords: getGoldenPromptRecords(),
  };
}

export async function runSyntheticVerification({ persist = false } = {}) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const account = {
    id: "gmail:demo@example.com",
    provider: "gmail",
    email: "demo@example.com",
    demo: true,
  };
  const messages = buildDemoMessages(account);
  const aiRun = runAiLoopOnMessages({
    account,
    messages,
    feedback: [],
    trigger: "verification",
  });
  const carryOverRun = runAiLoopOnMessages({
    account,
    messages,
    feedback: [],
    trigger: "verification",
    previousBriefing: getGoldenPreviousBriefing(),
  });
  const decisionsById = new Map(
    aiRun.output.decisions.map((decision) => [decision.messageId, decision]),
  );
  const cases = [
    ...suite.cases.map((testCase) => evaluateCase(testCase, decisionsById.get(testCase.messageId))),
    ...evaluateGoldenPromptRecords(aiRun, { carryOverRun }),
  ];
  const checks = cases.flatMap((testCase) => testCase.checks);
  const passedChecks = checks.filter((check) => check.passed).length;
  const score = checks.length ? Number((passedChecks / checks.length).toFixed(4)) : 0;
  const passedCases = cases.filter((testCase) => testCase.passed).length;
  const completedAt = new Date().toISOString();
  const run = {
    id: `aiver_${crypto.randomUUID()}`,
    suiteId: suite.id,
    suiteTitle: suite.title,
    status: score >= suite.threshold ? "passed" : "failed",
    threshold: suite.threshold,
    score,
    provider: aiRun.provider,
    promptRefs: aiRun.promptRefs,
    aiRunId: aiRun.id,
    summary: {
      cases: cases.length,
      passedCases,
      failedCases: cases.length - passedCases,
      checks: checks.length,
      passedChecks,
      failedChecks: checks.length - passedChecks,
    },
    cases,
    metrics: {
      latencyMs: Date.now() - started,
      aiLatencyMs: aiRun.metrics.latencyMs,
      messagesProcessed: aiRun.metrics.messagesProcessed,
    },
    startedAt,
    completedAt,
    createdAt: completedAt,
  };

  run.observability = await traceVerificationRun(run);

  if (persist) await saveVerificationRun(run);
  return run;
}
