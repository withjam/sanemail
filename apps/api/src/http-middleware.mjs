import crypto from "node:crypto";
import { loadConfig } from "./config.mjs";

const DEFAULT_BODY_LIMIT_BYTES = 1_000_000; // 1 MB
const DEFAULT_BODY_TIMEOUT_MS = 10_000;

/**
 * Attach a request id to every incoming request so logs can be correlated
 * across the web tier, the worker, and the LLM provider. Honors a
 * pre-existing `x-request-id` header (e.g. from a load balancer).
 */
export function attachRequestId(request, response) {
  const incoming = request.headers["x-request-id"];
  const requestId =
    typeof incoming === "string" && incoming.trim()
      ? incoming.trim().slice(0, 200)
      : crypto.randomUUID();
  request.requestId = requestId;
  response.setHeader("X-Request-Id", requestId);
  return requestId;
}

function safePathname(request) {
  try {
    return new URL(request.url, "http://internal").pathname;
  } catch {
    return request.url || "/";
  }
}

function clientIp(request) {
  const fwd = request.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return request.socket?.remoteAddress || "";
}

/**
 * Single-line JSON access log on response close. Errors include the message
 * but not the stack (which goes to console.error separately if thrown).
 */
export function logRequest(request, response) {
  const start = Date.now();
  const route = safePathname(request);
  const log = () => {
    const entry = {
      ts: new Date().toISOString(),
      level: response.statusCode >= 500 ? "error" : response.statusCode >= 400 ? "warn" : "info",
      msg: "http_request",
      requestId: request.requestId,
      method: request.method,
      route,
      status: response.statusCode,
      durMs: Date.now() - start,
      userId: request.userId || null,
      ip: clientIp(request),
    };
    console.log(JSON.stringify(entry));
  };
  response.once("finish", log);
  response.once("close", () => {
    if (!response.writableEnded) log();
  });
}

/**
 * Allow-list driven CORS. The web app is served from the same origin in
 * production, so the only legal cross-origin request is during local dev
 * (`vite` on a different port). We mirror exactly what's allowed and refuse
 * everything else.
 *
 * Returns true when the request was a preflight that the function handled
 * itself (caller should bail out).
 */
export function applyCors(request, response, config = loadConfig()) {
  const origin = request.headers.origin;
  if (!origin) return false;

  const allowed = new Set(
    [config.webOrigin, config.appOrigin]
      .filter(Boolean)
      .map((value) => value.replace(/\/$/, "")),
  );
  const normalizedOrigin = String(origin).replace(/\/$/, "");
  if (!allowed.has(normalizedOrigin)) {
    // Don't set CORS headers; the browser will block. We still serve the
    // request so same-origin clients (curl, server tests) work normally.
    return false;
  }

  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-Request-Id",
  );
  response.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS",
  );
  response.setHeader("Access-Control-Max-Age", "600");

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return true;
  }
  return false;
}

/**
 * Reads the request body with a hard size cap and an inactivity timeout.
 * Returns the parsed JSON value, or throws an HttpError that the caller
 * surfaces as a 4xx response.
 */
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function readJsonBody(
  request,
  { limitBytes = DEFAULT_BODY_LIMIT_BYTES, timeoutMs = DEFAULT_BODY_TIMEOUT_MS } = {},
) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];
    let settled = false;

    const finish = (handler) => (...args) => {
      if (settled) return;
      settled = true;
      cleanup();
      handler(...args);
    };
    const onSettleResolve = finish(resolve);
    const onSettleReject = finish(reject);

    const timer = setTimeout(() => {
      onSettleReject(new HttpError(408, "request_timeout", "Request body read timed out"));
      try {
        request.destroy();
      } catch {
        // ignore
      }
    }, timeoutMs);
    // Note: do NOT unref this timer. The whole point is to fire even if the
    // request is otherwise idle (slow client). Unrefing would let the event
    // loop exit before the timeout could trigger.

    const cleanup = () => {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };

    const onData = (chunk) => {
      received += chunk.length;
      if (received > limitBytes) {
        onSettleReject(
          new HttpError(413, "payload_too_large", `Body exceeds ${limitBytes} bytes`),
        );
        try {
          request.destroy();
        } catch {
          // ignore
        }
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (!chunks.length) return onSettleResolve({});
      try {
        onSettleResolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        onSettleReject(new HttpError(400, "invalid_json", `Invalid JSON: ${error.message}`));
      }
    };
    const onError = (error) =>
      onSettleReject(new HttpError(400, "request_error", error.message || "Request error"));
    const onAborted = () =>
      onSettleReject(new HttpError(400, "request_aborted", "Request aborted"));

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("aborted", onAborted);
  });
}

/**
 * Per-key sliding-window rate limiter. In-memory; safe for a single Fly
 * machine. Replace with a Postgres counter when we scale beyond one instance.
 */
export function createRateLimiter({ windowMs, max }) {
  const buckets = new Map();
  return {
    check(key) {
      const now = Date.now();
      const cutoff = now - windowMs;
      const queue = buckets.get(key) || [];
      const fresh = queue.filter((ts) => ts > cutoff);
      if (fresh.length >= max) {
        const retryAfterMs = Math.max(0, fresh[0] + windowMs - now);
        buckets.set(key, fresh);
        return { allowed: false, retryAfterMs };
      }
      fresh.push(now);
      buckets.set(key, fresh);
      return { allowed: true, retryAfterMs: 0 };
    },
    reset(key) {
      if (key === undefined) buckets.clear();
      else buckets.delete(key);
    },
    size() {
      return buckets.size;
    },
  };
}
