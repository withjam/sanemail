import { Ollama } from "ollama";
import { renderPrompt } from "./prompts.mjs";

function clientHost(host) {
  const normalized = host.replace(/\/+$/, "");
  if (normalized.endsWith("/api/chat")) return normalized.slice(0, -"/api/chat".length);
  if (normalized.endsWith("/api")) return normalized.slice(0, -"/api".length);
  return normalized;
}

function chatUrl(host) {
  return `${clientHost(host)}/api/chat`;
}

function debugEnabled() {
  return ["1", "true", "yes", "on"].includes(String(process.env.AI_DEBUG || "").toLowerCase());
}

function debugLog(label, value) {
  if (!debugEnabled()) return;
  console.log(`[ollama debug] ${label}`);
  console.log(JSON.stringify(value, null, 2));
}

function headers(config) {
  return {
    ...(config.ollama.apiKey
      ? { Authorization: `Bearer ${config.ollama.apiKey}` }
      : {}),
  };
}

function createClient(config, signal) {
  return new Ollama({
    host: clientHost(config.ollama.host),
    headers: headers(config),
    fetch: (url, options = {}) =>
      fetch(url, {
        ...options,
        signal: options.signal || signal,
      }),
  });
}

function parseJsonContent(content) {
  const trimmed = String(content || "").trim();
  if (!trimmed) throw new Error("Ollama returned an empty message.");

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw contentPreviewError(new Error("Ollama did not return JSON."), content);
    try {
      return JSON.parse(match[0]);
    } catch {
      throw contentPreviewError(error, content);
    }
  }
}

function contentPreviewError(error, content) {
  error.contentPreview = String(content || "").slice(0, 1600);
  return error;
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 8);
}

function normalizeCategory(value, fallback) {
  const normalized = String(value || "").trim().toLowerCase();
  const categories = {
    today: "Today",
    "needs reply": "Needs Reply",
    needs_reply: "Needs Reply",
    fyi: "FYI",
    "junk review": "Junk Review",
    junk_review: "Junk Review",
    "all mail": "All Mail",
    all_mail: "All Mail",
  };
  return categories[normalized] || fallback;
}

function normalizeDecision(payload, fallback) {
  const category = normalizeCategory(payload.category, fallback.category);
  const possibleJunk =
    typeof payload.possibleJunk === "boolean" ? payload.possibleJunk : fallback.possibleJunk;
  const automated = typeof payload.automated === "boolean" ? payload.automated : fallback.automated;
  const needsReply =
    typeof payload.needsReply === "boolean" ? payload.needsReply : fallback.needsReply;
  const actions = stringArray(payload.actions || payload.extracted?.actions);
  const deadlines = stringArray(payload.deadlines || payload.extracted?.deadlines);
  const entities = stringArray(payload.entities || payload.extracted?.entities);

  return {
    category,
    needsReply,
    possibleJunk,
    automated,
    confidence: Number(clamp(payload.confidence ?? fallback.confidence, 0, 1).toFixed(2)),
    recsysScore: Math.round(clamp(payload.recsysScore ?? fallback.recsysScore, 0, 100)),
    suppressFromToday:
      typeof payload.suppressFromToday === "boolean"
        ? payload.suppressFromToday
        : possibleJunk || automated,
    reasons: stringArray(payload.reasons).length ? stringArray(payload.reasons) : fallback.reasons,
    extracted: {
      actions: actions.length ? actions : fallback.extracted.actions,
      deadlines: deadlines.length ? deadlines : fallback.extracted.deadlines,
      entities: entities.length ? entities : fallback.extracted.entities,
      replyCue: needsReply ? "reply-likely" : null,
    },
  };
}

function stringValue(value, fallback = "") {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function normalizeNarrative(value, fallback = {}) {
  const narrative = value && typeof value === "object" ? value : {};
  return {
    status: stringValue(narrative.status, fallback.status || ""),
    needToKnow: stringValue(narrative.needToKnow, fallback.needToKnow || ""),
    mightBeMissing: stringValue(narrative.mightBeMissing, fallback.mightBeMissing || ""),
    needsAttention: stringValue(narrative.needsAttention, fallback.needsAttention || ""),
  };
}

function normalizeCallouts(payloadCallouts, fallbackCallouts = []) {
  const fallbackById = new Map(fallbackCallouts.map((callout) => [callout.messageId, callout]));
  const used = new Set();
  const normalized = [];

  for (const item of Array.isArray(payloadCallouts) ? payloadCallouts : []) {
    if (!item || typeof item !== "object") continue;
    const messageId = stringValue(item.messageId);
    const fallback = fallbackById.get(messageId);
    if (!messageId || !fallback || used.has(messageId)) continue;

    const kind = ["attention", "new_attention", "carry_over"].includes(item.kind)
      ? item.kind
      : fallback.kind;
    normalized.push({
      id: fallback.id,
      kind,
      label: "Need attention",
      title: stringValue(item.title, fallback.title),
      body: stringValue(item.body, fallback.body),
      messageId,
      messageIds: [messageId],
      priority: normalized.length + 1,
      deliveredAt: stringValue(item.deliveredAt, fallback.deliveredAt || ""),
    });
    used.add(messageId);
    if (normalized.length >= 4) break;
  }

  return normalized.length ? normalized : fallbackCallouts.slice(0, 4);
}

function normalizeBriefing(payload, fallback, model) {
  const narrative = normalizeNarrative(payload.narrative, fallback.narrative);
  const text = stringValue(payload.text, [
    narrative.status,
    narrative.needToKnow,
    narrative.mightBeMissing,
    narrative.needsAttention,
  ].filter(Boolean).join(" ") || fallback.text);

  return {
    ...fallback,
    text,
    narrative,
    callouts: normalizeCallouts(payload.callouts, fallback.callouts || []),
    generatedAt: new Date().toISOString(),
    source: "ai-loop",
    model,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function statusFromError(error) {
  return error?.status ?? error?.status_code ?? error?.response?.status;
}

function retryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = new Date(value).getTime();
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - Date.now());
}

function retryDelayMs(error, attempt) {
  if (Number.isFinite(error?.retryAfterMs)) return error.retryAfterMs;
  const status = statusFromError(error);
  const overloaded = status === 429 || status === 503;
  const base = overloaded ? 5000 : 1000;
  const max = overloaded ? 60000 : 12000;
  const jitter = Math.floor(Math.random() * 750);
  return Math.min(max, base * 2 ** attempt + jitter);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function responsePreview(error) {
  return error?.contentPreview ? String(error.contentPreview) : undefined;
}

function normalizeFinalError(error, stage, config) {
  const status = statusFromError(error);
  const message = error?.name === "AbortError"
    ? `Ollama ${stage} timed out after ${config.ai.timeoutMs}ms.`
    : errorMessage(error);
  const wrapped = new Error(status ? `Ollama ${stage} failed (${status}): ${message}` : `Ollama ${stage} failed: ${message}`);
  wrapped.cause = error;
  wrapped.status = status;
  return wrapped;
}

function chatOptions(config, attempt, { numPredict } = {}) {
  const jsonRecovery = attempt > 0;
  return {
    think: jsonRecovery ? false : config.ollama.think,
    options: {
      temperature: jsonRecovery ? 0 : config.ollama.temperature,
      ...(numPredict ? { num_predict: numPredict } : {}),
    },
    jsonRecovery,
  };
}

function buildMessages(message, fallback) {
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
  const rankPrompt = renderPrompt("mail-rank", {
    category: fallback.category,
    needsReply: fallback.needsReply,
    possibleJunk: fallback.possibleJunk,
    direct: fallback.direct,
    ageHours: "",
    feedback: "",
  });

  return [
    {
      role: "system",
      content: [
        "You are SaneMail's personal email chief-of-staff model.",
        "Classify one email, extract action cues, and produce a ranking decision.",
        "Return only compact JSON. Do not include markdown.",
        "Allowed categories: Today, Needs Reply, FYI, Junk Review, All Mail.",
        "Be conservative about scam and junk detection.",
        "Schema: {\"category\":string,\"needsReply\":boolean,\"possibleJunk\":boolean,\"automated\":boolean,\"confidence\":number,\"recsysScore\":number,\"suppressFromToday\":boolean,\"reasons\":string[],\"actions\":string[],\"deadlines\":string[],\"entities\":string[]}",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        "Triage prompt:",
        triagePrompt.user,
        "",
        "Extraction prompt:",
        extractPrompt.user,
        "",
        "Ranking prompt:",
        rankPrompt.user,
        "",
        "Deterministic fallback decision:",
        JSON.stringify({
          category: fallback.category,
          needsReply: fallback.needsReply,
          possibleJunk: fallback.possibleJunk,
          automated: fallback.automated,
          direct: fallback.direct,
          recsysScore: fallback.recsysScore,
          reasons: fallback.reasons,
        }),
      ].join("\n"),
    },
  ];
}

export async function classifyWithOllama({ config, message, fallback }) {
  const started = Date.now();
  let lastError;
  const url = chatUrl(config.ollama.host);

  for (let attempt = 0; attempt <= config.ai.maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.ai.timeoutMs);
    const client = createClient(config, controller.signal);
    const generated = chatOptions(config, attempt, { numPredict: 350 });
    const body = {
      model: config.ollama.model,
      stream: false,
      format: "json",
      think: generated.think,
      options: generated.options,
      messages: buildMessages(message, fallback),
    };

    try {
      debugLog("classification request", {
        url,
        clientHost: clientHost(config.ollama.host),
        client: "official ollama-js",
        model: body.model,
        think: body.think,
        temperature: body.options.temperature,
        jsonRecovery: generated.jsonRecovery,
        attempt: attempt + 1,
        messageId: message.id,
        apiKey: config.ollama.apiKey ? "set (redacted)" : "unset",
      });
      const payload = await client.chat(body);
      debugLog("classification response", {
        url,
        status: 200,
        ok: true,
        attempt: attempt + 1,
        messageId: message.id,
        latencyMs: Date.now() - started,
        model: payload.model || config.ollama.model,
      });
      const parsed = parseJsonContent(payload.message?.content || payload.response);
      const decision = normalizeDecision(parsed, fallback);
      const thinking = payload.message?.thinking || payload.thinking || "";

      return {
        decision,
        meta: {
          latencyMs: Date.now() - started,
          model: payload.model || config.ollama.model,
          thinkingChars: thinking.length,
          promptEvalCount: payload.prompt_eval_count || 0,
          evalCount: payload.eval_count || 0,
          totalDurationNs: payload.total_duration || 0,
          attempts: attempt + 1,
        },
      };
    } catch (error) {
      lastError = error;
      const status = statusFromError(error);
      debugLog("classification response", {
        url,
        status: status || "unknown",
        ok: false,
        attempt: attempt + 1,
        messageId: message.id,
        latencyMs: Date.now() - started,
        error: errorMessage(error),
        responsePreview: responsePreview(error),
      });
      if (attempt >= config.ai.maxRetries || (status && !retryableStatus(status))) break;
      const delayMs = retryDelayMs(error, attempt);
      debugLog("classification retry", {
        status,
        attempt: attempt + 1,
        nextAttempt: attempt + 2,
        delayMs,
        jsonRecovery: true,
        messageId: message.id,
      });
      await sleep(delayMs);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw normalizeFinalError(lastError, "classification", config);
}

export async function generateBriefingWithOllama({ config, prompt, fallback }) {
  const started = Date.now();
  let lastError;
  const url = chatUrl(config.ollama.host);

  for (let attempt = 0; attempt <= config.ai.maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.ai.timeoutMs);
    const client = createClient(config, controller.signal);
    const generated = chatOptions(config, attempt, { numPredict: 900 });
    const body = {
      model: config.ollama.model,
      stream: false,
      format: "json",
      think: generated.think,
      options: generated.options,
      messages: [
        {
          role: "system",
          content: prompt.system,
        },
        {
          role: "user",
          content: prompt.user,
        },
      ],
    };

    try {
      debugLog("briefing request", {
        url,
        clientHost: clientHost(config.ollama.host),
        client: "official ollama-js",
        model: body.model,
        think: body.think,
        temperature: body.options.temperature,
        jsonRecovery: generated.jsonRecovery,
        attempt: attempt + 1,
        promptId: prompt.id,
        promptVersion: prompt.version,
        apiKey: config.ollama.apiKey ? "set (redacted)" : "unset",
      });
      const payload = await client.chat(body);
      debugLog("briefing response", {
        url,
        status: 200,
        ok: true,
        attempt: attempt + 1,
        promptId: prompt.id,
        latencyMs: Date.now() - started,
        model: payload.model || config.ollama.model,
      });
      const parsed = parseJsonContent(payload.message?.content || payload.response);
      const thinking = payload.message?.thinking || payload.thinking || "";

      return {
        briefing: normalizeBriefing(parsed, fallback, payload.model || config.ollama.model),
        meta: {
          latencyMs: Date.now() - started,
          model: payload.model || config.ollama.model,
          thinkingChars: thinking.length,
          promptEvalCount: payload.prompt_eval_count || 0,
          evalCount: payload.eval_count || 0,
          totalDurationNs: payload.total_duration || 0,
          attempts: attempt + 1,
        },
      };
    } catch (error) {
      lastError = error;
      const status = statusFromError(error);
      debugLog("briefing response", {
        url,
        status: status || "unknown",
        ok: false,
        attempt: attempt + 1,
        promptId: prompt.id,
        latencyMs: Date.now() - started,
        error: errorMessage(error),
        responsePreview: responsePreview(error),
      });
      if (attempt >= config.ai.maxRetries || (status && !retryableStatus(status))) break;
      const delayMs = retryDelayMs(error, attempt);
      debugLog("briefing retry", {
        status,
        attempt: attempt + 1,
        nextAttempt: attempt + 2,
        delayMs,
        jsonRecovery: true,
        promptId: prompt.id,
      });
      await sleep(delayMs);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw normalizeFinalError(lastError, "briefing", config);
}
