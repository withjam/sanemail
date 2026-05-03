import crypto from "node:crypto";
import { loadConfig } from "../config.mjs";
import { classifyMessage } from "../classifier.mjs";
import { getPrimaryAccount, latestInboxBriefing, readStore, recordAiRun } from "../store.mjs";
import { classifyWithOllama, generateBriefingWithOllama } from "./ollama.mjs";
import { traceAiRun } from "./phoenix.mjs";
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
    deliveredAt: message.date,
    category: classification.category,
    needsReply: classification.needsReply,
    possibleJunk: classification.possibleJunk,
    automated: classification.automated,
    direct: classification.direct,
    confidence: confidenceFor(classification, actions, deadlines),
    recsysScore: rank.recsysScore,
    suppressFromToday: rank.suppressFromToday,
    temporal: {
      deliveredAt: message.date,
      ageHours: messageAgeHours,
      recent: messageAgeHours <= 24,
      within7Days: messageAgeHours <= 168,
    },
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
  return new Set([
    ...((previousBriefing?.callouts || []).flatMap((callout) => [
      callout.messageId,
      ...(callout.messageIds || []),
    ])),
    ...(previousBriefing?.messageIds || []),
  ].filter(Boolean));
}

function stillRelevantFromPrevious(previousBriefing, decisions, limit = 2) {
  const previousIds = idsFromPreviousBriefing(previousBriefing);
  if (!previousIds.size) return [];

  return sortForBriefing(
    decisions.filter(
      (decision) =>
        previousIds.has(decision.messageId) &&
        !decision.possibleJunk &&
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

function buildBriefingCallouts({ needsReplyLast7, carryOver, previousBriefing }) {
  const previousIds = idsFromPreviousBriefing(previousBriefing);
  const callouts = [];
  const used = new Set();

  for (const decision of carryOver) {
    used.add(decision.messageId);
    callouts.push({
      id: `callout-${decision.messageId}`,
      kind: "carry_over",
      label: "Need attention",
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
    callouts.push({
      id: `callout-${decision.messageId}`,
      kind: seenBefore ? "attention" : "new_attention",
      label: "Need attention",
      title: decision.subject.replace(/[?.!]+$/, ""),
      body: calloutBody(decision),
      messageId: decision.messageId,
      messageIds: [decision.messageId],
      priority: callouts.length + 1,
      deliveredAt: decisionDeliveredAt(decision),
    });
    used.add(decision.messageId);
    if (callouts.length >= 4) break;
  }

  return callouts.slice(0, 4);
}

function buildBriefingNarrative({
  callouts,
}) {
  const topTitles = callouts.map((callout) => callout.title);
  const status = callouts.length
    ? `Your inbox is mostly calm. I would open ${joinReadable(topTitles)} first; those are the items most likely to need your attention right now.`
    : `Your inbox looks calm right now. I do not see anything that needs your attention before you are ready to scan the rest.`;

  return {
    status,
    needToKnow: "",
    mightBeMissing: "",
    needsAttention: "",
  };
}

function buildBriefingState(decisions = [], previousBriefing = null) {
  const visible = decisions.filter((decision) => !decision.possibleJunk);
  const needsReply = decisions.filter(
    (decision) => decision.needsReply && !decision.possibleJunk && !decision.suppressFromToday,
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
  const carryOver = stillRelevantFromPrevious(previousBriefing, decisions);
  const replySubjects = summarizeSubjects(needsReplyLast7, () => true, 3);
  const upcomingSubjects = summarizeSubjects(upcoming, () => true, 2);
  const recentSubjects = summarizeSubjects(recent, () => true, 2);
  const carryOverSubjects = carryOver.map((decision) => decision.subject.replace(/[?.!]+$/, ""));
  const callouts = buildBriefingCallouts({ needsReplyLast7, carryOver, previousBriefing });
  const narrative = buildBriefingNarrative({
    callouts,
  });

  return {
    visible,
    needsReply,
    recent,
    last7Days,
    needsReplyLast7,
    upcoming,
    automated,
    hidden,
    carryOver,
    replySubjects,
    upcomingSubjects,
    recentSubjects,
    carryOverSubjects,
    callouts,
    narrative,
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
    actions: decision.extracted?.actions || [],
    deadlines: decision.extracted?.deadlines || [],
    entities: decision.extracted?.entities || [],
    reasons: decision.reasons || [],
    rank: decision.recsysScore,
  };
}

function briefingContextFromState(state, previousBriefing = null) {
  return {
    instructionContext:
      "Use this as private context for deciding what matters. The user should only see the conversational summary and linked callouts.",
    recencyPolicy:
      "Prefer recent messages, include items from the past 7 days when still relevant, and use prior briefing items only to avoid neglecting important reminders.",
    candidateCallouts: state.callouts.map((callout) => ({
      kind: callout.kind,
      label: callout.label,
      title: callout.title,
      body: callout.body,
      messageId: callout.messageId,
      messageIds: callout.messageIds,
      deliveredAt: callout.deliveredAt,
    })),
    recentMessages: sortForBriefing(state.recent).slice(0, 8).map(decisionBriefingItem),
    attentionCandidates: sortForBriefing(state.needsReplyLast7).slice(0, 12).map(decisionBriefingItem),
    upcomingCandidates: sortForBriefing(state.upcoming).slice(0, 10).map(decisionBriefingItem),
    mayBeNeglected: sortForBriefing([
      ...state.carryOver,
      ...state.needsReplyLast7.filter((decision) => decisionAgeHours(decision) > 24),
    ]).slice(0, 8).map(decisionBriefingItem),
    backgroundContext: sortForBriefing(state.automated).slice(0, 6).map(decisionBriefingItem),
    hiddenContext: sortForBriefing(state.hidden).slice(0, 4).map(decisionBriefingItem),
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

function renderBriefingPromptFromState(state) {
  const context = briefingContextFromState(state);
  return renderPrompt("mail-briefing", {
    recent: state.recentSubjects,
    last7Days: state.last7Days.length,
    needsReply: state.replySubjects,
    upcoming: state.upcomingSubjects,
    carryOver: state.carryOverSubjects,
    callouts: state.callouts.map(
      (callout) => `${callout.label}: ${callout.title} [messageId=${callout.messageId}] ${callout.body}`,
    ),
    informational: state.automated.map((decision) => decision.subject).slice(0, 3),
    hidden: state.hidden.map((decision) => decision.subject).slice(0, 3),
    context,
  });
}

function renderBriefingPromptForDecisions(decisions = [], previousBriefing = null) {
  const state = buildBriefingState(decisions, previousBriefing);
  const context = briefingContextFromState(state, previousBriefing);
  return renderPrompt("mail-briefing", {
    recent: state.recentSubjects,
    last7Days: state.last7Days.length,
    needsReply: state.replySubjects,
    upcoming: state.upcomingSubjects,
    carryOver: state.carryOverSubjects,
    callouts: state.callouts.map(
      (callout) => `${callout.label}: ${callout.title} [messageId=${callout.messageId}] ${callout.body}`,
    ),
    informational: state.automated.map((decision) => decision.subject).slice(0, 3),
    hidden: state.hidden.map((decision) => decision.subject).slice(0, 3),
    context,
  });
}

export function buildInboxBriefing(decisions = [], { previousBriefing = null } = {}) {
  const state = buildBriefingState(decisions, previousBriefing);
  const {
    visible,
    needsReply,
    recent,
    last7Days,
    needsReplyLast7,
    upcoming,
    automated,
    hidden,
    carryOver,
    carryOverSubjects,
    callouts,
    narrative,
  } = state;

  let text;
  if (!decisions.length) {
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
  const prompt = renderBriefingPromptFromState(state);

  return {
    text,
    narrative,
    callouts,
    generatedAt: new Date().toISOString(),
    source: "ai-loop",
    model: "deterministic-briefing-v0",
    prompt: {
      id: prompt.id,
      version: prompt.version,
      hash: prompt.hash,
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
    messageIds: idsFor(visible, 8),
    carryOver: {
      previousBriefingId: previousBriefing?.id || null,
      previousGeneratedAt: previousBriefing?.generatedAt || null,
      messageIds: carryOver.map((decision) => decision.messageId),
      subjects: carryOverSubjects,
    },
  };
}

function refreshRunOutput(run, decisions, previousBriefing = null) {
  const curated = rankDecisions(decisions);
  const tokenCount = decisions.reduce(
    (sum, decision) => sum + decision.instrumentation.estimatedPromptTokens,
    0,
  );

  run.output = {
    decisions,
    curatedMessageIds: curated.map((decision) => decision.messageId),
    topTodayMessageIds: curated.slice(0, 8).map((decision) => decision.messageId),
    briefing: buildInboxBriefing(decisions, { previousBriefing }),
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
  previousBriefing = null,
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
      briefing: buildInboxBriefing(decisions, { previousBriefing }),
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

async function applyOllamaProvider(run, scopedMessages, config, previousBriefing = null) {
  const started = Date.now();
  const fallbackById = new Map(run.output.decisions.map((decision) => [decision.messageId, decision]));
  const decisions = [];
  const errors = [];
  const modelMetrics = {
    promptEvalCount: 0,
    evalCount: 0,
    thinkingChars: 0,
    briefingPromptEvalCount: 0,
    briefingEvalCount: 0,
    briefingThinkingChars: 0,
  };
  const classifyMessages = Boolean(config.ai.ollamaClassifyMessages);
  aiDebugLog("ollama provider selected", {
    messageCount: scopedMessages.length,
    host: config.ollama.host,
    model: config.ollama.model,
    think: config.ollama.think,
    temperature: config.ollama.temperature,
    fallbackToMock: config.ai.fallbackToMock,
    timeoutMs: config.ai.timeoutMs,
    maxRetries: config.ai.maxRetries,
    classifyMessages,
    apiKey: config.ollama.apiKey ? "set (redacted)" : "unset",
  });

  if (!classifyMessages) {
    decisions.push(...run.output.decisions);
    aiDebugLog("ollama message classification skipped", {
      reason: "AI_OLLAMA_CLASSIFY_MESSAGES is not enabled; using deterministic synthetic decisions as the briefing feature store.",
      decisionCount: decisions.length,
    });
  } else {
    for (const message of scopedMessages) {
      const fallback = fallbackById.get(message.id);
      if (!fallback) continue;

      try {
        const result = await classifyWithOllama({ config, message, fallback });
        modelMetrics.promptEvalCount += result.meta.promptEvalCount;
        modelMetrics.evalCount += result.meta.evalCount;
        modelMetrics.thinkingChars += result.meta.thinkingChars;
        decisions.push({
          ...fallback,
          ...result.decision,
          providerMeta: {
            name: "ollama",
            model: result.meta.model,
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
      } catch (error) {
        errors.push({
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error),
        });
        aiDebugLog("ollama classification fallback", errors[errors.length - 1]);
        if (!config.ai.fallbackToMock) throw error;
        decisions.push({
          ...fallback,
          providerMeta: {
            name: "mock-local",
            model: run.provider.model,
            fallbackReason: errors[errors.length - 1].error,
          },
        });
      }
    }
  }

  refreshRunOutput(run, decisions, previousBriefing);
  const classificationErrorCount = errors.length;
  let briefingUsedOllama = false;
  if (decisions.length) {
    const briefingStart = Date.now();
    try {
      const briefingPrompt = renderBriefingPromptForDecisions(decisions, previousBriefing);
      aiDebugLog("ollama briefing context", {
        promptId: briefingPrompt.id,
        promptVersion: briefingPrompt.version,
        promptUserChars: briefingPrompt.user.length,
        promptUserPreview: briefingPrompt.user.slice(0, 1600),
      });
      const result = await generateBriefingWithOllama({
        config,
        prompt: briefingPrompt,
        fallback: run.output.briefing,
      });
      modelMetrics.briefingPromptEvalCount += result.meta.promptEvalCount;
      modelMetrics.briefingEvalCount += result.meta.evalCount;
      modelMetrics.briefingThinkingChars += result.meta.thinkingChars;
      run.output.briefing = result.briefing;
      briefingUsedOllama = true;
      run.spans.push(
        createSpan("model.ollama_briefing", briefingStart, {
          model: result.meta.model,
          attempts: result.meta.attempts,
          calloutCount: result.briefing.callouts?.length || 0,
        }),
      );
    } catch (error) {
      errors.push({
        messageId: "__briefing__",
        error: error instanceof Error ? error.message : String(error),
      });
      aiDebugLog("ollama briefing fallback", errors[errors.length - 1]);
      run.spans.push(
        createSpan("model.ollama_briefing", briefingStart, {
          model: config.ollama.model,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      if (!config.ai.fallbackToMock) throw error;
    }
  }
  const classificationSuccessCount = classifyMessages ? Math.max(0, decisions.length - classificationErrorCount) : 0;
  const providerUsedOllama = briefingUsedOllama || classificationSuccessCount > 0;
  const usedOnlyFallback = !providerUsedOllama;
  run.provider = {
    name: providerUsedOllama ? "ollama" : "mock-local",
    model: providerUsedOllama ? config.ollama.model : "deterministic-synthetic-v0",
    requestedProvider: "ollama",
    requestedModel: config.ollama.model,
    temperature: config.ollama.temperature,
    think: config.ollama.think,
    host: config.ollama.host,
    classifyMessages,
    fallbackToMock: config.ai.fallbackToMock,
    fallbackErrors: errors.slice(0, 5),
  };
  aiDebugLog("ollama provider completed", {
    provider: run.provider,
    metrics: {
      providerLatencyMs: Date.now() - started,
      classifyMessages,
      briefingUsedOllama,
      classificationSuccesses: classificationSuccessCount,
      classificationErrors: classificationErrorCount,
      totalErrors: errors.length,
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
      decisionCount: decisions.length,
      errorCount: errors.length,
      model: config.ollama.model,
      think: String(config.ollama.think),
    }),
  );
  return run;
}

export async function runAiLoop({ limit, trigger = "manual" } = {}) {
  const config = loadConfig();
  const store = await readStore();
  const account = (await getPrimaryAccount()) || store.accounts[0] || null;
  const effectiveLimit =
    limit === undefined && config.ai.provider === "ollama" ? config.ai.runLimit : limit;
  const messages = [...(store.messages || [])]
    .filter((message) => !account?.id || message.accountId === account.id)
    .sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime())
    .slice(0, effectiveLimit || undefined);
  aiDebugLog("provider decision", {
    requestedProvider: config.ai.provider,
    willCallOllama: config.ai.provider === "ollama",
    effectiveLimit,
    selectedMessages: messages.length,
    fallbackToMock: config.ai.fallbackToMock,
    ollama: {
      host: config.ollama.host,
      model: config.ollama.model,
      think: config.ollama.think,
      temperature: config.ollama.temperature,
      apiKey: config.ollama.apiKey ? "set (redacted)" : "unset",
    },
  });
  const previousBriefing = latestInboxBriefing(store, account?.id);
  const run = runAiLoopOnMessages({
    account,
    messages,
    feedback: store.feedback,
    trigger,
    previousBriefing,
  });
  if (config.ai.provider === "ollama") {
    await applyOllamaProvider(run, messages, config, previousBriefing);
  } else {
    run.provider.requestedProvider = config.ai.provider;
  }
  run.observability = await traceAiRun(run);
  await recordAiRun(run);
  return run;
}
