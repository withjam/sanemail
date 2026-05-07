import {
  Link,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  useParams,
} from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  Archive,
  BrainCircuit,
  Check,
  CheckCircle2,
  Circle,
  Clock3,
  Database,
  ExternalLink,
  FlaskConical,
  Inbox,
  Loader2,
  Mail,
  MailCheck,
  MessageSquare,
  Plug,
  Plus,
  RefreshCw,
  Settings,
  ShieldAlert,
  Star,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  AccountSummary,
  AiRun,
  AiVerificationRun,
  ClassificationBacklogSummary,
  ClassificationExtractedMetadata,
  FeedbackKind,
  InboxBriefing,
  MailMessage,
  MailProvider,
  PhoenixObservabilityStatus,
  RecentClassification,
  StatusResponse,
  SyntheticIngestionResponse,
} from "@togomail/shared/types";
import {
  AI_OPS_RECENT_CLASSIFICATIONS_LIMIT,
  classifyUnclassifiedMessages,
  clearDemoData,
  disconnect,
  getAiControl,
  getHome,
  getMessage,
  getMessages,
  getRecentClassifications,
  getStatus,
  getToday,
  backfillOlderGmailBatch,
  ingestNextGmailBatch,
  runDailyBrief,
  runAiVerification,
  resetDemoData,
  saveFeedback,
  startGmailConnect,
  synthesizeIngestionBatch,
  syncGmail,
  syncMock,
} from "./api";
import type { AiRunMode } from "./api";
import { useAuth } from "./auth-provider";
import { useOnlineStatus } from "./hooks";
import { queryClient, queryKeys } from "./query";
import { LogOut } from "lucide-react";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function shortHash(value: string) {
  return value.slice(0, 10);
}

function senderName(from: string) {
  const match = from.match(/^"?([^"<]+)"?\s*</);
  return (match?.[1] || from || "Unknown sender").trim();
}

function classForCategory(category: string) {
  if (category === "Junk Review") return "pill danger";
  if (category === "Needs Reply") return "pill success";
  if (category === "FYI") return "pill muted-pill";
  return "pill";
}

function labelForCategory(category: string) {
  return category === "Needs Reply" ? "Needs attention" : category;
}

const defaultObservability: PhoenixObservabilityStatus = {
  enabled: false,
  initialized: false,
  available: false,
  projectName: "Sanemail",
  collectorEndpoint: "http://localhost:6006",
  appUrl: "http://localhost:6006",
  batch: false,
  privacy: {
    sensitiveContent: "redacted",
    inputsHidden: true,
    embeddingVectorsHidden: true,
  },
  error: null,
};

function useStatus() {
  return useQuery({
    queryKey: queryKeys.status,
    queryFn: getStatus,
  });
}

function Shell() {
  const online = useOnlineStatus();
  const status = useStatus();
  const navItems = [
    { to: "/", label: "Home", icon: MailCheck },
    { to: "/today", label: "Today", icon: CheckCircle2 },
    { to: "/mail", label: "All Mail", icon: Inbox },
    { to: "/ai", label: "AI Ops", icon: BrainCircuit },
    { to: "/settings", label: "Settings", icon: Settings },
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link to="/" className="brand" aria-label="Togo Mail home">
          <span className="brand-mark">T</span>
          <span>Togo Mail</span>
        </Link>
        <nav className="nav-list" aria-label="Primary">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className="nav-link"
                activeProps={{ className: "nav-link active" }}
                data-testid={`nav-${item.label.toLowerCase().replaceAll(" ", "-")}`}
                aria-label={item.label}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <div className="connection">
            {online ? <Wifi size={16} /> : <WifiOff size={16} />}
            <span>{online ? "Online" : "Offline cache"}</span>
          </div>
          <SidebarSourcesSummary status={status.data} />
          <SidebarIdentity />
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <div>
            <div className="eyebrow">Personal email</div>
            <div className="topbar-title">Sane defaults, full control</div>
          </div>
          <SyncButton status={status.data} />
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function ConnectGmailButton({
  label,
  icon: Icon,
  testId,
}: {
  label: string;
  icon: typeof Mail;
  testId: string;
}) {
  const mutation = useMutation({ mutationFn: startGmailConnect });
  return (
    <button
      type="button"
      className="button primary"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      data-testid={testId}
    >
      {mutation.isPending ? <Loader2 className="spin" size={16} /> : <Icon size={16} />}
      {label}
    </button>
  );
}

function SidebarIdentity() {
  const { authConfigured, email, signOut } = useAuth();
  if (!authConfigured) {
    return (
      <div className="account-line" data-testid="sidebar-identity-dev">
        <span className="muted">Dev mode (no auth)</span>
      </div>
    );
  }
  return (
    <div className="account-line" data-testid="sidebar-identity">
      <span className="muted" title={email || ""}>{email || "Signed in"}</span>
      <button
        type="button"
        className="sidebar-manage-link"
        onClick={() => void signOut()}
        data-testid="sidebar-sign-out"
      >
        <LogOut size={12} />
        Sign out
      </button>
    </div>
  );
}

function SidebarSourcesSummary({ status }: { status?: StatusResponse }) {
  if (!status) {
    return (
      <div className="account-line" data-testid="sidebar-sources">
        Loading sources…
      </div>
    );
  }
  const sources = resolveSources(status);
  const connectedSources = sources.filter((source) => source.connected);
  const sourceLabel = connectedSources.length === 1 ? "source" : "sources";
  return (
    <div className="account-line" data-testid="sidebar-sources">
      <strong>{connectedSources.length} {sourceLabel} connected</strong>
      <ul className="sidebar-source-list">
        {connectedSources.map((source) => (
          <li key={source.entry.key} className="sidebar-source-row">
            <CheckCircle2 size={12} />
            <span>{source.entry.label}</span>
            {source.email && <span className="muted">· {source.email}</span>}
          </li>
        ))}
      </ul>
      <Link to="/settings" className="sidebar-manage-link">
        <Settings size={12} />
        Manage sources
      </Link>
    </div>
  );
}

function SyncButton({ status }: { status?: StatusResponse }) {
  const syncMutation = useMutation({
    mutationFn: syncGmail,
    onSuccess: () => {
      void queryClient.invalidateQueries();
    },
  });
  const demoMutation = useMutation({
    mutationFn: syncMock,
    onSuccess: () => {
      void queryClient.invalidateQueries();
    },
  });

  if (!status) {
    return (
      <button className="button" disabled>
        <Loader2 className="spin" size={17} />
        Loading
      </button>
    );
  }

  const sources = resolveSources(status);
  const gmailConnected = sources.some(
    (source) => source.entry.key === "gmail" && source.connected,
  );

  if (gmailConnected) {
    return (
      <button
        className="button primary"
        onClick={() => syncMutation.mutate()}
        disabled={syncMutation.isPending}
        data-testid="topbar-sync-gmail"
      >
        {syncMutation.isPending ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
        Sync Gmail
      </button>
    );
  }

  return (
    <button
      className="button primary"
      onClick={() => demoMutation.mutate()}
      disabled={demoMutation.isPending}
      data-testid="topbar-sync-demo"
    >
      {demoMutation.isPending ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
      Sync demo
    </button>
  );
}

function Dashboard() {
  const status = useStatus();
  const home = useQuery({
    queryKey: queryKeys.home,
    queryFn: getHome,
  });
  const [activeTab, setActiveTab] = useState<"mostRecent" | "needsReply" | "upcoming">("needsReply");

  if (status.isError) return <ErrorPanel title="Could not load status" error={status.error} />;
  if (home.isError) return <ErrorPanel title="Could not load home" error={home.error} />;
  if (status.isLoading || !status.data || home.isLoading || !home.data) return <Loading label="Loading mailbox" />;

  const statusData = status.data;
  const tabs = home.data.tabs;
  const tabItems = [
    { id: "needsReply" as const, label: "Needs attention", messages: tabs.needsReply },
    { id: "upcoming" as const, label: "Upcoming", messages: tabs.upcoming },
    { id: "mostRecent" as const, label: "Most recent", messages: tabs.mostRecent },
  ];
  const active = tabItems.find((item) => item.id === activeTab) || tabItems[0];

  return (
    <div className="page-grid">
      <section className="page-heading">
        <h1>Home</h1>
      </section>
      <BriefingPanel briefing={home.data.briefing} />
      {!statusData.account && (
        <ConnectPanel missing={[...statusData.configMissing, ...(statusData.securityMissing || [])]} />
      )}
      <section className="surface flush">
        <div className="home-tabs" role="tablist" aria-label="Inbox views">
          {tabItems.map((item) => (
            <button
              key={item.id}
              className={item.id === active.id ? "tab-button active" : "tab-button"}
              type="button"
              role="tab"
              id={`home-tab-${item.id}`}
              aria-selected={item.id === active.id}
              aria-controls={`home-panel-${item.id}`}
              onClick={() => setActiveTab(item.id)}
              data-testid={`home-tab-${item.id}`}
            >
              <span>{item.label}</span>
              <span className="tab-count">{item.messages.length}</span>
            </button>
          ))}
        </div>
        <div
          key={active.id}
          role="tabpanel"
          id={`home-panel-${active.id}`}
          aria-labelledby={`home-tab-${active.id}`}
          data-testid="home-tab-panel"
          data-active-tab={active.id}
        >
          <MessageStack messages={active.messages} empty={emptyForHomeTab(active.id)} />
        </div>
      </section>
    </div>
  );
}

function BriefingPanel({ briefing }: { briefing: InboxBriefing }) {
  const paragraphs = briefing.narrative
    ? [
        briefing.narrative.status,
        briefing.narrative.needToKnow,
        briefing.narrative.mightBeMissing,
        briefing.narrative.needsAttention,
      ].filter(Boolean)
    : [briefing.text];

  return (
    <section className="briefing-content" data-testid="inbox-briefing">
      <div className="briefing-copy">
        {paragraphs.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>
    </section>
  );
}

function emptyForHomeTab(tab: "mostRecent" | "needsReply" | "upcoming") {
  if (tab === "needsReply") return "Nothing needs attention right now.";
  if (tab === "upcoming") return "No upcoming events, bills, or deadlines detected.";
  return "No recent inbox messages to show.";
}

function ConnectPanel({ missing }: { missing: string[] }) {
  const connectMutation = useMutation({ mutationFn: startGmailConnect });
  return (
    <section className="callout">
      <div>
        <h2>Gmail read-only</h2>
        <p>
          {missing.length
            ? `Missing ${missing.join(", ")}. Demo mail still works.`
            : "Connect Gmail to import messages without changing the Gmail mailbox."}
        </p>
      </div>
      <button
        type="button"
        className="button primary"
        onClick={() => connectMutation.mutate()}
        disabled={connectMutation.isPending}
      >
        {connectMutation.isPending ? <Loader2 className="spin" size={17} /> : <Mail size={17} />}
        Connect
      </button>
    </section>
  );
}

function oauthErrorMessage(error: string) {
  if (error === "invalid_oauth_callback") {
    return "Start from Connect Gmail instead of opening the callback route directly.";
  }
  if (error === "missing_google_config") {
    return "Gmail OAuth is not configured yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then restart the API.";
  }
  return error;
}

function Stat({ icon: Icon, label, value, testId }: { icon: typeof Mail; label: string; value: number; testId?: string }) {
  return (
    <div className="stat" data-testid={testId}>
      <Icon size={18} />
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function TodayRoute() {
  const query = useQuery({
    queryKey: queryKeys.today,
    queryFn: getToday,
  });

  if (query.isError) return <ErrorPanel title="Could not load Today" error={query.error} />;
  if (query.isLoading || !query.data) return <Loading label="Loading Today" />;

  return (
    <MessageListPage
      title="Today"
      subtitle="Actionable messages, filtered away from obvious junk."
      messages={query.data.messages}
      empty="Nothing is demanding attention yet."
    />
  );
}

function MailRoute() {
  const query = useQuery({
    queryKey: queryKeys.messages,
    queryFn: getMessages,
  });

  if (query.isError) return <ErrorPanel title="Could not load mail" error={query.error} />;
  if (query.isLoading || !query.data) return <Loading label="Loading All Mail" />;

  return (
    <MessageListPage
      title="All Mail"
      subtitle="The faithful view over every locally synced message."
      messages={query.data.messages}
      empty="No messages synced yet."
    />
  );
}

function MessageListPage({
  title,
  subtitle,
  messages,
  empty,
}: {
  title: string;
  subtitle: string;
  messages: MailMessage[];
  empty: string;
}) {
  return (
    <div className="page-grid">
      <section className="page-heading">
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </section>
      <section className="surface flush">
        <MessageStack messages={messages} empty={empty} />
      </section>
    </div>
  );
}

function MessageStack({ messages, empty }: { messages: MailMessage[]; empty: string }) {
  if (!messages.length) return <EmptyState text={empty} />;
  return (
    <div className="message-stack">
      {messages.map((message) => (
        <MessageRow key={message.id} message={message} />
      ))}
    </div>
  );
}

function MessageRow({ message }: { message: MailMessage }) {
  return (
    <Link
      to="/message/$messageId"
      params={{ messageId: message.id }}
      className="message-row"
      data-testid="message-row"
      data-message-id={message.id}
    >
      <div className="sender-cell">
        <span className="sender">{senderName(message.from)}</span>
        <span className="date">{formatDate(message.date)}</span>
      </div>
      <div className="message-main">
        <div className="subject-line">{message.subject}</div>
        <div className="snippet">{message.snippet || message.bodyText}</div>
      </div>
      <div className="row-meta">
        <span className={classForCategory(message.sane.category)}>{labelForCategory(message.sane.category)}</span>
        <span className="score">{Math.round(message.sane.todayScore)}</span>
      </div>
    </Link>
  );
}

function MessageDetailRoute() {
  const { messageId } = useParams({ from: "/message/$messageId" });
  const query = useQuery({
    queryKey: queryKeys.message(messageId),
    queryFn: () => getMessage(messageId),
  });
  const feedbackMutation = useMutation({
    mutationFn: (kind: FeedbackKind) => saveFeedback(messageId, kind),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.message(messageId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.messages });
      void queryClient.invalidateQueries({ queryKey: queryKeys.today });
      void queryClient.invalidateQueries({ queryKey: queryKeys.home });
    },
  });

  if (query.isError) return <ErrorPanel title="Could not load message" error={query.error} />;
  if (query.isLoading || !query.data) return <Loading label="Loading message" />;

  const message = query.data.message;
  const feedbackActions: Array<[FeedbackKind, string, typeof Star]> = [
    ["important", "Important", Star],
    ["not-important", "Not important", ThumbsDown],
    ["junk", "Junk", ShieldAlert],
    ["not-junk", "Not junk", ThumbsUp],
    ["needs-reply", "Needs attention", MessageSquare],
    ["done", "Done", Check],
  ];

  return (
    <div className="detail-layout">
      <section className="message-detail-header">
        <Link to="/mail" className="button">
          <Archive size={17} />
          All Mail
        </Link>
        <h1>{message.subject}</h1>
        <p>{senderName(message.from)} · {formatDate(message.date)}</p>
        <div className="toolbar">
          <span className={classForCategory(message.sane.category)}>{labelForCategory(message.sane.category)}</span>
          <span className="pill">score {Math.round(message.sane.todayScore)}</span>
        </div>
      </section>
      <section className="surface">
        <div className="section-header">
          <div>
            <h2>Why</h2>
            <p>{message.sane.reasons.join(", ")}.</p>
          </div>
        </div>
        <div className="feedback-bar">
          {feedbackActions.map(([kind, label, Icon]) => (
            <button
              key={kind}
              className="button"
              onClick={() => feedbackMutation.mutate(kind)}
              disabled={feedbackMutation.isPending}
              data-testid={`feedback-${kind}`}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </div>
        {message.feedback.length > 0 && (
          <p className="feedback-note">
            Feedback: {message.feedback.map((item) => item.kind).join(", ")}
          </p>
        )}
      </section>
      <article className="message-body">{message.bodyText || message.snippet || "(no body text extracted)"}</article>
    </div>
  );
}

const aiRunModeOptions: { id: AiRunMode; label: string; hint: string }[] = [
  { id: "auto", label: "Auto", hint: "Use server default (iterative if a prior brief exists)" },
  { id: "cold_start", label: "Cold start", hint: "Rebuild from all messages" },
  { id: "iterative", label: "Iterative", hint: "Only messages newer than the last brief" },
];

function AiOpsRoute() {
  const [runMode, setRunMode] = useState<AiRunMode>("auto");
  const [runLimit, setRunLimit] = useState<number>(500);
  const [classificationLimit, setClassificationLimit] = useState<number>(10);
  const status = useStatus();
  const query = useQuery({
    queryKey: queryKeys.aiControl,
    queryFn: getAiControl,
  });
  const recentClassificationsQuery = useQuery({
    queryKey: queryKeys.recentClassifications,
    queryFn: () => getRecentClassifications(AI_OPS_RECENT_CLASSIFICATIONS_LIMIT),
  });
  const runMutation = useMutation({
    mutationFn: (options: { mode: AiRunMode; limit: number }) => runDailyBrief(options),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.aiControl });
    },
  });
  const verifyMutation = useMutation({
    mutationFn: runAiVerification,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.aiControl });
    },
  });
  const synthesizeMutation = useMutation({
    mutationFn: synthesizeIngestionBatch,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.aiControl });
      void queryClient.invalidateQueries({ queryKey: queryKeys.status });
      void queryClient.invalidateQueries({ queryKey: queryKeys.home });
      void queryClient.invalidateQueries({ queryKey: queryKeys.messages });
      void queryClient.invalidateQueries({ queryKey: queryKeys.today });
    },
  });
  const classifyMutation = useMutation({
    mutationFn: () => classifyUnclassifiedMessages({ limit: classificationLimit }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.aiControl });
      void queryClient.invalidateQueries({ queryKey: queryKeys.recentClassifications });
      void queryClient.invalidateQueries({ queryKey: queryKeys.status });
      void queryClient.invalidateQueries({ queryKey: queryKeys.home });
      void queryClient.invalidateQueries({ queryKey: queryKeys.messages });
      void queryClient.invalidateQueries({ queryKey: queryKeys.today });
    },
  });

  if (query.isError) return <ErrorPanel title="Could not load AI Ops" error={query.error} />;
  if (query.isLoading || !query.data) return <Loading label="Loading AI Ops" />;

  const latestRun = runMutation.data?.run || query.data.latestRun;
  const latestClassificationRun =
    classifyMutation.data?.run ||
    query.data.ingestion?.latestClassificationRun ||
    query.data.latestClassificationRun ||
    null;
  const classificationBacklog =
    classifyMutation.data?.classificationBacklog.after ||
    synthesizeMutation.data?.classificationBacklog ||
    query.data.ingestion?.classificationBacklog ||
    null;
  const latestVerification = verifyMutation.data?.run || query.data.latestVerification;
  const observability = query.data.observability ?? defaultObservability;
  const prompts = query.data.prompts ?? [];
  const syntheticConnected = Boolean(status.data?.connectedProviders?.includes("mock"));

  return (
    <div className="page-grid">
      <section className="page-heading">
        <h1>AI Ops</h1>
        <p>Prompt control, run traces, and local evals for the curation loop.</p>
      </section>
      <section className="surface">
        <div className="section-header">
          <div>
            <h2>Ingestion flow</h2>
            <p>Fast local emulation for new mail, followed by explicit classification.</p>
          </div>
          <div className="toolbar">
            <label className="ai-run-limit" title="Max unclassified messages to classify in this batch">
              <span className="ai-run-limit-label">Batch</span>
              <input
                type="number"
                min={1}
                max={500}
                step={1}
                value={classificationLimit}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isFinite(next) && next > 0) {
                    setClassificationLimit(Math.min(500, Math.floor(next)));
                  }
                }}
                disabled={classifyMutation.isPending || synthesizeMutation.isPending}
                data-testid="ai-classification-limit"
              />
            </label>
            <button
              className="button primary"
              onClick={() => synthesizeMutation.mutate()}
              disabled={
                !syntheticConnected ||
                synthesizeMutation.isPending ||
                classifyMutation.isPending
              }
              data-testid="ai-synthesize-ingestion"
              title={
                syntheticConnected
                  ? "Generate a small synthetic batch for testing."
                  : "Synthetic source is not connected."
              }
            >
              {synthesizeMutation.isPending ? <Loader2 className="spin" size={17} /> : <Database size={17} />}
              Synthesize batch
            </button>
            <button
              className="button"
              onClick={() => classifyMutation.mutate()}
              disabled={classifyMutation.isPending || synthesizeMutation.isPending}
              data-testid="ai-classify-unclassified"
            >
              {classifyMutation.isPending ? <Loader2 className="spin" size={17} /> : <MailCheck size={17} />}
              Classify unclassified
            </button>
          </div>
        </div>
        {synthesizeMutation.isError ? (
          <p className="ops-warn" data-testid="ai-synthesize-error">
            Ingest failed: {synthesizeMutation.error instanceof Error ? synthesizeMutation.error.message : String(synthesizeMutation.error)}
          </p>
        ) : null}
        {classifyMutation.isError ? (
          <p className="ops-warn" data-testid="ai-classify-error">
            Classification failed: {classifyMutation.error instanceof Error ? classifyMutation.error.message : String(classifyMutation.error)}
          </p>
        ) : null}
        <div className="ops-grid">
          <SyntheticBatchSummary response={synthesizeMutation.data || null} />
          <BacklogSummary summary={classificationBacklog} />
          <ClassificationRunSummary run={latestClassificationRun} />
        </div>
      </section>
      <section className="surface">
        <div className="section-header">
          <div>
            <h2>Control loop</h2>
            <p>
              Runs the daily brief pipeline only — one LLM call to draft the greeting from
              existing decisions. Classification and ranking run as separate batches.
            </p>
          </div>
          <div className="toolbar">
            <div className="ai-run-mode" role="group" aria-label="Run loop mode" data-testid="ai-run-mode">
              {aiRunModeOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={option.id === runMode ? "tab-button active" : "tab-button"}
                  onClick={() => setRunMode(option.id)}
                  disabled={runMutation.isPending}
                  title={option.hint}
                  aria-pressed={option.id === runMode}
                  data-testid={`ai-run-mode-${option.id}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <label className="ai-run-limit" title="Max non-junk messages to score before drafting the brief">
              <span className="ai-run-limit-label">Non-junk</span>
              <input
                type="number"
                min={1}
                max={500}
                step={10}
                value={runLimit}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isFinite(next) && next > 0) setRunLimit(Math.min(500, Math.floor(next)));
                }}
                disabled={runMutation.isPending}
                data-testid="ai-run-limit"
              />
            </label>
            <button
              className="button primary"
              onClick={() => runMutation.mutate({ mode: runMode, limit: runLimit })}
              disabled={runMutation.isPending}
              data-testid="ai-run-loop"
            >
              {runMutation.isPending ? <Loader2 className="spin" size={17} /> : <BrainCircuit size={17} />}
              Run daily brief
            </button>
            <button
              className="button"
              onClick={() => verifyMutation.mutate()}
              disabled={verifyMutation.isPending}
              data-testid="ai-verify"
            >
              {verifyMutation.isPending ? <Loader2 className="spin" size={17} /> : <FlaskConical size={17} />}
              Verify
            </button>
          </div>
        </div>
        {runMutation.isError ? (
          <p className="ops-warn" data-testid="ai-run-error">
            Run failed: {runMutation.error instanceof Error ? runMutation.error.message : String(runMutation.error)}
          </p>
        ) : null}
        <div className="ops-grid">
          <PhoenixSummary observability={observability} latestRun={latestRun} latestVerification={latestVerification} />
          <AiRunSummary run={latestRun} />
          <VerificationSummary run={latestVerification} />
        </div>
      </section>
      <section className="surface">
        <div className="section-header">
          <div>
            <h2>Active prompts</h2>
            <p>{prompts.length} versioned prompts are pinned for this loop.</p>
          </div>
        </div>
        <div className="prompt-stack">
          {prompts.map((prompt) => (
            <div className="prompt-row" key={prompt.id}>
              <div>
                <h3>{prompt.id}</h3>
                <p>{prompt.description}</p>
              </div>
              <div className="prompt-meta">
                <span className="pill">{prompt.version}</span>
                <span className="pill">{prompt.stage}</span>
                <span className="pill">{shortHash(prompt.hash)}</span>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="surface flush">
        <div className="section-header padded-header">
          <div>
            <h2>Latest decisions</h2>
            <p>{latestRun ? `${latestRun.output.decisions.length} messages processed.` : "Run the loop to create decisions."}</p>
          </div>
        </div>
        {latestRun ? <DecisionList run={latestRun} /> : <EmptyState text="No AI run has been recorded yet." />}
      </section>
      <section className="surface flush" data-testid="ai-recent-classifications">
        <div className="section-header padded-header">
          <div>
            <h2>{AI_OPS_RECENT_CLASSIFICATIONS_LIMIT} most recent classifications</h2>
            <p>
              {recentClassificationsQuery.data
                ? `${recentClassificationsQuery.data.classifications.length} shown · newest persisted rows across all runs (up to ${AI_OPS_RECENT_CLASSIFICATIONS_LIMIT}).`
                : "Loading persisted classifications…"}
            </p>
          </div>
        </div>
        {recentClassificationsQuery.isError ? (
          <>
            <EmptyState text="Could not load recent classifications." />
            <p className="ops-warn" data-testid="ai-recent-classifications-error">
              {recentClassificationsQuery.error instanceof Error
                ? recentClassificationsQuery.error.message
                : String(recentClassificationsQuery.error)}
            </p>
          </>
        ) : recentClassificationsQuery.data && recentClassificationsQuery.data.classifications.length ? (
          <RecentClassificationsList items={recentClassificationsQuery.data.classifications} />
        ) : recentClassificationsQuery.isLoading ? (
          <EmptyState text="Loading…" />
        ) : (
          <EmptyState text="No classifications have been persisted yet." />
        )}
      </section>
      <section className="surface">
        <div className="section-header">
          <div>
            <h2>Verification cases</h2>
            <p>{latestVerification ? `${latestVerification.summary.passedCases}/${latestVerification.summary.cases} cases passed.` : "Run verification to score the synthetic suite."}</p>
          </div>
        </div>
        {latestVerification ? <VerificationCases run={latestVerification} /> : <EmptyState text="No verification run has been recorded yet." />}
      </section>
    </div>
  );
}

function PhoenixSummary({
  observability,
  latestRun,
  latestVerification,
}: {
  observability: PhoenixObservabilityStatus;
  latestRun: AiRun | null;
  latestVerification: AiVerificationRun | null;
}) {
  const traceId = latestRun?.observability?.traceId || latestVerification?.observability?.traceId;
  const status = !observability.enabled
    ? "disabled"
    : observability.available
      ? "connected"
      : "unavailable";

  return (
    <div className="ops-panel" data-testid="phoenix-status">
      <Activity size={18} />
      <strong>Phoenix {status}</strong>
      <span>{observability.projectName} · {observability.privacy.sensitiveContent}</span>
      {traceId && <span className="muted">trace {shortHash(traceId)}</span>}
      <a className="button compact-button" href={observability.appUrl} target="_blank" rel="noreferrer">
        <ExternalLink size={15} />
        Open Phoenix
      </a>
    </div>
  );
}

function AiRunSummary({ run }: { run: AiRun | null }) {
  if (!run) {
    return (
      <div className="ops-panel" data-testid="ai-latest-run-status">
        <Activity size={18} />
        <strong>No run yet</strong>
        <span>Start with the local mailbox.</span>
      </div>
    );
  }

  const requestedModel = run.provider.requestedModel;
  const modelMismatch = requestedModel && requestedModel !== run.provider.model;
  const latestLlmCall = [...(run.llmCalls || [])]
    .reverse()
    .find((call) => call.pipeline === "daily_brief") || [...(run.llmCalls || [])].at(-1);

  return (
    <div className="ops-panel" data-testid="ai-latest-run-status">
      <Activity size={18} />
      <strong>{run.status}</strong>
      <span>{run.metrics.messagesProcessed} messages · {run.metrics.latencyMs}ms</span>
      <span className="muted">{run.kind} · {run.input.briefingFlow || run.input.pipeline || "pipeline"}</span>
      <span className="muted">{run.provider.name} · {run.provider.model}</span>
      {latestLlmCall ? (
        <span className={latestLlmCall.fallback ? "ops-warn" : "muted"}>
          {latestLlmCall.pipeline} · {latestLlmCall.status} · {latestLlmCall.attempts} attempts
        </span>
      ) : null}
      {modelMismatch ? (
        <span className="ops-warn" data-testid="ai-model-mismatch">
          Requested {requestedModel}; server returned {run.provider.model}
        </span>
      ) : null}
      <span className="muted">confidence {formatPercent(run.metrics.averageConfidence)}</span>
    </div>
  );
}

function VerificationSummary({ run }: { run: AiVerificationRun | null }) {
  if (!run) {
    return (
      <div className="ops-panel" data-testid="ai-verification-status">
        <FlaskConical size={18} />
        <strong>No eval yet</strong>
        <span>Synthetic suite is ready.</span>
      </div>
    );
  }

  return (
    <div className="ops-panel" data-testid="ai-verification-status">
      <FlaskConical size={18} />
      <strong>{run.status}</strong>
      <span>{run.summary.passedCases}/{run.summary.cases} cases · score {formatPercent(run.score)}</span>
      <span className="muted">{run.suiteId}</span>
    </div>
  );
}

function DecisionList({ run }: { run: AiRun }) {
  const decisions = [...run.output.decisions].sort((a, b) => b.recsysScore - a.recsysScore).slice(0, 8);

  return (
    <div className="decision-list">
      {decisions.map((decision) => (
        <div className="decision-row" key={decision.messageId}>
          <div>
            <div className="subject-line">{decision.subject}</div>
            <div className="snippet">{senderName(decision.from)} · input {shortHash(decision.instrumentation.inputHash)}</div>
          </div>
          <div className="row-meta">
            <span className={classForCategory(decision.category)}>{decision.category}</span>
            <span className="pill">rank {decision.recsysScore}</span>
            <span className="pill">conf {formatPercent(decision.confidence)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

const EMPTY_CLASSIFICATION_EXTRACTED: ClassificationExtractedMetadata = {
  actions: [],
  deadlines: [],
  entities: [],
  replyCue: null,
};

function recentClassificationExtracted(item: RecentClassification): ClassificationExtractedMetadata {
  return item.extracted ?? EMPTY_CLASSIFICATION_EXTRACTED;
}

function recentClassificationReasons(item: RecentClassification): string[] {
  return Array.isArray(item.reasons) ? item.reasons : [];
}

function recentClassificationHasExpandableMetadata(item: RecentClassification) {
  const extracted = recentClassificationExtracted(item);
  const reasons = recentClassificationReasons(item);
  return (
    reasons.length > 0 ||
    extracted.entities.length > 0 ||
    extracted.actions.length > 0 ||
    extracted.deadlines.length > 0 ||
    Boolean(extracted.replyCue)
  );
}

function ClassificationMetaChips({ label, values }: { label: string; values: string[] }) {
  if (!values.length) return null;
  return (
    <div className="classification-meta-section">
      <span className="classification-meta-label">{label}</span>
      <div className="classification-meta-chips">
        {values.map((v, i) => (
          <span className="pill muted-pill" key={`${label}-${i}-${v}`}>
            {v}
          </span>
        ))}
      </div>
    </div>
  );
}

function RecentClassificationsList({ items }: { items: RecentClassification[] }) {
  return (
    <div className="decision-list">
      {items.map((item) => {
        const extracted = recentClassificationExtracted(item);
        const reasons = recentClassificationReasons(item);
        return (
        <div className="decision-row" key={item.id} data-testid="ai-recent-classification-row">
          <div className="decision-cell-main">
            <div>
              <div className="subject-line">{item.subject}</div>
              <div className="snippet">
                {senderName(item.from)}
                {item.classifiedAt ? <> · {formatDate(item.classifiedAt)}</> : null}
                {item.model ? <> · {item.model}</> : null}
              </div>
              {item.summary ? <div className="snippet">{item.summary}</div> : null}
            </div>
            {recentClassificationHasExpandableMetadata(item) ? (
              <details className="classification-meta" data-testid="ai-recent-classification-metadata">
                <summary>Extracted metadata</summary>
                <ClassificationMetaChips label="Entities" values={extracted.entities} />
                <ClassificationMetaChips label="Actions" values={extracted.actions} />
                <ClassificationMetaChips label="Deadlines" values={extracted.deadlines} />
                {extracted.replyCue ? (
                  <div className="classification-meta-section">
                    <span className="classification-meta-label">Reply cue</span>
                    <p className="classification-meta-replycue">{extracted.replyCue}</p>
                  </div>
                ) : null}
                {reasons.length > 0 ? (
                  <div className="classification-meta-section">
                    <span className="classification-meta-label">Reasons</span>
                    <ul className="classification-meta-reasons">
                      {reasons.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </details>
            ) : null}
          </div>
          <div className="row-meta">
            <span className={classForCategory(item.category)}>{item.category}</span>
            {item.needsReply ? <span className="pill">reply</span> : null}
            {item.possibleJunk ? <span className="pill danger">junk?</span> : null}
            {item.automated ? <span className="pill">auto</span> : null}
            <span className="pill">score {Math.round(item.score)}</span>
            <span className="pill">conf {formatPercent(item.confidence)}</span>
          </div>
        </div>
        );
      })}
    </div>
  );
}

function VerificationCases({ run }: { run: AiVerificationRun }) {
  return (
    <div className="case-stack">
      {run.cases.map((testCase) => (
        <div className="case-row" key={testCase.id}>
          <div>
            <h3>{testCase.id}</h3>
            <p>{testCase.description}</p>
          </div>
          <span className={testCase.passed ? "pill success" : "pill danger"}>
            {testCase.passed ? "passed" : "failed"}
          </span>
        </div>
      ))}
    </div>
  );
}

function formatMs(value?: number) {
  if (!Number.isFinite(value)) return "0ms";
  return `${Math.round(Number(value))}ms`;
}

function SyntheticBatchSummary({ response }: { response: SyntheticIngestionResponse | null }) {
  if (!response) {
    return (
      <div className="ops-panel" data-testid="ai-ingestion-latest-batch">
        <Database size={18} />
        <strong>No batch yet</strong>
        <span>Ready to synthesize local mail.</span>
      </div>
    );
  }

  return (
    <div className="ops-panel" data-testid="ai-ingestion-latest-batch">
      <Database size={18} />
      <strong>{response.batch.count} messages</strong>
      <span>{response.analytics.inserted} inserted · {response.analytics.updated} updated</span>
      <span className="muted">
        ingest {formatMs(response.analytics.ingestLatencyMs)} · synth {formatMs(response.analytics.synthesisLatencyMs)}
      </span>
      <span className="muted">classification skipped · brief skipped</span>
    </div>
  );
}

function BacklogSummary({ summary }: { summary: ClassificationBacklogSummary | null }) {
  if (!summary) {
    return (
      <div className="ops-panel" data-testid="ai-classification-backlog">
        <Activity size={18} />
        <strong>Backlog unknown</strong>
        <span>Load AI Ops to inspect state.</span>
      </div>
    );
  }

  return (
    <div className="ops-panel" data-testid="ai-classification-backlog">
      <Activity size={18} />
      <strong>{summary.backlog} unclassified</strong>
      <span>{summary.total} total · {summary.classified} classified</span>
      <span className="muted">
        {summary.pending} pending · {summary.stale} stale · {summary.failed} failed
      </span>
      {summary.newestPriorityAt ? <span className="muted">newest {formatDate(summary.newestPriorityAt)}</span> : null}
    </div>
  );
}

function ClassificationRunSummary({ run }: { run: AiRun | null }) {
  if (!run) {
    return (
      <div className="ops-panel" data-testid="ai-classification-latest-run">
        <MailCheck size={18} />
        <strong>No classification run</strong>
        <span>Run a batch after ingest.</span>
      </div>
    );
  }

  const categories = Object.entries(run.metrics.categoryCounts || {})
    .map(([category, count]) => `${category}: ${count}`)
    .join(" · ");

  return (
    <div className="ops-panel" data-testid="ai-classification-latest-run">
      <MailCheck size={18} />
      <strong>{run.metrics.messagesProcessed} processed</strong>
      <span>{run.provider.name} · {run.provider.model}</span>
      <span className="muted">{formatMs(run.metrics.latencyMs)} · {run.llmCalls?.length || 0} LLM calls</span>
      {categories ? <span className="muted">{categories}</span> : null}
    </div>
  );
}

type SourceProviderKey = "synthetic-local-dev" | "gmail";

type SourceCatalogEntry = {
  key: SourceProviderKey;
  provider: MailProvider;
  label: string;
  description: string;
  icon: typeof Mail;
  realConnection: boolean;
  alwaysConnected?: boolean;
};

const SOURCE_CATALOG: SourceCatalogEntry[] = [
  {
    key: "synthetic-local-dev",
    provider: "mock",
    label: "Synthetic local dev",
    description: "Built-in fixture mailbox used for development and demos.",
    icon: Database,
    realConnection: false,
    alwaysConnected: true,
  },
  {
    key: "gmail",
    provider: "gmail",
    label: "Gmail",
    description: "Read-only Gmail import using the Google API.",
    icon: Mail,
    realConnection: true,
  },
];

type ResolvedSource = {
  entry: SourceCatalogEntry;
  connected: boolean;
  account: AccountSummary | null;
  email: string;
};

function resolveSources(status: StatusResponse): ResolvedSource[] {
  const account = status.account;
  const accountIsDemo = Boolean(account?.demo) || account?.provider === "mock";

  return SOURCE_CATALOG.map((entry) => {
    if (entry.key === "synthetic-local-dev") {
      return {
        entry,
        connected: accountIsDemo,
        account: accountIsDemo ? account : null,
        email: account && accountIsDemo ? account.email : "",
      };
    }
    const matched = account && !accountIsDemo && account.provider === entry.provider ? account : null;
    return {
      entry,
      connected: Boolean(matched),
      account: matched,
      email: matched?.email || "",
    };
  });
}

function SettingsRoute() {
  const status = useStatus();
  const syncGmailMutation = useMutation({
    mutationFn: syncGmail,
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  const ingestNextGmailMutation = useMutation({
    mutationFn: ingestNextGmailBatch,
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  const backfillOlderGmailMutation = useMutation({
    mutationFn: backfillOlderGmailBatch,
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  const syncMockMutation = useMutation({
    mutationFn: syncMock,
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  const disconnectMutation = useMutation({
    mutationFn: disconnect,
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  const demoResetMutation = useMutation({
    mutationFn: resetDemoData,
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  const demoClearMutation = useMutation({
    mutationFn: clearDemoData,
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  const params = new URLSearchParams(window.location.search);
  const oauthError = params.get("error");
  const connectedQuery = params.get("connected");

  if (status.isError) return <ErrorPanel title="Could not load settings" error={status.error} />;
  if (status.isLoading || !status.data) return <Loading label="Loading settings" />;
  const statusData = status.data;
  const sources = resolveSources(statusData);
  const connectedSources = sources.filter((source) => source.connected);
  const availableSources = sources.filter((source) => !source.connected && source.entry.realConnection);
  const configMissing = [...statusData.configMissing, ...(statusData.securityMissing || [])];
  const hasGmail = sources.some((source) => source.entry.key === "gmail" && source.connected);

  return (
    <div className="page-grid">
      <section className="page-heading">
        <h1>Settings</h1>
        <p>Manage the sources that feed your mailbox. Connect additional providers to import more mail.</p>
      </section>
      {oauthError && (
        <section className="callout danger-callout">
          <AlertTriangle size={20} />
          <div>
            <h2>OAuth did not complete</h2>
            <p>{oauthErrorMessage(oauthError)}</p>
          </div>
        </section>
      )}
      {connectedQuery && (
        <section className="callout success-callout">
          <CheckCircle2 size={20} />
          <div>
            <h2>Connected</h2>
            <p>{connectedQuery}</p>
          </div>
        </section>
      )}

      <section className="surface flush" data-testid="settings-sources">
        <div className="section-header padded-header">
          <div>
            <h2>Sources</h2>
            <p>
              {connectedSources.length === 1
                ? "1 source connected."
                : `${connectedSources.length} sources connected.`}
            </p>
          </div>
        </div>
        <div className="source-list">
          {connectedSources.map((source) => (
            <SourceConnectionCard
              key={source.entry.key}
              source={source}
              gmailReadonly={statusData.gmailReadonly}
              configMissing={configMissing}
              syncGmailPending={syncGmailMutation.isPending}
              queueGmailPending={ingestNextGmailMutation.isPending}
              backfillGmailPending={backfillOlderGmailMutation.isPending}
              syncMockPending={syncMockMutation.isPending}
              disconnectPending={disconnectMutation.isPending}
              demoResetPending={demoResetMutation.isPending}
              demoClearPending={demoClearMutation.isPending}
              hasGmail={hasGmail}
              onSyncGmail={() => syncGmailMutation.mutate()}
              onQueueGmail={() => ingestNextGmailMutation.mutate()}
              onBackfillGmail={() => backfillOlderGmailMutation.mutate()}
              onSyncMock={() => syncMockMutation.mutate()}
              onDisconnect={() => disconnectMutation.mutate()}
              onResetDemo={() => demoResetMutation.mutate()}
              onClearDemo={() => demoClearMutation.mutate()}
            />
          ))}
        </div>
      </section>

      {availableSources.length > 0 && (
        <section className="surface" data-testid="settings-add-source">
          <div className="section-header">
            <div>
              <h2>Add another source</h2>
              <p>Bring more mail into Togo Mail by connecting an additional provider.</p>
            </div>
          </div>
          <div className="add-source-list">
            {availableSources.map((source) => {
              const Icon = source.entry.icon;
              const blockedByConfig = source.entry.key === "gmail" && configMissing.length > 0;
              return (
                <div className="add-source-row" key={source.entry.key}>
                  <div className="add-source-info">
                    <span className="add-source-icon"><Icon size={18} /></span>
                    <div>
                      <strong>{source.entry.label}</strong>
                      <span>{source.entry.description}</span>
                    </div>
                  </div>
                  {source.entry.key === "gmail" ? (
                    blockedByConfig ? (
                      <span className="pill muted-pill" title={configMissing.join(", ")}>
                        Needs config: {configMissing.join(", ")}
                      </span>
                    ) : (
                      <ConnectGmailButton
                        label={`Connect ${source.entry.label}`}
                        icon={Plus}
                        testId="settings-connect-gmail"
                      />
                    )
                  ) : (
                    <span className="pill">Built-in</span>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="surface">
        <div className="section-header">
          <div>
            <h2>Local counts</h2>
            <p>Aggregated across every connected source.</p>
          </div>
        </div>
        <div className="stats-grid compact">
          <Stat icon={Mail} label="Synced" value={statusData.counts.messages} testId="settings-stat-synced" />
          <Stat icon={CheckCircle2} label="Today" value={statusData.counts.today} />
          <Stat icon={MessageSquare} label="Needs attention" value={statusData.counts.needsReply} />
          <Stat icon={ShieldAlert} label="Junk review" value={statusData.counts.junkReview} />
        </div>
      </section>

      <section className="surface settings-surface" data-testid="settings-danger-zone">
        <div>
          <h2>Danger zone</h2>
          <p className="muted">Clear every cached message and disconnect every source.</p>
        </div>
        <div className="settings-actions">
          {hasGmail && (
            <button
              className="button danger-button"
              onClick={() => demoClearMutation.mutate()}
              disabled={demoClearMutation.isPending}
              data-testid="settings-clear-demo-danger"
              title="Remove the synthetic demo mailbox so you can evaluate Gmail-only."
            >
              {demoClearMutation.isPending ? <Loader2 className="spin" size={17} /> : <Trash2 size={17} />}
              Delete demo mailbox
            </button>
          )}
          <button
            className="button danger-button"
            onClick={() => disconnectMutation.mutate()}
            disabled={disconnectMutation.isPending}
          >
            {disconnectMutation.isPending ? <Loader2 className="spin" size={17} /> : <Trash2 size={17} />}
            Delete local data
          </button>
        </div>
      </section>
    </div>
  );
}

function SourceConnectionCard({
  source,
  gmailReadonly,
  configMissing,
  syncGmailPending,
  queueGmailPending,
  backfillGmailPending,
  syncMockPending,
  disconnectPending,
  demoResetPending,
  demoClearPending,
  hasGmail,
  onSyncGmail,
  onQueueGmail,
  onBackfillGmail,
  onSyncMock,
  onDisconnect,
  onResetDemo,
  onClearDemo,
}: {
  source: ResolvedSource;
  gmailReadonly: string;
  configMissing: string[];
  syncGmailPending: boolean;
  queueGmailPending: boolean;
  backfillGmailPending: boolean;
  syncMockPending: boolean;
  disconnectPending: boolean;
  demoResetPending: boolean;
  demoClearPending: boolean;
  hasGmail: boolean;
  onSyncGmail: () => void;
  onQueueGmail: () => void;
  onBackfillGmail: () => void;
  onSyncMock: () => void;
  onDisconnect: () => void;
  onResetDemo: () => void;
  onClearDemo: () => void;
}) {
  const Icon = source.entry.icon;
  const isDev = source.entry.key === "synthetic-local-dev";
  const isGmail = source.entry.key === "gmail";
  const blockedByConfig = isGmail && configMissing.length > 0;

  return (
    <div
      className={`source-card${source.connected ? " connected" : ""}${isDev ? " dev" : ""}`}
      data-testid={`source-card-${source.entry.key}`}
      data-connected={source.connected ? "true" : "false"}
    >
      <div className="source-card-head">
        <span className="source-card-icon"><Icon size={20} /></span>
        <div className="source-card-title">
          <div className="source-card-title-row">
            <strong>{source.entry.label}</strong>
            <SourceStatusBadge connected={source.connected} alwaysConnected={source.entry.alwaysConnected} />
          </div>
          <span className="source-card-email">
            {source.connected
              ? source.email
              : blockedByConfig
                ? `Needs ${configMissing.join(", ")}`
                : "Not connected"}
          </span>
        </div>
      </div>
      <p className="source-card-description">{source.entry.description}</p>
      <div className="source-card-meta">
        {isDev && <span className="pill">default</span>}
        {isGmail && <span className="pill">read-only</span>}
        {isGmail && <span className="muted">{gmailReadonly}</span>}
        {source.account?.updatedAt && (
          <span className="muted">updated {formatDate(source.account.updatedAt)}</span>
        )}
      </div>
      <div className="source-card-actions">
        {isDev && (
          <>
            {hasGmail ? (
              <button
                className="button danger-button"
                onClick={onClearDemo}
                disabled={demoClearPending}
                data-testid="settings-clear-demo"
                title="Remove the synthetic demo mailbox so you can evaluate real Gmail only."
              >
                {demoClearPending ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
                Delete demo mailbox
              </button>
            ) : (
              <>
                <button
                  className="button"
                  onClick={onSyncMock}
                  disabled={syncMockPending}
                  data-testid="source-sync-dev"
                >
                  {syncMockPending ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                  Sync
                </button>
                <button
                  className="button"
                  onClick={onResetDemo}
                  disabled={demoResetPending}
                  data-testid="settings-reset-demo"
                >
                  {demoResetPending ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                  Reset demo data
                </button>
              </>
            )}
          </>
        )}
        {isGmail && source.connected && (
          <>
            <button
              className="button"
              onClick={onSyncGmail}
              disabled={syncGmailPending}
              data-testid="source-sync-gmail"
            >
              {syncGmailPending ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
              Sync
            </button>
            <button
              className="button"
              onClick={onQueueGmail}
              disabled={queueGmailPending}
              data-testid="source-queue-sync-gmail"
              title="Enqueue the next Gmail ingestion batch (runs via the worker)."
            >
              {queueGmailPending ? <Loader2 className="spin" size={16} /> : <Archive size={16} />}
              Ingest next batch
            </button>
            <button
              className="button"
              onClick={onBackfillGmail}
              disabled={backfillGmailPending}
              data-testid="source-backfill-gmail"
              title="Enqueue one backfill batch (older messages) until the cutoff is reached."
            >
              {backfillGmailPending ? <Loader2 className="spin" size={16} /> : <Archive size={16} />}
              Backfill older
            </button>
            <button
              className="button danger-button"
              onClick={onDisconnect}
              disabled={disconnectPending}
              data-testid="source-disconnect-gmail"
            >
              <Trash2 size={16} />
              Disconnect
            </button>
          </>
        )}
        {isGmail && !source.connected && (
          blockedByConfig ? (
            <span className="muted">Add Google credentials and restart the API to enable.</span>
          ) : (
            <ConnectGmailButton label="Connect" icon={Plug} testId="source-connect-gmail" />
          )
        )}
      </div>
    </div>
  );
}

function SourceStatusBadge({
  connected,
  alwaysConnected,
}: {
  connected: boolean;
  alwaysConnected?: boolean;
}) {
  if (alwaysConnected) {
    return (
      <span className="status-badge connected" title="Default-connected for local dev">
        <CheckCircle2 size={14} />
        Connected
      </span>
    );
  }
  if (connected) {
    return (
      <span className="status-badge connected">
        <CheckCircle2 size={14} />
        Connected
      </span>
    );
  }
  return (
    <span className="status-badge">
      <Circle size={14} />
      Not connected
    </span>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className="loading">
      <Loader2 className="spin" size={22} />
      <span>{label}</span>
    </div>
  );
}

function ErrorPanel({ title, error }: { title: string; error: Error }) {
  return (
    <section className="callout danger-callout">
      <AlertTriangle size={20} />
      <div>
        <h2>{title}</h2>
        <p>{error.message}</p>
      </div>
    </section>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="empty-state">
      <Clock3 size={22} />
      <span>{text}</span>
    </div>
  );
}

const rootRoute = createRootRoute({
  component: Shell,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Dashboard,
});

const todayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/today",
  component: TodayRoute,
});

const mailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mail",
  component: MailRoute,
});

const aiOpsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ai",
  component: AiOpsRoute,
});

const messageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/message/$messageId",
  component: MessageDetailRoute,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsRoute,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  todayRoute,
  mailRoute,
  aiOpsRoute,
  messageRoute,
  settingsRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
