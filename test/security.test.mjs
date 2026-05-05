import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("JSON store encrypts OAuth tokens at rest", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sanemail-secure-store-"));
  const previousDataDir = process.env.DATA_DIR;
  const previousStoreDriver = process.env.STORE_DRIVER;
  const previousAppSecret = process.env.APP_SECRET;
  process.env.DATA_DIR = dataDir;
  process.env.STORE_DRIVER = "json";
  process.env.APP_SECRET = "test-secret-that-is-long-enough-for-local-encryption";

  try {
    const store = await import(`../apps/api/src/store.mjs?secureStore=${encodeURIComponent(dataDir)}`);
    await store.clearLocalData();
    await store.upsertAccount({
      id: "gmail:secure@example.com",
      provider: "gmail",
      email: "secure@example.com",
      accessToken: "access-token-plain",
      refreshToken: "refresh-token-plain",
      tokenExpiresAt: "2026-05-05T12:00:00.000Z",
    });

    const raw = await readFile(path.join(dataDir, "sanemail.json"), "utf8");
    const snapshot = await store.readStore();

    assert.equal(raw.includes("access-token-plain"), false);
    assert.equal(raw.includes("refresh-token-plain"), false);
    assert.match(raw, /"authEncrypted"/);
    assert.equal(snapshot.accounts[0].accessToken, "access-token-plain");
    assert.equal(snapshot.accounts[0].refreshToken, "refresh-token-plain");
  } finally {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousStoreDriver === undefined) delete process.env.STORE_DRIVER;
    else process.env.STORE_DRIVER = previousStoreDriver;
    if (previousAppSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = previousAppSecret;

    await rm(dataDir, { recursive: true, force: true });
  }
});
