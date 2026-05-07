const gmailBaseUrl = "https://gmail.googleapis.com/gmail/v1/users/me";

function base64UrlDecode(value = "") {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeDate(headers, gmailMessage) {
  const headerDate = headers.date ? new Date(headers.date) : null;
  if (headerDate && Number.isFinite(headerDate.getTime())) {
    return headerDate.toISOString();
  }

  const internalDate = gmailMessage.internalDate
    ? new Date(Number(gmailMessage.internalDate))
    : null;
  if (internalDate && Number.isFinite(internalDate.getTime())) {
    return internalDate.toISOString();
  }

  return new Date().toISOString();
}

function collectParts(payload, collector = { plain: [], html: [] }) {
  if (!payload) return collector;

  const data = payload.body?.data;
  if (data && payload.mimeType === "text/plain") {
    collector.plain.push(base64UrlDecode(data));
  }
  if (data && payload.mimeType === "text/html") {
    collector.html.push(stripHtml(base64UrlDecode(data)));
  }

  for (const part of payload.parts || []) {
    collectParts(part, collector);
  }

  return collector;
}

function headersToObject(headers = []) {
  return Object.fromEntries(
    headers.map((header) => [header.name.toLowerCase(), header.value]),
  );
}

async function gmailFetch(account, path, options = {}) {
  const response = await fetch(`${gmailBaseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${account.accessToken}`,
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gmail API ${response.status}: ${detail}`);
  }

  return response.json();
}

export function buildGoogleAuthUrl(config, state) {
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: config.google.redirectUri,
    response_type: "code",
    scope: config.google.readonlyScope,
    access_type: "offline",
    prompt: "consent",
    state,
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCodeForTokens(config, code) {
  const body = new URLSearchParams({
    code,
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    redirect_uri: config.google.redirectUri,
    grant_type: "authorization_code",
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OAuth token exchange failed: ${detail}`);
  }

  return response.json();
}

export async function refreshAccessToken(config, account) {
  if (!account.refreshToken) {
    throw new Error("No refresh token is available for this Gmail account.");
  }

  const body = new URLSearchParams({
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    refresh_token: account.refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OAuth refresh failed: ${detail}`);
  }

  const tokens = await response.json();
  return {
    ...account,
    accessToken: tokens.access_token,
    tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  };
}

export async function getProfile(account) {
  return gmailFetch(account, "/profile");
}

export async function listRecentMessageIds(account, { limit, query }) {
  const params = new URLSearchParams({
    maxResults: String(limit),
    q: query,
  });
  const payload = await gmailFetch(account, `/messages?${params.toString()}`);
  return payload.messages || [];
}

export async function getMessage(account, messageId) {
  const params = new URLSearchParams({ format: "full" });
  return gmailFetch(account, `/messages/${messageId}?${params.toString()}`);
}

export function normalizeGmailMessage(account, gmailMessage) {
  const headers = headersToObject(gmailMessage.payload?.headers);
  const parts = collectParts(gmailMessage.payload);
  const bodyText = normalizeText(parts.plain.join("\n\n") || parts.html.join("\n\n"));
  const date = normalizeDate(headers, gmailMessage);

  return {
    id: `${account.id}:message:${gmailMessage.id}`,
    accountId: account.id,
    provider: "gmail",
    providerMessageId: gmailMessage.id,
    providerThreadId: gmailMessage.threadId,
    sourceLabels: gmailMessage.labelIds || [],
    historyId: gmailMessage.historyId,
    internalDate: gmailMessage.internalDate,
    subject: headers.subject || "(no subject)",
    from: headers.from || "",
    to: headers.to || "",
    cc: headers.cc || "",
    date,
    snippet: gmailMessage.snippet || "",
    bodyText,
    headers: {
      from: headers.from || "",
      to: headers.to || "",
      cc: headers.cc || "",
      bcc: headers.bcc || "",
      subject: headers.subject || "",
      date: headers.date || "",
      "message-id": headers["message-id"] || "",
      "in-reply-to": headers["in-reply-to"] || "",
      references: headers.references || "",
      "list-unsubscribe": headers["list-unsubscribe"] || "",
    },
    syncedAt: new Date().toISOString(),
  };
}

export async function syncRecentMessages(config, account) {
  const ids = await listRecentMessageIds(account, {
    limit: config.sync.messageLimit,
    query: config.sync.query,
  });

  const messages = [];
  for (const item of ids) {
    const gmailMessage = await getMessage(account, item.id);
    messages.push(normalizeGmailMessage(account, gmailMessage));
  }

  return messages;
}

function yyyymmdd(date) {
  const value = new Date(date);
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

export async function syncBackfillOlderMessages(config, account, { beforeDate } = {}) {
  if (!beforeDate) throw new Error("syncBackfillOlderMessages requires beforeDate");
  const query = `${config.sync.query} before:${yyyymmdd(beforeDate)}`.trim();
  const ids = await listRecentMessageIds(account, {
    limit: config.sync.backfillMessageLimit || config.sync.messageLimit,
    query,
  });

  const messages = [];
  for (const item of ids) {
    const gmailMessage = await getMessage(account, item.id);
    messages.push(normalizeGmailMessage(account, gmailMessage));
  }
  return messages;
}
