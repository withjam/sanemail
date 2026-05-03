import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, validateGoogleConfig } from "./config.mjs";
import {
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  getProfile,
  refreshAccessToken,
  syncRecentMessages,
} from "./gmail.mjs";
import {
  clearLocalData,
  consumeOAuthState,
  getPrimaryAccount,
  latestInboxBriefing,
  listAiRuns,
  listVerificationRuns,
  readStore,
  saveFeedback,
  saveOAuthState,
  upsertAccount,
  upsertSyncedMessages,
} from "./store.mjs";
import { getClassifiedMessages } from "./classifier.mjs";
import { resetDemoData } from "./demo-data.mjs";
import { getPromptRecords } from "./ai/prompts.mjs";
import { buildInboxBriefing, runAiLoop } from "./ai/pipeline.mjs";
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

function getMessageList(store, account) {
  return getClassifiedMessages(store, account).sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );
}

function getTodayMessages(store, account) {
  return getClassifiedMessages(store, account)
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

function hasUpcomingSignal(message, decision) {
  const text = `${message.subject || ""}\n${message.snippet || ""}\n${message.bodyText || ""}`.toLowerCase();
  return (
    (decision?.extracted?.deadlines || []).length > 0 ||
    (decision?.extracted?.actions || []).some((action) =>
      ["pay", "schedule", "confirm", "sign", "review"].includes(action),
    ) ||
    /\b(deadline|due|tomorrow|bill|statement|flight|check-in|appointment|reservation)\b|\bby\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(morning|afternoon|evening)\b/.test(
      text,
    )
  );
}

function messageAgeHours(message) {
  const time = new Date(message.date || Number(message.internalDate) || 0).getTime();
  if (!Number.isFinite(time)) return 9999;
  return Math.max(0, (Date.now() - time) / 36e5);
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

function accountNeedsRefresh(account) {
  if (!account?.accessToken) return true;
  if (!account.tokenExpiresAt) return false;
  return new Date(account.tokenExpiresAt).getTime() - Date.now() < 60_000;
}

async function getFreshAccount() {
  const account = await getPrimaryAccount();
  if (!account) throw new Error("No Gmail account is connected.");
  if (!accountNeedsRefresh(account)) return account;

  const refreshed = await refreshAccessToken(config, account);
  return upsertAccount(refreshed);
}

async function parseJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function routeStatus(response) {
  const store = await readStore();
  const account = store.accounts[0] || null;
  const messages = getMessageList(store, account);
  const today = getTodayMessages(store, account);

  sendJson(response, {
    account: publicAccount(account),
    configMissing: validateGoogleConfig(config),
    counts: {
      messages: messages.length,
      today: today.length,
      needsReply: messages.filter((message) => message.sane.needsReply).length,
      junkReview: messages.filter((message) => message.sane.possibleJunk).length,
    },
    gmailReadonly: config.google.readonlyScope,
  });
}

async function routeMessages(response) {
  const store = await readStore();
  const account = store.accounts[0] || null;
  sendJson(response, { messages: getMessageList(store, account) });
}

async function routeToday(response) {
  const store = await readStore();
  const account = store.accounts[0] || null;
  sendJson(response, { messages: getTodayMessages(store, account) });
}

async function routeHome(response) {
  const store = await readStore();
  const account = store.accounts[0] || null;
  const messages = getMessageList(store, account);
  const visibleMessages = messages.filter((message) => !message.sane.possibleJunk);
  const run = latestAiRun(store);
  const storedBriefing = latestInboxBriefing(store, account?.id);
  const decisions = decisionMap(run);
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
  const upcoming = visibleMessages.filter((message) => hasUpcomingSignal(message, decisions.get(message.id)));

  sendJson(response, {
    briefing: {
      ...briefing,
      runId: briefing.runId || run?.id || null,
      provider: briefing.provider || run?.provider || null,
      stale: !storedBriefing && !run?.output?.briefing,
    },
    tabs: {
      mostRecent: visibleMessages.slice(0, 8),
      needsReply: visibleMessages.filter((message) => message.sane.needsReply).slice(0, 8),
      upcoming: upcoming.slice(0, 8),
    },
  });
}

async function routeMessage(messageId, response) {
  const store = await readStore();
  const account = store.accounts[0] || null;
  const message = getMessageList(store, account).find((item) => item.id === messageId);
  if (!message) {
    sendJson(response, { error: "message_not_found" }, 404);
    return;
  }
  sendJson(response, { message });
}

async function routeFeedback(messageId, request, response) {
  const body = await parseJsonBody(request);
  const kind = body.kind;
  if (!kind) {
    sendJson(response, { error: "missing_feedback_kind" }, 400);
    return;
  }

  await saveFeedback(messageId, kind);
  sendJson(response, { ok: true });
}

async function routeSyncGmail(response) {
  const account = await getFreshAccount();
  const messages = await syncRecentMessages(config, account);
  const result = await upsertSyncedMessages(account, messages);
  sendJson(response, { ok: true, result });
}

async function routeDisconnect(response) {
  await clearLocalData();
  sendJson(response, { ok: true });
}

async function routeDemoReset(response) {
  const { account, result } = await resetDemoData();
  sendJson(response, { ok: true, account: publicAccount(account), result });
}

async function routeAiControl(response) {
  const runs = await listAiRuns(20);
  const verificationRuns = await listVerificationRuns(20);
  sendJson(response, {
    prompts: getPromptRecords(),
    observability: getPhoenixStatus(),
    latestRun: runs[0] || null,
    runs,
    latestVerification: verificationRuns[0] || null,
    verificationRuns,
  });
}

async function routeAiRun(request, response) {
  const body = await parseJsonBody(request);
  const limit = body.limit ? Number(body.limit) : undefined;
  const run = await runAiLoop({ limit, trigger: "api" });
  sendJson(response, { ok: true, run });
}

async function routeAiVerify(response) {
  const run = await runSyntheticVerification({ persist: true });
  sendJson(response, { ok: true, run });
}

async function routeConnectGmail(response) {
  const missing = validateGoogleConfig(config);
  if (missing.length) {
    redirect(response, `${config.webOrigin}/settings?error=missing_google_config`);
    return;
  }

  const state = crypto.randomUUID();
  await saveOAuthState(state);
  redirect(response, buildGoogleAuthUrl(config, state));
}

async function routeOAuthCallback(url, response) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    redirect(response, `${config.webOrigin}/settings?error=${encodeURIComponent(error)}`);
    return;
  }
  if (!code || !state || !(await consumeOAuthState(state))) {
    redirect(response, `${config.webOrigin}/settings?error=invalid_oauth_callback`);
    return;
  }

  const tokens = await exchangeCodeForTokens(config, code);
  const tempAccount = {
    id: "gmail:pending",
    provider: "gmail",
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  };
  const profile = await getProfile(tempAccount);
  const existing = await getPrimaryAccount();
  const account = await upsertAccount({
    id: `gmail:${profile.emailAddress}`,
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

async function handleApi(url, request, response) {
  const messageMatch = url.pathname.match(/^\/api\/messages\/(.+?)(\/feedback)?$/);

  if (request.method === "GET" && url.pathname === "/api/status") return routeStatus(response);
  if (request.method === "GET" && url.pathname === "/api/home") return routeHome(response);
  if (request.method === "GET" && url.pathname === "/api/messages") return routeMessages(response);
  if (request.method === "GET" && url.pathname === "/api/today") return routeToday(response);
  if (request.method === "POST" && url.pathname === "/api/sync/gmail") return routeSyncGmail(response);
  if (request.method === "POST" && url.pathname === "/api/disconnect") return routeDisconnect(response);
  if (request.method === "POST" && url.pathname === "/api/demo/reset") return routeDemoReset(response);
  if (request.method === "GET" && url.pathname === "/api/ai/control") return routeAiControl(response);
  if (request.method === "GET" && url.pathname === "/api/ai/runs") {
    return sendJson(response, { runs: await listAiRuns(50) });
  }
  if (request.method === "GET" && url.pathname === "/api/ai/verification") {
    return sendJson(response, { runs: await listVerificationRuns(50) });
  }
  if (request.method === "POST" && url.pathname === "/api/ai/run") return routeAiRun(request, response);
  if (request.method === "POST" && url.pathname === "/api/ai/verify") return routeAiVerify(response);
  if (request.method === "GET" && url.pathname === "/api/connect/gmail") return routeConnectGmail(response);

  if (messageMatch) {
    const messageId = decodeURIComponent(messageMatch[1]);
    if (request.method === "GET" && !messageMatch[2]) return routeMessage(messageId, response);
    if (request.method === "POST" && messageMatch[2]) return routeFeedback(messageId, request, response);
  }

  sendJson(response, { error: "not_found" }, 404);
}

async function handleRequest(request, response) {
  const url = new URL(request.url, config.appOrigin);

  try {
    if (url.pathname === "/connect/gmail") return routeConnectGmail(response);
    if (url.pathname === "/oauth/google/callback") return routeOAuthCallback(url, response);
    if (url.pathname.startsWith("/api/")) return handleApi(url, request, response);

    if (!["GET", "HEAD"].includes(request.method)) {
      sendJson(response, { error: "unsupported_method" }, 405);
      return;
    }

    return serveStatic(url, response);
  } catch (error) {
    console.error(error);
    sendJson(response, { error: "internal_error", message: error.message }, 500);
  }
}

export function createServer() {
  return http.createServer(handleRequest);
}

export function startServer() {
  const server = createServer();
  server.listen(config.port, config.host, () => {
    const address = server.address();
    const origin =
      address && typeof address === "object"
        ? `http://${config.host}:${address.port}`
        : config.appOrigin;
    console.log(`SaneMail API running at ${origin}`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
