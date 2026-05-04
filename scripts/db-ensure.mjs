import pg from "pg";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildDatabaseUrls } = require("./db-env.cjs");

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, "\"\"")}"`;
}

async function databaseExists(client, name) {
  const result = await client.query("select 1 from pg_database where datname = $1", [name]);
  return result.rowCount > 0;
}

async function ensureDatabase(client, name) {
  if (await databaseExists(client, name)) {
    console.log(`Database ${name} already exists.`);
    return false;
  }

  await client.query(`create database ${quoteIdentifier(name)}`);
  console.log(`Created database ${name}.`);
  return true;
}

const urls = buildDatabaseUrls();

if (!urls.databaseUrl) {
  throw new Error(
    "Set DATABASE_URL or POSTGRES_HOST/POSTGRES_PASSWORD before running database bootstrap.",
  );
}

if (!urls.rootDatabaseUrl) {
  throw new Error("Set ROOT_DATABASE_URL or POSTGRES_ROOT_DB before running database bootstrap.");
}

const client = new pg.Client({ connectionString: urls.rootDatabaseUrl });
await client.connect();

try {
  await ensureDatabase(client, urls.databaseName);
  await ensureDatabase(client, urls.shadowDatabaseName);
} finally {
  await client.end();
}
