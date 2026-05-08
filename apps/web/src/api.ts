import type {
  AiControlResponse,
  AiClassificationRunResponse,
  AiRunResponse,
  AiVerificationResponse,
  FeedbackKind,
  DemoResetResponse,
  HomeResponse,
  MessagePreviewResponse,
  MessageResponse,
  MessagesResponse,
  RecentClassificationsResponse,
  StatusResponse,
  SyncResponse,
  SyntheticIngestionResponse,
} from "@togomail/shared/types";
import { getCurrentAccessToken } from "./auth";

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers || {});
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const token = getCurrentAccessToken();
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(path, {
    ...init,
    headers,
  });

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const payload = await response.json();
      detail = payload.message || payload.error || detail;
    } catch {
      // Keep the HTTP status text.
    }
    throw new Error(detail);
  }

  return response.json() as Promise<T>;
}

export function getStatus() {
  return apiFetch<StatusResponse>("/api/status");
}

export function getHome() {
  return apiFetch<HomeResponse>("/api/home");
}

export function getMessages() {
  return apiFetch<MessagesResponse>("/api/messages");
}

export function getToday() {
  return apiFetch<MessagesResponse>("/api/today");
}

export function getMessage(id: string) {
  return apiFetch<MessageResponse>(`/api/messages/${encodeURIComponent(id)}`);
}

export function getMessagePreview(ref: string) {
  return apiFetch<MessagePreviewResponse>(`/api/messages/${encodeURIComponent(ref)}/preview`);
}

export function saveFeedback(id: string, kind: FeedbackKind) {
  return apiFetch<{ ok: true }>(
    `/api/messages/${encodeURIComponent(id)}/feedback`,
    {
      method: "POST",
      body: JSON.stringify({ kind }),
    },
  );
}

export function syncGmail(sourceConnectionId?: string) {
  return apiFetch<SyncResponse>("/api/sync/gmail", {
    method: "POST",
    body: JSON.stringify(sourceConnectionId ? { sourceConnectionId } : {}),
  });
}

export function queueGmailSync(sourceConnectionId?: string) {
  return apiFetch<{ ok: true; queued: SyncResponse["queued"] }>("/api/queue/sync/gmail", {
    method: "POST",
    body: JSON.stringify(sourceConnectionId ? { sourceConnectionId } : {}),
  });
}

export function queueGmailBackfillOlder(sourceConnectionId?: string) {
  return apiFetch<{ ok: true; queued: SyncResponse["queued"] }>("/api/queue/backfill/gmail", {
    method: "POST",
    body: JSON.stringify(sourceConnectionId ? { sourceConnectionId } : {}),
  });
}

export function ingestNextGmailBatch(sourceConnectionId?: string) {
  return apiFetch<SyncResponse>("/api/ingest/gmail/next", {
    method: "POST",
    body: JSON.stringify(sourceConnectionId ? { sourceConnectionId } : {}),
  });
}

export function backfillOlderGmailBatch(sourceConnectionId?: string) {
  return apiFetch<SyncResponse>("/api/ingest/gmail/backfill", {
    method: "POST",
    body: JSON.stringify(sourceConnectionId ? { sourceConnectionId } : {}),
  });
}

export function syncMock() {
  return apiFetch<DemoResetResponse>("/api/sync/mock", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function disconnect() {
  return apiFetch<{ ok: true }>("/api/disconnect", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function resetDemoData() {
  return apiFetch<DemoResetResponse>("/api/demo/reset", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function clearDemoData() {
  return apiFetch<{ ok: true }>("/api/demo/clear", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function getAiControl() {
  return apiFetch<AiControlResponse>("/api/ai/control");
}

export type AiRunMode = "auto" | "cold_start" | "iterative";

export interface RunAiLoopOptions {
  mode?: AiRunMode;
  limit?: number;
}

export function runDailyBrief({ mode = "auto", limit }: RunAiLoopOptions = {}) {
  const body: { mode?: AiRunMode; limit?: number } = {};
  if (mode !== "auto") body.mode = mode;
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0)
    body.limit = limit;
  return apiFetch<AiRunResponse>("/api/ai/run", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function synthesizeIngestionBatch() {
  return apiFetch<SyntheticIngestionResponse>("/api/ai/ingestion/synthesize", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function classifyUnclassifiedMessages({
  limit,
}: { limit?: number } = {}) {
  const body: { limit?: number } = {};
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0)
    body.limit = limit;
  return apiFetch<AiClassificationRunResponse>("/api/ai/ingestion/classify", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function runAiVerification() {
  return apiFetch<AiVerificationResponse>("/api/ai/verify", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/** Rows fetched for the AI Ops "recent classifications" panel (newest first). */
export const AI_OPS_RECENT_CLASSIFICATIONS_LIMIT = 15;

export function getRecentClassifications(limit = AI_OPS_RECENT_CLASSIFICATIONS_LIMIT) {
  return apiFetch<RecentClassificationsResponse>(
    `/api/ai/classifications/recent?limit=${encodeURIComponent(String(limit))}`,
  );
}

/**
 * Asks the API for a Google OAuth redirect URL bound to the current user's
 * session, then sends the browser there. We can't use a plain `<a href>` to
 * /api/connect/gmail because regular link navigation does not carry the
 * Authorization header — the API would reject it as unauthenticated.
 */
export async function startGmailConnect(): Promise<void> {
  const { url } = await apiFetch<{ url: string }>("/api/connect/gmail/start", {
    method: "POST",
    body: JSON.stringify({}),
  });
  window.location.assign(url);
}
