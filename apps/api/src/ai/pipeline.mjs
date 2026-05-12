import crypto from "node:crypto";
import { loadConfig } from "../config.mjs";
import {
  applyFeedbackToClassification,
  classifyMessage,
  isSentByMailbox,
} from "../classifier.mjs";
import { stripQuotedEmailTail } from "../email-quote-strip.mjs";
import { effectiveClassificationBodyText } from "../thread-copy-dedupe.mjs";
import { extractCompletionEvents } from "../completion-extract.mjs";
import {
  getPrimarySourceConnection,
  latestInboxBriefing,
  readStoreFor,
  recordAiRun,
  selectMessagesForClassificationBatch,
} from "../store.mjs";
import {
  buildClassificationMessages,
  classifyWithOllama,
  generateBriefingProseWithOllama,
} from "./ollama.mjs";
import { traceAiRun } from "./phoenix.mjs";
import { getPromptSnapshots, hashValue, renderPrompt } from "./prompts.mjs";

const SENT_BODY_PREVIEW_CHARS = 480;

function sentMailContextForReconciliation(store, account, limit = 20) {
  return [...(store.messages || [])]
    .filter((message) => !account?.id || message.accountId === account.id)
    .filter((message) => isSentByMailbox(message, account))
    .sort((a, b) => messageDeliveredAtMs(b) - messageDeliveredAtMs(a))
    .slice(0, limit)
    .map((message) => {
      const stripped = stripQuotedEmailTail(message.bodyText || "");
      const bodyPreview =
        stripped.length > SENT_BODY_PREVIEW_CHARS
          ? `${stripped.slice(0, SENT_BODY_PREVIEW_CHARS)}…`
          : stripped;
      return {
        messageId: message.id,
        deliveredAt: message.date || null,
        subject: message.subject || "",
        to: message.to || message.headers?.to || "",
        snippet: message.snippet || "",
        bodyPreview,
      };
    });
}

/** Inbound messages followed by any mailbox-sent message in the same thread (same Gmail threadId). */
export function buildThreadReplyResolvedMessageIds(messages = [], account) {
  if (!account) return new Set();
  const byThread = new Map();
  for (const message of messages) {
    if (!message) continue;
    if (account.id && message.accountId !== account.id) continue;
    const tid = String(message.providerThreadId || "").trim();
    if (!tid) continue;
    if (!byThread.has(tid)) byThread.set(tid, []);
    byThread.get(tid).push(message);
  }
  const resolved = new Set();
  for (const list of byThread.values()) {
    const sorted = [...list].sort((a, b) => messageDeliveredAtMs(a) - messageDeliveredAtMs(b));
    for (let i = 0; i < sorted.length; i++) {
      if (isSentByMailbox(sorted[i], account)) continue;
      const t0 = messageDeliveredAtMs(sorted[i]);
      for (let j = i + 1; j < sorted.length; j++) {
        if (messageDeliveredAtMs(sorted[j]) < t0) continue;
        if (isSentByMailbox(sorted[j], account)) {
          resolved.add(sorted[i].id);
          break;
        }
      }
    }
  }
  return resolved;
}

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
  const body = stripQuotedEmailTail(message.bodyText || "");
  return `${message.subject || ""}\n${message.snippet || ""}\n${body}`;
}

function wordCountForMessage(message) {
  const body = `${message.subject || ""} ${stripQuotedEmailTail(message.bodyText || "")} ${message.snippet || ""}`;
  const tokens = body.trim().split(/\s+/).filter(Boolean);
  return tokens.length;
}

function ageHours(message) {
  const time = new Date(message.date || Number(message.internalDate) || 0).getTime();
  if (!Number.isFinite(time)) return 9999;
  return Math.max(0, (Date.now() - time) / 36e5);
}

function messageDeliveredAtMs(message) {
  const time = new Date(message.date || Number(message.internalDate) || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function decisionAgeHours(decision) {
  if (typeof decision.temporal?.ageHours === "number") return decision.temporal.ageHours;
  const time = new Date(decision.deliveredAt || 0).getTime();
  if (!Number.isFinite(time)) return 9999;
  return Math.max(0, (Date.now() - time) / 36e5);
}

function decisionDeliveredAt(decision) {
  return decision.temporal?.deliveredAt || decision.deliveredAt || "";
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

const addressedFeedbackKinds = new Set(["done", "not-important", "junk"]);

function feedbackEntriesForMessage(feedback, messageId) {
  return feedback.filter((entry) => entry.messageId === messageId);
}

function latestFeedbackEntry(feedbackEntries = []) {
  return [...feedbackEntries].sort(
    (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime(),
  )[0] || null;
}

function feedbackState(feedbackEntries = []) {
  const latest = latestFeedbackEntry(feedbackEntries);
  return {
    kinds: feedbackEntries.map((entry) => entry.kind),
    latestKind: latest?.kind || null,
    latestAt: latest?.createdAt || null,
    addressed: latest ? addressedFeedbackKinds.has(latest.kind) : false,
  };
}

function isDecisionAddressed(decision) {
  return Boolean(decision.feedback?.addressed || decision.resolvedBySentFollowUp);
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
  const recency =
    messageAgeHours <= 6
      ? 30
      : messageAgeHours <= 24
        ? 22
        : messageAgeHours <= 72
          ? 12
          : messageAgeHours <= 168
            ? 5
            : 0;
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
    suppressFromToday:
      Boolean(classification.feedbackState?.addressed) ||
      classification.possibleJunk ||
      classification.automated,
  };
}

function decisionForMessage(message, account, feedback, threadReplyResolvedIds, threadCorpusMessages) {
  const bodyEffective = effectiveClassificationBodyText(message, threadCorpusMessages || []);
  const messageForClassification = { ...message, bodyText: bodyEffective };
  const text = textForMessage(messageForClassification);
  const messageAgeHours = Number(ageHours(message).toFixed(2));
  const feedbackEntries = feedbackEntriesForMessage(feedback, message.id);
  const messageFeedback = feedbackState(feedbackEntries);
  const classification = applyFeedbackToClassification(
    classifyMessage(messageForClassification, account),
    feedbackEntries,
  );
  const userInsistsReply = messageFeedback.latestKind === "needs-reply";
  const sentFollowUpInThread =
    threadReplyResolvedIds instanceof Set && threadReplyResolvedIds.has(message.id);
  const resolvedBySentFollowUp =
    Boolean(sentFollowUpInThread) && !userInsistsReply && !messageFeedback.addressed;
  const feedbackKinds = messageFeedback.kinds;
  const actions = extractActions(text);
  const deadlines = extractDeadlines(text);
  const completions = extractCompletionEvents(text, message.date);
  const entities = extractEntities(messageForClassification);
  const bodyForModel = bodyEffective;
  const triagePrompt = renderPrompt("mail-triage", {
    subject: message.subject,
    from: message.from,
    to: message.to,
    labels: message.sourceLabels || [],
    snippet: message.snippet,
    bodyText: bodyForModel,
  });
  const extractPrompt = renderPrompt("mail-extract", {
    subject: message.subject,
    from: message.from,
    snippet: message.snippet,
    bodyText: bodyForModel,
  });
  const classificationForRank = {
    ...classification,
    needsReply: classification.needsReply && !resolvedBySentFollowUp,
  };
  const rank = rankDecision(classificationForRank, actions, deadlines, messageAgeHours, feedbackKinds);
  const rankPrompt = renderPrompt("mail-rank", {
    category: classification.category,
    needsReply: classificationForRank.needsReply,
    possibleJunk: classification.possibleJunk,
    direct: classification.direct,
    ageHours: messageAgeHours,
    feedback: feedbackKinds.join(", "),
  });

  const wordCount = wordCountForMessage(messageForClassification);

  return {
    messageId: message.id,
    subject: message.subject,
    from: message.from,
    deliveredAt: message.date,
    category: classification.category,
    needsReply: classificationForRank.needsReply,
    possibleJunk: classification.possibleJunk,
    automated: classification.automated,
    direct: classification.direct,
    addressed: messageFeedback.addressed,
    confidence: confidenceFor(classificationForRank, actions, deadlines),
    recsysScore: rank.recsysScore,
    suppressFromToday: rank.suppressFromToday || resolvedBySentFollowUp,
    temporal: {
      deliveredAt: message.date,
      ageHours: messageAgeHours,
      recent: messageAgeHours <= 24,
      within7Days: messageAgeHours <= 168,
    },
    reasons: rank.rankingReasons,
    summary: null,
    wordCount,
    extracted: {
      actions,
      deadlines,
      entities,
      completions,
      replyCue: classificationForRank.needsReply ? "reply-likely" : null,
    },
    feedback: messageFeedback,
    resolvedBySentFollowUp,
    embedding: embeddingSummary(text),
    instrumentation: {
      inputHash: hashValue({
        subject: message.subject,
        from: message.from,
        date: message.date,
        snippet: message.snippet,
        bodyText: bodyEffective,
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

function publicError(error) {
  return error instanceof Error ? error.message : String(error);
}

function classificationModel(config) {
  return config.ollama.classificationModel || config.ollama.model;
}

function boundedMessageLimit(limit, config) {
  const requested = Number(limit === undefined ? config.ai.runLimit : limit);
  const fallback = Number(config.ai.runLimit || 500);
  const value = Number.isFinite(requested) && requested > 0 ? requested : fallback;
  return Math.min(500, Math.max(1, Math.floor(value)));
}

const briefingContextLimits = {
  recentMessages: 80,
  attentionCandidates: 48,
  upcomingCandidates: 40,
  mayBeNeglected: 32,
  backgroundContext: 24,
  hiddenContext: 8,
};

function limitedDecisionItems(decisions, limit) {
  const sorted = sortForBriefing(decisions);
  return {
    items: sorted.slice(0, limit).map(decisionBriefingItem),
    total: sorted.length,
    omitted: Math.max(0, sorted.length - limit),
  };
}

function llmCallId() {
  return `llm_${crypto.randomUUID()}`;
}

function promptInputHash(prompt) {
  return hashValue({
    system: prompt.system,
    user: prompt.user,
  });
}

function outputHash(value) {
  return hashValue(value || null);
}

function recordLlmCall(run, call) {
  run.llmCalls ||= [];
  run.llmCalls.push({
    id: llmCallId(),
    createdAt: nowIso(),
    ...call,
  });
}

const TRACE_LLM_SYS_MAX = 12_000;
const TRACE_LLM_USER_MAX = 48_000;
const TRACE_LLM_OUT_MAX = 48_000;

function llmTracePayloadFromPrompt(config, prompt, assistantPiece) {
  if (!config.phoenix?.allowSensitiveContent) return {};
  const assistant =
    typeof assistantPiece === "string" ? assistantPiece : JSON.stringify(assistantPiece ?? null);
  return {
    tracePromptSystem: String(prompt?.system ?? "").slice(0, TRACE_LLM_SYS_MAX),
    tracePromptUser: String(prompt?.user ?? "").slice(0, TRACE_LLM_USER_MAX),
    traceAssistant: assistant.slice(0, TRACE_LLM_OUT_MAX),
  };
}

function llmTracePayloadFromClassification(config, messages, decision) {
  if (!config.phoenix?.allowSensitiveContent) return {};
  const sys = messages.find((m) => m.role === "system")?.content ?? "";
  const usr = messages.find((m) => m.role === "user")?.content ?? "";
  return {
    tracePromptSystem: String(sys).slice(0, TRACE_LLM_SYS_MAX),
    tracePromptUser: String(usr).slice(0, TRACE_LLM_USER_MAX),
    traceAssistant: decision != null ? JSON.stringify(decision).slice(0, TRACE_LLM_OUT_MAX) : undefined,
  };
}

function aiDebugEnabled() {
  return ["1", "true", "yes", "on"].includes(String(process.env.AI_DEBUG || "").toLowerCase());
}

function aiDebugLog(label, value) {
  if (!aiDebugEnabled()) return;
  console.log(`[ai-loop debug] ${label}`);
  console.log(JSON.stringify(value, null, 2));
}

function rankDecisions(decisions) {
  const ranked = [...decisions].sort((a, b) => b.recsysScore - a.recsysScore);
  return ranked.filter((decision) => !decision.suppressFromToday).slice(0, 30);
}

function sortForBriefing(decisions) {
  return [...decisions].sort((a, b) => {
    if (b.recsysScore !== a.recsysScore) return b.recsysScore - a.recsysScore;
    const ageDelta = decisionAgeHours(a) - decisionAgeHours(b);
    if (ageDelta !== 0) return ageDelta;
    return new Date(decisionDeliveredAt(b) || 0).getTime() - new Date(decisionDeliveredAt(a) || 0).getTime();
  });
}

function summarizeSubjects(decisions, predicate, limit = 3) {
  return sortForBriefing(decisions.filter(predicate))
    .slice(0, limit)
    .map((decision) => decision.subject.replace(/[?.!]+$/, ""));
}

function joinReadable(items) {
  if (!items.length) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function idsFor(decisions, limit = 8) {
  return sortForBriefing(decisions)
    .slice(0, limit)
    .map((decision) => decision.messageId);
}

function idsFromPreviousBriefing(previousBriefing) {
  return new Set(
    [
      ...(previousBriefing?.messageIds || []),
      ...(previousBriefing?.carryOver?.messageIds || []),
      ...(previousBriefing?.memory?.carryOverMessageIds || []),
      ...(previousBriefing?.memory?.unresolvedPreviousMessageIds || []),
    ].filter(Boolean),
  );
}

function previousBriefingTimestamp(previousBriefing) {
  const value = previousBriefing?.generatedAt || previousBriefing?.createdAt || null;
  if (!value) return { iso: null, ms: 0 };
  const ms = new Date(value).getTime();
  return {
    iso: value,
    ms: Number.isFinite(ms) ? ms : 0,
  };
}

function normalizedBriefingMode(mode, previousBriefing) {
  const normalized = String(mode || "auto").trim().toLowerCase().replaceAll("_", "-");
  if (["cold", "cold-start", "batch", "full", "full-refresh"].includes(normalized)) {
    return "cold_start";
  }
  if (["iterative", "incremental", "since-last", "since-last-brief"].includes(normalized)) {
    return previousBriefing ? "iterative" : "cold_start";
  }
  return previousBriefing ? "iterative" : "cold_start";
}

function uniqueMessages(messages) {
  const seen = new Set();
  const unique = [];
  for (const message of messages) {
    if (!message?.id || seen.has(message.id)) continue;
    seen.add(message.id);
    unique.push(message);
  }
  return unique;
}

function feedbackByMessageId(feedback = []) {
  const byId = new Map();
  for (const entry of feedback) {
    if (!byId.has(entry.messageId)) byId.set(entry.messageId, []);
    byId.get(entry.messageId).push(entry);
  }
  return byId;
}

export function selectMessagesForBriefing({
  messages = [],
  feedback = [],
  previousBriefing = null,
  mode = "auto",
  limit,
} = {}) {
  const sorted = [...messages].sort((a, b) => messageDeliveredAtMs(b) - messageDeliveredAtMs(a));
  const flow = normalizedBriefingMode(mode, previousBriefing);
  const previous = previousBriefingTimestamp(previousBriefing);
  const previousIds = idsFromPreviousBriefing(previousBriefing);
  const feedbackMap = feedbackByMessageId(feedback);
  const resolvedPreviousMessageIds = [];
  const unresolvedPreviousMessageIds = [];

  for (const messageId of previousIds) {
    const state = feedbackState(feedbackMap.get(messageId) || []);
    if (state.addressed) resolvedPreviousMessageIds.push(messageId);
    else unresolvedPreviousMessageIds.push(messageId);
  }

  if (flow === "cold_start") {
    const selected = sorted.slice(0, limit || undefined);
    return {
      mode: flow,
      selected,
      newMessages: selected,
      carryOverMessages: [],
      since: null,
      previousBriefingId: null,
      previousGeneratedAt: null,
      resolvedPreviousMessageIds: [],
      unresolvedPreviousMessageIds: [],
    };
  }

  const newMessages = sorted.filter((message) => messageDeliveredAtMs(message) > previous.ms);
  const carryOverMessages = sorted.filter(
    (message) =>
      unresolvedPreviousMessageIds.includes(message.id) &&
      !newMessages.some((newMessage) => newMessage.id === message.id),
  );
  const carryOverCount = carryOverMessages.length;
  const newLimit = limit ? Math.max(0, limit - carryOverCount) : undefined;
  const selected = uniqueMessages([
    ...newMessages.slice(0, newLimit === undefined ? undefined : newLimit),
    ...carryOverMessages,
  ]).slice(0, limit || undefined);

  return {
    mode: flow,
    selected,
    newMessages: newMessages.filter((message) => selected.some((item) => item.id === message.id)),
    carryOverMessages: carryOverMessages.filter((message) => selected.some((item) => item.id === message.id)),
    since: previous.iso,
    previousBriefingId: previousBriefing?.id || null,
    previousGeneratedAt: previous.iso,
    resolvedPreviousMessageIds,
    unresolvedPreviousMessageIds,
  };
}

function memoryFromSelection(selection, decisions) {
  return {
    mode: selection.mode,
    since: selection.since,
    previousBriefingId: selection.previousBriefingId,
    previousGeneratedAt: selection.previousGeneratedAt,
    includedMessageIds: decisions.map((decision) => decision.messageId),
    newMessageIds: selection.newMessages.map((message) => message.id),
    carryOverMessageIds: selection.carryOverMessages.map((message) => message.id),
    unresolvedPreviousMessageIds: selection.unresolvedPreviousMessageIds,
    resolvedPreviousMessageIds: selection.resolvedPreviousMessageIds,
  };
}

function stillRelevantFromPrevious(previousBriefing, decisions, limit = 2) {
  const previousIds = idsFromPreviousBriefing(previousBriefing);
  if (!previousIds.size) return [];

  return sortForBriefing(
    decisions.filter(
      (decision) =>
        previousIds.has(decision.messageId) &&
        !decision.possibleJunk &&
        !isDecisionAddressed(decision) &&
        (decision.needsReply ||
          decision.extracted.deadlines.length > 0 ||
          decision.extracted.actions.some((action) =>
            ["pay", "schedule", "confirm", "sign", "review"].includes(action),
          )),
    ),
  ).slice(0, limit);
}

function actionNoun(actions, needsReply) {
  const action = actions.find((item) => item !== "reply") || (needsReply ? "reply" : "review");
  const nouns = {
    approve: "approval",
    confirm: "confirmation",
    review: "review",
    sign: "signature",
  };
  return nouns[action] || action;
}

function calloutBody(decision) {
  const sender = senderName(decision.from);
  const deadlines = decision.extracted.deadlines || [];
  const actions = decision.extracted.actions || [];
  const action = actionNoun(actions, decision.needsReply);
  const deadlineText = deadlines.length ? ` Time cue: ${deadlines[0]}.` : "";

  return `${sender} appears to need a ${action}.${deadlineText}`;
}

/** Up to four attention items for prose context (not persisted as callouts). */
function buildAttentionHighlights({ needsReplyLast7, carryOver, previousBriefing }) {
  const previousIds = idsFromPreviousBriefing(previousBriefing);
  const highlights = [];
  const used = new Set();

  for (const decision of carryOver) {
    used.add(decision.messageId);
    highlights.push({
      id: `attention-${decision.messageId}`,
      kind: "carry_over",
      label: "Needs attention",
      title: decision.subject.replace(/[?.!]+$/, ""),
      body: calloutBody(decision),
      messageId: decision.messageId,
      messageIds: [decision.messageId],
      priority: 1,
      deliveredAt: decisionDeliveredAt(decision),
    });
  }

  for (const decision of sortForBriefing(needsReplyLast7)) {
    if (used.has(decision.messageId)) continue;
    const seenBefore = previousIds.has(decision.messageId);
    highlights.push({
      id: `attention-${decision.messageId}`,
      kind: seenBefore ? "attention" : "new_attention",
      label: "Needs attention",
      title: decision.subject.replace(/[?.!]+$/, ""),
      body: calloutBody(decision),
      messageId: decision.messageId,
      messageIds: [decision.messageId],
      priority: highlights.length + 1,
      deliveredAt: decisionDeliveredAt(decision),
    });
    used.add(decision.messageId);
    if (highlights.length >= 4) break;
  }

  return highlights.slice(0, 4);
}

function buildBriefingNarrative({ attentionHighlights }) {
  const topTitles = attentionHighlights.map((item) => item.title);
  const status = attentionHighlights.length
    ? `Your inbox is mostly calm. I would open ${joinReadable(topTitles)} first; those are the items most likely to need your attention right now.`
    : `Your inbox looks calm right now. I do not see anything that needs your attention before you are ready to scan the rest.`;

  return {
    status,
    needToKnow: "",
    mightBeMissing: "",
    needsAttention: "",
  };
}

function buildBriefingState(decisions = [], previousBriefing = null, memory = null) {
  const visible = decisions.filter((decision) => !decision.possibleJunk && !isDecisionAddressed(decision));
  const needsReply = decisions.filter(
    (decision) =>
      decision.needsReply &&
      !decision.possibleJunk &&
      !decision.suppressFromToday &&
      !isDecisionAddressed(decision),
  );
  const recent = visible.filter((decision) => decisionAgeHours(decision) <= 24);
  const last7Days = visible.filter((decision) => decisionAgeHours(decision) <= 168);
  const needsReplyLast7 = needsReply.filter((decision) => decisionAgeHours(decision) <= 168);
  const upcoming = decisions.filter(
    (decision) =>
      !decision.possibleJunk &&
      (decision.extracted.deadlines.length > 0 ||
        decision.extracted.actions.some((action) =>
          ["pay", "schedule", "confirm", "sign", "review"].includes(action),
        )),
  );
  const automated = decisions.filter((decision) => decision.automated && !decision.possibleJunk);
  const hidden = decisions.filter((decision) => decision.possibleJunk);
  const addressed = decisions.filter(isDecisionAddressed);
  const carryOver = stillRelevantFromPrevious(previousBriefing, decisions);
  const replySubjects = summarizeSubjects(needsReplyLast7, () => true, 3);
  const upcomingSubjects = summarizeSubjects(upcoming, () => true, 2);
  const recentSubjects = summarizeSubjects(recent, () => true, 2);
  const carryOverSubjects = carryOver.map((decision) => decision.subject.replace(/[?.!]+$/, ""));
  const attentionHighlights = buildAttentionHighlights({ needsReplyLast7, carryOver, previousBriefing });
  const narrative = buildBriefingNarrative({
    attentionHighlights,
  });

  return {
    decisionCount: decisions.length,
    visible,
    needsReply,
    recent,
    last7Days,
    needsReplyLast7,
    upcoming,
    automated,
    hidden,
    addressed,
    carryOver,
    replySubjects,
    upcomingSubjects,
    recentSubjects,
    carryOverSubjects,
    attentionHighlights,
    narrative,
    memory,
  };
}

function decisionBriefingItem(decision) {
  return {
    messageId: decision.messageId,
    subject: decision.subject.replace(/[?.!]+$/, ""),
    from: senderName(decision.from),
    deliveredAt: decisionDeliveredAt(decision),
    recent: decisionAgeHours(decision) <= 24,
    within7Days: decisionAgeHours(decision) <= 168,
    category: decision.category,
    needsAttention: Boolean(decision.needsReply),
    possibleJunk: Boolean(decision.possibleJunk),
    automated: Boolean(decision.automated),
    addressed: Boolean(decision.feedback?.addressed),
    actions: decision.extracted?.actions || [],
    deadlines: decision.extracted?.deadlines || [],
    completions: decision.extracted?.completions || [],
    entities: decision.extracted?.entities || [],
    reasons: decision.reasons || [],
    rank: decision.recsysScore,
  };
}

function briefingContextFromState(state, previousBriefing = null) {
  const recentMessages = limitedDecisionItems(state.recent, briefingContextLimits.recentMessages);
  const attentionCandidates = limitedDecisionItems(
    state.needsReplyLast7,
    briefingContextLimits.attentionCandidates,
  );
  const upcomingCandidates = limitedDecisionItems(state.upcoming, briefingContextLimits.upcomingCandidates);
  const mayBeNeglected = limitedDecisionItems(
    [
      ...state.carryOver,
      ...state.needsReplyLast7.filter((decision) => decisionAgeHours(decision) > 24),
    ],
    briefingContextLimits.mayBeNeglected,
  );
  const backgroundContext = limitedDecisionItems(state.automated, briefingContextLimits.backgroundContext);
  const hiddenContext = limitedDecisionItems(state.hidden, briefingContextLimits.hiddenContext);

  return {
    instructionContext:
      "Use this as private context for deciding what matters. The user should only see the conversational summary and inline message source links.",
    recencyPolicy:
      "Prefer recent messages, include items from the past 7 days when still relevant, and use prior briefing items only to avoid neglecting important reminders.",
    processingSummary: {
      selectedMessages: state.memory?.includedMessageIds?.length ?? state.decisionCount,
      visible: state.visible.length,
      recent: state.recent.length,
      last7Days: state.last7Days.length,
      attentionCandidates: state.needsReplyLast7.length,
      upcomingCandidates: state.upcoming.length,
      backgroundContext: state.automated.length,
      hiddenContext: state.hidden.length,
      limits: briefingContextLimits,
      omitted: {
        recentMessages: recentMessages.omitted,
        attentionCandidates: attentionCandidates.omitted,
        upcomingCandidates: upcomingCandidates.omitted,
        mayBeNeglected: mayBeNeglected.omitted,
        backgroundContext: backgroundContext.omitted,
        hiddenContext: hiddenContext.omitted,
      },
    },
    briefingMemory: {
      mode: state.memory?.mode || (previousBriefing ? "iterative" : "cold_start"),
      since: state.memory?.since || null,
      previousBriefingId: state.memory?.previousBriefingId || previousBriefing?.id || null,
      previousGeneratedAt:
        state.memory?.previousGeneratedAt ||
        previousBriefing?.generatedAt ||
        previousBriefing?.createdAt ||
        null,
      includedMessageIds: state.memory?.includedMessageIds || [],
      newMessageIds: state.memory?.newMessageIds || [],
      unresolvedPreviousMessageIds: state.memory?.unresolvedPreviousMessageIds || [],
      resolvedPreviousMessageIds: state.memory?.resolvedPreviousMessageIds || [],
    },
    candidateAttention: state.attentionHighlights.map((item) => ({
      kind: item.kind,
      label: item.label,
      title: item.title,
      body: item.body,
      messageId: item.messageId,
      messageIds: item.messageIds,
      deliveredAt: item.deliveredAt,
    })),
    recentMessages: recentMessages.items,
    attentionCandidates: attentionCandidates.items,
    upcomingCandidates: upcomingCandidates.items,
    mayBeNeglected: mayBeNeglected.items,
    backgroundContext: backgroundContext.items,
    hiddenContext: hiddenContext.items,
    previousBriefing: previousBriefing
      ? {
          generatedAt: previousBriefing.generatedAt || previousBriefing.createdAt || null,
          text: previousBriefing.text || "",
          messageIds: previousBriefing.messageIds || [],
          carryOverMessageIds: previousBriefing.carryOver?.messageIds || [],
        }
      : null,
  };
}

function renderBriefingPromptFromState(state, previousBriefing = null) {
  const context = briefingContextFromState(state, previousBriefing);
  return renderPrompt("mail-briefing-prose", {
    recent: state.recentSubjects,
    last7Days: state.last7Days.length,
    needsReply: state.replySubjects,
    upcoming: state.upcomingSubjects,
    carryOver: state.carryOverSubjects,
    attentionHighlights: state.attentionHighlights.map(
      (item) => `${item.label}: ${item.title} [messageId:${item.messageId}] ${item.body}`,
    ),
    informational: state.automated.map((decision) => decision.subject).slice(0, 3),
    hidden: state.hidden.map((decision) => decision.subject).slice(0, 3),
    context,
  });
}

function renderBriefingPromptForDecisions(decisions = [], previousBriefing = null, memory = null) {
  const state = buildBriefingState(decisions, previousBriefing, memory);
  const context = briefingContextFromState(state, previousBriefing);
  return renderPrompt("mail-briefing-prose", {
    recent: state.recentSubjects,
    last7Days: state.last7Days.length,
    needsReply: state.replySubjects,
    upcoming: state.upcomingSubjects,
    carryOver: state.carryOverSubjects,
    attentionHighlights: state.attentionHighlights.map(
      (item) => `${item.label}: ${item.title} [messageId:${item.messageId}] ${item.body}`,
    ),
    informational: state.automated.map((decision) => decision.subject).slice(0, 3),
    hidden: state.hidden.map((decision) => decision.subject).slice(0, 3),
    context,
  });
}

export function buildBriefingContextForDecisions(decisions = [], previousBriefing = null, memory = null) {
  const state = buildBriefingState(decisions, previousBriefing, memory);
  return briefingContextFromState(state, previousBriefing);
}

export function buildInboxBriefing(decisions = [], { previousBriefing = null, memory = null } = {}) {
  const state = buildBriefingState(decisions, previousBriefing, memory);
  const {
    visible,
    needsReply,
    recent,
    last7Days,
    needsReplyLast7,
    upcoming,
    automated,
    hidden,
    addressed,
    carryOver,
    carryOverSubjects,
    attentionHighlights,
    narrative,
  } = state;

  let text;
  if (!decisions.length && memory?.mode === "iterative") {
    text = "No new mail needs your attention since the last briefing.";
  } else if (!decisions.length) {
    text = "There is no local mail to summarize yet. Connect Gmail or reset the demo mailbox to generate a briefing.";
  } else if (visible.length === 0) {
    text = "Nothing needs your attention right now. The latest mail is either informational or being kept out of the main view.";
  } else {
    text = [
      narrative.status,
      narrative.needToKnow,
      narrative.mightBeMissing,
      narrative.needsAttention,
    ].filter(Boolean).join(" ");
  }
  const prompt = renderBriefingPromptFromState(state, previousBriefing);
  const generatedAt = new Date().toISOString();
  const memoryBlock = {
    mode: memory?.mode || (previousBriefing ? "iterative" : "cold_start"),
    producedAt: generatedAt,
    since: memory?.since || null,
    previousBriefingId: memory?.previousBriefingId || previousBriefing?.id || null,
    previousGeneratedAt:
      memory?.previousGeneratedAt ||
      previousBriefing?.generatedAt ||
      previousBriefing?.createdAt ||
      null,
    includedMessageIds: memory?.includedMessageIds || decisions.map((decision) => decision.messageId),
    newMessageIds: memory?.newMessageIds || [],
    carryOverMessageIds: carryOver.map((decision) => decision.messageId),
    unresolvedPreviousMessageIds: memory?.unresolvedPreviousMessageIds || [],
    resolvedPreviousMessageIds: memory?.resolvedPreviousMessageIds || [],
  };

  const mergedMessageIds = (() => {
    const attentionIds = attentionHighlights.map((h) => h.messageId);
    const topVisible = idsFor(visible, 8);
    const seen = new Set();
    const out = [];
    for (const id of [...attentionIds, ...topVisible]) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out.slice(0, 16);
  })();

  return {
    text,
    narrative,
    generatedAt,
    source: "ai-loop",
    model: "deterministic-briefing-v0",
    prompt: {
      id: prompt.id,
      version: prompt.version,
      hash: prompt.hash,
      promptHash: prompt.promptHash,
      modelBindingHash: prompt.modelBindingHash,
      contractHash: prompt.contractHash,
    },
    counts: {
      visible: visible.length,
      recent: recent.length,
      last7Days: last7Days.length,
      needsReply: needsReply.length,
      needsReplyLast7: needsReplyLast7.length,
      upcoming: upcoming.length,
      informational: automated.length,
      hidden: hidden.length,
      carriedOver: carryOver.length,
    },
    messageIds: mergedMessageIds,
    memory: memoryBlock,
    carryOver: {
      previousBriefingId: previousBriefing?.id || null,
      previousGeneratedAt: previousBriefing?.generatedAt || null,
      messageIds: carryOver.map((decision) => decision.messageId),
      subjects: carryOverSubjects,
    },
  };
}

function refreshRunOutput(
  run,
  decisions,
  previousBriefing = null,
  memory = null,
  { includeBriefing = true } = {},
) {
  const curated = rankDecisions(decisions);
  const tokenCount = decisions.reduce(
    (sum, decision) => sum + decision.instrumentation.estimatedPromptTokens,
    0,
  );

  run.output = {
    decisions,
    curatedMessageIds: curated.map((decision) => decision.messageId),
    topTodayMessageIds: curated.slice(0, 8).map((decision) => decision.messageId),
    ...(includeBriefing ? { briefing: buildInboxBriefing(decisions, { previousBriefing, memory }) } : {}),
  };
  run.metrics = {
    ...run.metrics,
    messagesProcessed: decisions.length,
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
  };
}

export function runAiLoopOnMessages({
  account,
  messages,
  feedback = [],
  limit,
  trigger = "manual",
  kind = "mailbox-curation",
  includeBriefing = true,
  previousBriefing = null,
  briefingSelection = null,
  memory = null,
  threadReplyResolvedIds = null,
  threadCorpusMessages = null,
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
  const decisions = scopedMessages.map((message) =>
    decisionForMessage(message, account || {}, feedback, threadReplyResolvedIds, threadCorpusMessages),
  );
  spans.push(createSpan("model.mock_inference", modelStart, { decisionCount: decisions.length }));
  const briefingMemory =
    memory || (briefingSelection ? memoryFromSelection(briefingSelection, decisions) : null);

  const rankStart = Date.now();
  const curated = rankDecisions(decisions);
  spans.push(createSpan("recsys.rank", rankStart, { curatedCount: curated.length }));

  const completedAt = nowIso();
  const latencyMs = Date.now() - runStart;
  const tokenCount = decisions.reduce(
    (sum, decision) => sum + decision.instrumentation.estimatedPromptTokens,
    0,
  );

  return {
    id: `airun_${crypto.randomUUID()}`,
    kind,
    trigger,
    status: "succeeded",
    provider: {
      name: "deterministic",
      model: "deterministic-synthetic-v0",
      temperature: 0,
    },
    promptRefs,
    input: {
      accountId: account?.id || null,
      messageCount: scopedMessages.length,
      pipeline: kind,
      corpusHash: hashValue(scopedMessages.map((message) => message.id)),
      briefingFlow: briefingMemory?.mode || (previousBriefing ? "iterative" : "cold_start"),
      messageSelection: briefingMemory
        ? {
            mode: briefingMemory.mode,
            since: briefingMemory.since,
            includedMessageIds: briefingMemory.includedMessageIds,
            newMessageIds: briefingMemory.newMessageIds,
            carryOverMessageIds: briefingMemory.carryOverMessageIds,
            resolvedPreviousMessageIds: briefingMemory.resolvedPreviousMessageIds,
          }
        : null,
      previousBriefing: previousBriefing
        ? {
            id: previousBriefing.id || null,
            generatedAt: previousBriefing.generatedAt || null,
            hash: hashValue({
              text: previousBriefing.text,
              counts: previousBriefing.counts,
              messageIds: previousBriefing.messageIds,
            }),
          }
        : null,
      messageHashes: decisions.map((decision) => ({
        messageId: decision.messageId,
        inputHash: decision.instrumentation.inputHash,
      })),
    },
    output: {
      decisions,
      curatedMessageIds: curated.map((decision) => decision.messageId),
      topTodayMessageIds: curated.slice(0, 8).map((decision) => decision.messageId),
      ...(includeBriefing
        ? { briefing: buildInboxBriefing(decisions, { previousBriefing, memory: briefingMemory }) }
        : {}),
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
    llmCalls: [],
    startedAt,
    completedAt,
    createdAt: completedAt,
  };
}

async function runOllamaBriefProseCall({ run, config, prompt, proseFallback }) {
  const started = Date.now();
  const inputHash = promptInputHash(prompt);
  try {
    const result = await generateBriefingProseWithOllama({
      config,
      prompt,
      proseFallback,
    });
    const status = result.meta.fallback ? "fallback" : "succeeded";
    recordLlmCall(run, {
      pipeline: "daily_brief",
      stage: "brief_prose",
      provider: "ollama",
      status,
      model: result.meta.model || config.ollama.model,
      requestedModel: config.ollama.model,
      temperature: config.ollama.temperature,
      promptId: prompt.id,
      promptVersion: prompt.version,
      promptHash: prompt.hash,
      contractHash: prompt.contractHash,
      inputHash,
      outputHash: hashValue(result.text.slice(0, 8000)),
      inputMessageCount: run.input?.messageCount || 0,
      outputMessageCount: 0,
      attempts: result.meta.attempts,
      latencyMs: result.meta.latencyMs,
      promptEvalCount: result.meta.promptEvalCount,
      evalCount: result.meta.evalCount,
      thinkingChars: result.meta.thinkingChars,
      fallback: Boolean(result.meta.fallback),
      fallbackReason: result.meta.fallbackReason || null,
      ...llmTracePayloadFromPrompt(config, prompt, result.text),
    });
    return result;
  } catch (error) {
    const latencyMs = Date.now() - started;
    const message = publicError(error);
    recordLlmCall(run, {
      pipeline: "daily_brief",
      stage: "brief_prose",
      provider: "ollama",
      status: "fallback",
      model: config.ollama.model,
      requestedModel: config.ollama.model,
      temperature: config.ollama.temperature,
      promptId: prompt.id,
      promptVersion: prompt.version,
      promptHash: prompt.hash,
      contractHash: prompt.contractHash,
      inputHash,
      outputHash: hashValue(proseFallback.slice(0, 8000)),
      inputMessageCount: run.input?.messageCount || 0,
      outputMessageCount: 0,
      attempts: Math.max(1, Number(config.ai.maxRetries || 0) + 1),
      latencyMs,
      promptEvalCount: 0,
      evalCount: 0,
      thinkingChars: 0,
      fallback: true,
      fallbackReason: "provider_error",
      error: message,
      ...llmTracePayloadFromPrompt(config, prompt, proseFallback),
    });
    return { text: proseFallback, meta: { fallback: true, fallbackReason: "provider_error", attempts: 1 } };
  }
}

async function runOllamaBriefReconcileProseCall({ run, config, prompt, proseFallback }) {
  const started = Date.now();
  const inputHash = promptInputHash(prompt);
  try {
    const result = await generateBriefingProseWithOllama({
      config,
      prompt,
      proseFallback,
    });
    const status = result.meta.fallback ? "fallback" : "succeeded";
    recordLlmCall(run, {
      pipeline: "daily_brief",
      stage: "brief_reconcile",
      provider: "ollama",
      status,
      model: result.meta.model || config.ollama.model,
      requestedModel: config.ollama.model,
      temperature: config.ollama.temperature,
      promptId: prompt.id,
      promptVersion: prompt.version,
      promptHash: prompt.hash,
      contractHash: prompt.contractHash,
      inputHash,
      outputHash: hashValue(result.text.slice(0, 8000)),
      inputMessageCount: 0,
      outputMessageCount: 0,
      attempts: result.meta.attempts,
      latencyMs: result.meta.latencyMs,
      promptEvalCount: result.meta.promptEvalCount,
      evalCount: result.meta.evalCount,
      thinkingChars: result.meta.thinkingChars,
      fallback: Boolean(result.meta.fallback),
      fallbackReason: result.meta.fallbackReason || null,
      ...llmTracePayloadFromPrompt(config, prompt, result.text),
    });
    return result;
  } catch (error) {
    recordLlmCall(run, {
      pipeline: "daily_brief",
      stage: "brief_reconcile",
      provider: "ollama",
      status: "failed",
      model: config.ollama.model,
      requestedModel: config.ollama.model,
      temperature: config.ollama.temperature,
      promptId: prompt.id,
      promptVersion: prompt.version,
      promptHash: prompt.hash,
      contractHash: prompt.contractHash,
      inputHash,
      inputMessageCount: 0,
      outputMessageCount: 0,
      attempts: Math.max(1, Number(config.ai.maxRetries || 0) + 1),
      latencyMs: Date.now() - started,
      promptEvalCount: 0,
      evalCount: 0,
      thinkingChars: 0,
      error: publicError(error),
      ...llmTracePayloadFromPrompt(config, prompt, proseFallback),
    });
    return { text: proseFallback, meta: { fallback: true, fallbackReason: "provider_error" } };
  }
}

async function applyOllamaProvider(
  run,
  scopedMessages,
  config,
  previousBriefing = null,
  memory = null,
  {
    briefingOnly = false,
    generateBriefing = true,
    sentMail = [],
    threadCorpusMessages = null,
  } = {},
) {
  const started = Date.now();
  const fallbackById = new Map(run.output.decisions.map((decision) => [decision.messageId, decision]));
  const decisions = [];
  const modelMetrics = {
    promptEvalCount: 0,
    evalCount: 0,
    thinkingChars: 0,
    briefingPromptEvalCount: 0,
    briefingEvalCount: 0,
    briefingThinkingChars: 0,
  };
  const classifyMessages = !briefingOnly && Boolean(config.ai.ollamaClassifyMessages);
  const requestedClassificationModel = classificationModel(config);
  let classificationResponseModel = null;
  aiDebugLog("ollama provider selected", {
    messageCount: scopedMessages.length,
    host: config.ollama.host,
    briefingModel: config.ollama.model,
    classificationModel: requestedClassificationModel,
    think: config.ollama.think,
    classificationThink: config.ollama.classificationThink,
    temperature: config.ollama.temperature,
    classificationTemperature: config.ollama.classificationTemperature,
    timeoutMs: config.ai.timeoutMs,
    maxRetries: config.ai.maxRetries,
    classifyMessages,
    briefingOnly,
    generateBriefing,
    briefingFlow: memory?.mode || (previousBriefing ? "iterative" : "cold_start"),
    since: memory?.since || null,
    apiKey: config.ollama.apiKey ? "set (redacted)" : "unset",
  });

  if (!classifyMessages) {
    decisions.push(...run.output.decisions);
    aiDebugLog("ollama message classification skipped", {
      reason: "briefing-only run; deterministic local decisions used as feature store.",
      decisionCount: decisions.length,
    });
  } else {
    for (const message of scopedMessages) {
      const fallback = fallbackById.get(message.id);
      if (!fallback) continue;

      const messageForLlm = {
        ...message,
        bodyText: effectiveClassificationBodyText(message, threadCorpusMessages || []),
      };

      let result;
      const classificationStarted = Date.now();
      try {
        result = await classifyWithOllama({ config, message: messageForLlm, fallback });
      } catch (error) {
        recordLlmCall(run, {
          pipeline: "classification_batch",
          stage: "message_classification",
          provider: "ollama",
          status: "failed",
          model: requestedClassificationModel,
          requestedModel: requestedClassificationModel,
          temperature: config.ollama.classificationTemperature,
          inputHash: fallback.instrumentation.inputHash,
          inputMessageCount: 1,
          outputMessageCount: 0,
          attempts: Math.max(1, Number(config.ai.maxRetries || 0) + 1),
          latencyMs: Date.now() - classificationStarted,
          promptEvalCount: 0,
          evalCount: 0,
          thinkingChars: 0,
          error: publicError(error),
          ...llmTracePayloadFromClassification(
            config,
            buildClassificationMessages(messageForLlm, fallback),
            null,
          ),
        });
        throw error;
      }
      recordLlmCall(run, {
        pipeline: "classification_batch",
        stage: "message_classification",
        provider: "ollama",
        status: "succeeded",
        model: result.meta.model || requestedClassificationModel,
        requestedModel: result.meta.requestedModel || requestedClassificationModel,
        temperature: config.ollama.classificationTemperature,
        inputHash: fallback.instrumentation.inputHash,
        outputHash: outputHash(result.decision),
        inputMessageCount: 1,
        outputMessageCount: 1,
        attempts: result.meta.attempts,
        latencyMs: result.meta.latencyMs,
        promptEvalCount: result.meta.promptEvalCount,
        evalCount: result.meta.evalCount,
        thinkingChars: result.meta.thinkingChars,
        ...llmTracePayloadFromClassification(
          config,
          buildClassificationMessages(messageForLlm, fallback),
          result.decision,
        ),
      });
      modelMetrics.promptEvalCount += result.meta.promptEvalCount;
      modelMetrics.evalCount += result.meta.evalCount;
      modelMetrics.thinkingChars += result.meta.thinkingChars;
      classificationResponseModel = result.meta.model || requestedClassificationModel;
      decisions.push({
        ...fallback,
        ...result.decision,
        providerMeta: {
          name: "ollama",
          model: result.meta.model,
          requestedModel: result.meta.requestedModel || requestedClassificationModel,
          latencyMs: result.meta.latencyMs,
          thinkingChars: result.meta.thinkingChars,
          attempts: result.meta.attempts,
        },
        instrumentation: {
          ...fallback.instrumentation,
          provider: "ollama",
          model: result.meta.model,
        },
      });
    }
  }

  refreshRunOutput(run, decisions, previousBriefing, memory, { includeBriefing: generateBriefing });
  let briefingResponseModel = null;
  if (generateBriefing && decisions.length) {
    const deterministicBriefing = run.output.briefing;
    const proseFallback = String(deterministicBriefing?.text || "").trim();
    const briefingStart = Date.now();
    const briefingPrompt = renderBriefingPromptForDecisions(decisions, previousBriefing, memory);
    aiDebugLog("ollama briefing context", {
      promptId: briefingPrompt.id,
      promptVersion: briefingPrompt.version,
      promptUserChars: briefingPrompt.user.length,
      promptUserPreview: briefingPrompt.user.slice(0, 1600),
    });
    const prosePass = await runOllamaBriefProseCall({
      run,
      config,
      prompt: briefingPrompt,
      proseFallback,
    });
    modelMetrics.briefingPromptEvalCount += prosePass.meta.promptEvalCount;
    modelMetrics.briefingEvalCount += prosePass.meta.evalCount;
    modelMetrics.briefingThinkingChars += prosePass.meta.thinkingChars;
    briefingResponseModel = prosePass.meta.model || null;
    let proseDraft = prosePass.text;
    let finalPrompt = briefingPrompt;
    let lastPassFallback = Boolean(prosePass.meta.fallback);
    run.spans.push(
      createSpan("model.ollama_briefing_prose", briefingStart, {
        pipeline: "daily_brief",
        status: prosePass.meta.fallback ? "degraded" : "ok",
        model: prosePass.meta.model,
        attempts: prosePass.meta.attempts,
        fallback: Boolean(prosePass.meta.fallback),
        fallbackReason: prosePass.meta.fallbackReason || null,
      }),
    );

    if (sentMail.length) {
      const reconcileStart = Date.now();
      const reconcilePrompt = renderPrompt("mail-briefing-reconcile", {
        briefing: proseDraft,
        sentMail,
      });
      const reconcilePass = await runOllamaBriefReconcileProseCall({
        run,
        config,
        prompt: reconcilePrompt,
        proseFallback: proseDraft,
      });
      proseDraft = reconcilePass.text;
      finalPrompt = reconcilePrompt;
      lastPassFallback = Boolean(reconcilePass.meta.fallback);
      modelMetrics.briefingPromptEvalCount += reconcilePass.meta.promptEvalCount || 0;
      modelMetrics.briefingEvalCount += reconcilePass.meta.evalCount || 0;
      modelMetrics.briefingThinkingChars += reconcilePass.meta.thinkingChars || 0;
      briefingResponseModel = reconcilePass.meta.model || briefingResponseModel;
      run.spans.push(
        createSpan("model.ollama_briefing_reconcile", reconcileStart, {
          pipeline: "daily_brief",
          status: reconcilePass.meta.fallback ? "degraded" : "ok",
          model: reconcilePass.meta.model,
          attempts: reconcilePass.meta.attempts,
          fallback: Boolean(reconcilePass.meta.fallback),
          fallbackReason: reconcilePass.meta.fallbackReason || null,
        }),
      );
    }

    // Display + memory text both come from the (post-reconcile) prose. Counts,
    // narrative, messageIds, memory, and carryOver remain deterministic from
    // buildInboxBriefing — no second LLM pass needed to stamp them.
    const finalText = typeof proseDraft === "string" && proseDraft.trim()
      ? proseDraft
      : deterministicBriefing.text;
    run.output.briefing = {
      ...deterministicBriefing,
      text: finalText,
      source: lastPassFallback ? "ai-loop-fallback" : "ollama",
      model: briefingResponseModel || deterministicBriefing.model,
      prompt: {
        id: finalPrompt.id,
        version: finalPrompt.version,
        hash: finalPrompt.hash,
        promptHash: finalPrompt.promptHash,
        modelBindingHash: finalPrompt.modelBindingHash,
        contractHash: finalPrompt.contractHash,
      },
    };
  }
  run.provider = {
    name: "ollama",
    model:
      briefingResponseModel ||
      classificationResponseModel ||
      (generateBriefing ? config.ollama.model : requestedClassificationModel),
    requestedModel: generateBriefing ? config.ollama.model : requestedClassificationModel,
    briefingModel: config.ollama.model,
    classificationModel: requestedClassificationModel,
    temperature: config.ollama.temperature,
    think: config.ollama.think,
    host: config.ollama.host,
    classifyMessages,
  };
  aiDebugLog("ollama provider completed", {
    provider: run.provider,
    metrics: {
      providerLatencyMs: Date.now() - started,
      classifyMessages,
      generateBriefing,
      decisionCount: decisions.length,
      ollamaPromptEvalCount: modelMetrics.promptEvalCount,
      ollamaEvalCount: modelMetrics.evalCount,
      ollamaBriefingPromptEvalCount: modelMetrics.briefingPromptEvalCount,
      ollamaBriefingEvalCount: modelMetrics.briefingEvalCount,
    },
  });
  run.metrics = {
    ...run.metrics,
    latencyMs: Date.now() - new Date(run.startedAt).getTime(),
    providerLatencyMs: Date.now() - started,
    ollamaPromptEvalCount: modelMetrics.promptEvalCount,
    ollamaEvalCount: modelMetrics.evalCount,
    ollamaThinkingChars: modelMetrics.thinkingChars,
    ollamaBriefingPromptEvalCount: modelMetrics.briefingPromptEvalCount,
    ollamaBriefingEvalCount: modelMetrics.briefingEvalCount,
    ollamaBriefingThinkingChars: modelMetrics.briefingThinkingChars,
  };
  run.spans.push(
    createSpan("model.ollama_chat", started, {
      pipeline: generateBriefing ? "daily_brief" : "classification_batch",
      status: (run.llmCalls || []).some((call) => call.fallback || call.status === "failed")
        ? "degraded"
        : "ok",
      decisionCount: decisions.length,
      llmCallCount: run.llmCalls?.length || 0,
      model: generateBriefing ? config.ollama.model : requestedClassificationModel,
      think: String(generateBriefing ? config.ollama.think : config.ollama.classificationThink),
    }),
  );
  return run;
}

export async function runAiLoop({
  userId,
  limit,
  trigger = "manual",
  mode,
  briefingOnly = true,
  generateBriefing = true,
} = {}) {
  if (!userId) throw new Error("runAiLoop requires a userId");
  const config = loadConfig();
  const store = await readStoreFor(userId);
  const account = (await getPrimarySourceConnection(userId)) || store.accounts[0] || null;
  const effectiveLimit = boundedMessageLimit(limit, config);
  const allMessages = [...(store.messages || [])]
    .filter((message) => !account?.id || message.accountId === account.id)
    .filter((message) => !isSentByMailbox(message, account))
    .sort((a, b) => messageDeliveredAtMs(b) - messageDeliveredAtMs(a));
  const feedbackByMessage = new Map();
  for (const entry of store.feedback || []) {
    if (!feedbackByMessage.has(entry.messageId)) feedbackByMessage.set(entry.messageId, []);
    feedbackByMessage.get(entry.messageId).push(entry);
  }
  const accountMessagesForThread = [...(store.messages || [])].filter(
    (message) => !account?.id || message.accountId === account.id,
  );
  const isJunkMessage = (message) => {
    const classification = applyFeedbackToClassification(
      classifyMessage(
        {
          ...message,
          bodyText: effectiveClassificationBodyText(message, accountMessagesForThread),
        },
        account || {},
      ),
      feedbackByMessage.get(message.id) || [],
    );
    return classification.possibleJunk;
  };
  const nonJunkMessages = briefingOnly
    ? allMessages.filter((message) => !isJunkMessage(message))
    : allMessages;
  const junkFiltered = allMessages.length - nonJunkMessages.length;
  // Briefings are keyed by source connection id (run.input.accountId), not auth userId.
  const previousBriefing = latestInboxBriefing(store, account?.id || null);
  const classificationSelection = !generateBriefing;
  const selection = classificationSelection
    ? {
        mode: "classification_batch",
        selected: selectMessagesForClassificationBatch(store, account, effectiveLimit),
        newMessages: [],
        carryOverMessages: [],
        since: null,
        previousBriefingId: null,
        previousGeneratedAt: null,
        resolvedPreviousMessageIds: [],
        unresolvedPreviousMessageIds: [],
      }
    : selectMessagesForBriefing({
        messages: nonJunkMessages,
        feedback: store.feedback,
        previousBriefing,
        mode: mode || config.ai.briefingMode,
        limit: effectiveLimit,
      });
  const messages = selection.selected;
  const contextBriefing = selection.mode === "iterative" ? previousBriefing : null;
  const sentMail = generateBriefing ? sentMailContextForReconciliation(store, account, 20) : [];
  const threadReplyResolvedIds = buildThreadReplyResolvedMessageIds(accountMessagesForThread, account);
  aiDebugLog("ollama run", {
    effectiveLimit,
    briefingFlow: selection.mode,
    since: selection.since,
    allMessages: allMessages.length,
    junkFiltered,
    selectedMessages: messages.length,
    newMessages: selection.newMessages.length,
    carryOverMessages: selection.carryOverMessages.length,
    resolvedPreviousMessages: selection.resolvedPreviousMessageIds.length,
    ollama: {
      host: config.ollama.host,
      model: config.ollama.model,
      classificationModel: config.ollama.classificationModel,
      think: config.ollama.think,
      classificationThink: config.ollama.classificationThink,
      temperature: config.ollama.temperature,
      classificationTemperature: config.ollama.classificationTemperature,
      apiKey: config.ollama.apiKey ? "set (redacted)" : "unset",
    },
  });
  const run = runAiLoopOnMessages({
    account,
    messages,
    feedback: store.feedback,
    trigger,
    kind: generateBriefing ? "daily-brief" : "classification-batch",
    includeBriefing: generateBriefing,
    previousBriefing: contextBriefing,
    briefingSelection: generateBriefing ? selection : null,
    threadReplyResolvedIds,
    threadCorpusMessages: accountMessagesForThread,
  });
  run.promptRefs = getPromptSnapshots({
    "mail-message-classification": {
      provider: "ollama",
      model: classificationModel(config),
      temperature: config.ollama.classificationTemperature,
      think: config.ollama.classificationThink,
    },
    ...(generateBriefing
      ? {
          "mail-briefing-prose": {
            provider: "ollama",
            model: config.ollama.model,
            temperature: config.ollama.temperature,
            think: config.ollama.think,
          },
          "mail-briefing-reconcile": {
            provider: "ollama",
            model: config.ollama.model,
            temperature: config.ollama.temperature,
            think: config.ollama.think,
          },
        }
      : {}),
  });
  console.log("[ai run] starting", {
    trigger,
    briefingOnly,
    generateBriefing,
    briefingFlow: selection.mode,
    selectedMessages: messages.length,
    junkFiltered,
    ollama: {
      host: config.ollama.host,
      model: config.ollama.model,
      classificationModel: config.ollama.classificationModel,
      temperature: config.ollama.temperature,
      classificationTemperature: config.ollama.classificationTemperature,
      think: config.ollama.think,
      classificationThink: config.ollama.classificationThink,
    },
    envOllamaModel: process.env.OLLAMA_MODEL ?? "(not set)",
    envOllamaClassificationModel: process.env.OLLAMA_CLASSIFICATION_MODEL ?? "(not set)",
  });
  const ollamaStart = Date.now();
  await applyOllamaProvider(run, messages, config, contextBriefing, run.output.briefing?.memory, {
    briefingOnly,
    generateBriefing,
    sentMail,
    threadCorpusMessages: accountMessagesForThread,
  });
  console.log("[ai run] finished", {
    runId: run.id,
    requestedModel: config.ollama.model,
    requestedClassificationModel: config.ollama.classificationModel,
    reportedProvider: run.provider.name,
    reportedModel: run.provider.model,
    latencyMs: Date.now() - ollamaStart,
    decisions: run.output.decisions.length,
    briefMessageIds: run.output.briefing?.messageIds?.length || 0,
  });
  run.observability = await traceAiRun(run);
  await recordAiRun(run);
  return run;
}

/**
 * Daily brief pipeline. Selects non-junk messages, builds the deterministic feature
 * store, then issues a single LLM call to draft the brief. Idempotent — each call
 * persists a new run with kind="daily-brief".
 */
export async function runDailyBrief({ userId, limit, mode, trigger = "manual" } = {}) {
  if (!userId) throw new Error("runDailyBrief requires a userId");
  return runAiLoop({
    userId,
    limit,
    mode,
    trigger,
    briefingOnly: true,
    generateBriefing: true,
  });
}

/**
 * Classification batch pipeline. Selects messages from the classification backlog
 * (pending/stale/failed), runs them through the classification LLM (or deterministic
 * fallback if classification LLM is disabled), and updates classificationState. Does
 * not generate or persist a brief. Each call persists a run with kind="classification-batch".
 */
export async function runClassificationBatch({ userId, limit, trigger = "manual" } = {}) {
  if (!userId) throw new Error("runClassificationBatch requires a userId");
  return runAiLoop({
    userId,
    limit,
    trigger,
    briefingOnly: false,
    generateBriefing: false,
  });
}
