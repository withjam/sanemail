import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("queue runtime: missing file falls back to QUEUE_AUTO_POST_INGEST_JOBS", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sanemail-queue-runtime-"));
  const prev = { dataDir: process.env.DATA_DIR, auto: process.env.QUEUE_AUTO_POST_INGEST_JOBS };

  process.env.DATA_DIR = dataDir;
  delete process.env.QUEUE_AUTO_POST_INGEST_JOBS;

  try {
    const rt = await import(`../apps/api/src/queue-runtime.mjs?qr=${encodeURIComponent(dataDir)}`);
    assert.equal(await rt.isQueueAutomationEnabled(), false);

    process.env.QUEUE_AUTO_POST_INGEST_JOBS = "true";
    const rt2 = await import(`../apps/api/src/queue-runtime.mjs?qr2=${encodeURIComponent(dataDir)}`);
    assert.equal(await rt2.isQueueAutomationEnabled(), true);
  } finally {
    if (prev.dataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prev.dataDir;
    if (prev.auto === undefined) delete process.env.QUEUE_AUTO_POST_INGEST_JOBS;
    else process.env.QUEUE_AUTO_POST_INGEST_JOBS = prev.auto;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("queue runtime: file override beats env", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sanemail-queue-runtime-2-"));
  const prev = { dataDir: process.env.DATA_DIR, auto: process.env.QUEUE_AUTO_POST_INGEST_JOBS };

  process.env.DATA_DIR = dataDir;
  process.env.QUEUE_AUTO_POST_INGEST_JOBS = "true";

  try {
    const rt = await import(`../apps/api/src/queue-runtime.mjs?qr3=${encodeURIComponent(dataDir)}`);
    await rt.writeQueueRuntimePrefs({ automationEnabled: false });
    const rtReload = await import(`../apps/api/src/queue-runtime.mjs?qr4=${encodeURIComponent(dataDir)}`);
    assert.equal(await rtReload.isQueueAutomationEnabled(), false);

    await rtReload.writeQueueRuntimePrefs({ automationEnabled: true });
    const rtReload2 = await import(`../apps/api/src/queue-runtime.mjs?qr5=${encodeURIComponent(dataDir)}`);
    assert.equal(await rtReload2.isQueueAutomationEnabled(), true);
  } finally {
    if (prev.dataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prev.dataDir;
    if (prev.auto === undefined) delete process.env.QUEUE_AUTO_POST_INGEST_JOBS;
    else process.env.QUEUE_AUTO_POST_INGEST_JOBS = prev.auto;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("queue runtime: per-source override beats legacy global", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sanemail-queue-runtime-3-"));
  const prev = { dataDir: process.env.DATA_DIR, auto: process.env.QUEUE_AUTO_POST_INGEST_JOBS };

  process.env.DATA_DIR = dataDir;
  process.env.QUEUE_AUTO_POST_INGEST_JOBS = "false";

  try {
    const rt = await import(`../apps/api/src/queue-runtime.mjs?qr6=${encodeURIComponent(dataDir)}`);
    await rt.writeQueueRuntimePrefs({ automationEnabled: false });
    await rt.writeSourceAutomationOverride("src-a", true);
    const rt2 = await import(`../apps/api/src/queue-runtime.mjs?qr7=${encodeURIComponent(dataDir)}`);
    assert.equal(await rt2.isQueueAutomationEnabledForSource("src-a"), true);
    assert.equal(await rt2.isQueueAutomationEnabledForSource("src-b"), false);
  } finally {
    if (prev.dataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prev.dataDir;
    if (prev.auto === undefined) delete process.env.QUEUE_AUTO_POST_INGEST_JOBS;
    else process.env.QUEUE_AUTO_POST_INGEST_JOBS = prev.auto;
    await rm(dataDir, { recursive: true, force: true });
  }
});
