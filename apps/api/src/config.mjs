import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function loadDotEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim().replace(/^export\s+/, "");
    const rawValue = trimmed.slice(equalsIndex + 1).trim();
    const value = rawValue.startsWith("\"") || rawValue.startsWith("'")
      ? rawValue.replace(/^['"]|['"]$/g, "")
      : rawValue.replace(/\s+#.*$/, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function booleanEnv(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function thinkEnv(name, defaultValue = "high") {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  const normalized = value.toLowerCase();
  if (["0", "false", "no", "off", "none", "non-thinking", "nothink"].includes(normalized)) {
    return false;
  }
  if (["1", "true", "yes", "on", "thinking", "think"].includes(normalized)) return true;
  return normalized;
}

export function loadConfig() {
  loadDotEnv();

  const port = Number(process.env.PORT || 3000);
  const appOrigin = process.env.APP_ORIGIN || `http://localhost:${port}`;
  const webOrigin = process.env.WEB_ORIGIN || appOrigin;

  return {
    port,
    host: process.env.HOST || "127.0.0.1",
    appOrigin,
    webOrigin,
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
      redirectUri:
        process.env.GOOGLE_REDIRECT_URI ||
        `${appOrigin}/oauth/google/callback`,
      readonlyScope: "https://www.googleapis.com/auth/gmail.readonly",
    },
    sync: {
      messageLimit: Number(process.env.SYNC_MESSAGE_LIMIT || 50),
      query: process.env.SYNC_QUERY || "newer_than:90d -in:chats",
    },
    ai: {
      provider: String(process.env.AI_PROVIDER || "mock").trim().toLowerCase(),
      fallbackToMock: booleanEnv("AI_FALLBACK_TO_MOCK", true),
      timeoutMs: Number(process.env.AI_TIMEOUT_MS || 120_000),
      maxRetries: Number(process.env.AI_MAX_RETRIES || 2),
      runLimit: Number(process.env.AI_RUN_LIMIT || 12),
      ollamaClassifyMessages: booleanEnv("AI_OLLAMA_CLASSIFY_MESSAGES", false),
    },
    ollama: {
      host: process.env.OLLAMA_HOST || "http://127.0.0.1:11434",
      model: process.env.OLLAMA_MODEL || process.env.AI_MODEL || "deepseek-v4-pro:cloud",
      think: thinkEnv("OLLAMA_THINK", thinkEnv("AI_THINK", "high")),
      apiKey: process.env.OLLAMA_API_KEY || "",
      temperature: Number(process.env.OLLAMA_TEMPERATURE || 0),
    },
    phoenix: {
      enabled: booleanEnv("PHOENIX_ENABLED", false),
      projectName: process.env.PHOENIX_PROJECT_NAME || "Sanemail",
      collectorEndpoint: process.env.PHOENIX_COLLECTOR_ENDPOINT || "http://localhost:6006",
      batch: booleanEnv("PHOENIX_BATCH", false),
      allowSensitiveContent: booleanEnv("PHOENIX_ALLOW_SENSITIVE_CONTENT", false),
    },
  };
}

export function validateGoogleConfig(config) {
  const missing = [];
  if (!config.google.clientId) missing.push("GOOGLE_CLIENT_ID");
  if (!config.google.clientSecret) missing.push("GOOGLE_CLIENT_SECRET");
  return missing;
}
