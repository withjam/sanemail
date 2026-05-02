export type SaneCategory = "Today" | "Needs Reply" | "FYI" | "Junk Review" | "All Mail";

export type SaneClassification = {
  category: SaneCategory;
  todayScore: number;
  needsReply: boolean;
  automated: boolean;
  possibleJunk: boolean;
  direct: boolean;
  reasons: string[];
  classifiedAt: string;
};

export type Feedback = {
  id: string;
  messageId: string;
  kind: FeedbackKind;
  createdAt: string;
};

export type FeedbackKind =
  | "important"
  | "not-important"
  | "junk"
  | "not-junk"
  | "needs-reply"
  | "done";

export type MailMessage = {
  id: string;
  accountId: string;
  provider: "gmail";
  providerMessageId: string;
  providerThreadId: string;
  sourceLabels: string[];
  historyId?: string;
  internalDate?: string;
  subject: string;
  from: string;
  to: string;
  cc?: string;
  date: string;
  snippet: string;
  bodyText: string;
  headers: Record<string, string>;
  syncedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  sane: SaneClassification;
  feedback: Feedback[];
};

export type AccountSummary = {
  id: string;
  provider: "gmail";
  email: string;
  demo?: boolean;
  messagesTotal?: number;
  threadsTotal?: number;
  historyId?: string;
  scope?: string;
  updatedAt?: string;
};

export type StatusResponse = {
  account: AccountSummary | null;
  configMissing: string[];
  counts: {
    messages: number;
    today: number;
    needsReply: number;
    junkReview: number;
  };
  gmailReadonly: string;
};

export type MessagesResponse = {
  messages: MailMessage[];
};

export type MessageResponse = {
  message: MailMessage;
};

export type SyncResponse = {
  ok: true;
  result: {
    inserted: number;
    updated: number;
    count: number;
  };
};

export type DemoResetResponse = SyncResponse & {
  account: AccountSummary;
};

export type AiPromptRecord = {
  id: string;
  version: string;
  stage: string;
  title: string;
  description: string;
  provider: string;
  model: string;
  temperature: number;
  variables: string[];
  responseSchema: Record<string, unknown>;
  system: string;
  userTemplate: string;
  hash: string;
};

export type AiPromptRef = {
  id: string;
  version: string;
  stage: string;
  title: string;
  provider: string;
  model: string;
  temperature: number;
  hash: string;
};

export type AiDecision = {
  messageId: string;
  subject: string;
  from: string;
  category: SaneCategory;
  needsReply: boolean;
  possibleJunk: boolean;
  automated: boolean;
  direct: boolean;
  confidence: number;
  recsysScore: number;
  suppressFromToday: boolean;
  reasons: string[];
  extracted: {
    actions: string[];
    deadlines: string[];
    entities: string[];
    replyCue: string | null;
  };
  embedding: {
    model: string;
    dimensions: number;
    hash: string;
    preview: number[];
  };
  instrumentation: {
    inputHash: string;
    promptInputHashes: string[];
    estimatedPromptTokens: number;
  };
};

export type AiRun = {
  id: string;
  kind: string;
  trigger: string;
  status: "succeeded" | "failed";
  provider: {
    name: string;
    model: string;
    temperature: number;
  };
  promptRefs: AiPromptRef[];
  input: {
    accountId: string | null;
    messageCount: number;
    corpusHash: string;
    messageHashes: Array<{ messageId: string; inputHash: string }>;
  };
  output: {
    decisions: AiDecision[];
    curatedMessageIds: string[];
    topTodayMessageIds: string[];
  };
  metrics: {
    latencyMs: number;
    messagesProcessed: number;
    estimatedPromptTokens: number;
    estimatedCompletionTokens: number;
    categoryCounts: Record<string, number>;
    averageConfidence: number;
  };
  spans: Array<{
    name: string;
    status: string;
    durationMs: number;
    [key: string]: unknown;
  }>;
  startedAt: string;
  completedAt: string;
  createdAt: string;
};

export type AiVerificationRun = {
  id: string;
  suiteId: string;
  suiteTitle: string;
  status: "passed" | "failed";
  threshold: number;
  score: number;
  provider: AiRun["provider"];
  promptRefs: AiPromptRef[];
  aiRunId: string;
  summary: {
    cases: number;
    passedCases: number;
    failedCases: number;
    checks: number;
    passedChecks: number;
    failedChecks: number;
  };
  cases: Array<{
    id: string;
    messageId: string;
    description: string;
    passed: boolean;
    checks: Array<{
      name: string;
      expected: unknown;
      actual: unknown;
      passed: boolean;
    }>;
  }>;
  metrics: {
    latencyMs: number;
    aiLatencyMs: number;
    messagesProcessed: number;
  };
  startedAt: string;
  completedAt: string;
  createdAt: string;
};

export type AiControlResponse = {
  prompts: AiPromptRecord[];
  latestRun: AiRun | null;
  runs: AiRun[];
  latestVerification: AiVerificationRun | null;
  verificationRuns: AiVerificationRun[];
};

export type AiRunResponse = {
  ok: true;
  run: AiRun;
};

export type AiVerificationResponse = {
  ok: true;
  run: AiVerificationRun;
};
