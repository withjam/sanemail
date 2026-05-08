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

function buildDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const host = process.env.POSTGRES_HOST || "";
  if (!host) return "";

  const user = encodeURIComponent(process.env.POSTGRES_USER || "postgres");
  const password = encodeURIComponent(process.env.POSTGRES_PASSWORD || "");
  const auth = password ? `${user}:${password}` : user;
  const port = process.env.POSTGRES_PORT || "5432";
  const database = encodeURIComponent(process.env.POSTGRES_DB || "sanemail");
  return `postgres://${auth}@${host}:${port}/${database}`;
}

export function loadConfig() {
  loadDotEnv();

  const port = Number(process.env.PORT || 3000);
  const appOrigin = process.env.APP_ORIGIN || `http://localhost:${port}`;
  const webOrigin = process.env.WEB_ORIGIN || appOrigin;
  const databaseUrl = buildDatabaseUrl();
  const ollamaModel = process.env.OLLAMA_MODEL || process.env.AI_MODEL || "deepseek-v4-pro:cloud";
  const env = (process.env.NODE_ENV || "development").toLowerCase();

  return {
    env,
    port,
    host: process.env.HOST || "127.0.0.1",
    appOrigin,
    webOrigin,
    database: {
      url: databaseUrl,
      host: process.env.POSTGRES_HOST || "",
      port: Number(process.env.POSTGRES_PORT || 5432),
      database: process.env.POSTGRES_DB || "sanemail",
      user: process.env.POSTGRES_USER || "postgres",
      password: process.env.POSTGRES_PASSWORD || "",
    },
    storage: {
      driver: String(process.env.STORE_DRIVER || "json").trim().toLowerCase(),
    },
    security: {
      appSecret: process.env.APP_SECRET || "",
      encryptionKey: process.env.ENCRYPTION_KEY || "",
      encryptionKeyVersion: process.env.ENCRYPTION_KEY_VERSION || "local-v1",
    },
    auth: {
      jwtSecret:
        process.env.SUPABASE_JWT_SECRET ||
        process.env.AUTH_JWT_SECRET ||
        "",
      jwtIssuer: process.env.SUPABASE_JWT_ISSUER || process.env.AUTH_JWT_ISSUER || "",
      jwtAudience:
        process.env.SUPABASE_JWT_AUDIENCE ||
        process.env.AUTH_JWT_AUDIENCE ||
        "authenticated",
      devUserId: process.env.DEV_USER_ID || "",
      devUserEmail: process.env.DEV_USER_EMAIL || "",
    },
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
      backfillMessageLimit: Number(process.env.SYNC_BACKFILL_MESSAGE_LIMIT || process.env.SYNC_MESSAGE_LIMIT || 50),
      backfillCutoffDays: Number(process.env.SYNC_BACKFILL_CUTOFF_DAYS || 90),
    },
    queue: {
      driver: process.env.QUEUE_DRIVER || "local-json",
      databaseUrl: process.env.QUEUE_DATABASE_URL || databaseUrl,
      pollIntervalMs: Number(process.env.QUEUE_POLL_INTERVAL_MS || 1000),
      classificationBatchSize: Number(process.env.CLASSIFICATION_BATCH_SIZE || 10),
      autoPostIngestJobs: booleanEnv("QUEUE_AUTO_POST_INGEST_JOBS", false),
    },
    ai: {
      timeoutMs: Number(process.env.AI_TIMEOUT_MS || 120_000),
      maxRetries: Number(process.env.AI_MAX_RETRIES || 3),
      runLimit: Number(process.env.AI_RUN_LIMIT || 500),
      briefingMode: process.env.AI_BRIEFING_MODE || "auto",
      ollamaClassifyMessages: booleanEnv("AI_OLLAMA_CLASSIFY_MESSAGES", false),
    },
    ollama: {
      host: process.env.OLLAMA_HOST || "http://127.0.0.1:11434",
      model: ollamaModel,
      classificationModel:
        process.env.OLLAMA_CLASSIFICATION_MODEL ||
        process.env.AI_CLASSIFICATION_MODEL ||
        ollamaModel,
      think: thinkEnv("OLLAMA_THINK", thinkEnv("AI_THINK", "high")),
      classificationThink: thinkEnv(
        "OLLAMA_CLASSIFICATION_THINK",
        thinkEnv("AI_CLASSIFICATION_THINK", false),
      ),
      apiKey: process.env.OLLAMA_API_KEY || "",
      /** Creative temperature for briefing prose + reconciliation. */
      temperature: Number(process.env.OLLAMA_TEMPERATURE || 0),
      classificationTemperature: Number(process.env.OLLAMA_CLASSIFICATION_TEMPERATURE || 0),
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

export function validateSecurityConfig(config) {
  const missing = [];
  const googleConfigured = Boolean(config.google.clientId || config.google.clientSecret);
  if (
    (config.storage.driver === "postgres" || googleConfigured) &&
    !config.security.appSecret &&
    !config.security.encryptionKey
  ) {
    missing.push("APP_SECRET");
  }

  const inProd = config.env === "production";
  if (inProd && !config.auth.jwtSecret) {
    missing.push("SUPABASE_JWT_SECRET");
  }
  if (inProd && config.auth.devUserId) {
    missing.push("DEV_USER_ID_must_not_be_set_in_production");
  }
  if (inProd && config.storage.driver !== "postgres") {
    missing.push("STORE_DRIVER_must_be_postgres_in_production");
  }
  if (inProd && !config.database.url) {
    missing.push("DATABASE_URL");
  }
  return missing;
}

/**
 * Hard-fails when production prerequisites are missing. Call from server +
 * worker entry points so we crash on boot rather than serve traffic with a
 * misconfigured environment.
 */
export function assertProductionConfig(config) {
  if (config.env !== "production") return;
  const missing = validateSecurityConfig(config);
  if (!missing.length) return;
  throw new Error(
    `Refusing to start in production with invalid configuration: ${missing.join(", ")}`,
  );
}
