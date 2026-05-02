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

    const key = trimmed.slice(0, equalsIndex).trim();
    const rawValue = trimmed.slice(equalsIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
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
  };
}

export function validateGoogleConfig(config) {
  const missing = [];
  if (!config.google.clientId) missing.push("GOOGLE_CLIENT_ID");
  if (!config.google.clientSecret) missing.push("GOOGLE_CLIENT_SECRET");
  return missing;
}
