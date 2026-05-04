import { existsSync } from "node:fs";
import path from "node:path";
import { runAiLoop } from "./ai/pipeline.mjs";
import { loadConfig } from "./config.mjs";

const debug = process.argv.includes("--debug") || ["1", "true", "yes", "on"].includes(String(process.env.AI_DEBUG || "").toLowerCase());
const config = loadConfig();
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : undefined;
const modeArg = process.argv.find((arg) => arg.startsWith("--mode="));
const mode = modeArg ? modeArg.slice("--mode=".length) : "cold-start";

function redactSecret(value) {
  if (!value) return "unset";
  return `set (${String(value).length} chars, redacted)`;
}

function debugLog(label, value) {
  if (!debug) return;
  console.log(`[ai:run debug] ${label}`);
  console.log(JSON.stringify(value, null, 2));
}

debugLog("resolved configuration", {
  cwd: process.cwd(),
  envFile: {
    path: path.join(process.cwd(), ".env"),
    present: existsSync(path.join(process.cwd(), ".env")),
  },
  ai: {
    provider: config.ai.provider,
    fallbackToMock: config.ai.fallbackToMock,
    timeoutMs: config.ai.timeoutMs,
    maxRetries: config.ai.maxRetries,
    runLimit: config.ai.runLimit,
    briefingMode: config.ai.briefingMode,
    cliDefaultBriefingMode: "cold-start",
    requestedBriefingMode: mode,
    ollamaClassifyMessages: config.ai.ollamaClassifyMessages,
  },
  ollama: {
    host: config.ollama.host,
    model: config.ollama.model,
    think: config.ollama.think,
    temperature: config.ollama.temperature,
    apiKey: redactSecret(config.ollama.apiKey),
  },
  phoenix: {
    enabled: config.phoenix.enabled,
    collectorEndpoint: config.phoenix.collectorEndpoint,
    projectName: config.phoenix.projectName,
  },
});
if (debug && config.ai.provider !== "ollama") {
  console.log(
    `[ai:run debug] Ollama will NOT be called because AI_PROVIDER resolved to "${config.ai.provider}". Set AI_PROVIDER=ollama to use Ollama Cloud.`,
  );
}

let run;
try {
  run = await runAiLoop({ limit, mode, trigger: "cli" });
} catch (error) {
  if (debug) {
    console.error("[ai:run debug] run failed");
    console.error(error instanceof Error ? error.stack || error.message : error);
  }
  throw error;
}

console.log(
  `AI run ${run.status}: ${run.metrics.messagesProcessed} messages, ${run.metrics.latencyMs}ms, ${run.output.curatedMessageIds.length} curated`,
);
console.log(`Run id: ${run.id}`);

debugLog("run provider", run.provider);
debugLog("run metrics", run.metrics);
debugLog("briefing output", {
  text: run.output.briefing?.text,
  narrative: run.output.briefing?.narrative,
  callouts: (run.output.briefing?.callouts || []).map((callout) => ({
    kind: callout.kind,
    label: callout.label,
    title: callout.title,
    body: callout.body,
    messageId: callout.messageId,
  })),
  prompt: run.output.briefing?.prompt,
  memory: run.output.briefing?.memory,
});
debugLog("provider fallback errors", run.provider?.fallbackErrors || []);
