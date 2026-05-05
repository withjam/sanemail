import crypto from "node:crypto";
import { loadConfig } from "./config.mjs";

const algorithm = "aes-256-gcm";
const defaultSalt = "sanemail:encrypted-store:v1";

let cachedKey;
let cachedKeySource;

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(value) {
  return Buffer.from(String(value || ""), "base64url");
}

function keySource(config = loadConfig()) {
  if (config.security.encryptionKey) {
    return `key:${config.security.encryptionKey}`;
  }
  if (config.security.appSecret) {
    return `secret:${config.security.appSecret}`;
  }
  return "";
}

function parseEncryptionKey(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;

  const hex = normalized.match(/^[a-f0-9]{64}$/i)
    ? Buffer.from(normalized, "hex")
    : null;
  if (hex?.length === 32) return hex;

  const base64 = Buffer.from(normalized, "base64");
  if (base64.length === 32) return base64;

  throw new Error("ENCRYPTION_KEY must be 32 bytes encoded as base64 or 64 hex characters.");
}

function encryptionKey(config = loadConfig()) {
  const source = keySource(config);
  if (!source) {
    throw new Error(
      "APP_SECRET or ENCRYPTION_KEY is required before storing Gmail tokens or message bodies.",
    );
  }

  if (cachedKey && cachedKeySource === source) return cachedKey;

  const directKey = parseEncryptionKey(config.security.encryptionKey);
  cachedKey = directKey || crypto.scryptSync(config.security.appSecret, defaultSalt, 32);
  cachedKeySource = source;
  return cachedKey;
}

function aadFor(purpose) {
  return Buffer.from(`sanemail:${purpose || "secret"}:v1`, "utf8");
}

export function hasConfiguredSecret(config = loadConfig()) {
  return Boolean(config.security.appSecret || config.security.encryptionKey);
}

export function encryptJson(value, { purpose = "secret", config = loadConfig() } = {}) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(algorithm, encryptionKey(config), iv);
  cipher.setAAD(aadFor(purpose));

  const plaintext = Buffer.from(JSON.stringify(value ?? null), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    v: 1,
    alg: algorithm,
    purpose,
    keyVersion: config.security.encryptionKeyVersion,
    iv: base64Url(iv),
    tag: base64Url(cipher.getAuthTag()),
    ciphertext: base64Url(ciphertext),
  };
}

export function decryptJson(payload, { purpose, config = loadConfig() } = {}) {
  if (!payload) return null;
  if (typeof payload === "string") {
    try {
      return decryptJson(JSON.parse(payload), { purpose, config });
    } catch {
      return null;
    }
  }

  if (payload.alg !== algorithm || payload.v !== 1) {
    throw new Error("Unsupported encrypted payload format.");
  }

  const payloadPurpose = purpose || payload.purpose || "secret";
  const decipher = crypto.createDecipheriv(
    algorithm,
    encryptionKey(config),
    fromBase64Url(payload.iv),
  );
  decipher.setAAD(aadFor(payloadPurpose));
  decipher.setAuthTag(fromBase64Url(payload.tag));

  const plaintext = Buffer.concat([
    decipher.update(fromBase64Url(payload.ciphertext)),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

export function hashSensitiveValue(value, { purpose = "hash", config = loadConfig() } = {}) {
  const hmacKey = config.security.appSecret || config.security.encryptionKey || "sanemail-local-hash";
  return crypto
    .createHmac("sha256", hmacKey)
    .update(`${purpose}:${String(value || "")}`)
    .digest("hex");
}

export function redactSecret(value) {
  if (!value) return "";
  return `set:${crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12)}`;
}
