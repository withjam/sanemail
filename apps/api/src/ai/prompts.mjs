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
    version: "2026-05-07.1",
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
      completions: [{ phrase: "string", occurredAt: "string (ISO 8601)" }],
    },
    system:
      "Extract only useful operational context from personal email. Do not invent facts. Return short normalized fields that can support ranking and reminders. For emails that state something already happened (e.g. payment posted, package delivered, flight landed, subscription cancelled), include completions with phrase plus occurredAt; use the message received time if the body does not give a specific time.",
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
    version: "2026-05-07.2",
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
      completions: [{ phrase: "string", occurredAt: "string (ISO 8601)" }],
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
      "You are TogoMails's single-message email classification model.",
      "Classify one source-agnostic canonical message after it has been durably ingested.",
      "Keep stable system placement separate from personalized user message types.",
      "Prefer existing active taxonomy types when they fit.",
      "Suggest candidate types only when the evidence is specific and reusable.",
      "Be conservative about junk, scams, and security alerts.",
      "When the message body has more than 50 words, write a single neutral sentence (under 30 words) capturing what the message is about. Otherwise return null for summary.",
      "When the email reports a completed or finalized event (e.g. check cleared, payment posted, refund processed, package delivered, flight landed, service cancelled), include a completions array: each item has phrase and occurredAt (ISO 8601). If no explicit event time is in the body, use the message Date.",
      "Return compact JSON only.",
    ].join(" "),
    userTemplate:
      "Policy:\n{{policy}}\n\nUser taxonomy:\n{{taxonomy}}\n\nUser signals:\n{{userSignals}}\n\nMessage:\n{{message}}",
  },
  {
    id: "mail-briefing-prose",
    version: "2026-05-08.2",
    stage: "briefing",
    title: "Inbox briefing (prose)",
    description:
      "Draft a natural-language inbox briefing;",
    provider: "mock-local",
    model: "deterministic-briefing-v0",
    temperature: 0.7,
    variables: [
      "recent",
      "last7Days",
      "needsReply",
      "upcoming",
      "carryOver",
      "attentionHighlights",
      "informational",
      "hidden",
      "context",
    ],
    responseSchema: { prose: "string" },
    system:
      "You are a personal chief of staff reviewing email. Write in warm, conversational prose. Prefer action and clarity over filler. Do not output JSON or markdown code fences. Do not quote aggregate counts from the context. Preserve entire messageId string when calling out messages",
    userTemplate:
      "Summarize the status of my email inbox like you were my friendly and helpful personal chief of staff.  Write separate paragraphs about what requires my attention, what is likely upcoming, and remind me of anything I may be neglecting. Do not add section headers or titles. Prefer recent messages to old messages, but take them into account to ensure I haven't forgotten anything important. Give me a conversational summary, not a numeric regurgitation, and try not to repeat the same messages.\n\nUse this structured context (candidate attention items list message ids):\n{{context}}\n\nWhen you refer to a specific message, put its full canonical id inside the tag using exactly: [messageId:THE_FULL_MESSAGE_ID] (the id may contain colons — copy it verbatim from the context). Place the tag at the end of the sentence or clause about that message. Do not add additional formatting or struture, just write in plain text.",
  },
  {
    id: "mail-briefing-reconcile",
    version: "2026-05-08.1",
    stage: "briefing",
    title: "Inbox briefing reconciliation (prose)",
    description:
      "Adjust a prose inbox briefing using recently sent mail; plain text output for direct display + memory.",
    provider: "mock-local",
    model: "deterministic-briefing-v0",
    temperature: 0.7,
    variables: ["briefing", "sentMail"],
    responseSchema: { prose: "string" },
    system: [
      "You help reconcile an inbox briefing with recently sent mail from the same mailbox.",
      "You receive a prose briefing and a list of sent messages. If sent mail clearly shows the user already handled something mentioned in the briefing, update the prose: you may remove or soften that item and briefly note it is already addressed.",
      "Be conservative; if evidence is weak, leave the briefing unchanged.",
      "Preserve any [messageId:...] tags when those messages are still relevant.",
      "Output plain text only — no JSON, no code fences.",
    ].join(" "),
    userTemplate:
      "Reconcile my briefing in light of the messages I've sent recently. Maintain the tone, attitude, and content of the original briefing. Do not add section headers or titles or other markdown formatting. Prose briefing draft:\n{{briefing}}\n\nRecently sent mail from this mailbox (most recent first):\n{{sentMail}}\n\nReturn the full revised prose briefing only.",
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
