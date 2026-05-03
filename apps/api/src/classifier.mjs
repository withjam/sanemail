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

export function classifyMessage(message, account) {
  const headers = message.headers || {};
  const text = `${message.subject || ""}\n${message.snippet || ""}\n${message.bodyText || ""}`;
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
    includesAny(text, junkPatterns) ||
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

export function getClassifiedMessages(store, account) {
  return store.messages
    .filter((message) => !account || message.accountId === account.id)
    .map((message) => ({
      ...message,
      sane: classifyMessage(message, account || {}),
      feedback: store.feedback.filter((entry) => entry.messageId === message.id),
    }));
}
