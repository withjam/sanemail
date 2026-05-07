import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  applyCors,
  attachRequestId,
  createRateLimiter,
  HttpError,
  readJsonBody,
} from "../apps/api/src/http-middleware.mjs";

class FakeResponse {
  constructor() {
    this.headers = {};
    this.statusCode = 200;
    this.ended = false;
    this.bodyChunks = [];
  }
  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
  }
  getHeader(name) {
    return this.headers[name.toLowerCase()];
  }
  writeHead(status) {
    this.statusCode = status;
  }
  end(value) {
    if (value !== undefined) this.bodyChunks.push(value);
    this.ended = true;
  }
  once() {
    // not exercised in these tests
    return this;
  }
}

class FakeRequest extends EventEmitter {
  constructor({ method = "POST", url = "/", headers = {} } = {}) {
    super();
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.socket = { remoteAddress: "127.0.0.1" };
    this.destroyed = false;
    // EventEmitter throws on `error` events with no listeners. The middleware
    // detaches listeners as soon as it settles, so an out-of-band emit (e.g.
    // from destroy()) would otherwise crash the test runner.
    this.on("error", () => {});
  }
  destroy() {
    this.destroyed = true;
  }
}

test("attachRequestId sets a uuid when no header is present", () => {
  const req = new FakeRequest({ headers: {} });
  const res = new FakeResponse();
  const id = attachRequestId(req, res);
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(res.headers["x-request-id"], id);
  assert.equal(req.requestId, id);
});

test("attachRequestId honors an inbound x-request-id", () => {
  const req = new FakeRequest({ headers: { "x-request-id": "trace-42" } });
  const res = new FakeResponse();
  const id = attachRequestId(req, res);
  assert.equal(id, "trace-42");
  assert.equal(res.headers["x-request-id"], "trace-42");
});

test("applyCors allows the configured WEB_ORIGIN", () => {
  const config = {
    webOrigin: "http://localhost:5173",
    appOrigin: "http://localhost:3000",
  };
  const req = new FakeRequest({ method: "GET", headers: { origin: "http://localhost:5173" } });
  const res = new FakeResponse();
  const handled = applyCors(req, res, config);
  assert.equal(handled, false);
  assert.equal(res.headers["access-control-allow-origin"], "http://localhost:5173");
  assert.equal(res.headers["access-control-allow-credentials"], "true");
});

test("applyCors handles preflight OPTIONS itself", () => {
  const config = { webOrigin: "http://localhost:5173", appOrigin: "http://localhost:3000" };
  const req = new FakeRequest({ method: "OPTIONS", headers: { origin: "http://localhost:5173" } });
  const res = new FakeResponse();
  const handled = applyCors(req, res, config);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 204);
  assert.equal(res.ended, true);
});

test("applyCors does not echo a foreign origin", () => {
  const config = { webOrigin: "http://localhost:5173", appOrigin: "http://localhost:3000" };
  const req = new FakeRequest({ method: "GET", headers: { origin: "http://evil.example" } });
  const res = new FakeResponse();
  applyCors(req, res, config);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});

test("readJsonBody parses a small request", async () => {
  const req = new FakeRequest();
  setImmediate(() => {
    req.emit("data", Buffer.from(JSON.stringify({ hello: "world" }), "utf8"));
    req.emit("end");
  });
  const body = await readJsonBody(req);
  assert.deepEqual(body, { hello: "world" });
});

test("readJsonBody rejects bodies above the size limit with 413", async () => {
  const req = new FakeRequest();
  const limit = 50;
  setImmediate(() => {
    req.emit("data", Buffer.alloc(limit + 1, "x"));
  });
  try {
    await readJsonBody(req, { limitBytes: limit });
    assert.fail("expected HttpError");
  } catch (error) {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 413);
    assert.equal(error.code, "payload_too_large");
  }
});

test("readJsonBody rejects malformed JSON with 400", async () => {
  const req = new FakeRequest();
  setImmediate(() => {
    req.emit("data", Buffer.from("not json"));
    req.emit("end");
  });
  try {
    await readJsonBody(req);
    assert.fail("expected HttpError");
  } catch (error) {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 400);
    assert.equal(error.code, "invalid_json");
  }
});

test("readJsonBody times out a slow client with 408", async () => {
  const req = new FakeRequest();
  // never emit anything
  try {
    await readJsonBody(req, { timeoutMs: 30 });
    assert.fail("expected HttpError");
  } catch (error) {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 408);
    assert.equal(error.code, "request_timeout");
  }
});

test("createRateLimiter allows up to N then refuses with retry-after", () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 3 });
  assert.equal(limiter.check("alice").allowed, true);
  assert.equal(limiter.check("alice").allowed, true);
  assert.equal(limiter.check("alice").allowed, true);
  const fourth = limiter.check("alice");
  assert.equal(fourth.allowed, false);
  assert.ok(fourth.retryAfterMs >= 0);
  // Different key has its own bucket.
  assert.equal(limiter.check("bob").allowed, true);
});
