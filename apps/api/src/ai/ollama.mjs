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

function stripJsonFence(value) {
  return String(value || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

function findBalancedJsonEnd(value, startIndex) {
  const opener = value[startIndex];
  if (opener !== "{" && opener !== "[") return -1;

  const stack = [opener];
  let inString = false;
  let escaped = false;

  for (let index = startIndex + 1; index < value.length; index += 1) {
    const char = value[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }

    if (char !== "}" && char !== "]") continue;

    const expected = stack.pop();
    if ((char === "}" && expected !== "{") || (char === "]" && expected !== "[")) return -1;
    if (!stack.length) return index;
  }

  return -1;
}

function balancedJsonCandidates(value) {
  const candidates = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "{" && char !== "[") continue;

    const endIndex = findBalancedJsonEnd(value, index);
    if (endIndex !== -1) candidates.push(value.slice(index, endIndex + 1));
  }
  return candidates;
}

function partialJsonCandidates(value) {
  const candidates = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "{" || char === "[") candidates.push(value.slice(index));
  }
  return candidates;
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  return candidates
    .map((candidate) => String(candidate || "").trim())
    .filter(Boolean)
    .filter((candidate) => {
      if (seen.has(candidate)) return false;
      seen.add(candidate);
      return true;
    });
}

function jsonCandidates(content) {
  const trimmed = String(content || "").trim();
  const unfenced = stripJsonFence(trimmed);
  return uniqueCandidates([
    trimmed,
    unfenced,
    ...balancedJsonCandidates(unfenced),
    ...partialJsonCandidates(unfenced),
  ]);
}

function escapeControlCharsInStrings(value) {
  let result = "";
  let inString = false;
  let escaped = false;

  for (const char of value) {
    if (!inString) {
      if (char === "\"") inString = true;
      result += char;
      continue;
    }

    if (escaped) {
      escaped = false;
      result += char;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      result += char;
      continue;
    }

    if (char === "\"") {
      inString = false;
      result += char;
      continue;
    }

    if (char === "\n") {
      result += "\\n";
    } else if (char === "\r") {
      result += "\\r";
    } else if (char === "\t") {
      result += "\\t";
    } else {
      result += char;
    }
  }

  return result;
}

function closeJsonDelimiters(value) {
  const stack = [];
  let inString = false;
  let escaped = false;

  for (const char of value) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }

    if (char !== "}" && char !== "]") continue;

    const expected = stack.pop();
    if ((char === "}" && expected !== "{") || (char === "]" && expected !== "[")) return value;
  }

  let closed = inString ? `${value}"` : value;
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    closed += stack[index] === "{" ? "}" : "]";
  }
  return closed;
}

function repairJsonCandidate(candidate) {
  return closeJsonDelimiters(
    escapeControlCharsInStrings(stripJsonFence(candidate)).replace(/,\s*([}\]])/g, "$1"),
  );
}

function hasExpectedJsonShape(parsed, expectedKeys) {
  if (!expectedKeys.length) return true;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  return expectedKeys.some((key) => Object.prototype.hasOwnProperty.call(parsed, key));
}

export function parseJsonContent(content, { expectedKeys = [] } = {}) {
  const trimmed = String(content || "").trim();
  if (!trimmed) {
    throw contentPreviewError(new Error("Ollama returned an empty message."), content, {
      code: "OLLAMA_MALFORMED_JSON",
      retryable: true,
    });
  }

  let lastError = null;
  let shapeError = null;
  for (const candidate of jsonCandidates(trimmed)) {
    const parseCandidates = uniqueCandidates([candidate, repairJsonCandidate(candidate)]);
    for (const parseCandidate of parseCandidates) {
      try {
        const parsed = JSON.parse(parseCandidate);
        if (hasExpectedJsonShape(parsed, expectedKeys)) return parsed;
        shapeError ||= new Error("Ollama JSON did not match the expected response shape.");
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw contentPreviewError(
    shapeError || lastError || new Error("Ollama did not return JSON."),
    content,
    {
      code: "OLLAMA_MALFORMED_JSON",
      retryable: true,
    },
  );
}

function contentPreviewError(error, content, options = {}) {
  error.contentPreview = String(content || "").slice(0, 1600);
  if (options.code) error.code = options.code;
  if (options.retryable !== undefined) error.retryable = options.retryable;
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

function normalizeSummary(value, wordCount) {
  if (!Number.isFinite(wordCount) || wordCount <= 50) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > 400 ? `${trimmed.slice(0, 397)}...` : trimmed;
}

function normalizeDeliveredAtIso(value) {
  const t = new Date(value || 0).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
}

function completionEventsFromPayload(payload, deliveredAtIso) {
  const defaultAt = normalizeDeliveredAtIso(deliveredAtIso);
  const raw =
    payload.completions ||
    payload.extracted?.completions ||
    payload.completedEvents ||
    payload.completed ||
    [];
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const phrase = item.trim();
      if (phrase) out.push({ phrase, occurredAt: defaultAt });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const phrase = String(item.phrase || item.summary || item.label || "").trim();
    if (!phrase) continue;
    let occurredAt = String(item.occurredAt || item.at || "").trim();
    let t = new Date(occurredAt || defaultAt).getTime();
    if (!Number.isFinite(t)) t = new Date(defaultAt).getTime();
    out.push({ phrase, occurredAt: new Date(t).toISOString() });
  }
  return out.slice(0, 8);
}

function mergeCompletionEvents(deterministic, model) {
  const map = new Map();
  for (const c of deterministic) {
    if (c?.phrase) map.set(String(c.phrase).toLowerCase(), c);
  }
  for (const c of model) {
    if (c?.phrase) map.set(String(c.phrase).toLowerCase(), c);
  }
  return Array.from(map.values()).slice(0, 8);
}

function normalizeDecision(payload, fallback, deliveredAtIso) {
  const category = normalizeCategory(payload.category, fallback.category);
  const possibleJunk =
    typeof payload.possibleJunk === "boolean" ? payload.possibleJunk : fallback.possibleJunk;
  const automated = typeof payload.automated === "boolean" ? payload.automated : fallback.automated;
  const needsReply =
    typeof payload.needsReply === "boolean" ? payload.needsReply : fallback.needsReply;
  const actions = stringArray(payload.actions || payload.extracted?.actions);
  const deadlines = stringArray(payload.deadlines || payload.extracted?.deadlines);
  const entities = stringArray(payload.entities || payload.extracted?.entities);
  const summary = normalizeSummary(payload.summary, fallback.wordCount);
  const deterministicCompletions = fallback.extracted?.completions || [];
  const completions = mergeCompletionEvents(
    deterministicCompletions,
    completionEventsFromPayload(payload, deliveredAtIso),
  );

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
    summary,
    extracted: {
      actions: actions.length ? actions : fallback.extracted.actions,
      deadlines: deadlines.length ? deadlines : fallback.extracted.deadlines,
      entities: entities.length ? entities : fallback.extracted.entities,
      completions,
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
      label: "Needs attention",
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
  const generatedAt = new Date().toISOString();

  return {
    ...fallback,
    text,
    narrative,
    callouts: normalizeCallouts(payload.callouts, fallback.callouts || []),
    generatedAt,
    memory: fallback.memory
      ? {
          ...fallback.memory,
          producedAt: generatedAt,
        }
      : fallback.memory,
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

function maxRetries(config) {
  const retries = Number(config?.ai?.maxRetries);
  if (!Number.isFinite(retries) || retries < 0) return 3;
  return Math.floor(retries);
}

function statusFromError(error) {
  return error?.status ?? error?.status_code ?? error?.response?.status;
}

function isRetryableError(error) {
  const status = statusFromError(error);
  if (status) return retryableStatus(status);
  return error?.retryable !== false;
}

function isJsonContentError(error) {
  return error?.code === "OLLAMA_MALFORMED_JSON";
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

function chatOptions(config, attempt, { numPredict, think = config.ollama.think, temperature = config.ollama.temperature } = {}) {
  const jsonRecovery = attempt > 0;
  return {
    think: jsonRecovery ? false : think,
    options: {
      temperature: jsonRecovery ? 0 : temperature,
      ...(numPredict ? { num_predict: numPredict } : {}),
    },
    jsonRecovery,
  };
}

/** Creative prose (brief + reconcile): OLLAMA_TEMPERATURE; retries force temp 0. */
function chatOptionsBriefingProse(config, attempt, { numPredict = 1200 } = {}) {
  const jsonRecovery = attempt > 0;
  const temperature = jsonRecovery ? 0 : Number(config.ollama.temperature ?? 0);
  return {
    think: jsonRecovery ? false : config.ollama.think,
    options: {
      temperature,
      ...(numPredict ? { num_predict: numPredict } : {}),
    },
    jsonRecovery,
  };
}

/** Final JSON structurize: always deterministic (temperature 0, no extended thinking). */
function chatOptionsBriefingStructurize(config, attempt, { numPredict = 900 } = {}) {
  return {
    think: false,
    options: {
      temperature: 0,
      ...(numPredict ? { num_predict: numPredict } : {}),
    },
    jsonRecovery: attempt > 0,
  };
}

function normalizeBriefingProseContent(raw) {
  let text = String(raw || "").trim();
  const fenced = text.match(/^```(?:\w+)?\s*([\s\S]*?)\s*```$/);
  if (fenced) text = fenced[1].trim();
  return text;
}

function fallbackBriefingForJsonError(fallback) {
  const generatedAt = new Date().toISOString();
  return {
    ...fallback,
    generatedAt,
    memory: fallback.memory
      ? {
          ...fallback.memory,
          producedAt: generatedAt,
        }
      : fallback.memory,
    source: "ai-loop-fallback",
    model: fallback.model || "deterministic-briefing-v0",
  };
}

/** Exported for Phoenix tracing when PHOENIX_ALLOW_SENSITIVE_CONTENT is set. */
export function buildClassificationMessages(message, fallback) {
  return buildMessages(message, fallback);
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

  const wordCount = Number.isFinite(fallback.wordCount) ? fallback.wordCount : 0;
  const summaryClause =
    wordCount > 50
      ? `Write a single neutral sentence (under 30 words) summarizing the message in the "summary" field. Body word count: ${wordCount}.`
      : `The body has only ${wordCount} words; return summary: null.`;

  return [
    {
      role: "system",
      content: [
        "You are SaneMail's personal email chief-of-staff model.",
        "Classify one email, extract action cues, and produce a ranking decision.",
        "Return only compact JSON. Do not include markdown.",
        "Allowed categories: Today, Needs Reply, FYI, Junk Review, All Mail.",
        "Be conservative about scam and junk detection.",
        summaryClause,
        "Schema: {\"category\":string,\"needsReply\":boolean,\"possibleJunk\":boolean,\"automated\":boolean,\"confidence\":number,\"recsysScore\":number,\"suppressFromToday\":boolean,\"reasons\":string[],\"summary\":string|null,\"actions\":string[],\"deadlines\":string[],\"entities\":string[],\"completions\":[{\"phrase\":string,\"occurredAt\":string}]}",
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

export async function classifyWithOllama({ config, message, fallback, clientFactory = createClient, sleepFn = sleep }) {
  const started = Date.now();
  let lastError;
  const url = chatUrl(config.ollama.host);
  const retryLimit = maxRetries(config);
  const requestModel = config.ollama.classificationModel || config.ollama.model;
  const requestThink = config.ollama.classificationThink ?? false;
  const requestTemperature = Number(config.ollama.classificationTemperature ?? 0);

  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.ai.timeoutMs);
    const client = clientFactory(config, controller.signal);
    const generated = chatOptions(config, attempt, {
      numPredict: 350,
      think: requestThink,
      temperature: requestTemperature,
    });
    const body = {
      model: requestModel,
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
        briefingModel: config.ollama.model,
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
        model: payload.model || requestModel,
      });
      const parsed = parseJsonContent(payload.message?.content || payload.response, {
        expectedKeys: ["category", "needsReply", "recsysScore"],
      });
      const decision = normalizeDecision(parsed, fallback, message.date);
      const thinking = payload.message?.thinking || payload.thinking || "";

      return {
        decision,
        meta: {
          latencyMs: Date.now() - started,
          model: payload.model || requestModel,
          requestedModel: requestModel,
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
      if (attempt >= retryLimit || !isRetryableError(error)) break;
      const delayMs = retryDelayMs(error, attempt);
      debugLog("classification retry", {
        status,
        attempt: attempt + 1,
        nextAttempt: attempt + 2,
        delayMs,
        jsonRecovery: true,
        messageId: message.id,
      });
      await sleepFn(delayMs);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw normalizeFinalError(lastError, "classification", config);
}

export async function generateBriefingProseWithOllama({
  config,
  prompt,
  proseFallback = "",
  clientFactory = createClient,
  sleepFn = sleep,
}) {
  const started = Date.now();
  let lastError;
  let attempts = 0;
  const url = chatUrl(config.ollama.host);
  const retryLimit = maxRetries(config);

  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    attempts = attempt + 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.ai.timeoutMs);
    const client = clientFactory(config, controller.signal);
    const generated = chatOptionsBriefingProse(config, attempt, { numPredict: 1200 });
    const body = {
      model: config.ollama.model,
      stream: false,
      think: generated.think,
      options: generated.options,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
    };

    try {
      const payload = await client.chat(body);
      const text = normalizeBriefingProseContent(payload.message?.content || payload.response);
      if (!text) throw contentPreviewError(new Error("Ollama returned an empty prose briefing."), "", {
        code: "OLLAMA_MALFORMED_JSON",
        retryable: true,
      });
      const thinking = payload.message?.thinking || payload.thinking || "";
      return {
        text,
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
      if (attempt >= retryLimit || !isRetryableError(error)) break;
      await sleepFn(retryDelayMs(error, attempt));
    } finally {
      clearTimeout(timeout);
    }
  }

  console.warn("[ollama briefing prose fallback]", {
    attempts,
    requestModel: config.ollama.model,
    responsePreview: responsePreview(lastError),
  });
  return {
    text: proseFallback || "Brief unavailable.",
    meta: {
      latencyMs: Date.now() - started,
      model: config.ollama.model,
      thinkingChars: 0,
      promptEvalCount: 0,
      evalCount: 0,
      totalDurationNs: 0,
      attempts,
      fallback: true,
      fallbackReason: "prose_error",
      error: lastError ? errorMessage(lastError) : null,
    },
  };
}

/** Final step: prose + anchors → UI JSON. Always uses JSON mode and temperature 0. */
export async function generateBriefingWithOllama({
  config,
  prompt,
  fallback,
  clientFactory = createClient,
  sleepFn = sleep,
}) {
  const started = Date.now();
  let lastError;
  let attempts = 0;
  const url = chatUrl(config.ollama.host);
  const retryLimit = maxRetries(config);

  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    attempts = attempt + 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.ai.timeoutMs);
    const client = clientFactory(config, controller.signal);
    const generated = chatOptionsBriefingStructurize(config, attempt, { numPredict: 900 });
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
      console.log("[ollama briefing structurize request]", {
        url,
        attempt: attempt + 1,
        requestModel: body.model,
        think: body.think,
        temperature: body.options.temperature,
        promptUserChars: prompt.user.length,
      });
      debugLog("briefing structurize request", {
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
      console.log("[ollama briefing structurize response]", {
        url,
        attempt: attempt + 1,
        latencyMs: Date.now() - started,
        requestModel: body.model,
        responseModel: payload.model || "(none returned)",
        modelMismatch: payload.model && payload.model !== body.model,
        promptEvalCount: payload.prompt_eval_count || 0,
        evalCount: payload.eval_count || 0,
      });
      debugLog("briefing structurize response", {
        url,
        status: 200,
        ok: true,
        attempt: attempt + 1,
        promptId: prompt.id,
        latencyMs: Date.now() - started,
        model: payload.model || config.ollama.model,
      });
      const parsed = parseJsonContent(payload.message?.content || payload.response, {
        expectedKeys: ["text", "narrative", "callouts"],
      });
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
      debugLog("briefing structurize response", {
        url,
        status: status || "unknown",
        ok: false,
        attempt: attempt + 1,
        promptId: prompt.id,
        latencyMs: Date.now() - started,
        error: errorMessage(error),
        responsePreview: responsePreview(error),
      });
      if (attempt >= retryLimit || !isRetryableError(error)) break;
      const delayMs = retryDelayMs(error, attempt);
      debugLog("briefing structurize retry", {
        status,
        attempt: attempt + 1,
        nextAttempt: attempt + 2,
        delayMs,
        jsonRecovery: true,
        promptId: prompt.id,
      });
      await sleepFn(delayMs);
    } finally {
      clearTimeout(timeout);
    }
  }

  if (isJsonContentError(lastError)) {
    console.warn("[ollama briefing structurize fallback]", {
      reason: "malformed_json",
      attempts,
      requestModel: config.ollama.model,
      responsePreview: responsePreview(lastError),
    });
    debugLog("briefing structurize fallback", {
      reason: "malformed_json",
      attempts,
      promptId: prompt.id,
      responsePreview: responsePreview(lastError),
    });
    return {
      briefing: fallbackBriefingForJsonError(fallback),
      meta: {
        latencyMs: Date.now() - started,
        model: config.ollama.model,
        thinkingChars: 0,
        promptEvalCount: 0,
        evalCount: 0,
        totalDurationNs: 0,
        attempts,
        fallback: true,
        fallbackReason: "malformed_json",
      },
    };
  }

  throw normalizeFinalError(lastError, "briefing", config);
}
