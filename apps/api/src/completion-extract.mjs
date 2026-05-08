/**
 * Deterministic extraction of "completion" signals from message text (things that
 * already happened). `occurredAt` defaults to the message delivery time when the
 * email does not specify a clearer timestamp.
 */

function normalizeOccurredAt(iso) {
  const t = new Date(iso || 0).getTime();
  if (!Number.isFinite(t)) return new Date().toISOString();
  return new Date(t).toISOString();
}

const completionPatterns = [
  { re: /\bcheck\s+(has\s+)?cleared\b/i, phrase: "Check cleared" },
  { re: /\bpayment\s+(was\s+)?posted\b/i, phrase: "Payment posted" },
  { re: /\bpayment\s+received\b/i, phrase: "Payment received" },
  { re: /\b(refund|return)\s+processed\b/i, phrase: "Refund processed" },
  { re: /\bpackage\s+(was\s+)?delivered\b/i, phrase: "Package delivered" },
  { re: /\bflight\s+(has\s+)?landed\b/i, phrase: "Flight landed" },
  { re: /\bservice\s+(was\s+)?cancel(?:led|ed)\b/i, phrase: "Service cancelled" },
  { re: /\bsubscription\s+(was\s+)?cancel(?:led|ed)\b/i, phrase: "Subscription cancelled" },
  { re: /\border\s+(has\s+been\s+)?shipped\b/i, phrase: "Order shipped" },
  { re: /\btransaction\s+complete\b/i, phrase: "Transaction complete" },
  { re: /\bno\s+action\s+(is\s+)?needed\b/i, phrase: "No action needed" },
  { re: /\bthanks\s+for\s+your\s+order\b/i, phrase: "Order confirmation" },
  { re: /\bappointment\s+(was\s+)?cancel(?:led|ed)\b/i, phrase: "Appointment cancelled" },
];

export function extractCompletionEvents(text, deliveredAtIso) {
  const occurredAt = normalizeOccurredAt(deliveredAtIso);
  const haystack = String(text || "");
  if (!haystack.trim()) return [];

  const seen = new Set();
  const out = [];
  for (const { re, phrase } of completionPatterns) {
    if (!re.test(haystack)) continue;
    if (seen.has(phrase)) continue;
    seen.add(phrase);
    out.push({ phrase, occurredAt });
  }
  return out;
}
