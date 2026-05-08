import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyWithOllama,
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

test("parseJsonContent repairs common malformed briefing JSON", () => {
  const content = [
    "```json",
    "{\"text\":\"hello",
    "there\",\"narrative\":{\"status\":\"ready\"},\"counts\":{},\"messageIds\":[]}",
    "```",
  ].join("\n");

  const parsed = parseJsonContent(content, { expectedKeys: ["text", "narrative"] });

  assert.equal(parsed.text, "hello\nthere");
  assert.equal(parsed.narrative.status, "ready");
});

test("parseJsonContent extracts the expected JSON object from prose", () => {
  const parsed = parseJsonContent(
    [
      "I checked the inbox first.",
      "{\"foo\":\"not the briefing\"}",
      "Final answer:",
      "{\"text\":\"Brief ready\",\"narrative\":{\"status\":\"Brief ready\"},\"counts\":{},\"messageIds\":[]}",
    ].join("\n"),
    { expectedKeys: ["text", "narrative"] },
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

