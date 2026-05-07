import { spawn } from "node:child_process";

const apiPort = process.env.API_PORT || process.env.PORT || "3000";

const env = {
  ...process.env,
  PORT: apiPort,
  API_PORT: apiPort,
  HOST: process.env.HOST || "127.0.0.1",
  APP_ORIGIN: process.env.APP_ORIGIN || `http://localhost:${apiPort}`,
  WEB_ORIGIN: process.env.WEB_ORIGIN || "http://localhost:5173",
  PHOENIX_ENABLED: process.env.PHOENIX_ENABLED || "true",
  PHOENIX_PROJECT_NAME: process.env.PHOENIX_PROJECT_NAME || "Sanemail",
  PHOENIX_COLLECTOR_ENDPOINT:
    process.env.PHOENIX_COLLECTOR_ENDPOINT || "http://localhost:6006",
  OPENINFERENCE_HIDE_INPUTS: process.env.OPENINFERENCE_HIDE_INPUTS || "true",
  OPENINFERENCE_HIDE_INPUT_MESSAGES:
    process.env.OPENINFERENCE_HIDE_INPUT_MESSAGES || "true",
  OPENINFERENCE_HIDE_EMBEDDINGS_VECTORS:
    process.env.OPENINFERENCE_HIDE_EMBEDDINGS_VECTORS || "true",
};

const processes = [
  spawn("bun", ["apps/api/src/server.mjs"], {
    env,
    stdio: "inherit",
  }),
  spawn("bun", ["run", "dev", "--host", "127.0.0.1", "--port", "5173"], {
    cwd: "apps/web",
    env,
    stdio: "inherit",
  }),
];

if (["1", "true", "yes", "on"].includes(String(process.env.QUEUE_WORKER_ENABLED || "").toLowerCase())) {
  processes.push(
    spawn("bun", ["apps/api/src/worker.mjs"], {
      env,
      stdio: "inherit",
    }),
  );
}

function shutdown(signal) {
  for (const child of processes) child.kill(signal);
}

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

for (const child of processes) {
  child.on("exit", (code, signal) => {
    if (signal) return;
    if (code && code !== 0) {
      shutdown("SIGTERM");
      process.exit(code);
    }
  });
}
