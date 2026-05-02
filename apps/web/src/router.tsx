import {
  Link,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  useParams,
} from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Activity,
  AlertTriangle,
  Archive,
  BrainCircuit,
  Check,
  CheckCircle2,
  Clock3,
  FlaskConical,
  Inbox,
  Loader2,
  Mail,
  MailCheck,
  MessageSquare,
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
import { useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  AiRun,
  AiVerificationRun,
  FeedbackKind,
  MailMessage,
  StatusResponse,
} from "@sanemail/shared/types";
import {
  disconnect,
  getAiControl,
  getMessage,
  getMessages,
  getStatus,
  getToday,
  runAiLoop,
  runAiVerification,
  resetDemoData,
  saveFeedback,
  syncGmail,
} from "./api";
import { useOnlineStatus } from "./hooks";
import { queryClient, queryKeys } from "./query";

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
        <Link to="/" className="brand" aria-label="SaneMail home">
          <span className="brand-mark">S</span>
          <span>SaneMail</span>
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
          <div className="account-line">
            {status.data?.account?.email || "Gmail not connected"}
          </div>
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

function SyncButton({ status }: { status?: StatusResponse }) {
  const syncMutation = useMutation({
    mutationFn: syncGmail,
    onSuccess: () => {
      void queryClient.invalidateQueries();
    },
  });
  const demoMutation = useMutation({
    mutationFn: resetDemoData,
    onSuccess: () => {
      void queryClient.invalidateQueries();
    },
  });

  if (!status?.account) {
    return (
      <a className="button primary" href="/api/connect/gmail" data-testid="connect-gmail-link">
        <Mail size={17} />
        Connect Gmail
      </a>
    );
  }

  if (status.account.demo) {
    return (
      <button
        className="button primary"
        onClick={() => demoMutation.mutate()}
        disabled={demoMutation.isPending}
        data-testid="topbar-reset-demo"
      >
        {demoMutation.isPending ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
        Reset demo
      </button>
    );
  }

  return (
    <button className="button primary" onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending}>
      {syncMutation.isPending ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
      Sync
    </button>
  );
}

function Dashboard() {
  const status = useStatus();
  const today = useQuery({
    queryKey: queryKeys.today,
    queryFn: getToday,
  });

  if (status.isError) return <ErrorPanel title="Could not load status" error={status.error} />;
  if (status.isLoading || !status.data) return <Loading label="Loading mailbox" />;

  const statusData = status.data;
  const counts = statusData.counts;
  const topToday = today.data?.messages.slice(0, 4) || [];

  return (
    <div className="page-grid">
      <section className="page-heading">
        <h1>Today</h1>
        <p>The small set worth looking at first.</p>
      </section>
      <section className="stats-grid" aria-label="Mailbox summary" data-testid="mailbox-summary">
        <Stat icon={Mail} label="Synced" value={counts.messages} testId="stat-synced" />
        <Stat icon={CheckCircle2} label="Today" value={counts.today} testId="stat-today" />
        <Stat icon={MessageSquare} label="Need reply" value={counts.needsReply} testId="stat-needs-reply" />
        <Stat icon={ShieldAlert} label="Junk review" value={counts.junkReview} testId="stat-junk-review" />
      </section>
      {!statusData.account && <ConnectPanel missing={statusData.configMissing} />}
      <section className="surface">
        <div className="section-header">
          <div>
            <h2>First pass</h2>
            <p>{topToday.length ? "Ranked by current heuristics." : "Nothing is demanding attention yet."}</p>
          </div>
          <Link to="/today" className="button">
            <CheckCircle2 size={17} />
            Open Today
          </Link>
        </div>
        <MessageStack messages={topToday} empty="Seed demo mail or connect Gmail to see messages." />
      </section>
    </div>
  );
}

function ConnectPanel({ missing }: { missing: string[] }) {
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
      <a className="button primary" href="/api/connect/gmail">
        <Mail size={17} />
        Connect
      </a>
    </section>
  );
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
      virtual
    />
  );
}

function MessageListPage({
  title,
  subtitle,
  messages,
  empty,
  virtual = false,
}: {
  title: string;
  subtitle: string;
  messages: MailMessage[];
  empty: string;
  virtual?: boolean;
}) {
  return (
    <div className="page-grid">
      <section className="page-heading">
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </section>
      <section className="surface flush">
        {virtual ? <VirtualMessageList messages={messages} empty={empty} /> : <MessageStack messages={messages} empty={empty} />}
      </section>
    </div>
  );
}

function VirtualMessageList({ messages, empty }: { messages: MailMessage[]; empty: string }) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 92,
    overscan: 8,
  });

  if (!messages.length) return <EmptyState text={empty} />;

  return (
    <div ref={parentRef} className="virtual-list">
      <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
        {rowVirtualizer.getVirtualItems().map((virtualItem) => {
          const message = messages[virtualItem.index];
          return (
            <div
              key={message.id}
              className="virtual-row"
              style={{
                height: `${virtualItem.size}px`,
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <MessageRow message={message} />
            </div>
          );
        })}
      </div>
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
        <span className={classForCategory(message.sane.category)}>{message.sane.category}</span>
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
    ["needs-reply", "Needs reply", MessageSquare],
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
          <span className={classForCategory(message.sane.category)}>{message.sane.category}</span>
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

function AiOpsRoute() {
  const query = useQuery({
    queryKey: queryKeys.aiControl,
    queryFn: getAiControl,
  });
  const runMutation = useMutation({
    mutationFn: runAiLoop,
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

  if (query.isError) return <ErrorPanel title="Could not load AI Ops" error={query.error} />;
  if (query.isLoading || !query.data) return <Loading label="Loading AI Ops" />;

  const latestRun = runMutation.data?.run || query.data.latestRun;
  const latestVerification = verifyMutation.data?.run || query.data.latestVerification;

  return (
    <div className="page-grid">
      <section className="page-heading">
        <h1>AI Ops</h1>
        <p>Prompt control, run traces, and local evals for the curation loop.</p>
      </section>
      <section className="surface">
        <div className="section-header">
          <div>
            <h2>Control loop</h2>
            <p>Runs against the local mailbox with deterministic synthetic model output.</p>
          </div>
          <div className="toolbar">
            <button
              className="button primary"
              onClick={() => runMutation.mutate()}
              disabled={runMutation.isPending}
              data-testid="ai-run-loop"
            >
              {runMutation.isPending ? <Loader2 className="spin" size={17} /> : <BrainCircuit size={17} />}
              Run loop
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
        <div className="ops-grid">
          <AiRunSummary run={latestRun} />
          <VerificationSummary run={latestVerification} />
        </div>
      </section>
      <section className="surface">
        <div className="section-header">
          <div>
            <h2>Active prompts</h2>
            <p>{query.data.prompts.length} versioned prompts are pinned for this loop.</p>
          </div>
        </div>
        <div className="prompt-stack">
          {query.data.prompts.map((prompt) => (
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

  return (
    <div className="ops-panel" data-testid="ai-latest-run-status">
      <Activity size={18} />
      <strong>{run.status}</strong>
      <span>{run.metrics.messagesProcessed} messages · {run.metrics.latencyMs}ms</span>
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

function SettingsRoute() {
  const status = useStatus();
  const syncMutation = useMutation({
    mutationFn: syncGmail,
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
  const params = new URLSearchParams(window.location.search);
  const oauthError = params.get("error");
  const connected = params.get("connected");

  if (status.isError) return <ErrorPanel title="Could not load settings" error={status.error} />;
  if (status.isLoading || !status.data) return <Loading label="Loading settings" />;
  const statusData = status.data;

  return (
    <div className="page-grid">
      <section className="page-heading">
        <h1>Settings</h1>
        <p>Local app state and read-only Gmail connection.</p>
      </section>
      {oauthError && (
        <section className="callout danger-callout">
          <AlertTriangle size={20} />
          <div>
            <h2>OAuth did not complete</h2>
            <p>{oauthError === "invalid_oauth_callback" ? "Start from Connect Gmail instead of opening the callback route directly." : oauthError}</p>
          </div>
        </section>
      )}
      {connected && (
        <section className="callout success-callout">
          <CheckCircle2 size={20} />
          <div>
            <h2>Connected</h2>
            <p>{connected}</p>
          </div>
        </section>
      )}
      <section className="surface settings-surface">
        <div>
          <h2>Gmail</h2>
          <p className="muted">{statusData.account?.email || "No Gmail account connected."}</p>
          <p><span className="pill">read-only</span> {statusData.gmailReadonly}</p>
        </div>
        <div className="settings-actions">
          <a className="button primary" href="/api/connect/gmail" data-testid="settings-connect-gmail">
            <Mail size={17} />
            Connect Gmail
          </a>
          <button className="button" onClick={() => syncMutation.mutate()} disabled={!statusData.account || statusData.account.demo || syncMutation.isPending}>
            {syncMutation.isPending ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
            Sync
          </button>
          <button
            className="button"
            onClick={() => demoResetMutation.mutate()}
            disabled={demoResetMutation.isPending}
            data-testid="settings-reset-demo"
          >
            {demoResetMutation.isPending ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
            Reset demo data
          </button>
          <button className="button danger-button" onClick={() => disconnectMutation.mutate()} disabled={disconnectMutation.isPending}>
            <Trash2 size={17} />
            Delete local data
          </button>
        </div>
      </section>
      <section className="surface">
        <h2>Local counts</h2>
        <div className="stats-grid compact">
          <Stat icon={Mail} label="Synced" value={statusData.counts.messages} testId="settings-stat-synced" />
          <Stat icon={CheckCircle2} label="Today" value={statusData.counts.today} />
          <Stat icon={MessageSquare} label="Need reply" value={statusData.counts.needsReply} />
          <Stat icon={ShieldAlert} label="Junk review" value={statusData.counts.junkReview} />
        </div>
      </section>
    </div>
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
