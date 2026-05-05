import {
  SpanStatusCode,
  getEmbeddingAttributes,
  getLLMAttributes,
  register,
  trace,
} from "@arizeai/phoenix-otel";
import { loadConfig } from "../config.mjs";

let phoenixState;

function normalizeEndpoint(value) {
  if (!value) return "http://localhost:6006";
  return value.endsWith("/v1/traces") ? value.slice(0, -"/v1/traces".length) : value;
}

function defaultStatus(config = loadConfig().phoenix) {
  return {
    enabled: config.enabled,
    initialized: false,
    available: false,
    projectName: config.projectName,
    collectorEndpoint: config.collectorEndpoint,
    appUrl: normalizeEndpoint(config.collectorEndpoint),
    batch: config.batch,
    privacy: {
      sensitiveContent: config.allowSensitiveContent ? "allowed" : "redacted",
      inputsHidden: !config.allowSensitiveContent,
      embeddingVectorsHidden: true,
    },
    error: null,
  };
}

function setPrivacyDefaults(config) {
  if (config.allowSensitiveContent) return;

  process.env.OPENINFERENCE_HIDE_INPUTS ??= "true";
  process.env.OPENINFERENCE_HIDE_INPUT_MESSAGES ??= "true";
  process.env.OPENINFERENCE_HIDE_EMBEDDINGS_VECTORS ??= "true";
  process.env.OPENINFERENCE_HIDE_PROMPTS ??= "false";
}

function publicError(error) {
  return error instanceof Error ? error.message : String(error);
}

function initializePhoenix() {
  if (phoenixState) return phoenixState;

  const config = loadConfig().phoenix;
  const status = defaultStatus(config);
  if (!config.enabled) {
    phoenixState = { ...status, provider: null, tracer: null };
    return phoenixState;
  }

  try {
    setPrivacyDefaults(config);
    const provider = register({
      projectName: config.projectName,
      url: config.collectorEndpoint,
      batch: config.batch,
      headers: {
        "x-client-name": "sanemail-api",
      },
    });

    phoenixState = {
      ...status,
      initialized: true,
      available: true,
      provider,
      tracer: trace.getTracer("sanemail-ai"),
    };
  } catch (error) {
    phoenixState = {
      ...status,
      available: false,
      error: publicError(error),
      provider: null,
      tracer: null,
    };
  }

  return phoenixState;
}

function cleanAttributes(attributes) {
  return Object.fromEntries(
    Object.entries(attributes).filter(([_key, value]) => value !== undefined && value !== null),
  );
}

async function withSpan(name, attributes, callback) {
  const state = initializePhoenix();
  if (!state.available || !state.tracer) return callback(null);

  return state.tracer.startActiveSpan(name, async (span) => {
    span.setAttributes(cleanAttributes(attributes));
    try {
      const result = await callback(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: publicError(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}

function activeTraceId() {
  return trace.getActiveSpan()?.spanContext().traceId || null;
}

function promptAttributes(promptRefs) {
  const attributes = {};
  promptRefs.forEach((prompt, index) => {
    const prefix = `sanemail.prompt.${index}`;
    attributes[`${prefix}.id`] = prompt.id;
    attributes[`${prefix}.version`] = prompt.version;
    attributes[`${prefix}.stage`] = prompt.stage;
    attributes[`${prefix}.hash`] = prompt.hash;
    attributes[`${prefix}.model`] = prompt.model;
  });
  return attributes;
}

function categoryCountAttributes(categoryCounts) {
  return Object.fromEntries(
    Object.entries(categoryCounts || {}).map(([category, count]) => [
      `sanemail.category.${category.toLowerCase().replaceAll(" ", "_")}`,
      count,
    ]),
  );
}

function attributeValue(value) {
  if (value === undefined || value === null) return undefined;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value) && value.every((item) => ["string", "number", "boolean"].includes(typeof item))) {
    return value;
  }
  return JSON.stringify(value);
}

function recordedSpanAttributes(recordedSpan) {
  const ignored = new Set(["name", "status", "durationMs"]);
  return Object.fromEntries(
    Object.entries(recordedSpan)
      .filter(([key]) => !ignored.has(key))
      .map(([key, value]) => [`sanemail.stage.${key}`, attributeValue(value)])
      .filter(([_key, value]) => value !== undefined),
  );
}

function runAttributes(run) {
  return {
    "sanemail.kind": run.kind,
    "sanemail.run_id": run.id,
    "sanemail.trigger": run.trigger,
    "sanemail.status": run.status,
    "sanemail.pipeline": run.input.pipeline,
    "sanemail.account_id": run.input.accountId,
    "sanemail.corpus_hash": run.input.corpusHash,
    "sanemail.message_count": run.metrics.messagesProcessed,
    "sanemail.llm_call_count": run.llmCalls?.length || 0,
    "sanemail.curated_count": run.output.curatedMessageIds.length,
    "sanemail.average_confidence": run.metrics.averageConfidence,
    "sanemail.latency_ms": run.metrics.latencyMs,
    "sanemail.estimated_prompt_tokens": run.metrics.estimatedPromptTokens,
    "sanemail.estimated_completion_tokens": run.metrics.estimatedCompletionTokens,
    "sanemail.provider_latency_ms": run.metrics.providerLatencyMs,
    "sanemail.ollama_prompt_eval_count": run.metrics.ollamaPromptEvalCount,
    "sanemail.ollama_eval_count": run.metrics.ollamaEvalCount,
    "sanemail.ollama_thinking_chars": run.metrics.ollamaThinkingChars,
    "llm.provider": run.provider.name,
    "llm.model_name": run.provider.model,
    "llm.invocation_parameters": JSON.stringify({
      temperature: run.provider.temperature,
      think: run.provider.think,
      briefingModel: run.provider.briefingModel,
      classificationModel: run.provider.classificationModel,
    }),
    ...categoryCountAttributes(run.metrics.categoryCounts),
    ...promptAttributes(run.promptRefs),
  };
}

async function traceRecordedSpans(run) {
  for (const recordedSpan of run.spans) {
    await withSpan(`sanemail.${recordedSpan.name}`, {
      "sanemail.run_id": run.id,
      "sanemail.stage": recordedSpan.name,
      "sanemail.stage_duration_ms": recordedSpan.durationMs,
      "sanemail.stage_status": recordedSpan.status,
      "sanemail.message_count": recordedSpan.messageCount,
      "sanemail.prompt_count": recordedSpan.promptCount,
      "sanemail.decision_count": recordedSpan.decisionCount,
      "sanemail.curated_count": recordedSpan.curatedCount,
      ...recordedSpanAttributes(recordedSpan),
    }, async () => {});
  }
}

async function traceModelSummary(run) {
  await withSpan("sanemail.model.mock_inference.summary", {
    ...getLLMAttributes({
      provider: run.provider.name,
      modelName: run.provider.model,
      invocationParameters: { temperature: run.provider.temperature },
      tokenCount: {
        prompt: run.metrics.estimatedPromptTokens,
        completion: run.metrics.estimatedCompletionTokens,
        total: run.metrics.estimatedPromptTokens + run.metrics.estimatedCompletionTokens,
      },
      inputMessages: [{ role: "user", content: `corpus:${run.input.corpusHash}` }],
      outputMessages: [
        {
          role: "assistant",
          content: JSON.stringify({
            curatedMessageIds: run.output.curatedMessageIds,
            categoryCounts: run.metrics.categoryCounts,
          }),
        },
      ],
    }),
    "sanemail.run_id": run.id,
  }, async () => {});
}

async function traceEmbeddingSummary(run) {
  const embeddings = run.output.decisions.slice(0, 20).map((decision) => ({
    text: `message:${decision.instrumentation.inputHash}`,
  }));

  await withSpan("sanemail.embedding.synthetic_summary", {
    ...getEmbeddingAttributes({
      modelName: "hash-embedding-v0",
      embeddings,
    }),
    "sanemail.run_id": run.id,
    "sanemail.embedding_count": embeddings.length,
  }, async () => {});
}

async function traceDecisionSummaries(run) {
  for (const decision of run.output.decisions.slice(0, 20)) {
    await withSpan("sanemail.decision", {
      "sanemail.run_id": run.id,
      "sanemail.message_id": decision.messageId,
      "sanemail.input_hash": decision.instrumentation.inputHash,
      "sanemail.category": decision.category,
      "sanemail.recsys_score": decision.recsysScore,
      "sanemail.confidence": decision.confidence,
      "sanemail.needs_reply": decision.needsReply,
      "sanemail.possible_junk": decision.possibleJunk,
      "sanemail.automated": decision.automated,
      "sanemail.suppress_from_today": decision.suppressFromToday,
      "sanemail.actions": decision.extracted.actions,
      "sanemail.deadlines": decision.extracted.deadlines,
      "sanemail.embedding_hash": decision.embedding.hash,
    }, async () => {});
  }
}

async function traceLlmCalls(run) {
  for (const call of run.llmCalls || []) {
    await withSpan(`sanemail.llm.${call.pipeline}`, {
      ...getLLMAttributes({
        provider: call.provider,
        modelName: call.model,
        invocationParameters: {
          requestedModel: call.requestedModel,
          pipeline: call.pipeline,
          stage: call.stage,
          attempts: call.attempts,
          fallback: Boolean(call.fallback),
        },
        tokenCount: {
          prompt: call.promptEvalCount,
          completion: call.evalCount,
          total: call.promptEvalCount + call.evalCount,
        },
        inputMessages: [{ role: "user", content: `input:${call.inputHash}` }],
        outputMessages: [{ role: "assistant", content: `output:${call.outputHash || call.status}` }],
      }),
      "sanemail.run_id": run.id,
      "sanemail.llm_call_id": call.id,
      "sanemail.pipeline": call.pipeline,
      "sanemail.stage": call.stage,
      "sanemail.call_status": call.status,
      "sanemail.fallback": Boolean(call.fallback),
      "sanemail.fallback_reason": call.fallbackReason,
      "sanemail.error": call.error,
      "sanemail.latency_ms": call.latencyMs,
      "sanemail.input_message_count": call.inputMessageCount,
      "sanemail.output_message_count": call.outputMessageCount,
      "sanemail.prompt_id": call.promptId,
      "sanemail.prompt_version": call.promptVersion,
      "sanemail.prompt_hash": call.promptHash,
      "sanemail.contract_hash": call.contractHash,
    }, async () => {});
  }
}

export function getPhoenixStatus() {
  const state = initializePhoenix();
  const { provider: _provider, tracer: _tracer, ...status } = state;
  return status;
}

export async function traceAiRun(run) {
  const state = initializePhoenix();
  if (!state.available) return getPhoenixStatus();

  let traceId = null;
  const pipeline = String(run.input.pipeline || run.kind || "mailbox-curation").replaceAll("-", "_");
  await withSpan(`sanemail.ai.${pipeline}`, runAttributes(run), async () => {
    traceId = activeTraceId();
    await traceRecordedSpans(run);
    await traceLlmCalls(run);
    await traceModelSummary(run);
    await traceEmbeddingSummary(run);
    await traceDecisionSummaries(run);
  });

  await flushPhoenix();

  return {
    ...getPhoenixStatus(),
    traceId,
    tracedAt: new Date().toISOString(),
  };
}

export async function traceVerificationRun(run) {
  const state = initializePhoenix();
  if (!state.available) return getPhoenixStatus();

  let traceId = null;
  await withSpan("sanemail.ai.synthetic_verification", {
    "sanemail.verification_id": run.id,
    "sanemail.suite_id": run.suiteId,
    "sanemail.suite_title": run.suiteTitle,
    "sanemail.status": run.status,
    "sanemail.score": run.score,
    "sanemail.threshold": run.threshold,
    "sanemail.case_count": run.summary.cases,
    "sanemail.passed_cases": run.summary.passedCases,
    "sanemail.failed_cases": run.summary.failedCases,
    "sanemail.check_count": run.summary.checks,
    "sanemail.latency_ms": run.metrics.latencyMs,
    "llm.provider": run.provider.name,
    "llm.model_name": run.provider.model,
    ...promptAttributes(run.promptRefs),
  }, async () => {
    traceId = activeTraceId();
    for (const testCase of run.cases) {
      await withSpan("sanemail.eval.case", {
        "sanemail.verification_id": run.id,
        "sanemail.case_id": testCase.id,
        "sanemail.message_id": testCase.messageId,
        "sanemail.case_passed": testCase.passed,
        "sanemail.failed_checks": testCase.checks
          .filter((check) => !check.passed)
          .map((check) => check.name),
      }, async () => {});
    }
  });

  await flushPhoenix();

  return {
    ...getPhoenixStatus(),
    traceId,
    tracedAt: new Date().toISOString(),
  };
}

export async function flushPhoenix() {
  const state = initializePhoenix();
  if (!state.available || !state.provider) return;
  try {
    await state.provider.forceFlush?.();
  } catch (error) {
    state.available = false;
    state.error = publicError(error);
  }
}

export async function shutdownPhoenix() {
  const state = initializePhoenix();
  if (!state.available || !state.provider) return;
  try {
    await state.provider.shutdown?.();
  } catch (error) {
    state.error = publicError(error);
  }
}
