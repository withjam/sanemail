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
    id: "mail-message-classification",
    version: "2026-05-07.1",
    stage: "classification",
    title: "Single message classification",
    description:
      "Classify one ingested message into stable system placement and dynamic user message types.",
    provider: "mock-local",
    model: "deterministic-message-classification-v0",
    temperature: 0,
    variables: ["policy", "taxonomy", "userSignals", "message"],
    responseSchema: {
      messageId: "string",
      systemCategory: ["Today", "Needs Reply", "FYI", "Junk Review", "All Mail"],
      needsReply: "boolean",
      automated: "boolean",
      possibleJunk: "boolean",
      direct: "boolean",
      score: "number",
      confidence: "number",
      reasons: "string[]",
      summary: "string | null",
      actionKinds: "string[]",
      deadlines: "string[]",
      entityKeys: "string[]",
      messageTypes: [
        {
          typeId: "string | null",
          slug: "string",
          confidence: "number",
          rank: "number",
          evidence: "string[]",
        },
      ],
      candidateTypeSuggestions: [
        {
          slug: "string",
          displayName: "string",
          description: "string",
          evidence: "string[]",
        },
      ],
    },
    system: [
      "You are SaneMail's single-message email classification model.",
      "Classify one source-agnostic canonical message after it has been durably ingested.",
      "Keep stable system placement separate from personalized user message types.",
      "Prefer existing active taxonomy types when they fit.",
      "Suggest candidate types only when the evidence is specific and reusable.",
      "Be conservative about junk, scams, and security alerts.",
      "When the message body has more than 50 words, write a single neutral sentence (under 30 words) capturing what the message is about. Otherwise return null for summary.",
      "Return compact JSON only.",
    ].join(" "),
    userTemplate:
      "Policy:\n{{policy}}\n\nUser taxonomy:\n{{taxonomy}}\n\nUser signals:\n{{userSignals}}\n\nMessage:\n{{message}}",
  },
  {
    id: "mail-briefing",
    version: "2026-05-05.1",
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
      "You are a personal chief of staff responsible for reviewing email messages and summarizing them in succinct, friendly, yet topical summaries.  Prefer action and insights to fluff and filler so that your boss can attack their day with confidence.",
    userTemplate:
      "Summarize the status of my email inbox like you were my friendly, personal chief of staff.  Greet me with an executive summary of my current inbox. Tell me what I need to know, what requires my attention, what is likely upcoming in the near future, and remind me of anything I may have missed in the past. Give me conversational summaries, not numeric regurgitation or aggregations. Use this structured inbox context. Preserve messageId values exactly for linked callouts. Do not mention aggregate counts or system processing details.\n\nReturn JSON for the UI with this shape: {\"text\":\"brief conversational summary of the state of my inbox. Focus on today. Give me confidence in what you have planned. Don't aggregate numbers or counts, or summarize generalities.  Provide clear substance that sets the tone for what follows.\",\"narrative\":{\"status\":\"main paragraph\",\"needToKnow\":\"what are the most pressing items you've identified, summarize them for me here\",\"mightBeMissing\":\"summarize the items I may have forgotten, overlooked, neglected, or put off for later to make sure I don't miss them.\",\"needsAttention\":\"Summarize and callout the most urgent items that require my attention.  This can be a reply, a task, a deadline, or something time sensitive or urgent in its message\"},\"callouts\":[{\"kind\":\"attention|new_attention|carry_over\",\"label\":\"Needs attention\",\"title\":\"email subject without trailing punctuation\",\"body\":\"one short human reason this item matters\",\"messageId\":\"source message id\",\"messageIds\":[\"source message id\"],\"priority\":1,\"deliveredAt\":\"ISO timestamp\"}],\"counts\":{},\"messageIds\":[\"source message id\"]}. Keep callouts to 4 or fewer and use linked message ids when calling out specific emails.\n\n{{context}}",
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
    variables: prompt.variables,
    system: prompt.system,
    userTemplate: prompt.userTemplate,
    responseSchema: prompt.responseSchema,
  });
}

function overrideFor(prompt, modelOverrides = {}) {
  return {
    ...(modelOverrides["*"] || modelOverrides.default || {}),
    ...(modelOverrides[prompt.id] || {}),
  };
}

export function modelBindingForPrompt(prompt, override = {}) {
  const binding = {
    provider: override.provider || prompt.provider,
    model: override.model || prompt.model,
    temperature: Number(override.temperature ?? prompt.temperature ?? 0),
  };

  if (override.think !== undefined) binding.think = override.think;
  else if (prompt.think !== undefined) binding.think = prompt.think;

  return binding;
}

export function modelBindingHash(prompt, override = {}) {
  return hashValue(modelBindingForPrompt(prompt, override));
}

export function promptContractHash(prompt, override = {}) {
  const promptContentHash = promptHash(prompt);
  return hashValue({
    id: prompt.id,
    version: prompt.version,
    stage: prompt.stage,
    promptHash: promptContentHash,
    modelBinding: modelBindingForPrompt(prompt, override),
    responseSchema: prompt.responseSchema,
  });
}

function promptRecord(prompt, override = {}) {
  const binding = modelBindingForPrompt(prompt, override);
  const contentHash = promptHash(prompt);

  return {
    ...prompt,
    ...binding,
    hash: contentHash,
    promptHash: contentHash,
    modelBindingHash: modelBindingHash(prompt, override),
    contractHash: promptContractHash(prompt, override),
  };
}

export function getPromptRecords(modelOverrides = {}) {
  return promptDefinitions.map((prompt) => promptRecord(prompt, overrideFor(prompt, modelOverrides)));
}

export function getPromptSnapshots(modelOverrides = {}) {
  return getPromptRecords(modelOverrides).map((prompt) => ({
    id: prompt.id,
    version: prompt.version,
    stage: prompt.stage,
    title: prompt.title,
    provider: prompt.provider,
    model: prompt.model,
    temperature: prompt.temperature,
    hash: prompt.hash,
    promptHash: prompt.promptHash,
    modelBindingHash: prompt.modelBindingHash,
    contractHash: prompt.contractHash,
  }));
}

export function getPromptById(id) {
  const prompt = promptDefinitions.find((item) => item.id === id);
  if (!prompt) throw new Error(`Unknown prompt: ${id}`);
  return prompt;
}

export function renderPrompt(id, variables = {}, modelOverride = {}) {
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
    promptHash: promptHash(prompt),
    modelBindingHash: modelBindingHash(prompt, modelOverride),
    contractHash: promptContractHash(prompt, modelOverride),
    system: prompt.system,
    user: renderedUser,
  };
}
