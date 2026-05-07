export type SaneCategory = "Today" | "Needs Reply" | "FYI" | "Junk Review" | "All Mail";

export type MailProvider = "gmail" | "outlook" | "imap" | "mx" | "mock";

export type MessageTypeKind =
  | "system_seed"
  | "discovered"
  | "user_defined"
  | "imported_source_label";

export type MessageTypeStatus = "candidate" | "active" | "muted" | "archived";

export type MessageTypeScope = "all_sources" | "source";

export type MessageTypeBriefPolicy = "always" | "important_only" | "daily_digest" | "never";

export type MessageTypeImportance = "high" | "normal" | "low";

export type QueueJobName =
  | "source.sync"
  | "classification.batch"
  | "message-types.discover"
  | "brief.generate";

export type SourceSyncJobPayload = {
  sourceConnectionId: string;
  userId: string;
  provider?: MailProvider;
  trigger: "watch" | "poll" | "manual" | "backfill" | "recovery";
  cursorHint?: string;
  requestedAt: string;
};

export type ClassificationBatchJobPayload = {
  userId: string;
  classifierVersion: string;
  taxonomyVersion?: string;
  reason: "post_ingest" | "retry" | "taxonomy_changed" | "manual";
  maxBatchSize?: number;
  requestedAt: string;
};

export type MessageTypesDiscoveryJobPayload = {
  userId: string;
  taxonomyVersion?: string;
  reason: "classification_batch" | "feedback_threshold" | "manual";
  requestedAt: string;
};

export type BriefGenerateJobPayload = {
  userId: string;
  scopeType: "all_sources" | "source";
  sourceConnectionId?: string | null;
  trigger: "post_ingest" | "scheduled_daily" | "manual" | "feedback_update";
  requestedAt: string;
};

export type QueueJobSummary = {
  id: string;
  name: QueueJobName;
  key: string;
  queue: string;
  status: "pending" | "running" | "succeeded" | "dead";
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  createdAt: string;
  updatedAt?: string;
  completedAt?: string;
  failedAt?: string;
  lastError?: string;
};

export type SourceConnectionStatus =
  | "active"
  | "paused"
  | "reauth_required"
  | "sync_error"
  | "deleted";

export type SourceConnectionSummary = {
  id: string;
  userId?: string;
  provider: MailProvider;
  sourceEmail: string;
  displayName?: string;
  status: SourceConnectionStatus;
  scope?: string;
  lastSuccessfulSyncAt?: string;
  lastFailedSyncAt?: string;
  syncCursorKind?: string;
  syncCursorUpdatedAt?: string;
  demo?: boolean;
  updatedAt?: string;
};

export type MessageTypeSummary = {
  id: string;
  userId?: string;
  slug: string;
  displayName: string;
  description?: string;
  kind: MessageTypeKind;
  status: MessageTypeStatus;
  scope: MessageTypeScope;
  sourceConnectionId?: string | null;
  parentTypeId?: string | null;
  defaultImportance?: MessageTypeImportance;
  briefPolicy?: MessageTypeBriefPolicy;
  taxonomyVersion?: string;
  updatedAt?: string;
};

export type MessageTypeAssignment = {
  messageTypeId: string;
  displayName: string;
  confidence: number;
  rank: number;
  state?: "current" | "rejected" | "superseded";
  evidence?: string[];
  taxonomyVersion?: string;
};

export type SaneClassification = {
  category: SaneCategory;
  todayScore: number;
  needsReply: boolean;
  automated: boolean;
  possibleJunk: boolean;
  direct: boolean;
  reasons: string[];
  classifiedAt: string;
  feedbackState?: {
    latestKind: FeedbackKind | null;
    addressed: boolean;
  };
  messageTypes?: MessageTypeAssignment[];
  taxonomyVersion?: string;
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
  sourceConnectionId?: string;
  accountId: string;
  provider: MailProvider;
  providerMessageId: string;
  providerThreadId: string;
  sourceLabels: string[];
  sourceRefs?: MessageSourceRef[];
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
  features?: MessageClassificationFeatures;
  syncedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  sane: SaneClassification;
  feedback: Feedback[];
};

export type MessageClassificationFeatures = {
  senderDomain?: string;
  listId?: string;
  listUnsubscribePresent?: boolean;
  sourceLabelKeys?: string[];
  directness?: "to" | "cc" | "bcc" | "list" | "unknown";
  bulkHint?: boolean;
  transactionalHint?: boolean;
  securityHint?: boolean;
  calendarHint?: boolean;
  entityKeys?: string[];
  actionKinds?: string[];
  deadlineAt?: string | null;
  featureVersion?: string;
};

export type MessageSourceRef = {
  id: string;
  messageId: string;
  sourceConnectionId: string;
  provider: MailProvider;
  providerMessageId: string;
  providerThreadId?: string;
  providerLabels?: string[];
  providerHistoryId?: string;
  sourceInternalDate?: string;
  sourceUrl?: string;
  sourceState?: "present" | "deleted" | "archived" | "spam" | "trash" | "unknown";
  lastSeenAt?: string;
};

export type AccountSummary = {
  id: string;
  provider: MailProvider;
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
  securityMissing?: string[];
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

export type HomeResponse = {
  briefing: InboxBriefing;
  tabs: {
    mostRecent: MailMessage[];
    needsReply: MailMessage[];
    upcoming: MailMessage[];
  };
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
  queued?: {
    enqueued: boolean;
    job: QueueJobSummary;
  };
};

export type DemoResetResponse = SyncResponse & {
  account: AccountSummary;
};

export type ClassificationBacklogSummary = {
  total: number;
  pending: number;
  stale: number;
  failed: number;
  classified: number;
  backlog: number;
  newestPriorityAt: string | null;
  oldestPriorityAt: string | null;
};

export type SyntheticIngestionResponse = SyncResponse & {
  account: AccountSummary;
  batch: {
    id: string;
    source: string;
    generator: string;
    count: number;
    messageIds: string[];
    subjects: string[];
    newestReceivedAt: string | null;
    oldestReceivedAt: string | null;
    createdAt: string;
  };
  analytics: {
    messagesSynthesized: number;
    inserted: number;
    updated: number;
    synthesisLatencyMs: number;
    ingestLatencyMs: number;
    totalLatencyMs: number;
    totalRouteLatencyMs?: number;
    classificationSkipped: boolean;
    briefingSkipped: boolean;
  };
  classificationBacklog: ClassificationBacklogSummary;
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
  promptHash: string;
  modelBindingHash: string;
  contractHash: string;
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
  promptHash: string;
  modelBindingHash: string;
  contractHash: string;
};

export type AiEvalRecord = {
  id: string;
  promptIds: string[];
  title: string;
  evaluator: string;
  checks: string[];
  hash: string;
};

/** Persisted as message_classifications.action_metadata (from AiDecision.extracted). */
export type ClassificationExtractedMetadata = {
  actions: string[];
  deadlines: string[];
  entities: string[];
  replyCue: string | null;
};

export type AiDecision = {
  messageId: string;
  subject: string;
  from: string;
  deliveredAt?: string;
  category: SaneCategory;
  needsReply: boolean;
  possibleJunk: boolean;
  automated: boolean;
  direct: boolean;
  addressed?: boolean;
  confidence: number;
  recsysScore: number;
  suppressFromToday: boolean;
  temporal?: {
    deliveredAt: string;
    ageHours: number;
    recent: boolean;
    within7Days: boolean;
  };
  reasons: string[];
  extracted: ClassificationExtractedMetadata;
  feedback?: {
    kinds: FeedbackKind[];
    latestKind: FeedbackKind | null;
    latestAt: string | null;
    addressed: boolean;
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

export type InboxBriefing = {
  text: string;
  narrative?: {
    status: string;
    needToKnow: string;
    mightBeMissing: string;
    needsAttention: string;
  };
  callouts?: Array<{
    id: string;
    kind: "attention" | "new_attention" | "carry_over";
    label: string;
    title: string;
    body: string;
    messageId?: string;
    messageIds: string[];
    priority: number;
    deliveredAt?: string;
  }>;
  generatedAt: string;
  source: string;
  model: string;
  prompt?: {
    id: string;
    version: string;
    hash: string;
    promptHash?: string;
    modelBindingHash?: string;
    contractHash?: string;
  };
  counts: {
    visible: number;
    recent: number;
    last7Days: number;
    needsReply: number;
    needsReplyLast7?: number;
    upcoming: number;
    informational: number;
    hidden: number;
    carriedOver?: number;
  };
  messageIds: string[];
  memory?: {
    mode: "cold_start" | "iterative";
    producedAt: string;
    since: string | null;
    previousBriefingId: string | null;
    previousGeneratedAt: string | null;
    includedMessageIds: string[];
    newMessageIds: string[];
    carryOverMessageIds: string[];
    unresolvedPreviousMessageIds: string[];
    resolvedPreviousMessageIds: string[];
  };
  carryOver?: {
    previousBriefingId: string | null;
    previousGeneratedAt: string | null;
    messageIds: string[];
    subjects: string[];
  };
  runId?: string | null;
  provider?: AiRun["provider"] | null;
  stale?: boolean;
};

export type PhoenixObservabilityStatus = {
  enabled: boolean;
  initialized: boolean;
  available: boolean;
  projectName: string;
  collectorEndpoint: string;
  appUrl: string;
  batch: boolean;
  privacy: {
    sensitiveContent: "allowed" | "redacted";
    inputsHidden: boolean;
    embeddingVectorsHidden: boolean;
  };
  error: string | null;
  traceId?: string | null;
  tracedAt?: string;
};

export type AiRun = {
  id: string;
  kind: string;
  trigger: string;
  status: "succeeded" | "failed";
  provider: {
    name: string;
    model: string;
    requestedModel?: string;
    briefingModel?: string;
    classificationModel?: string;
    temperature: number;
    think?: string | boolean;
    host?: string;
    classifyMessages?: boolean;
  };
  promptRefs: AiPromptRef[];
  input: {
    accountId: string | null;
    messageCount: number;
    pipeline?: string;
    corpusHash: string;
    briefingFlow?: "cold_start" | "iterative";
    messageSelection?: {
      mode: "cold_start" | "iterative";
      since: string | null;
      includedMessageIds: string[];
      newMessageIds: string[];
      carryOverMessageIds: string[];
      resolvedPreviousMessageIds: string[];
    } | null;
    previousBriefing?: {
      id: string | null;
      generatedAt: string | null;
      hash: string;
    } | null;
    messageHashes: Array<{ messageId: string; inputHash: string }>;
  };
  output: {
    decisions: AiDecision[];
    curatedMessageIds: string[];
    topTodayMessageIds: string[];
    briefing?: InboxBriefing;
  };
  metrics: {
    latencyMs: number;
    messagesProcessed: number;
    estimatedPromptTokens: number;
    estimatedCompletionTokens: number;
    categoryCounts: Record<string, number>;
    averageConfidence: number;
    providerLatencyMs?: number;
    ollamaPromptEvalCount?: number;
    ollamaEvalCount?: number;
    ollamaThinkingChars?: number;
  };
  spans: Array<{
    name: string;
    status: string;
    durationMs: number;
    [key: string]: unknown;
  }>;
  llmCalls?: Array<{
    id: string;
    pipeline: string;
    stage: string;
    provider: string;
    status: "succeeded" | "failed" | "fallback";
    model: string;
    requestedModel?: string;
    promptId?: string;
    promptVersion?: string;
    promptHash?: string;
    contractHash?: string;
    inputHash: string;
    outputHash?: string;
    inputMessageCount: number;
    outputMessageCount: number;
    attempts: number;
    latencyMs: number;
    promptEvalCount: number;
    evalCount: number;
    thinkingChars: number;
    fallback?: boolean;
    fallbackReason?: string | null;
    error?: string;
    createdAt: string;
  }>;
  startedAt: string;
  completedAt: string;
  createdAt: string;
  observability?: PhoenixObservabilityStatus;
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
    promptId?: string;
    evalIds?: string[];
  }>;
  metrics: {
    latencyMs: number;
    aiLatencyMs: number;
    messagesProcessed: number;
  };
  startedAt: string;
  completedAt: string;
  createdAt: string;
  observability?: PhoenixObservabilityStatus;
};

export type AiControlResponse = {
  prompts: AiPromptRecord[];
  evals: AiEvalRecord[];
  observability: PhoenixObservabilityStatus;
  latestRun: AiRun | null;
  latestClassificationRun?: AiRun | null;
  runs: AiRun[];
  queueJobs?: QueueJobSummary[];
  ingestion?: {
    classificationBacklog: ClassificationBacklogSummary;
    latestClassificationRun: AiRun | null;
  };
  latestVerification: AiVerificationRun | null;
  verificationRuns: AiVerificationRun[];
};

export type AiRunResponse = {
  ok: true;
  run: AiRun;
};

export type AiClassificationRunResponse = AiRunResponse & {
  classificationBacklog: {
    before: ClassificationBacklogSummary;
    after: ClassificationBacklogSummary;
  };
  analytics: {
    messagesProcessed: number;
    latencyMs: number;
    briefingGenerated: boolean;
    llmCalls: number;
  };
};

export type AiVerificationResponse = {
  ok: true;
  run: AiVerificationRun;
};

export type RecentClassification = {
  id: string;
  messageId: string;
  subject: string;
  from: string;
  receivedAt: string | null;
  category: SaneCategory;
  needsReply: boolean;
  automated: boolean;
  possibleJunk: boolean;
  direct: boolean;
  score: number;
  confidence: number;
  reasons: string[];
  summary: string | null;
  extracted: ClassificationExtractedMetadata;
  modelProvider: string | null;
  model: string | null;
  promptId: string | null;
  promptVersion: string | null;
  classifiedAt: string | null;
};

export type RecentClassificationsResponse = {
  classifications: RecentClassification[];
};
