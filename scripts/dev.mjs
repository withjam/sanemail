import { spawn } from "node:child_process";

const env = {
  ...process.env,
  PORT: process.env.PORT || "3000",
  HOST: process.env.HOST || "127.0.0.1",
  APP_ORIGIN: process.env.APP_ORIGIN || "http://localhost:3000",
  WEB_ORIGIN: process.env.WEB_ORIGIN || "http://localhost:5173",
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
