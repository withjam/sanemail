const { buildDatabaseUrls } = require("./scripts/db-env.cjs");

const urls = buildDatabaseUrls();

module.exports = {
  connectionString: urls.databaseUrl,
  shadowConnectionString: urls.shadowDatabaseUrl,
  rootConnectionString: urls.rootDatabaseUrl,
  migrationsFolder: "./migrations",
  pgSettings: {
    search_path: "public",
  },
  blankMigrationContent:
    "-- Write the next idempotent migration here. Run `bun run db:current` while iterating.\n",
};
