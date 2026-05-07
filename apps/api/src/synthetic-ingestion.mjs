import crypto from "node:crypto";
import {
  getPrimarySourceConnection,
  upsertAccount,
  upsertSyncedMessages,
} from "./store.mjs";

function syntheticAccountFor(userId) {
  return {
    id: `mock:ingestion:${userId}`,
    userId,
    provider: "mock",
    email: "ingestion@example.com",
    scope: "mock.ingestion",
    historyId: "synthetic-ingestion",
    demo: true,
  };
}

const people = [
  ["Maya Chen", "maya"],
  ["Jordan Rivera", "jordan"],
  ["Nina Patel", "nina"],
  ["Sam Wilson", "sam"],
  ["Elena Rossi", "elena"],
  ["Marcus Brown", "marcus"],
  ["Leah Kim", "leah"],
  ["Owen Miller", "owen"],
];

const actionScenarios = [
  ["contractor estimate", "review the contractor estimate", "by tomorrow morning"],
  ["school volunteer roster", "let me know which shift works", "by Thursday"],
  ["travel document checklist", "review the checklist", "today"],
  ["dinner reservation choice", "confirm which reservation you prefer", "tomorrow evening"],
  ["tax organizer packet", "review the uncertain sections", "by Friday"],
  ["home insurance comparison", "look over the coverage notes", "by Monday"],
];

const updateScenarios = [
  ["Northstar Electric Billing <billing@northstar-electric.example>", "Electric bill due Monday", "Your electric bill is due Monday.", "Autopay is not enabled for this account."],
  ["ParcelPost <notifications@parcelpost.example>", "Package out for delivery", "Your package is out for delivery today.", "Tracking shows delivery between 1 PM and 5 PM."],
  ["City Library <notices@citylibrary.example>", "Library hold expires tomorrow", "Your library hold expires tomorrow.", "Pick it up before closing or it will move to the next reader."],
  ["Skyline Air Notifications <notifications@skyline.example>", "Boarding pass ready", "Your boarding pass is ready.", "Save it before you leave for the airport."],
];

const newsletterScenarios = [
  ["The Morning Brief <newsletter@morningbrief.example>", "The Morning Brief: housing and transit", "Today's local briefing covers housing, transit, and a new coffee shop.", "Read the full issue online when you have time."],
  ["Weeknight Table <newsletter@weeknighttable.example>", "Recipe newsletter: pantry dinners", "Five pantry dinner ideas are included this week.", "The lentil recipe is the reader favorite."],
  ["DevTools Weekly <newsletter@devtools.example>", "Developer tool release notes", "New CLI flags and editor plugins are highlighted this week.", "Examples are included in the release notes."],
];

const securityScenarios = [
  ["Security Alert <security-alert@example-login.test>", "Verify your account immediately", "Urgent action required. Verify your account immediately.", "Your password expires today. Follow the secure link to avoid account closure."],
  ["Refund Department <refunds@unclaimed-cash.example>", "Unclaimed refund notice", "An unclaimed refund is waiting for confirmation.", "Send your account details to release payment."],
];

function pick(items) {
  return items[crypto.randomInt(items.length)];
}

function safeLocalPart(value) {
  return String(value || "sender").toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "");
}

function listUnsubscribe(domain, id) {
  return `<mailto:unsubscribe+${id}@${domain}>`;
}

function actionMessageDraft() {
  const [name, handle] = pick(people);
  const [topic, action, deadline] = pick(actionScenarios);
  const subject = `Can you ${action.split(" ").slice(0, 3).join(" ")}?`;
  const snippet = `Could you ${action} and let me know your thoughts ${deadline}?`;
  return {
    labels: ["INBOX", "UNREAD"],
    from: `${name} <${handle}@example.com>`,
    subject: subject.charAt(0).toUpperCase() + subject.slice(1),
    snippet,
    bodyText: `${snippet} I am trying to keep the ${topic} moving before it gets stale.`,
  };
}

function updateMessageDraft() {
  const [from, subject, snippet, bodyText] = pick(updateScenarios);
  return {
    labels: ["CATEGORY_UPDATES"],
    from,
    subject,
    snippet,
    bodyText,
    listUnsubscribe: listUnsubscribe("updates.example", safeLocalPart(subject)),
  };
}

function newsletterMessageDraft() {
  const [from, subject, snippet, bodyText] = pick(newsletterScenarios);
  return {
    labels: ["CATEGORY_PROMOTIONS"],
    from,
    subject,
    snippet,
    bodyText,
    listUnsubscribe: listUnsubscribe("lists.example", safeLocalPart(subject)),
  };
}

function securityMessageDraft() {
  const [from, subject, snippet, bodyText] = pick(securityScenarios);
  return {
    labels: ["INBOX"],
    from,
    subject,
    snippet,
    bodyText,
  };
}

const draftBuilders = [
  actionMessageDraft,
  actionMessageDraft,
  updateMessageDraft,
  updateMessageDraft,
  newsletterMessageDraft,
  securityMessageDraft,
];

async function accountForSyntheticIngestion(userId) {
  if (!userId) throw new Error("accountForSyntheticIngestion requires a userId");
  const existing = await getPrimarySourceConnection(userId);
  if (existing?.id && existing?.email) return existing;
  return upsertAccount(syntheticAccountFor(userId));
}

function buildSyntheticMessages(account, count, batchId, baseTime = Date.now()) {
  return Array.from({ length: count }, (_item, index) => {
    const draft = pick(draftBuilders)();
    const providerMessageId = `synth-${batchId}-${index + 1}-${crypto.randomUUID().slice(0, 8)}`;
    const providerThreadId = `thread-${providerMessageId}`;
    const offsetMs = (index * 3 + crypto.randomInt(0, 3)) * 60 * 1000;
    const deliveredAt = new Date(baseTime - offsetMs).toISOString();

    return {
      id: `${account.id}:message:${providerMessageId}`,
      accountId: account.id,
      provider: account.provider || "mock",
      providerMessageId,
      providerThreadId,
      sourceLabels: draft.labels,
      subject: draft.subject,
      from: draft.from,
      to: account.email,
      cc: "",
      date: deliveredAt,
      internalDate: String(baseTime - offsetMs),
      snippet: draft.snippet,
      bodyText: draft.bodyText,
      headers: {
        from: draft.from,
        to: account.email,
        cc: "",
        subject: draft.subject,
        date: new Date(baseTime - offsetMs).toUTCString(),
        "message-id": `<${providerMessageId}@synthetic.sanemail.local>`,
        "list-unsubscribe": draft.listUnsubscribe || "",
      },
      syncedAt: new Date(baseTime).toISOString(),
    };
  });
}

function summarizeBatch(messages) {
  const delivered = messages
    .map((message) => new Date(message.date || 0).getTime())
    .filter(Number.isFinite);
  const newest = delivered.length ? new Date(Math.max(...delivered)).toISOString() : null;
  const oldest = delivered.length ? new Date(Math.min(...delivered)).toISOString() : null;

  return {
    messageIds: messages.map((message) => message.id),
    subjects: messages.map((message) => message.subject),
    newestReceivedAt: newest,
    oldestReceivedAt: oldest,
  };
}

export async function synthesizeIngestionBatch({ userId, count } = {}) {
  if (!userId) throw new Error("synthesizeIngestionBatch requires a userId");
  const totalStarted = Date.now();
  const requested = Number(count);
  const messageCount = Number.isFinite(requested) && requested >= 3 && requested <= 6
    ? Math.floor(requested)
    : crypto.randomInt(3, 7);
  const batchId = crypto.randomUUID().slice(0, 12);
  const account = await accountForSyntheticIngestion(userId);

  const synthStarted = Date.now();
  const messages = buildSyntheticMessages(account, messageCount, batchId);
  const synthesisLatencyMs = Date.now() - synthStarted;

  const ingestStarted = Date.now();
  const result = await upsertSyncedMessages(account, messages);
  const ingestLatencyMs = Date.now() - ingestStarted;
  const summary = summarizeBatch(messages);

  return {
    account,
    result,
    batch: {
      id: `synthetic_batch_${batchId}`,
      source: "synthetic-ingestion-emulator",
      generator: "template",
      count: messages.length,
      ...summary,
      createdAt: new Date().toISOString(),
    },
    analytics: {
      messagesSynthesized: messages.length,
      inserted: result.inserted,
      updated: result.updated,
      synthesisLatencyMs,
      ingestLatencyMs,
      totalLatencyMs: Date.now() - totalStarted,
      classificationSkipped: true,
      briefingSkipped: true,
    },
  };
}
