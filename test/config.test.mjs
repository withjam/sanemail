import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProductionConfig,
  validateSecurityConfig,
} from "../apps/api/src/config.mjs";

function buildConfig(overrides = {}) {
  return {
    env: "production",
    storage: { driver: "postgres" },
    database: { url: "postgres://x" },
    security: { appSecret: "secret-value", encryptionKey: "", encryptionKeyVersion: "v1" },
    auth: { jwtSecret: "supabase-jwt-secret", devUserId: "" },
    google: { clientId: "", clientSecret: "" },
    ...overrides,
  };
}

test("validateSecurityConfig is happy in a fully configured production environment", () => {
  assert.deepEqual(validateSecurityConfig(buildConfig()), []);
});

test("validateSecurityConfig refuses STORE_DRIVER=json in production", () => {
  const missing = validateSecurityConfig(buildConfig({ storage: { driver: "json" } }));
  assert.ok(missing.includes("STORE_DRIVER_must_be_postgres_in_production"));
});

test("validateSecurityConfig refuses missing DATABASE_URL in production", () => {
  const missing = validateSecurityConfig(buildConfig({ database: { url: "" } }));
  assert.ok(missing.includes("DATABASE_URL"));
});

test("validateSecurityConfig refuses missing SUPABASE_JWT_SECRET in production", () => {
  const missing = validateSecurityConfig(
    buildConfig({ auth: { jwtSecret: "", devUserId: "" } }),
  );
  assert.ok(missing.includes("SUPABASE_JWT_SECRET"));
});

test("validateSecurityConfig refuses DEV_USER_ID in production", () => {
  const missing = validateSecurityConfig(
    buildConfig({ auth: { jwtSecret: "ok", devUserId: "alice" } }),
  );
  assert.ok(missing.includes("DEV_USER_ID_must_not_be_set_in_production"));
});

test("validateSecurityConfig is permissive in development", () => {
  const config = buildConfig({
    env: "development",
    storage: { driver: "json" },
    database: { url: "" },
    auth: { jwtSecret: "", devUserId: "alice" },
  });
  // Even with the dev shortcuts present, security validation does not flag
  // the prod-only checks.
  const missing = validateSecurityConfig(config);
  for (const code of [
    "STORE_DRIVER_must_be_postgres_in_production",
    "DATABASE_URL",
    "SUPABASE_JWT_SECRET",
    "DEV_USER_ID_must_not_be_set_in_production",
  ]) {
    assert.equal(missing.includes(code), false, `${code} should not be flagged in dev`);
  }
});

test("assertProductionConfig throws when production prerequisites are missing", () => {
  assert.throws(
    () => assertProductionConfig(buildConfig({ storage: { driver: "json" } })),
    /STORE_DRIVER_must_be_postgres_in_production/,
  );
});

test("assertProductionConfig is a no-op in development", () => {
  assert.doesNotThrow(() => assertProductionConfig(buildConfig({ env: "development" })));
});
