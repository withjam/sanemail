import assert from "node:assert/strict";
import test from "node:test";
import { generateBriefingWithOllama, parseJsonContent } from "../apps/api/src/ai/ollama.mjs";

const config = {
  ai: {
    timeoutMs: 1000,
    maxRetries: 3,
  },
  ollama: {
    host: "http://ollama.test",
    model: "test-brief-model",
    think: "high",
    apiKey: "",
    temperature: 0.3,
  },
};

const prompt = {
  id: "mail-briefing",
  version: "test",
  system: "Return JSON.",
  user: "Summarize the inbox.",
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
