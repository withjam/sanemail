const fs = require("node:fs");
const path = require("node:path");

function loadDotEnv(cwd = process.cwd()) {
  const envPath = path.join(cwd, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
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

function buildDatabaseUrlFromParts(databaseName = process.env.POSTGRES_DB || "sanemail") {
  const host = process.env.POSTGRES_HOST || "";
  if (!host) return "";

  const user = encodeURIComponent(process.env.POSTGRES_USER || "postgres");
  const password = encodeURIComponent(process.env.POSTGRES_PASSWORD || "");
  const auth = password ? `${user}:${password}` : user;
  const port = process.env.POSTGRES_PORT || "5432";
  const database = encodeURIComponent(databaseName);
  return `postgres://${auth}@${host}:${port}/${database}`;
}

function databaseNameFromUrl(connectionString) {
  if (!connectionString) return "";
  const parsed = new URL(connectionString);
  return decodeURIComponent(parsed.pathname.replace(/^\//, "")) || "";
}

function replaceDatabaseName(connectionString, databaseName) {
  if (!connectionString || !databaseName) return "";
  const parsed = new URL(connectionString);
  parsed.pathname = `/${encodeURIComponent(databaseName)}`;
  return parsed.toString();
}

function buildDatabaseUrls() {
  loadDotEnv();

  const databaseUrl =
    process.env.DATABASE_URL ||
    buildDatabaseUrlFromParts(process.env.POSTGRES_DB || "sanemail");
  const databaseName =
    databaseNameFromUrl(databaseUrl) ||
    process.env.POSTGRES_DB ||
    "sanemail";
  const shadowDatabaseName =
    process.env.POSTGRES_SHADOW_DB ||
    `${databaseName}_shadow`;
  const rootDatabaseName = process.env.POSTGRES_ROOT_DB || "postgres";

  return {
    databaseUrl,
    databaseName,
    shadowDatabaseUrl:
      process.env.SHADOW_DATABASE_URL ||
      replaceDatabaseName(databaseUrl, shadowDatabaseName),
    shadowDatabaseName,
    rootDatabaseUrl:
      process.env.ROOT_DATABASE_URL ||
      replaceDatabaseName(databaseUrl, rootDatabaseName),
    rootDatabaseName,
  };
}

module.exports = {
  buildDatabaseUrls,
  databaseNameFromUrl,
  loadDotEnv,
};
