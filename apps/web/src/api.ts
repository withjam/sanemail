import type {
  AiControlResponse,
  AiClassificationRunResponse,
  AiRunResponse,
  AiVerificationResponse,
  FeedbackKind,
  DemoResetResponse,
  HomeResponse,
  MessageResponse,
  MessagesResponse,
  StatusResponse,
  SyncResponse,
  SyntheticIngestionResponse,
} from "@togomail/shared/types";

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
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

export function saveFeedback(id: string, kind: FeedbackKind) {
  return apiFetch<{ ok: true }>(`/api/messages/${encodeURIComponent(id)}/feedback`, {
    method: "POST",
    body: JSON.stringify({ kind }),
  });
}

export function syncGmail() {
  return apiFetch<SyncResponse>("/api/sync/gmail", {
    method: "POST",
    body: JSON.stringify({}),
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
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) body.limit = limit;
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

export function classifyUnclassifiedMessages({ limit }: { limit?: number } = {}) {
  const body: { limit?: number } = {};
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) body.limit = limit;
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
