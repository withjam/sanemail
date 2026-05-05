import { getGoldenPromptRecords } from "./golden-records.mjs";
import { getPromptRecords, hashValue } from "./prompts.mjs";

const promptEvalDefinitions = [
  {
    id: "mail-triage-classification-golden-v1",
    promptIds: ["mail-triage"],
    title: "Single-message triage classification",
    evaluator: "deterministic-assertions",
    checks: ["allowed category", "attention flags", "junk safety", "confidence range"],
  },
  {
    id: "mail-extract-action-golden-v1",
    promptIds: ["mail-extract"],
    title: "Action and deadline extraction",
    evaluator: "deterministic-assertions",
    checks: ["action cue recall", "deadline cue recall", "entity extraction shape"],
  },
  {
    id: "mail-rank-curation-golden-v1",
    promptIds: ["mail-rank"],
    title: "Today ranking and suppression",
    evaluator: "deterministic-assertions",
    checks: ["score range", "junk suppression", "automated suppression", "ranking reasons"],
  },
  {
    id: "mail-classification-batch-contract-v1",
    promptIds: ["mail-classification-batch"],
    title: "Batch classification contract",
    evaluator: "schema-and-contract-assertions",
    checks: [
      "recent-first batch input",
      "system category output",
      "dynamic message type assignments",
      "candidate type suggestions",
    ],
  },
  {
    id: "mail-briefing-golden-v1",
    promptIds: ["mail-briefing"],
    title: "Inbox briefing summary",
    evaluator: "golden-records",
    checks: ["required phrases", "forbidden phrases", "callout links", "counts", "carry-over"],
  },
];

function withHash(record) {
  return {
    ...record,
    hash: hashValue({
      id: record.id,
      promptIds: record.promptIds,
      evaluator: record.evaluator,
      checks: record.checks,
    }),
  };
}

function check(name, expected, actual, passed = actual === expected) {
  return { name, expected, actual, passed };
}

export function getAiEvalRecords() {
  return [
    ...promptEvalDefinitions,
    ...getGoldenPromptRecords().map((record) => ({
      id: record.id,
      promptIds: record.promptIds,
      title: record.title,
      evaluator: "golden-record",
      checks: ["expected output regression"],
      hash: record.hash,
    })),
  ].map((record) => (record.hash ? record : withHash(record)));
}

export function evaluatePromptContractCoverage(promptRefs = []) {
  const refsById = new Map(promptRefs.map((ref) => [ref.id, ref]));
  const evalsByPromptId = new Map();

  for (const evalRecord of getAiEvalRecords()) {
    for (const promptId of evalRecord.promptIds || []) {
      if (!evalsByPromptId.has(promptId)) evalsByPromptId.set(promptId, []);
      evalsByPromptId.get(promptId).push(evalRecord.id);
    }
  }

  return getPromptRecords().map((prompt) => {
    const ref = refsById.get(prompt.id);
    const evalIds = evalsByPromptId.get(prompt.id) || [];
    const checks = [
      check("promptRefExists", true, Boolean(ref)),
      check("promptHashRecorded", true, /^[a-f0-9]{64}$/.test(ref?.promptHash || ref?.hash || "")),
      check("modelBindingHashRecorded", true, /^[a-f0-9]{64}$/.test(ref?.modelBindingHash || "")),
      check("contractHashRecorded", true, /^[a-f0-9]{64}$/.test(ref?.contractHash || "")),
      check("modelBound", true, Boolean(ref?.provider && ref?.model && typeof ref?.temperature === "number")),
      check("evalCoverage", true, evalIds.length > 0),
    ];

    return {
      id: `prompt-contract-${prompt.id}`,
      messageId: `prompt:${prompt.id}`,
      promptId: prompt.id,
      description: `${prompt.title} has an immutable prompt/model contract and eval coverage.`,
      passed: checks.every((item) => item.passed),
      checks,
      evalIds,
    };
  });
}
