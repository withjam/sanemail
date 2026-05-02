import crypto from "node:crypto";
import { classifyMessage } from "../classifier.mjs";
import { getPrimaryAccount, readStore, recordAiRun } from "../store.mjs";
import { getPromptSnapshots, hashValue, renderPrompt } from "./prompts.mjs";

const actionPatterns = [
  ["review", "review"],
  ["sign", "sign"],
  ["approve", "approve"],
  ["confirm", "confirm"],
  ["let me know", "reply"],
  ["thoughts", "reply"],
  ["available", "reply"],
];

const deadlinePatterns = [
  /\btomorrow(?:\s+(?:morning|afternoon|evening))?\b/i,
  /\btoday\b/i,
  /\bby\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(morning|afternoon|evening)\b/i,
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function nowIso() {
  return new Date().toISOString();
}

function estimatedTokens(value) {
  return Math.max(1, Math.ceil(String(value || "").length / 4));
}

function senderName(from) {
  const match = String(from || "").match(/^"?([^"<]+)"?\s*</);
  return (match?.[1] || from || "Unknown sender").trim();
}

function textForMessage(message) {
  return `${message.subject || ""}\n${message.snippet || ""}\n${message.bodyText || ""}`;
}

function ageHours(message) {
  const time = new Date(message.date || Number(message.internalDate) || 0).getTime();
  if (!Number.isFinite(time)) return 9999;
  return Math.max(0, (Date.now() - time) / 36e5);
}

function extractActions(text) {
  const lower = text.toLowerCase();
  const actions = new Set();
  for (const [pattern, action] of actionPatterns) {
    if (lower.includes(pattern)) actions.add(action);
  }
  return Array.from(actions);
}

function extractDeadlines(text) {
  const deadlines = [];
  for (const pattern of deadlinePatterns) {
    const match = text.match(pattern);
    if (match) deadlines.push(match[0]);
  }
  return Array.from(new Set(deadlines));
}

function extractEntities(message) {
  const entities = new Set();
  const name = senderName(message.from);
  if (name && !name.includes("@")) entities.add(name);

  const text = textForMessage(message);
  for (const match of text.matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g)) {
    const value = match[0];
    if (!["The", "Your", "This", "Please", "Could", "Are"].includes(value)) {
      entities.add(value);
    }
  }

  return Array.from(entities).slice(0, 6);
}

function embeddingSummary(text, dimensions = 16) {
  const digest = crypto.createHash("sha256").update(text).digest();
  const raw = Array.from({ length: dimensions }, (_item, index) => {
    return Number(((digest[index] / 255) * 2 - 1).toFixed(4));
  });
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0)) || 1;
  const vector = raw.map((value) => Number((value / norm).toFixed(4)));

  return {
    model: "hash-embedding-v0",
    dimensions,
    hash: hashValue(vector),
    preview: vector.slice(0, 4),
  };
}

function feedbackForMessage(feedback, messageId) {
  return feedback.filter((entry) => entry.messageId === messageId).map((entry) => entry.kind);
}

function feedbackBoost(kinds) {
  let boost = 0;
  if (kinds.includes("important")) boost += 14;
  if (kinds.includes("needs-reply")) boost += 18;
  if (kinds.includes("done")) boost -= 22;
  if (kinds.includes("not-important")) boost -= 14;
  if (kinds.includes("junk")) boost -= 60;
  if (kinds.includes("not-junk")) boost += 10;
  return boost;
}

function confidenceFor(classification, actions, deadlines) {
  const base =
    0.62 +
    classification.reasons.length * 0.035 +
    (classification.possibleJunk ? 0.08 : 0) +
    (classification.needsReply ? 0.06 : 0) +
    (actions.length ? 0.04 : 0) +
    (deadlines.length ? 0.03 : 0);
  return Number(clamp(base, 0.52, 0.98).toFixed(2));
}

function rankDecision(classification, actions, deadlines, messageAgeHours, feedbackKinds) {
  const recency = messageAgeHours <= 12 ? 22 : messageAgeHours <= 24 ? 14 : messageAgeHours <= 72 ? 7 : 0;
  const actionScore = actions.length * 9 + deadlines.length * 6;
  const score =
    classification.todayScore +
    recency +
    actionScore +
    feedbackBoost(feedbackKinds) -
    (classification.possibleJunk ? 45 : 0) -
    (classification.automated ? 20 : 0);

  const reasons = [...classification.reasons];
  if (actions.length) reasons.push(`action cues: ${actions.join(", ")}`);
  if (deadlines.length) reasons.push(`time cues: ${deadlines.join(", ")}`);
  if (feedbackKinds.length) reasons.push(`local feedback: ${feedbackKinds.join(", ")}`);

  return {
    recsysScore: Math.round(clamp(score, 0, 100)),
    rankingReasons: reasons,
    suppressFromToday: classification.possibleJunk || classification.automated,
  };
}

function decisionForMessage(message, account, feedback) {
  const text = textForMessage(message);
  const messageAgeHours = Number(ageHours(message).toFixed(2));
  const feedbackKinds = feedbackForMessage(feedback, message.id);
  const classification = classifyMessage(message, account);
  const actions = extractActions(text);
  const deadlines = extractDeadlines(text);
  const entities = extractEntities(message);
  const triagePrompt = renderPrompt("mail-triage", {
    subject: message.subject,
    from: message.from,
    to: message.to,
    labels: message.sourceLabels || [],
    snippet: message.snippet,
    bodyText: message.bodyText,
  });
  const extractPrompt = renderPrompt("mail-extract", {
    subject: message.subject,
    from: message.from,
    snippet: message.snippet,
    bodyText: message.bodyText,
  });
  const rank = rankDecision(classification, actions, deadlines, messageAgeHours, feedbackKinds);
  const rankPrompt = renderPrompt("mail-rank", {
    category: classification.category,
    needsReply: classification.needsReply,
    possibleJunk: classification.possibleJunk,
    direct: classification.direct,
    ageHours: messageAgeHours,
    feedback: feedbackKinds.join(", "),
  });

  return {
    messageId: message.id,
    subject: message.subject,
    from: message.from,
    category: classification.category,
    needsReply: classification.needsReply,
    possibleJunk: classification.possibleJunk,
    automated: classification.automated,
    direct: classification.direct,
    confidence: confidenceFor(classification, actions, deadlines),
    recsysScore: rank.recsysScore,
    suppressFromToday: rank.suppressFromToday,
    reasons: rank.rankingReasons,
    extracted: {
      actions,
      deadlines,
      entities,
      replyCue: classification.needsReply ? "reply-likely" : null,
    },
    embedding: embeddingSummary(text),
    instrumentation: {
      inputHash: hashValue({
        subject: message.subject,
        from: message.from,
        date: message.date,
        snippet: message.snippet,
        bodyText: message.bodyText,
      }),
      promptInputHashes: [
        hashValue(triagePrompt.user),
        hashValue(extractPrompt.user),
        hashValue(rankPrompt.user),
      ],
      estimatedPromptTokens:
        estimatedTokens(triagePrompt.system) +
        estimatedTokens(triagePrompt.user) +
        estimatedTokens(extractPrompt.system) +
        estimatedTokens(extractPrompt.user) +
        estimatedTokens(rankPrompt.system) +
        estimatedTokens(rankPrompt.user),
    },
  };
}

function categoryCounts(decisions) {
  return decisions.reduce((counts, decision) => {
    counts[decision.category] = (counts[decision.category] || 0) + 1;
    return counts;
  }, {});
}

function createSpan(name, startedAt, meta = {}) {
  return {
    name,
    status: "ok",
    durationMs: Date.now() - startedAt,
    ...meta,
  };
}

export function runAiLoopOnMessages({
  account,
  messages,
  feedback = [],
  limit,
  trigger = "manual",
} = {}) {
  const startedAt = nowIso();
  const runStart = Date.now();
  const spans = [];

  const collectStart = Date.now();
  const scopedMessages = [...(messages || [])]
    .filter((message) => !account?.id || message.accountId === account.id)
    .sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime())
    .slice(0, limit || undefined);
  spans.push(createSpan("mailbox.collect", collectStart, { messageCount: scopedMessages.length }));

  const promptStart = Date.now();
  const promptRefs = getPromptSnapshots();
  spans.push(createSpan("prompt.resolve", promptStart, { promptCount: promptRefs.length }));

  const modelStart = Date.now();
  const decisions = scopedMessages.map((message) => decisionForMessage(message, account || {}, feedback));
  spans.push(createSpan("model.mock_inference", modelStart, { decisionCount: decisions.length }));

  const rankStart = Date.now();
  const ranked = [...decisions].sort((a, b) => b.recsysScore - a.recsysScore);
  const curated = ranked.filter((decision) => !decision.suppressFromToday).slice(0, 30);
  spans.push(createSpan("recsys.rank", rankStart, { curatedCount: curated.length }));

  const completedAt = nowIso();
  const latencyMs = Date.now() - runStart;
  const tokenCount = decisions.reduce(
    (sum, decision) => sum + decision.instrumentation.estimatedPromptTokens,
    0,
  );

  return {
    id: `airun_${crypto.randomUUID()}`,
    kind: "mailbox-curation",
    trigger,
    status: "succeeded",
    provider: {
      name: "mock-local",
      model: "deterministic-synthetic-v0",
      temperature: 0,
    },
    promptRefs,
    input: {
      accountId: account?.id || null,
      messageCount: scopedMessages.length,
      corpusHash: hashValue(scopedMessages.map((message) => message.id)),
      messageHashes: decisions.map((decision) => ({
        messageId: decision.messageId,
        inputHash: decision.instrumentation.inputHash,
      })),
    },
    output: {
      decisions,
      curatedMessageIds: curated.map((decision) => decision.messageId),
      topTodayMessageIds: curated.slice(0, 8).map((decision) => decision.messageId),
    },
    metrics: {
      latencyMs,
      messagesProcessed: scopedMessages.length,
      estimatedPromptTokens: tokenCount,
      estimatedCompletionTokens: decisions.length * 80,
      categoryCounts: categoryCounts(decisions),
      averageConfidence: decisions.length
        ? Number(
            (
              decisions.reduce((sum, decision) => sum + decision.confidence, 0) /
              decisions.length
            ).toFixed(2),
          )
        : 0,
    },
    spans,
    startedAt,
    completedAt,
    createdAt: completedAt,
  };
}

export async function runAiLoop({ limit, trigger = "manual" } = {}) {
  const store = await readStore();
  const account = (await getPrimaryAccount()) || store.accounts[0] || null;
  const run = runAiLoopOnMessages({
    account,
    messages: store.messages,
    feedback: store.feedback,
    limit,
    trigger,
  });
  await recordAiRun(run);
  return run;
}
