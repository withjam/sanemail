import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertProductionConfig,
  loadConfig,
  validateGoogleConfig,
  validateSecurityConfig,
} from "./config.mjs";
import { AuthError, describeAuthMode, requireUser } from "./auth.mjs";
import {
  applyCors,
  attachRequestId,
  createRateLimiter,
  HttpError,
  logRequest,
  readJsonBody,
} from "./http-middleware.mjs";
import {
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  getProfile,
} from "./gmail.mjs";
import {
  classificationBacklogSummaryFromStore,
  clearUserData,
  clearDemoData,
  consumeOAuthState,
  ensureUserRecord,
  getPrimarySourceConnection,
  latestInboxBriefing,
  listAiRunsFor,
  listRecentClassificationsFor,
  listVerificationRuns,
  readStoreFor,
  saveFeedback,
  saveOAuthState,
  upsertAccount,
} from "./store.mjs";
import { getClassifiedMessages, isSentByMailbox } from "./classifier.mjs";
import { listQueueJobs } from "./queue.mjs";
import { enqueueJob } from "./queue.mjs";
import { resetDemoData } from "./demo-data.mjs";
import { syncSourceConnection } from "./source-sync.mjs";
import { synthesizeIngestionBatch } from "./synthetic-ingestion.mjs";
import { maybeEnqueuePostIngestClassification } from "./post-ingest-jobs.mjs";
import { getPromptRecords } from "./ai/prompts.mjs";
import { getAiEvalRecords } from "./ai/evals.mjs";
import { buildInboxBriefing, runClassificationBatch, runDailyBrief } from "./ai/pipeline.mjs";
import { runSyntheticVerification } from "./ai/verification.mjs";
import { getPhoenixStatus } from "./ai/phoenix.mjs";

const config = loadConfig();
const webDistDir = path.join(process.cwd(), "apps", "web", "dist");

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function sendJson(response, payload, status = 200) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, text, status = 200, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  response.end(text);
}

function redirect(response, location) {
  response.writeHead(302, { Location: location });
  response.end();
}

function pickPrimaryAccount(store) {
  const accounts = store?.accounts || [];
  const real = accounts.find((account) => account && account.provider !== "mock" && !account.demo);
  return real || accounts[0] || null;
}

function getMessageList(store, account) {
  return getClassifiedMessages(store, account)
    .filter((message) => !isSentByMailbox(message, account))
    .sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );
}

function getTodayMessages(store, account) {
  return getClassifiedMessages(store, account)
    .filter((message) => !isSentByMailbox(message, account))
    .filter((message) => !message.sane.possibleJunk)
    .filter((message) => message.sane.category === "Today" || message.sane.needsReply)
    .sort((a, b) => b.sane.todayScore - a.sane.todayScore)
    .slice(0, 30);
}

function latestAiRun(store) {
  return [...(store.aiRuns || [])].sort(
    (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime(),
  )[0] || null;
}

function decisionMap(run) {
  return new Map((run?.output?.decisions || []).map((decision) => [decision.messageId, decision]));
}

const upcomingTermPattern =
  /\b(autopay|appointment|boarding pass|check-in|deadline|due|expires|flight|invoice|lesson|payment|pickup|registration|reminder|renewal|renews|reservation|scheduled|starts|street sweeping|ticket)\b|\b(bill|dues|installment|permit|refill|subscription)\b/i;
const upcomingTimePattern =
  /\bby\s+(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(morning|afternoon|evening)\b|\b(tomorrow|next week)\b/i;
const completedUpdatePattern =
  /\b(no action needed|no action is needed|package delivered|was delivered|receipt total|thanks for your order|refund processed|payment posted successfully)\b/i;

function messageTime(message) {
  const time = new Date(message.date || Number(message.internalDate) || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function sortByDateDesc(messages) {
  return [...messages].sort((a, b) => messageTime(b) - messageTime(a));
}

function sortByAttention(messages) {
  return [...messages].sort((a, b) => {
    if (b.sane.todayScore !== a.sane.todayScore) return b.sane.todayScore - a.sane.todayScore;
    return messageTime(b) - messageTime(a);
  });
}

export function hasUpcomingSignal(message, decision) {
  const text = `${message.subject || ""}\n${message.snippet || ""}\n${message.bodyText || ""}`.toLowerCase();
  const extractedDeadlines = decision?.extracted?.deadlines || [];
  const extractedActions = decision?.extracted?.actions || [];
  const explicitUpcomingText = upcomingTermPattern.test(text) || upcomingTimePattern.test(text);
  const usefulDeadline = extractedDeadlines.some((deadline) => {
    const normalized = String(deadline || "").toLowerCase();
    if (!normalized) return false;
    if (["today", "this morning"].includes(normalized)) return explicitUpcomingText;
    return true;
  });
  const usefulAction =
    explicitUpcomingText &&
    extractedActions.some((action) => ["pay", "schedule", "confirm", "sign"].includes(action));

  if (completedUpdatePattern.test(text) && !usefulDeadline) return false;
  return explicitUpcomingText || usefulDeadline || usefulAction;
}

function messageAgeHours(message) {
  const time = messageTime(message);
  if (!Number.isFinite(time)) return 9999;
  return Math.max(0, (Date.now() - time) / 36e5);
}

export function buildHomeTabs(messages, decisions = new Map()) {
  const visible = messages
    .filter((message) => !message.sane.possibleJunk)
    .map((message) => ({
      message,
      upcoming: hasUpcomingSignal(message, decisions.get(message.id)),
    }));

  const needsReply = sortByAttention(
    visible.filter((item) => item.message.sane.needsReply).map((item) => item.message),
  ).slice(0, 8);
  const upcoming = sortByDateDesc(
    visible
      .filter((item) => !item.message.sane.needsReply && item.upcoming)
      .map((item) => item.message),
  ).slice(0, 8);
  const mostRecent = sortByDateDesc(
    visible
      .filter((item) => !item.message.sane.needsReply && !item.upcoming)
      .map((item) => item.message),
  ).slice(0, 8);

  return { mostRecent, needsReply, upcoming };
}

function publicAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    provider: account.provider,
    email: account.email,
    messagesTotal: account.messagesTotal,
    threadsTotal: account.threadsTotal,
    historyId: account.historyId,
    scope: account.scope,
    demo: Boolean(account.demo),
    updatedAt: account.updatedAt,
  };
}

async function parseJsonBody(request) {
  return readJsonBody(request);
}

async function routeStatus(userId, response) {
  if (!userId) {
    sendJson(response, {
      account: null,
      authenticated: false,
      configMissing: validateGoogleConfig(config),
      securityMissing: validateSecurityConfig(config),
      authMode: describeAuthMode(config),
      connectedProviders: [],
      counts: { messages: 0, today: 0, needsReply: 0, junkReview: 0 },
      gmailReadonly: config.google.readonlyScope,
    });
    return;
  }

  const store = await readStoreFor(userId);
  const account = pickPrimaryAccount(store);
  const messages = getMessageList(store, account);
  const today = getTodayMessages(store, account);
  const connectedProviders = [...new Set((store.accounts || []).map((a) => a?.provider).filter(Boolean))];

  sendJson(response, {
    account: publicAccount(account),
    authenticated: true,
    configMissing: validateGoogleConfig(config),
    securityMissing: validateSecurityConfig(config),
    authMode: describeAuthMode(config),
    connectedProviders,
    counts: {
      messages: messages.length,
      today: today.length,
      needsReply: messages.filter((message) => !message.sane.possibleJunk && message.sane.needsReply).length,
      junkReview: messages.filter((message) => message.sane.possibleJunk).length,
    },
    gmailReadonly: config.google.readonlyScope,
  });
}

async function routeMessages(userId, response) {
  const store = await readStoreFor(userId);
  const account = pickPrimaryAccount(store);
  sendJson(response, { messages: getMessageList(store, account) });
}

async function routeToday(userId, response) {
  const store = await readStoreFor(userId);
  const account = pickPrimaryAccount(store);
  sendJson(response, { messages: getTodayMessages(store, account) });
}

async function routeHome(userId, response) {
  const store = await readStoreFor(userId);
  const account = pickPrimaryAccount(store);
  const messages = getMessageList(store, account);
  const visibleMessages = messages.filter((message) => !message.sane.possibleJunk);
  const run = latestAiRun(store);
  // Store is already user-scoped via readStoreFor(); no per-account filter needed.
  const storedBriefing = latestInboxBriefing(store);
  const decisions = decisionMap(run);
  const tabs = buildHomeTabs(messages, decisions);
  const briefing =
    storedBriefing ||
    run?.output?.briefing ||
    buildInboxBriefing(
      visibleMessages.map((message) => {
        const decision = decisions.get(message.id);
        const upcomingSignal = hasUpcomingSignal(message, decision);
        const ageHours = Number(messageAgeHours(message).toFixed(2));
        return {
          messageId: message.id,
          subject: message.subject,
          deliveredAt: message.date,
          possibleJunk: message.sane.possibleJunk,
          suppressFromToday: message.sane.possibleJunk,
          automated: message.sane.automated,
          needsReply: message.sane.needsReply,
          recsysScore: message.sane.todayScore,
          temporal: {
            deliveredAt: message.date,
            ageHours,
            recent: ageHours <= 24,
            within7Days: ageHours <= 168,
          },
          extracted: {
            actions: decision?.extracted?.actions || [],
            deadlines: decision?.extracted?.deadlines || (upcomingSignal ? ["upcoming"] : []),
          },
        };
      }),
      { previousBriefing: storedBriefing },
    );
  sendJson(response, {
    briefing: {
      ...briefing,
      runId: briefing.runId || run?.id || null,
      provider: briefing.provider || run?.provider || null,
      stale: !storedBriefing && !run?.output?.briefing,
    },
    tabs,
  });
}

async function routeMessage(userId, messageId, response) {
  const store = await readStoreFor(userId);
  const account = pickPrimaryAccount(store);
  const message = getMessageList(store, account).find((item) => item.id === messageId);
  if (!message) {
    sendJson(response, { error: "message_not_found" }, 404);
    return;
  }
  sendJson(response, { message });
}

async function routeFeedback(userId, messageId, request, response) {
  const body = await parseJsonBody(request);
  const kind = body.kind;
  if (!kind) {
    sendJson(response, { error: "missing_feedback_kind" }, 400);
    return;
  }
  // Verify the message belongs to this user before recording feedback.
  const store = await readStoreFor(userId);
  const owns = (store.messages || []).some((message) => message.id === messageId);
  if (!owns) {
    sendJson(response, { error: "message_not_found" }, 404);
    return;
  }

  await saveFeedback(messageId, kind);
  sendJson(response, { ok: true });
}

async function regenerateBriefAfterSync(userId, trigger) {
  try {
    const run = await runDailyBrief({ userId, trigger, mode: "cold_start" });
    return { runId: run.id, briefingGenerated: Boolean(run.output?.briefing) };
  } catch (error) {
    console.error(`[sync] brief regeneration failed (${trigger}):`, error);
    return { error: error.message || String(error) };
  }
}

async function routeSyncGmail(userId, response) {
  const { account, result } = await syncSourceConnection({
    userId,
    provider: "gmail",
    trigger: "manual",
  });
  const queued = await maybeEnqueuePostIngestClassification(account);
  const briefRun = await regenerateBriefAfterSync(userId, "sync:gmail");
  sendJson(response, { ok: true, result, briefRun, ...(queued ? { queued } : {}) });
}

async function routeQueueGmailSync(userId, response) {
  const store = await readStoreFor(userId);
  const gmailAccount = (store.accounts || []).find((account) => account?.provider === "gmail") || null;
  if (!gmailAccount) {
    sendJson(response, { error: "gmail_not_connected", message: "No Gmail account is connected." }, 400);
    return;
  }

  const queued = await enqueueJob("source.sync", {
    userId,
    sourceConnectionId: gmailAccount.id,
    provider: "gmail",
    trigger: "manual",
    cursorHint: "latest",
    requestedAt: new Date().toISOString(),
  });
  sendJson(response, { ok: true, queued });
}

async function routeQueueGmailBackfill(userId, response) {
  const store = await readStoreFor(userId);
  const gmailAccount = (store.accounts || []).find((account) => account?.provider === "gmail") || null;
  if (!gmailAccount) {
    sendJson(response, { error: "gmail_not_connected", message: "No Gmail account is connected." }, 400);
    return;
  }

  const queued = await enqueueJob("source.sync", {
    userId,
    sourceConnectionId: gmailAccount.id,
    provider: "gmail",
    trigger: "backfill",
    cursorHint: "backfill_older",
    requestedAt: new Date().toISOString(),
  });
  sendJson(response, { ok: true, queued });
}

async function routeDirectGmailIngest(userId, response, { cursorHint, trigger }) {
  const store = await readStoreFor(userId);
  const gmailAccount = (store.accounts || []).find((account) => account?.provider === "gmail") || null;
  if (!gmailAccount) {
    sendJson(response, { error: "gmail_not_connected", message: "No Gmail account is connected." }, 400);
    return;
  }

  const { account, result } = await syncSourceConnection({
    userId,
    sourceConnectionId: gmailAccount.id,
    provider: "gmail",
    trigger,
    cursorHint,
  });
  const queued = await maybeEnqueuePostIngestClassification(account);
  sendJson(response, { ok: true, result, ...(queued ? { queued } : {}) });
}

async function routeDisconnect(userId, response) {
  await clearUserData(userId);
  sendJson(response, { ok: true });
}

async function routeDemoReset(userId, response) {
  const { account, result } = await resetDemoData({ userId });
  sendJson(response, { ok: true, account: publicAccount(account), result });
}

async function routeDemoClear(userId, response) {
  const result = await clearDemoData(userId);
  sendJson(response, { ok: true, result });
}

async function routeSyncMock(userId, response) {
  const { account, result } = await syncSourceConnection({
    userId,
    provider: "mock",
    trigger: "manual",
  });
  const queued = await maybeEnqueuePostIngestClassification(account);
  const briefRun = await regenerateBriefAfterSync(userId, "sync:mock");
  sendJson(response, {
    ok: true,
    account: publicAccount(account),
    result,
    briefRun,
    ...(queued ? { queued } : {}),
  });
}

async function routeAiControl(userId, response) {
  const store = await readStoreFor(userId);
  const account = store.accounts[0] || null;
  const runs = await listAiRunsFor(userId, 20);
  const briefingRuns = runs.filter((run) => run.kind === "daily-brief" || run.output?.briefing);
  const classificationRuns = runs.filter((run) => run.kind === "classification-batch");
  const verificationRuns = await listVerificationRuns(20);
  const queueJobs = await listQueueJobs(20);
  sendJson(response, {
    prompts: getPromptRecords(),
    evals: getAiEvalRecords(),
    observability: getPhoenixStatus(),
    latestRun: briefingRuns[0] || runs[0] || null,
    latestClassificationRun: classificationRuns[0] || null,
    runs,
    queueJobs,
    ingestion: {
      classificationBacklog: classificationBacklogSummaryFromStore(store, account?.id),
      latestClassificationRun: classificationRuns[0] || null,
    },
    latestVerification: verificationRuns[0] || null,
    verificationRuns,
  });
}

async function routeAiIngestionSynthesize(userId, request, response) {
  const body = await parseJsonBody(request);
  const started = Date.now();
  const { account, result, batch, analytics } = await synthesizeIngestionBatch({
    userId,
    count: body.count,
  });
  const store = await readStoreFor(userId);
  sendJson(response, {
    ok: true,
    account: publicAccount(account),
    result,
    batch,
    analytics: {
      ...analytics,
      totalRouteLatencyMs: Date.now() - started,
    },
    classificationBacklog: classificationBacklogSummaryFromStore(store, account.id),
  });
}

async function routeAiClassifyUnclassified(userId, request, response) {
  const body = await parseJsonBody(request);
  const limit = body.limit ? Number(body.limit) : config.queue.classificationBatchSize;
  const beforeStore = await readStoreFor(userId);
  const account = beforeStore.accounts[0] || null;
  const before = classificationBacklogSummaryFromStore(beforeStore, account?.id);
  const started = Date.now();
  const run = await runClassificationBatch({
    userId,
    limit,
    trigger: "api:classification-batch",
  });
  const afterStore = await readStoreFor(userId);
  sendJson(response, {
    ok: true,
    run,
    classificationBacklog: {
      before,
      after: classificationBacklogSummaryFromStore(afterStore, account?.id),
    },
    analytics: {
      messagesProcessed: run.metrics?.messagesProcessed || 0,
      latencyMs: Date.now() - started,
      briefingGenerated: Boolean(run.output?.briefing),
      llmCalls: run.llmCalls?.length || 0,
    },
  });
}

async function routeAiRun(userId, request, response) {
  const body = await parseJsonBody(request);
  const limit = body.limit ? Number(body.limit) : undefined;
  const mode = body.mode;
  const run = await runDailyBrief({ userId, limit, mode, trigger: "api" });
  sendJson(response, { ok: true, run });
}

async function routeAiVerify(response) {
  const run = await runSyntheticVerification({ persist: true });
  sendJson(response, { ok: true, run });
}

async function routeConnectGmail(userId, response) {
  const missing = validateGoogleConfig(config);
  if (missing.length) {
    redirect(response, `${config.webOrigin}/settings?error=missing_google_config`);
    return;
  }

  const state = crypto.randomUUID();
  await saveOAuthState(state, userId);
  redirect(response, buildGoogleAuthUrl(config, state));
}

// JSON variant of the connect flow: returns the Google OAuth URL so the
// authenticated SPA can navigate to it. Necessary because a regular `<a href>`
// click cannot carry the Authorization bearer header.
async function routeConnectGmailStart(userId, response) {
  const missing = validateGoogleConfig(config);
  if (missing.length) {
    sendJson(response, { error: "missing_google_config", missing }, 400);
    return;
  }
  const state = crypto.randomUUID();
  await saveOAuthState(state, userId);
  sendJson(response, { url: buildGoogleAuthUrl(config, state) });
}

async function routeOAuthCallback(url, response) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    redirect(response, `${config.webOrigin}/settings?error=${encodeURIComponent(error)}`);
    return;
  }
  if (!code || !state) {
    redirect(response, `${config.webOrigin}/settings?error=invalid_oauth_callback`);
    return;
  }
  const consumed = await consumeOAuthState(state);
  if (!consumed?.ok || !consumed.userId) {
    redirect(response, `${config.webOrigin}/settings?error=invalid_oauth_callback`);
    return;
  }
  const userId = consumed.userId;

  const tokens = await exchangeCodeForTokens(config, code);
  const tempAccount = {
    id: "gmail:pending",
    userId,
    provider: "gmail",
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  };
  const profile = await getProfile(tempAccount);
  const existing = await getPrimarySourceConnection(userId);
  const account = await upsertAccount({
    id: `gmail:${userId}:${profile.emailAddress}`,
    userId,
    provider: "gmail",
    email: profile.emailAddress,
    messagesTotal: profile.messagesTotal,
    threadsTotal: profile.threadsTotal,
    historyId: profile.historyId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || existing?.refreshToken || "",
    tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    scope: config.google.readonlyScope,
  });

  redirect(response, `${config.webOrigin}/settings?connected=${encodeURIComponent(account.email)}`);
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function serveStatic(url, response) {
  let requestedPath = decodeURIComponent(url.pathname);
  if (requestedPath === "/") requestedPath = "/index.html";
  const normalized = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(webDistDir, normalized);

  if (!(await fileExists(filePath))) {
    filePath = path.join(webDistDir, "index.html");
  }

  if (!(await fileExists(filePath))) {
    sendText(
      response,
      "SaneMail API is running. Build apps/web or run `bun run dev` for the React app.",
      200,
    );
    return;
  }

  const fileStat = await stat(filePath);
  const extension = path.extname(filePath);
  response.writeHead(200, {
    "Content-Type": mimeTypes[extension] || "application/octet-stream",
    "Content-Length": fileStat.size,
  });
  createReadStream(filePath).pipe(response);
}

function authenticateRequest(request, response) {
  try {
    return requireUser(request, { config });
  } catch (error) {
    if (error instanceof AuthError) {
      sendJson(response, { error: error.code, message: error.message }, error.status);
      return null;
    }
    throw error;
  }
}

async function handleApi(url, request, response) {
  const messageMatch = url.pathname.match(/^\/api\/messages\/(.+?)(\/feedback)?$/);

  // /api/status is allowed without auth so the web app can probe configuration
  // before sign-in. With a token it also returns the user's snapshot.
  if (request.method === "GET" && url.pathname === "/api/status") {
    let userId = null;
    try {
      const principal = requireUser(request, { config });
      await ensureUserRecord(principal.userId, principal.email);
      userId = principal.userId;
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
    }
    return routeStatus(userId, response);
  }

  // Every other route requires authentication.
  const principal = authenticateRequest(request, response);
  if (!principal) return;
  await ensureUserRecord(principal.userId, principal.email);
  const { userId } = principal;
  request.userId = userId;

  // Cap LLM-driven routes per-user. Read-only routes are not limited because
  // they are cheap and the UI polls some of them.
  if (isAiRoute(url.pathname) && request.method === "POST") {
    const limit = aiRateLimiter.check(userId);
    if (!limit.allowed) {
      response.setHeader("Retry-After", Math.ceil(limit.retryAfterMs / 1000));
      sendJson(
        response,
        {
          error: "rate_limited",
          message: "Too many AI requests. Try again shortly.",
          retryAfterMs: limit.retryAfterMs,
        },
        429,
      );
      return;
    }
  }

  if (request.method === "GET" && url.pathname === "/api/home") return routeHome(userId, response);
  if (request.method === "GET" && url.pathname === "/api/messages") return routeMessages(userId, response);
  if (request.method === "GET" && url.pathname === "/api/today") return routeToday(userId, response);
  if (request.method === "POST" && url.pathname === "/api/sync/gmail") return routeSyncGmail(userId, response);
  if (request.method === "POST" && url.pathname === "/api/sync/mock") return routeSyncMock(userId, response);
  if (request.method === "POST" && url.pathname === "/api/queue/sync/gmail") return routeQueueGmailSync(userId, response);
  if (request.method === "POST" && url.pathname === "/api/queue/backfill/gmail") return routeQueueGmailBackfill(userId, response);
  if (request.method === "POST" && url.pathname === "/api/ingest/gmail/next") {
    return routeDirectGmailIngest(userId, response, { cursorHint: "latest", trigger: "manual" });
  }
  if (request.method === "POST" && url.pathname === "/api/ingest/gmail/backfill") {
    return routeDirectGmailIngest(userId, response, { cursorHint: "backfill_older", trigger: "backfill" });
  }
  if (request.method === "POST" && url.pathname === "/api/disconnect") return routeDisconnect(userId, response);
  if (request.method === "POST" && url.pathname === "/api/demo/reset") return routeDemoReset(userId, response);
  if (request.method === "POST" && url.pathname === "/api/demo/clear") return routeDemoClear(userId, response);
  if (request.method === "GET" && url.pathname === "/api/ai/control") return routeAiControl(userId, response);
  if (request.method === "GET" && url.pathname === "/api/queue/jobs") {
    return sendJson(response, { jobs: await listQueueJobs(50) });
  }
  if (request.method === "GET" && url.pathname === "/api/ai/runs") {
    return sendJson(response, { runs: await listAiRunsFor(userId, 50) });
  }
  if (request.method === "GET" && url.pathname === "/api/ai/verification") {
    return sendJson(response, { runs: await listVerificationRuns(50) });
  }
  if (request.method === "GET" && url.pathname === "/api/ai/classifications/recent") {
    const limitParam = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(100, Math.floor(limitParam)) : 15;
    return sendJson(response, { classifications: await listRecentClassificationsFor(userId, limit) });
  }
  if (request.method === "POST" && url.pathname === "/api/ai/run") return routeAiRun(userId, request, response);
  if (request.method === "POST" && url.pathname === "/api/ai/verify") return routeAiVerify(response);
  if (request.method === "POST" && url.pathname === "/api/ai/ingestion/synthesize") {
    return routeAiIngestionSynthesize(userId, request, response);
  }
  if (request.method === "POST" && url.pathname === "/api/ai/ingestion/classify") {
    return routeAiClassifyUnclassified(userId, request, response);
  }
  if (request.method === "GET" && url.pathname === "/api/connect/gmail") return routeConnectGmail(userId, response);
  if (request.method === "POST" && url.pathname === "/api/connect/gmail/start") {
    return routeConnectGmailStart(userId, response);
  }

  if (messageMatch) {
    const messageId = decodeURIComponent(messageMatch[1]);
    if (request.method === "GET" && !messageMatch[2]) return routeMessage(userId, messageId, response);
    if (request.method === "POST" && messageMatch[2]) {
      return routeFeedback(userId, messageId, request, response);
    }
  }

  sendJson(response, { error: "not_found" }, 404);
}

async function pingDatabase() {
  if (config.storage.driver !== "postgres") {
    return { ok: true, driver: config.storage.driver, skipped: true };
  }
  const start = Date.now();
  try {
    const { databasePing } = await import("./postgres-store.mjs");
    await databasePing();
    return { ok: true, driver: "postgres", durationMs: Date.now() - start };
  } catch (error) {
    return {
      ok: false,
      driver: "postgres",
      durationMs: Date.now() - start,
      error: error.message || String(error),
    };
  }
}

async function routeHealth(response) {
  // Liveness: the process is up and responding. Don't touch external deps.
  sendJson(response, {
    ok: true,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
  });
}

async function routeReady(response) {
  // Readiness: don't take traffic until DB is reachable.
  const db = await pingDatabase();
  const ok = Boolean(db.ok);
  sendJson(response, { ok, db }, ok ? 200 : 503);
}

// Per-user limiter on AI routes — these spawn LLM calls that cost real money,
// so we cap a single user's burst even before they cost the worker.
const aiRateLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
// Per-IP limiter on the unauthenticated OAuth callback to make state-replay
// brute-force attempts expensive.
const oauthRateLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });

function clientIpForRequest(request) {
  const fwd = request.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return request.socket?.remoteAddress || "unknown";
}

function isAiRoute(pathname) {
  return pathname.startsWith("/api/ai/");
}

async function handleRequest(request, response) {
  attachRequestId(request, response);
  logRequest(request, response);

  let url;
  try {
    url = new URL(request.url, config.appOrigin);
  } catch {
    sendJson(response, { error: "bad_request" }, 400);
    return;
  }

  if (applyCors(request, response, config)) return;

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      await routeHealth(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/ready") {
      await routeReady(response);
      return;
    }
    if (url.pathname === "/connect/gmail") {
      const principal = authenticateRequest(request, response);
      if (!principal) return;
      request.userId = principal.userId;
      await ensureUserRecord(principal.userId, principal.email);
      await routeConnectGmail(principal.userId, response);
      return;
    }
    if (url.pathname === "/oauth/google/callback") {
      const ip = clientIpForRequest(request);
      const limit = oauthRateLimiter.check(ip);
      if (!limit.allowed) {
        response.setHeader("Retry-After", Math.ceil(limit.retryAfterMs / 1000));
        sendJson(response, { error: "rate_limited" }, 429);
        return;
      }
      await routeOAuthCallback(url, response);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      await handleApi(url, request, response);
      return;
    }

    if (!["GET", "HEAD"].includes(request.method)) {
      sendJson(response, { error: "unsupported_method" }, 405);
      return;
    }

    await serveStatic(url, response);
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(response, { error: error.code, message: error.message }, error.status);
      return;
    }
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      msg: "request_error",
      requestId: request.requestId,
      route: url?.pathname,
      error: error.message,
      stack: error.stack,
    }));
    sendJson(response, { error: "internal_error", message: error.message }, 500);
  }
}

export function createServer() {
  return http.createServer(handleRequest);
}

function logOllamaBoot() {
  console.log("[ollama config]", {
    host: config.ollama.host,
    model: config.ollama.model,
    classificationModel: config.ollama.classificationModel,
    temperature: config.ollama.temperature,
    classificationTemperature: config.ollama.classificationTemperature,
    think: config.ollama.think,
    classificationThink: config.ollama.classificationThink,
    apiKey: config.ollama.apiKey ? `set (${String(config.ollama.apiKey).length} chars)` : "unset",
    envOllamaModel: process.env.OLLAMA_MODEL ?? "(not set)",
    envOllamaClassificationModel: process.env.OLLAMA_CLASSIFICATION_MODEL ?? "(not set)",
    envOllamaHost: process.env.OLLAMA_HOST ?? "(not set)",
    envOllamaTemperature: process.env.OLLAMA_TEMPERATURE ?? "(not set)",
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
}

export function installGracefulShutdown(server, { timeoutMs = 25_000 } = {}) {
  let shuttingDown = false;
  const handle = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] received ${signal}, draining connections`);
    const force = setTimeout(() => {
      console.error("[shutdown] timeout exceeded, forcing exit");
      process.exit(1);
    }, timeoutMs);
    force.unref?.();
    server.close((error) => {
      if (error) {
        console.error("[shutdown] server.close error", error);
        process.exit(1);
      }
      console.log("[shutdown] all connections drained");
      process.exit(0);
    });
  };
  process.once("SIGTERM", () => handle("SIGTERM"));
  process.once("SIGINT", () => handle("SIGINT"));
}

export function startServer() {
  assertProductionConfig(config);
  const server = createServer();
  installGracefulShutdown(server);
  server.listen(config.port, config.host, () => {
    const address = server.address();
    const origin =
      address && typeof address === "object"
        ? `http://${config.host}:${address.port}`
        : config.appOrigin;
    console.log(`SaneMail API running at ${origin}`);
    logOllamaBoot();
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
