import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyWithOllama,
  generateBriefingWithOllama,
  parseJsonContent,
} from "../apps/api/src/ai/ollama.mjs";

const config = {
  ai: {
    timeoutMs: 1000,
    maxRetries: 3,
  },
  ollama: {
    host: "http://ollama.test",
    model: "test-brief-model",
    classificationModel: "test-flash-classifier",
    think: "high",
    classificationThink: false,
    apiKey: "",
    temperature: 0.3,
    classificationTemperature: 0,
  },
};

const prompt = {
  id: "mail-briefing-structurize",
  version: "test",
  system: "Return JSON.",
  user: "Convert prose to briefing JSON.",
};

const fallbackBriefing = {
  text: "Deterministic fallback brief.",
  narrative: {
    status: "Deterministic fallback brief.",
    needToKnow: "",
    mightBeMissing: "",
    needsAttention: "",
  },
  callouts: [],
  generatedAt: "2026-05-05T00:00:00.000Z",
  source: "ai-loop",
  model: "deterministic-briefing-v0",
  counts: {},
  messageIds: [],
};

const fallbackDecision = {
  category: "Today",
  needsReply: true,
  possibleJunk: false,
  automated: false,
  direct: true,
  confidence: 0.8,
  recsysScore: 70,
  suppressFromToday: false,
  reasons: ["sent directly to you"],
  wordCount: 12,
  extracted: {
    actions: ["review"],
    deadlines: [],
    entities: [],
    completions: [],
    replyCue: null,
  },
};

const message = {
  id: "message-one",
  subject: "Please review",
  from: "Alex <alex@example.com>",
  to: "demo@example.com",
  sourceLabels: ["INBOX"],
  snippet: "Could you review this?",
  bodyText: "Could you review this?",
};

function validBriefContent(text = "Model-generated brief.") {
  return JSON.stringify({
    text,
    narrative: {
      status: text,
      needToKnow: "Nothing urgent.",
      mightBeMissing: "",
      needsAttention: "",
    },
    callouts: [],
  });
}

test("parseJsonContent repairs common malformed briefing JSON", () => {
  const content = [
    "```json",
    "{\"text\":\"hello",
    "there\",\"narrative\":{\"status\":\"ready\",},\"callouts\":[],}",
    "```",
  ].join("\n");

  const parsed = parseJsonContent(content, { expectedKeys: ["text", "narrative", "callouts"] });

  assert.equal(parsed.text, "hello\nthere");
  assert.equal(parsed.narrative.status, "ready");
  assert.deepEqual(parsed.callouts, []);
});

test("parseJsonContent extracts the expected JSON object from prose", () => {
  const parsed = parseJsonContent(
    [
      "I checked the inbox first.",
      "{\"foo\":\"not the briefing\"}",
      "Final answer:",
      "{\"text\":\"Brief ready\",\"narrative\":{\"status\":\"Brief ready\"},\"callouts\":[]",
    ].join("\n"),
    { expectedKeys: ["text", "narrative", "callouts"] },
  );

  assert.equal(parsed.text, "Brief ready");
  assert.equal(parsed.narrative.status, "Brief ready");
});

test("classifyWithOllama uses the separate single-message classification model", async () => {
  let requestBody = null;
  const clientFactory = () => ({
    chat: async (body) => {
      requestBody = body;
      return {
        model: "test-flash-classifier",
        message: {
          content: JSON.stringify({
            category: "Needs Reply",
            needsReply: true,
            possibleJunk: false,
            automated: false,
            confidence: 0.88,
            recsysScore: 82,
            suppressFromToday: false,
            reasons: ["single-message classification"],
            actions: ["review"],
            deadlines: [],
            entities: ["Alex"],
          }),
        },
        prompt_eval_count: 5,
        eval_count: 6,
      };
    },
  });

  const result = await classifyWithOllama({
    config,
    message,
    fallback: fallbackDecision,
    clientFactory,
    sleepFn: async () => {},
  });

  assert.equal(requestBody.model, "test-flash-classifier");
  assert.equal(requestBody.think, false);
  assert.equal(requestBody.messages.filter((item) => item.role === "user").length, 1);
  assert.match(requestBody.messages[0].content, /Classify one email/);
  assert.equal(result.meta.requestedModel, "test-flash-classifier");
  assert.equal(result.decision.category, "Needs Reply");
});

test("generateBriefingWithOllama retries malformed JSON up to the configured retry limit", async () => {
  let calls = 0;
  const clientFactory = () => ({
    chat: async () => {
      calls += 1;
      return {
        model: "test-brief-model",
        message: {
          content: calls < 4 ? "not json at all" : validBriefContent("Recovered on retry."),
        },
        prompt_eval_count: 10,
        eval_count: 12,
        total_duration: 123,
      };
    },
  });

  const result = await generateBriefingWithOllama({
    config,
    prompt,
    fallback: fallbackBriefing,
    clientFactory,
    sleepFn: async () => {},
  });

  assert.equal(calls, 4);
  assert.equal(result.meta.attempts, 4);
  assert.equal(result.briefing.text, "Recovered on retry.");
  assert.equal(result.meta.fallback, undefined);
});

test("generateBriefingWithOllama falls back after malformed JSON retries are exhausted", async () => {
  let calls = 0;
  const clientFactory = () => ({
    chat: async () => {
      calls += 1;
      return {
        model: "test-brief-model",
        message: {
          content: "still not json",
        },
      };
    },
  });

  const result = await generateBriefingWithOllama({
    config,
    prompt,
    fallback: fallbackBriefing,
    clientFactory,
    sleepFn: async () => {},
  });

  assert.equal(calls, 4);
  assert.equal(result.meta.attempts, 4);
  assert.equal(result.meta.fallback, true);
  assert.equal(result.meta.fallbackReason, "malformed_json");
  assert.equal(result.briefing.text, fallbackBriefing.text);
  assert.equal(result.briefing.source, "ai-loop-fallback");
});
