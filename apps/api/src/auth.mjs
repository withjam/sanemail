import crypto from "node:crypto";
import { loadConfig } from "./config.mjs";

export class AuthError extends Error {
  constructor(message, { status = 401, code = "unauthorized" } = {}) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

function base64UrlDecode(value) {
  if (!value) return Buffer.alloc(0);
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function timingSafeEqualBuffers(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function decodeSegments(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) {
    throw new AuthError("Malformed JWT: expected three segments", {
      code: "invalid_token",
    });
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  let header;
  let payload;
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString("utf8"));
    payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8"));
  } catch {
    throw new AuthError("Malformed JWT: invalid header or payload encoding", {
      code: "invalid_token",
    });
  }

  return {
    header,
    payload,
    signingInput: Buffer.from(`${headerB64}.${payloadB64}`, "utf8"),
    signature: base64UrlDecode(signatureB64),
  };
}

function verifyHs256(signingInput, signature, secret) {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(signingInput)
    .digest();
  return timingSafeEqualBuffers(expected, signature);
}

function checkClaims(payload, { issuer, audience, clockToleranceSec = 30 }) {
  const nowSec = Math.floor(Date.now() / 1000);

  if (typeof payload.exp !== "number" || payload.exp + clockToleranceSec < nowSec) {
    throw new AuthError("JWT expired", { code: "token_expired" });
  }
  if (typeof payload.nbf === "number" && payload.nbf - clockToleranceSec > nowSec) {
    throw new AuthError("JWT not yet valid", { code: "token_not_active" });
  }
  if (issuer && payload.iss !== issuer) {
    throw new AuthError("JWT issuer mismatch", { code: "issuer_mismatch" });
  }
  if (audience) {
    const audClaim = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audClaim.includes(audience)) {
      throw new AuthError("JWT audience mismatch", { code: "audience_mismatch" });
    }
  }
  if (!payload.sub || typeof payload.sub !== "string") {
    throw new AuthError("JWT missing subject claim", { code: "missing_subject" });
  }
}

export function verifyJwt(token, { config = loadConfig() } = {}) {
  const { jwtSecret, jwtIssuer, jwtAudience } = config.auth;
  if (!jwtSecret) {
    throw new AuthError("Server is missing SUPABASE_JWT_SECRET", {
      status: 500,
      code: "server_misconfigured",
    });
  }

  const { header, payload, signingInput, signature } = decodeSegments(token);

  if (header.alg !== "HS256") {
    throw new AuthError(`Unsupported JWT alg: ${header.alg}`, {
      code: "unsupported_alg",
    });
  }

  if (!verifyHs256(signingInput, signature, jwtSecret)) {
    throw new AuthError("JWT signature verification failed", {
      code: "bad_signature",
    });
  }

  checkClaims(payload, {
    issuer: jwtIssuer || undefined,
    audience: jwtAudience || undefined,
  });

  return payload;
}

export function extractBearer(request) {
  const header = request.headers?.authorization || request.headers?.Authorization;
  if (!header) return null;
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function devBypass(config) {
  if (config.env === "production") return null;
  const devUserId = config.auth.devUserId;
  if (!devUserId) return null;
  return {
    userId: devUserId,
    email: config.auth.devUserEmail || `${devUserId}@dev.local`,
    via: "dev_bypass",
  };
}

export function requireUser(request, { config = loadConfig() } = {}) {
  const token = extractBearer(request);
  if (!token) {
    const bypass = devBypass(config);
    if (bypass) return bypass;
    throw new AuthError("Missing bearer token", { code: "missing_token" });
  }

  const payload = verifyJwt(token, { config });
  return {
    userId: payload.sub,
    email: payload.email || null,
    raw: payload,
    via: "jwt",
  };
}

export function describeAuthMode(config = loadConfig()) {
  if (config.env !== "production" && config.auth.devUserId) {
    return {
      mode: "dev_bypass",
      devUserId: config.auth.devUserId,
      jwtConfigured: Boolean(config.auth.jwtSecret),
    };
  }
  return {
    mode: "jwt",
    jwtConfigured: Boolean(config.auth.jwtSecret),
    issuer: config.auth.jwtIssuer || null,
    audience: config.auth.jwtAudience || null,
  };
}
