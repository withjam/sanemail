import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "pipe",
      ...options,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed (${code})\n${stderr}`));
    });
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server did not start in time.")), 5000);

    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("SaneMail API running")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited before smoke test completed (${code}).`));
    });
  });
}

async function expectPage(origin, pathName, expectedText) {
  const response = await fetch(`${origin}${pathName}`);
  if (!response.ok) {
    throw new Error(`${pathName} returned HTTP ${response.status}`);
  }

  const html = await response.text();
  for (const text of expectedText) {
    if (!html.includes(text)) {
      throw new Error(`${pathName} did not contain expected text: ${text}`);
    }
  }
}

async function expectJson(origin, pathName, validate) {
  const response = await fetch(`${origin}${pathName}`);
  if (!response.ok) {
    throw new Error(`${pathName} returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  validate(payload);
}

async function postJson(origin, pathName, body, validate) {
  const response = await fetch(`${origin}${pathName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) {
    throw new Error(`${pathName} returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  validate(payload);
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), "sanemail-smoke-"));
const port = await getFreePort();
const origin = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  DATA_DIR: dataDir,
  PORT: String(port),
  HOST: "127.0.0.1",
  APP_ORIGIN: origin,
};

let server;

try {
  await run("bun", ["apps/api/src/dev-seed.mjs"], { env });
  server = spawn("bun", ["apps/api/src/server.mjs"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer(server);

  await expectPage(origin, "/", ["<div id=\"root\"></div>", "/assets/"]);
  await expectJson(origin, "/api/status", (payload) => {
    if (payload.counts.messages !== 12) {
      throw new Error(`Expected 12 synced messages; got ${payload.counts.messages}`);
    }
  });
  await expectJson(origin, "/api/messages", (payload) => {
    const subjects = payload.messages.map((message) => message.subject);
    for (const subject of [
      "Can you review the lease renewal today?",
      "Verify your account immediately",
      "Weekend sale: limited time offer",
      "Please sign the school trip form",
      "Flight check-in opens tomorrow",
    ]) {
      if (!subjects.includes(subject)) {
        throw new Error(`Missing seeded subject: ${subject}`);
      }
    }
  });
  await expectJson(origin, "/api/today", (payload) => {
    const subjects = payload.messages.map((message) => message.subject);
    if (!subjects.includes("Can you review the lease renewal today?")) {
      throw new Error("Today did not include the seeded action item.");
    }
    if (subjects.includes("Verify your account immediately")) {
      throw new Error("Today included the seeded scam-like message.");
    }
  });
  await expectJson(origin, "/api/ai/control", (payload) => {
    if (payload.prompts.length !== 3) {
      throw new Error(`Expected 3 AI prompts; got ${payload.prompts.length}`);
    }
  });
  await postJson(origin, "/api/ai/run", {}, (payload) => {
    if (payload.run.metrics.messagesProcessed !== 12) {
      throw new Error(`Expected 12 AI decisions; got ${payload.run.metrics.messagesProcessed}`);
    }
  });
  await postJson(origin, "/api/ai/verify", {}, (payload) => {
    if (payload.run.status !== "passed") {
      throw new Error(`Expected AI verification to pass; got ${payload.run.status}`);
    }
  });

  console.log("Smoke test passed.");
} finally {
  if (server) {
    server.kill("SIGTERM");
  }
  await rm(dataDir, { recursive: true, force: true });
}
