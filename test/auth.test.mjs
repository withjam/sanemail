import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  AuthError,
  describeAuthMode,
  extractBearer,
  requireUser,
  verifyJwt,
} from "../apps/api/src/auth.mjs";

const SECRET = "supabase-test-jwt-secret-do-not-use-in-prod";

function base64url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signHs256(payload, { secret = SECRET, header = { alg: "HS256", typ: "JWT" } } = {}) {
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = base64url(
    crypto.createHmac("sha256", secret).update(signingInput).digest(),
  );
  return `${signingInput}.${signature}`;
}

function withEnv(values, fn) {
  const previous = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function buildConfig(overrides = {}) {
  return {
    env: "development",
    auth: {
      jwtSecret: SECRET,
      jwtIssuer: "",
      jwtAudience: "authenticated",
      devUserId: "",
      devUserEmail: "",
      ...overrides,
    },
  };
}

test("verifyJwt accepts a well-formed HS256 Supabase token", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const token = signHs256({
    sub: "user-1",
    email: "alice@example.com",
    aud: "authenticated",
    iss: "https://demo.supabase.co/auth/v1",
    iat: nowSec,
    exp: nowSec + 3600,
  });

  const payload = verifyJwt(token, {
    config: buildConfig({ jwtIssuer: "https://demo.supabase.co/auth/v1" }),
  });
  assert.equal(payload.sub, "user-1");
  assert.equal(payload.email, "alice@example.com");
});

test("verifyJwt rejects tampered tokens", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const token = signHs256({ sub: "user-1", aud: "authenticated", exp: nowSec + 3600 });
  const tampered = `${token}x`;
  assert.throws(() => verifyJwt(tampered, { config: buildConfig() }), AuthError);
});

test("verifyJwt rejects expired tokens", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const token = signHs256({ sub: "user-1", aud: "authenticated", exp: nowSec - 3600 });
  assert.throws(
    () => verifyJwt(token, { config: buildConfig() }),
    /JWT expired/,
  );
});

test("verifyJwt rejects audience mismatch", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const token = signHs256({ sub: "user-1", aud: "anon", exp: nowSec + 3600 });
  assert.throws(
    () => verifyJwt(token, { config: buildConfig() }),
    /audience mismatch/,
  );
});

test("verifyJwt rejects issuer mismatch", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const token = signHs256({
    sub: "user-1",
    aud: "authenticated",
    iss: "https://attacker.example.com",
    exp: nowSec + 3600,
  });
  assert.throws(
    () => verifyJwt(token, { config: buildConfig({ jwtIssuer: "https://demo.supabase.co/auth/v1" }) }),
    /issuer mismatch/,
  );
});

test("verifyJwt rejects unsupported algorithms (alg=none)", () => {
  const headerB64 = base64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payloadB64 = base64url(
    JSON.stringify({
      sub: "user-1",
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  const token = `${headerB64}.${payloadB64}.`;
  assert.throws(
    () => verifyJwt(token, { config: buildConfig() }),
    /Unsupported JWT alg/,
  );
});

test("requireUser returns user from a valid bearer token", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const token = signHs256({
    sub: "user-42",
    email: "bob@example.com",
    aud: "authenticated",
    exp: nowSec + 3600,
  });
  const request = { headers: { authorization: `Bearer ${token}` } };
  const user = requireUser(request, { config: buildConfig() });
  assert.equal(user.userId, "user-42");
  assert.equal(user.email, "bob@example.com");
  assert.equal(user.via, "jwt");
});

test("requireUser falls back to DEV_USER_ID outside production", () => {
  const request = { headers: {} };
  const config = buildConfig({ devUserId: "local:dev-user" });
  config.env = "development";
  const user = requireUser(request, { config });
  assert.equal(user.userId, "local:dev-user");
  assert.equal(user.via, "dev_bypass");
});

test("requireUser refuses dev bypass in production", () => {
  const request = { headers: {} };
  const config = buildConfig({ devUserId: "local:dev-user" });
  config.env = "production";
  assert.throws(() => requireUser(request, { config }), /Missing bearer token/);
});

test("requireUser refuses requests without a token by default", () => {
  const request = { headers: {} };
  assert.throws(() => requireUser(request, { config: buildConfig() }), /Missing bearer token/);
});

test("extractBearer parses standard Authorization header", () => {
  assert.equal(extractBearer({ headers: { authorization: "Bearer abc.def.ghi" } }), "abc.def.ghi");
  assert.equal(extractBearer({ headers: { Authorization: "bearer xyz" } }), "xyz");
  assert.equal(extractBearer({ headers: {} }), null);
});

test("describeAuthMode reports dev_bypass when DEV_USER_ID is set in dev", () => {
  withEnv(
    {
      NODE_ENV: "development",
      DEV_USER_ID: "dev-user-1",
      SUPABASE_JWT_SECRET: SECRET,
      AUTH_JWT_SECRET: undefined,
      DEV_USER_EMAIL: undefined,
      SUPABASE_JWT_ISSUER: undefined,
      SUPABASE_JWT_AUDIENCE: undefined,
    },
    () => {
      const mode = describeAuthMode();
      assert.equal(mode.mode, "dev_bypass");
      assert.equal(mode.devUserId, "dev-user-1");
    },
  );
});
