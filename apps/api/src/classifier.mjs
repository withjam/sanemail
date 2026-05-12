import { stripQuotedEmailTail } from "./email-quote-strip.mjs";
import { effectiveClassificationBodyText } from "./thread-copy-dedupe.mjs";

const automatedPatterns = [
  "no-reply",
  "noreply",
  "donotreply",
  "notification",
  "notifications",
  "newsletter",
  "updates",
  "support@",
  "billing@",
  "receipts@",
];

const actionPatterns = [
  "can you",
  "could you",
  "please",
  "need you",
  "let me know",
  "thoughts",
  "approve",
  "review",
  "sign",
  "confirm",
  "available",
];

const junkPatterns = [
  "urgent action required",
  "verify your account",
  "limited time",
  "congratulations",
  "winner",
  "gift card",
  "crypto",
  "password expires",
];

const addressedFeedbackKinds = new Set(["done", "not-important", "junk"]);

function extractLowercasedEmails(value) {
  return [...String(value || "").toLowerCase().matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)].map(
    (match) => match[0],
  );
}

export function headerMailboxEmailMatches(header, mailboxEmail) {
  const mailbox = String(mailboxEmail || "").toLowerCase().trim();
  if (!mailbox) return false;
  return extractLowercasedEmails(header).includes(mailbox);
}

/** Deterministic: Gmail SENT label and/or From matches the connected mailbox. */
export function computeSentByMailboxFlag({
  sourceLabels = [],
  fromHeader = "",
  mailboxEmail = "",
} = {}) {
  const labels = sourceLabels || [];
  if (labels.includes("SENT")) return true;
  return headerMailboxEmailMatches(fromHeader, mailboxEmail);
}

export function isSentByMailbox(message, account) {
  if (message?.sentByMailbox === true) return true;
  if (message?.sentByMailbox === false) return false;
  return computeSentByMailboxFlag({
    sourceLabels: message?.sourceLabels,
    fromHeader: message?.from || message?.headers?.from,
    mailboxEmail: account?.email,
  });
}

function includesAny(value, patterns) {
  const lower = String(value || "").toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern));
}

function recipientContains(headers, email) {
  const to = String(headers.to || "").toLowerCase();
  const cc = String(headers.cc || "").toLowerCase();
  const normalized = String(email || "").toLowerCase();
  return normalized && (to.includes(normalized) || cc.includes(normalized));
}

function latestFeedbackKind(feedback = []) {
  return [...feedback].sort(
    (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime(),
  )[0]?.kind || null;
}

function recategorize(classification) {
  if (classification.possibleJunk) return "Junk Review";
  if (classification.needsReply) return "Needs Reply";
  if (classification.automated) return "FYI";
  return classification.todayScore >= 35 ? "Today" : "All Mail";
}

export function applyFeedbackToClassification(classification, feedback = []) {
  const latestKind = latestFeedbackKind(feedback);
  if (!latestKind) {
    return {
      ...classification,
      feedbackState: {
        latestKind: null,
        addressed: false,
      },
    };
  }

  const next = {
    ...classification,
    reasons: [...classification.reasons],
    feedbackState: {
      latestKind,
      addressed: addressedFeedbackKinds.has(latestKind),
    },
  };
  const forceAllMail = latestKind === "done" || latestKind === "not-important";

  if (latestKind === "junk") {
    next.possibleJunk = true;
    next.needsReply = false;
    next.todayScore -= 70;
    next.reasons.push("marked as junk");
  } else if (latestKind === "not-junk") {
    next.possibleJunk = false;
    next.todayScore += 10;
    next.reasons.push("marked as not junk");
  } else if (latestKind === "done") {
    next.needsReply = false;
    next.todayScore -= 55;
    next.reasons.push("marked done");
  } else if (latestKind === "not-important") {
    next.needsReply = false;
    next.todayScore -= 35;
    next.reasons.push("marked not important");
  } else if (latestKind === "needs-reply") {
    next.needsReply = true;
    next.todayScore += 35;
    next.reasons.push("marked as needing attention");
  } else if (latestKind === "important") {
    next.todayScore += 20;
    next.reasons.push("marked important");
  }

  next.todayScore = Math.round(next.todayScore);
  next.category = forceAllMail && !next.possibleJunk ? "All Mail" : recategorize(next);
  return next;
}

export function classifyMessage(message, account) {
  const headers = message.headers || {};
  const bodyForSignals = stripQuotedEmailTail(message.bodyText || "");
  const text = `${message.subject || ""}\n${message.snippet || ""}\n${bodyForSignals}`;
  const fullText = `${message.subject || ""}\n${message.snippet || ""}\n${message.bodyText || ""}`;
  const labels = message.sourceLabels || [];
  const from = message.from || headers.from || "";
  const direct = recipientContains(headers, account.email);
  const isAutomated =
    includesAny(from, automatedPatterns) ||
    includesAny(headers["list-unsubscribe"], ["http", "mailto"]) ||
    labels.some((label) =>
      ["CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS"].includes(label),
    );
  const possibleJunk =
    labels.includes("SPAM") ||
    includesAny(fullText, junkPatterns) ||
    includesAny(from, ["security-alert", "account-verify"]);
  const asksQuestion = text.includes("?");
  const hasActionLanguage = includesAny(text, actionPatterns);
  const needsReply = !isAutomated && direct && (asksQuestion || hasActionLanguage);

  const messageTime = new Date(message.date || Number(message.internalDate) || 0).getTime();
  const ageHours = Number.isFinite(messageTime)
    ? Math.max(0, (Date.now() - messageTime) / 36e5)
    : 9999;
  const recencyBoost = ageHours <= 24 ? 30 : ageHours <= 72 ? 15 : 0;
  const todayScore =
    recencyBoost +
    (needsReply ? 45 : 0) +
    (direct ? 20 : 0) -
    (isAutomated ? 25 : 0) -
    (possibleJunk ? 50 : 0);

  const category = possibleJunk
    ? "Junk Review"
    : needsReply
      ? "Needs Reply"
      : isAutomated
        ? "FYI"
        : todayScore >= 35
          ? "Today"
          : "All Mail";

  const reasons = [];
  if (direct) reasons.push("sent directly to you");
  if (needsReply) reasons.push("looks like it may need your attention");
  if (isAutomated) reasons.push("looks automated or bulk");
  if (possibleJunk) reasons.push("contains junk or scam-like signals");
  if (recencyBoost) reasons.push("recent message");
  if (!reasons.length) reasons.push("kept in the full mail stream");

  return {
    category,
    todayScore,
    needsReply,
    automated: isAutomated,
    possibleJunk,
    direct,
    reasons,
    classifiedAt: new Date().toISOString(),
  };
}

/**
 * @param {object} store
 * @param {object | null} account — When set, only that source's messages (single-mailbox views/tests).
 *   When null, every message in the store is classified using its own `message.accountId` mailbox.
 */
export function getClassifiedMessages(store, account) {
  const corpus = store.messages || [];
  const messages = account ? corpus.filter((message) => message.accountId === account.id) : corpus;
  const accountsById = new Map((store.accounts || []).filter(Boolean).map((a) => [a.id, a]));

  return messages.map((message) => {
    const mailbox = accountsById.get(message.accountId) || account || {};
    return {
      ...message,
      sane: applyFeedbackToClassification(
        classifyMessage(
          {
            ...message,
            bodyText: effectiveClassificationBodyText(message, corpus),
          },
          mailbox,
        ),
        store.feedback.filter((entry) => entry.messageId === message.id),
      ),
      feedback: store.feedback.filter((entry) => entry.messageId === message.id),
    };
  });
}
