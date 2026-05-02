import { runAiLoop } from "./ai/pipeline.mjs";

const run = await runAiLoop({ trigger: "cli" });

console.log(
  `AI run ${run.status}: ${run.metrics.messagesProcessed} messages, ${run.metrics.latencyMs}ms, ${run.output.curatedMessageIds.length} curated`,
);
console.log(`Run id: ${run.id}`);
