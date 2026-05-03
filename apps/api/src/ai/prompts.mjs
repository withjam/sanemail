import crypto from "node:crypto";

const promptDefinitions = [
  {
    id: "mail-triage",
    version: "2026-05-02.1",
    stage: "classification",
    title: "Message triage",
    description: "Classify one email into the SaneMail attention model.",
    provider: "mock-local",
    model: "deterministic-triage-v0",
    temperature: 0,
    variables: ["subject", "from", "to", "labels", "snippet", "bodyText"],
    responseSchema: {
      category: ["Today", "Needs Reply", "FYI", "Junk Review", "All Mail"],
      needsReply: "boolean",
      possibleJunk: "boolean",
      automated: "boolean",
      reasons: "string[]",
      confidence: "number",
    },
    system:
      "You are SaneMail's chief-of-staff email triage model. Prefer calm, conservative defaults. Protect the user from scams and bulk mail, but preserve a faithful all-mail view.",
    userTemplate:
      "Subject: {{subject}}\nFrom: {{from}}\nTo: {{to}}\nLabels: {{labels}}\nSnippet: {{snippet}}\nBody: {{bodyText}}",
  },
  {
    id: "mail-extract",
    version: "2026-05-02.1",
    stage: "extraction",
    title: "Action and context extraction",
    description: "Extract actions, dates, entities, and reply cues from one email.",
    provider: "mock-local",
    model: "deterministic-extract-v0",
    temperature: 0,
    variables: ["subject", "from", "snippet", "bodyText"],
    responseSchema: {
      actions: "string[]",
      deadlines: "string[]",
      entities: "string[]",
      replyCue: "string | null",
    },
    system:
      "Extract only useful operational context from personal email. Do not invent facts. Return short normalized fields that can support ranking and reminders.",
    userTemplate:
      "Subject: {{subject}}\nFrom: {{from}}\nSnippet: {{snippet}}\nBody: {{bodyText}}",
  },
  {
    id: "mail-rank",
    version: "2026-05-02.1",
    stage: "ranking",
    title: "Personal inbox ranking",
    description: "Rank messages for the curated Today surface using model and recsys features.",
    provider: "mock-local",
    model: "deterministic-rank-v0",
    temperature: 0,
    variables: ["category", "needsReply", "possibleJunk", "direct", "ageHours", "feedback"],
    responseSchema: {
      recsysScore: "number",
      rankingReasons: "string[]",
      suppressFromToday: "boolean",
    },
    system:
      "Rank email by usefulness to the user right now. Suppress obvious junk and bulk messages from the curated view, while keeping them available in All Mail.",
    userTemplate:
      "Category: {{category}}\nNeeds reply: {{needsReply}}\nPossible junk: {{possibleJunk}}\nDirect: {{direct}}\nAge hours: {{ageHours}}\nFeedback: {{feedback}}",
  },
  {
    id: "mail-briefing",
    version: "2026-05-03.3",
    stage: "briefing",
    title: "Inbox state briefing",
    description: "Summarize the status of my email inbox like you were my personal chief of staff",
    provider: "mock-local",
    model: "deterministic-briefing-v0",
    temperature: 0,
    variables: [
      "recent",
      "last7Days",
      "needsReply",
      "upcoming",
      "carryOver",
      "callouts",
      "informational",
      "hidden",
      "context",
    ],
    responseSchema: {
      text: "string",
      narrative: {
        status: "string",
        needToKnow: "string",
        mightBeMissing: "string",
        needsAttention: "string",
      },
      callouts: [
        {
          kind: "attention | new_attention | carry_over",
          label: "string",
          title: "string",
          body: "string",
          messageId: "string",
          messageIds: "string[]",
          priority: "number",
          deliveredAt: "string",
        },
      ],
      counts: "object",
      messageIds: "string[]",
    },
    system:
      "Summarize the status of my email inbox like you were my friendly, personal chief of staff. ",
    userTemplate:
      "Let me know what requires my attention, what is likely upcoming, and remind me of anything I may be neglecting. Prefer recent messages to old messages, but take them into account to ensure I haven't forgotten anything important. Limit the specific callouts to 4 most recent or urgent. Give me a conversational summary, not a numeric regurgitation. Use this structured inbox context. Preserve messageId values exactly for linked callouts. Do not mention aggregate counts or system processing details.\n\nReturn JSON for the UI with this shape: {\"text\":\"brief conversational summary\",\"narrative\":{\"status\":\"main paragraph\",\"needToKnow\":\"optional supporting paragraph or empty string\",\"mightBeMissing\":\"optional reminder paragraph or empty string\",\"needsAttention\":\"optional attention paragraph or empty string\"},\"callouts\":[{\"kind\":\"attention|new_attention|carry_over\",\"label\":\"Need attention\",\"title\":\"email subject without trailing punctuation\",\"body\":\"one short human reason this item matters\",\"messageId\":\"source message id\",\"messageIds\":[\"source message id\"],\"priority\":1,\"deliveredAt\":\"ISO timestamp\"}],\"counts\":{},\"messageIds\":[\"source message id\"]}. Keep callouts to 4 or fewer and use linked message ids when calling out specific emails.\n\n{{context}}",
  },
];

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortObject(value[key])]),
  );
}

export function stableJson(value) {
  return JSON.stringify(sortObject(value));
}

export function hashValue(value) {
  const input = typeof value === "string" ? value : stableJson(value);
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function promptHash(prompt) {
  return hashValue({
    id: prompt.id,
    version: prompt.version,
    system: prompt.system,
    userTemplate: prompt.userTemplate,
    responseSchema: prompt.responseSchema,
  });
}

export function getPromptRecords() {
  return promptDefinitions.map((prompt) => ({
    ...prompt,
    hash: promptHash(prompt),
  }));
}

export function getPromptSnapshots() {
  return getPromptRecords().map((prompt) => ({
    id: prompt.id,
    version: prompt.version,
    stage: prompt.stage,
    title: prompt.title,
    provider: prompt.provider,
    model: prompt.model,
    temperature: prompt.temperature,
    hash: prompt.hash,
  }));
}

export function getPromptById(id) {
  const prompt = promptDefinitions.find((item) => item.id === id);
  if (!prompt) throw new Error(`Unknown prompt: ${id}`);
  return prompt;
}

export function renderPrompt(id, variables = {}) {
  const prompt = getPromptById(id);
  const renderedUser = prompt.userTemplate.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const value = variables[key];
    if (Array.isArray(value)) return value.join(", ");
    if (value && typeof value === "object") return JSON.stringify(value, null, 2);
    if (value === null || value === undefined) return "";
    return String(value);
  });

  return {
    id: prompt.id,
    version: prompt.version,
    hash: promptHash(prompt),
    system: prompt.system,
    user: renderedUser,
  };
}
