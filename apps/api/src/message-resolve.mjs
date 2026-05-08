import { getClassifiedMessages } from "./classifier.mjs";

/**
 * Resolve a briefing reference to a message the user owns. Accepts canonical id,
 * provider message id (e.g. Gmail id), or the suffix after the last ":" in our id scheme.
 */
export function findMessageForUserRef(store, ref) {
  const raw = String(ref || "").trim();
  if (!raw) return null;

  const accountIds = new Set(
    (store.accounts || []).map((a) => a?.id).filter(Boolean),
  );
  const messages = (store.messages || []).filter((m) => accountIds.has(m.accountId));

  let match = messages.find((m) => m.id === raw);
  if (match) return match;

  match = messages.find((m) => (m.providerMessageId || "") === raw);
  if (match) return match;

  match = messages.find((m) => m.id.endsWith(`:${raw}`));
  if (match) return match;

  const withMessageSegment = `:message:${raw}`;
  match = messages.find((m) => m.id.endsWith(withMessageSegment));
  if (match) return match;

  return null;
}

export function messagePreviewForStore(store, message) {
  const account = (store.accounts || []).find((a) => a.id === message.accountId);
  if (!account) return null;

  const classified = getClassifiedMessages(store, account).find((m) => m.id === message.id);
  const sane = classified?.sane;

  return {
    id: message.id,
    subject: message.subject || "(no subject)",
    from: message.from || "",
    date: message.date || null,
    snippet: message.snippet || "",
    category: sane?.category ?? null,
    needsReply: typeof sane?.needsReply === "boolean" ? sane.needsReply : null,
  };
}
