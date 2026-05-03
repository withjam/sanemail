import { DEMO_MESSAGE_COUNT } from "../demo-data.mjs";
import { hashValue } from "./prompts.mjs";

export const GOLDEN_FEATURE_SET_ID = "synthetic-golden-mailbox-v1";

const goldenRecords = [
  {
    id: "golden-day-summary-v1",
    featureSetId: GOLDEN_FEATURE_SET_ID,
    promptIds: ["mail-briefing"],
    title: "Summarize the day",
    description:
      "Aggregate the synthetic mailbox into the homepage briefing paragraph.",
    input: {
      messageCount: DEMO_MESSAGE_COUNT,
      expectedTopReplySubjects: [
        "Can you review the lease renewal today?",
        "Please sign the school trip form",
        "Dinner this weekend?",
      ],
      expectedTopUpcomingSubjects: [
        "Can you review the lease renewal today?",
        "Please sign the school trip form",
      ],
      expectedInformationalSubjects: [
        "Flight check-in opens tomorrow",
        "Your monthly bank statement is ready",
        "Package delivered",
      ],
    },
    expected: {
      text:
        "Your inbox is mostly calm. I would open Can you review the lease renewal today, Please sign the school trip form, Dinner this weekend, and Re: Contractor estimate for the porch first; those are the items most likely to need your attention right now.",
      narrative: {
        status:
          "Your inbox is mostly calm. I would open Can you review the lease renewal today, Please sign the school trip form, Dinner this weekend, and Re: Contractor estimate for the porch first; those are the items most likely to need your attention right now.",
        needToKnow: "",
        mightBeMissing: "",
        needsAttention: "",
      },
      callouts: [
        {
          kind: "new_attention",
          label: "Need attention",
          title: "Can you review the lease renewal today",
          body:
            "Maya Chen appears to need a review. Time cue: tomorrow afternoon.",
          messageId: "gmail:demo@example.com:message:demo-lease-review",
        },
        {
          kind: "new_attention",
          label: "Need attention",
          title: "Please sign the school trip form",
          body:
            "Jordan Rivera appears to need a signature. Time cue: by Friday.",
          messageId: "gmail:demo@example.com:message:demo-school-form",
        },
        {
          kind: "new_attention",
          label: "Need attention",
          title: "Dinner this weekend",
          body:
            "Alex Morgan appears to need a reply. Time cue: Saturday evening.",
          messageId: "gmail:demo@example.com:message:demo-dinner",
        },
        {
          kind: "new_attention",
          label: "Need attention",
          title: "Re: Contractor estimate for the porch",
          body:
            "Nina Patel appears to need a review. Time cue: by Monday.",
          messageId: "gmail:demo@example.com:message:golden-action-01-b",
        },
      ],
      counts: {
        visible: 177,
        recent: 7,
        last7Days: 75,
        needsReply: 26,
        needsReplyLast7: 21,
        upcoming: 57,
        informational: 109,
        hidden: 23,
        carriedOver: 0,
      },
      messageIds: [
        "gmail:demo@example.com:message:demo-lease-review",
        "gmail:demo@example.com:message:demo-school-form",
        "gmail:demo@example.com:message:demo-dinner",
        "gmail:demo@example.com:message:golden-action-01-b",
        "gmail:demo@example.com:message:golden-action-02-b",
        "gmail:demo@example.com:message:golden-action-03-b",
        "gmail:demo@example.com:message:golden-action-04-b",
        "gmail:demo@example.com:message:golden-action-05-b",
      ],
      carryOver: {
        previousBriefingId: null,
        previousGeneratedAt: null,
        messageIds: [],
        subjects: [],
      },
      requiredPhrases: [
        "Your inbox is mostly calm",
        "need your attention",
        "Can you review the lease renewal today",
        "Please sign the school trip form",
        "Dinner this weekend",
        "Re: Contractor estimate for the porch",
      ],
      forbiddenPhrases: [
        "gift card winner",
        "Verify your account immediately",
        "password expires",
        "visible messages",
        "automated updates",
        "previous briefing",
        "carry forward",
        "suspicious",
      ],
    },
  },
  {
    id: "golden-day-summary-carryover-v1",
    featureSetId: GOLDEN_FEATURE_SET_ID,
    promptIds: ["mail-briefing"],
    title: "Summarize the day with prior context",
    description:
      "Aggregate the synthetic mailbox while carrying still-relevant reminders from the previous briefing.",
    input: {
      messageCount: DEMO_MESSAGE_COUNT,
      previousBriefing: {
        id: "brief_golden_previous",
        generatedAt: "2026-05-03T00:00:00.000Z",
        messageIds: [
          "gmail:demo@example.com:message:demo-lease-review",
          "gmail:demo@example.com:message:golden-action-01-b",
        ],
      },
    },
    expected: {
      text:
        "Your inbox is mostly calm. I would open Can you review the lease renewal today, Re: Contractor estimate for the porch, Please sign the school trip form, and Dinner this weekend first; those are the items most likely to need your attention right now.",
      narrative: {
        status:
          "Your inbox is mostly calm. I would open Can you review the lease renewal today, Re: Contractor estimate for the porch, Please sign the school trip form, and Dinner this weekend first; those are the items most likely to need your attention right now.",
        needToKnow: "",
        mightBeMissing: "",
        needsAttention: "",
      },
      callouts: [
        {
          kind: "carry_over",
          label: "Need attention",
          title: "Can you review the lease renewal today",
          body:
            "Maya Chen appears to need a review. Time cue: tomorrow afternoon.",
          messageId: "gmail:demo@example.com:message:demo-lease-review",
        },
        {
          kind: "carry_over",
          label: "Need attention",
          title: "Re: Contractor estimate for the porch",
          body:
            "Nina Patel appears to need a review. Time cue: by Monday.",
          messageId: "gmail:demo@example.com:message:golden-action-01-b",
        },
        {
          kind: "new_attention",
          label: "Need attention",
          title: "Please sign the school trip form",
          body:
            "Jordan Rivera appears to need a signature. Time cue: by Friday.",
          messageId: "gmail:demo@example.com:message:demo-school-form",
        },
        {
          kind: "new_attention",
          label: "Need attention",
          title: "Dinner this weekend",
          body:
            "Alex Morgan appears to need a reply. Time cue: Saturday evening.",
          messageId: "gmail:demo@example.com:message:demo-dinner",
        },
      ],
      counts: {
        visible: 177,
        recent: 7,
        last7Days: 75,
        needsReply: 26,
        needsReplyLast7: 21,
        upcoming: 57,
        informational: 109,
        hidden: 23,
        carriedOver: 2,
      },
      messageIds: [
        "gmail:demo@example.com:message:demo-lease-review",
        "gmail:demo@example.com:message:demo-school-form",
        "gmail:demo@example.com:message:demo-dinner",
        "gmail:demo@example.com:message:golden-action-01-b",
        "gmail:demo@example.com:message:golden-action-02-b",
        "gmail:demo@example.com:message:golden-action-03-b",
        "gmail:demo@example.com:message:golden-action-04-b",
        "gmail:demo@example.com:message:golden-action-05-b",
      ],
      carryOver: {
        previousBriefingId: "brief_golden_previous",
        previousGeneratedAt: "2026-05-03T00:00:00.000Z",
        messageIds: [
          "gmail:demo@example.com:message:demo-lease-review",
          "gmail:demo@example.com:message:golden-action-01-b",
        ],
        subjects: [
          "Can you review the lease renewal today",
          "Re: Contractor estimate for the porch",
        ],
      },
      requiredPhrases: [
        "Your inbox is mostly calm",
        "need your attention",
        "Can you review the lease renewal today",
        "Re: Contractor estimate for the porch",
        "Please sign the school trip form",
        "Dinner this weekend",
      ],
      forbiddenPhrases: [
        "gift card winner",
        "Verify your account immediately",
        "password expires",
        "visible messages",
        "automated updates",
        "previous briefing",
        "carry forward",
        "suspicious",
      ],
    },
  },
  {
    id: "golden-category-breakdown-v1",
    featureSetId: GOLDEN_FEATURE_SET_ID,
    promptIds: ["mail-triage", "mail-rank"],
    title: "Category breakdown",
    description:
      "Aggregate per-message prompt decisions into the SaneMail category model.",
    input: {
      messageCount: DEMO_MESSAGE_COUNT,
      categoryOrder: ["Needs Reply", "Today", "FYI", "Junk Review", "All Mail"],
      anchorMessageIds: [
        "gmail:demo@example.com:message:demo-lease-review",
        "gmail:demo@example.com:message:demo-flight",
        "gmail:demo@example.com:message:demo-security-scam",
        "gmail:demo@example.com:message:demo-newsletter",
        "gmail:demo@example.com:message:golden-friendly-01-a",
      ],
    },
    expected: {
      totalMessages: DEMO_MESSAGE_COUNT,
      visibleMessages: 177,
      hiddenMessages: 23,
      categoryCounts: {
        "Needs Reply": 26,
        Today: 5,
        FYI: 109,
        "Junk Review": 23,
        "All Mail": 37,
      },
      anchors: {
        "gmail:demo@example.com:message:demo-lease-review": {
          category: "Needs Reply",
          needsReply: true,
          possibleJunk: false,
        },
        "gmail:demo@example.com:message:demo-flight": {
          category: "FYI",
          automated: true,
          possibleJunk: false,
        },
        "gmail:demo@example.com:message:demo-security-scam": {
          category: "Junk Review",
          possibleJunk: true,
        },
        "gmail:demo@example.com:message:demo-newsletter": {
          category: "FYI",
          automated: true,
        },
        "gmail:demo@example.com:message:golden-friendly-01-a": {
          category: "All Mail",
          possibleJunk: false,
        },
      },
    },
  },
];

function withHash(record) {
  return {
    ...record,
    hash: hashValue({
      id: record.id,
      featureSetId: record.featureSetId,
      promptIds: record.promptIds,
      input: record.input,
      expected: record.expected,
    }),
  };
}

function sameJson(actual, expected) {
  if (actual === undefined || expected === undefined) return actual === expected;
  return hashValue(actual) === hashValue(expected);
}

function includesNormalized(value, expected) {
  return String(value || "").toLowerCase().includes(String(expected || "").toLowerCase());
}

function check(name, expected, actual, passed = actual === expected) {
  return { name, expected, actual, passed };
}

function normalizedCallouts(callouts = []) {
  return callouts.map((callout) => ({
    kind: callout.kind,
    label: callout.label,
    title: callout.title,
    body: callout.body,
    messageId: callout.messageId,
  }));
}

function evaluateDaySummary(record, aiRun) {
  const briefing = aiRun.output.briefing;
  const expected = record.expected;
  const text = briefing?.text || "";
  const checks = [
    check("text", expected.text, text),
    ...(expected.narrative
      ? [
          check(
            "narrative",
            expected.narrative,
            briefing?.narrative,
            sameJson(briefing?.narrative, expected.narrative),
          ),
        ]
      : []),
    ...(expected.callouts
      ? [
          check(
            "callouts",
            expected.callouts,
            normalizedCallouts(briefing?.callouts),
            sameJson(normalizedCallouts(briefing?.callouts), expected.callouts),
          ),
        ]
      : []),
    check("counts", expected.counts, briefing?.counts, sameJson(briefing?.counts, expected.counts)),
    check(
      "messageIds",
      expected.messageIds,
      briefing?.messageIds || [],
      sameJson(briefing?.messageIds || [], expected.messageIds),
    ),
    ...(expected.carryOver
      ? [
          check(
            "carryOver",
            expected.carryOver,
            briefing?.carryOver,
            sameJson(briefing?.carryOver, expected.carryOver),
          ),
        ]
      : []),
    ...expected.requiredPhrases.map((phrase) =>
      check(`requiredPhrase:${phrase}`, true, includesNormalized(text, phrase)),
    ),
    ...expected.forbiddenPhrases.map((phrase) =>
      check(`forbiddenPhrase:${phrase}`, false, includesNormalized(text, phrase)),
    ),
  ];

  return {
    id: record.id,
    messageId: record.featureSetId,
    description: record.description,
    passed: checks.every((item) => item.passed),
    checks,
  };
}

function evaluateCategoryBreakdown(record, aiRun) {
  const expected = record.expected;
  const decisionsById = new Map(
    aiRun.output.decisions.map((decision) => [decision.messageId, decision]),
  );
  const categoryCounts = aiRun.metrics.categoryCounts || {};
  const visibleMessages = aiRun.output.decisions.filter((decision) => !decision.possibleJunk).length;
  const hiddenMessages = aiRun.output.decisions.filter((decision) => decision.possibleJunk).length;
  const anchorChecks = Object.entries(expected.anchors).flatMap(([messageId, anchor]) => {
    const decision = decisionsById.get(messageId);
    return Object.entries(anchor).map(([key, value]) =>
      check(`anchor:${messageId}:${key}`, value, decision?.[key]),
    );
  });
  const checks = [
    check("totalMessages", expected.totalMessages, aiRun.metrics.messagesProcessed),
    check("visibleMessages", expected.visibleMessages, visibleMessages),
    check("hiddenMessages", expected.hiddenMessages, hiddenMessages),
    check("categoryCounts", expected.categoryCounts, categoryCounts, sameJson(categoryCounts, expected.categoryCounts)),
    ...anchorChecks,
  ];

  return {
    id: record.id,
    messageId: record.featureSetId,
    description: record.description,
    passed: checks.every((item) => item.passed),
    checks,
  };
}

export function getGoldenPromptRecords() {
  return goldenRecords.map(withHash);
}

export function getGoldenPreviousBriefing() {
  const record = goldenRecords.find((item) => item.id === "golden-day-summary-carryover-v1");
  return {
    ...record.input.previousBriefing,
    text: "Previous briefing kept these reminders in view.",
    counts: {},
  };
}

export function evaluateGoldenPromptRecords(aiRun, { carryOverRun = aiRun } = {}) {
  return getGoldenPromptRecords().map((record) => {
    if (record.id === "golden-day-summary-v1") return evaluateDaySummary(record, aiRun);
    if (record.id === "golden-day-summary-carryover-v1") {
      return evaluateDaySummary(record, carryOverRun);
    }
    if (record.id === "golden-category-breakdown-v1") return evaluateCategoryBreakdown(record, aiRun);
    throw new Error(`Unknown golden prompt record: ${record.id}`);
  });
}
