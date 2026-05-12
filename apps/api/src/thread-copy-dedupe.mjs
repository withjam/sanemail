import { stripQuotedEmailTail } from "./email-quote-strip.mjs";

const MIN_DEDUPE_BLOCK = 64;
const MIN_DEDUPE_LINE = 56;
const MIN_PRIOR_CORPUS = 48;

function deliveredAtMsForSort(message) {
  const time = new Date(message?.date || Number(message?.internalDate) || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

/** Strict ordering so ties break on provider id (stable thread order). */
export function isStrictlyEarlierInThread(a, b) {
  const da = deliveredAtMsForSort(a);
  const db = deliveredAtMsForSort(b);
  if (da !== db) return da < db;
  return String(a?.providerMessageId || a?.id || "") < String(b?.providerMessageId || b?.id || "");
}

/**
 * @param {object} currentMessage
 * @param {object[]} threadCorpusMessages — typically all messages for the account (incl. sent).
 * @returns {object[]}
 */
export function earlierThreadMessagesInCorpus(currentMessage, threadCorpusMessages = []) {
  const tid = String(currentMessage?.providerThreadId || "").trim();
  if (!tid || !threadCorpusMessages.length) return [];
  return threadCorpusMessages.filter(
    (candidate) =>
      candidate &&
      candidate.id !== currentMessage.id &&
      String(candidate.providerThreadId || "").trim() === tid &&
      isStrictlyEarlierInThread(candidate, currentMessage),
  );
}

function normalizeWs(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Drop paragraphs (and long lines inside mixed blocks) that appear verbatim in earlier
 * thread bodies after whitespace normalization — typical copy/paste of prior replies.
 *
 * @param {string} currentBody — already quote-tail-stripped when possible
 * @param {object[]} earlierMessages — strictly earlier-in-thread messages
 * @returns {string}
 */
export function stripCopyPastedFromEarlierThreadBodies(currentBody, earlierMessages = []) {
  let body = String(currentBody || "").replace(/\r\n/g, "\n");
  if (!body.trim() || !earlierMessages.length) return body.trimEnd();

  const priorPieces = [];
  for (const message of earlierMessages) {
    const piece = stripQuotedEmailTail(message.bodyText || "");
    if (piece) priorPieces.push(piece);
  }
  const priorNorm = normalizeWs(priorPieces.join("\n\n"));
  if (priorNorm.length < MIN_PRIOR_CORPUS) return body.trimEnd();

  const paragraphs = body.split(/\n{2,}/);
  const kept = [];
  for (const paragraph of paragraphs) {
    const raw = paragraph.trim();
    if (!raw.length) continue;
    if (raw.length < MIN_DEDUPE_BLOCK) {
      kept.push(raw);
      continue;
    }
    const normalized = normalizeWs(raw);
    if (normalized.length >= MIN_PRIOR_CORPUS && priorNorm.includes(normalized)) {
      continue;
    }
    if (raw.length >= 180 && raw.includes("\n")) {
      const lineKept = [];
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (t.length >= MIN_DEDUPE_LINE && priorNorm.includes(normalizeWs(t))) continue;
        lineKept.push(line);
      }
      const rebuilt = lineKept.join("\n").trim();
      if (rebuilt.length) kept.push(rebuilt);
      continue;
    }
    if (raw.length >= 320 && !raw.includes("\n")) {
      const rebuilt = dedupeSentencesFromPrior(raw, priorNorm);
      if (rebuilt.length) kept.push(rebuilt);
      continue;
    }
    kept.push(raw);
  }
  return kept.join("\n\n").trimEnd();
}

const MIN_SENTENCE_STRIP = 36;

function dedupeSentencesFromPrior(block, priorNorm) {
  const pieces = block.split(/(?<=[.!?])\s+/);
  const out = [];
  for (const piece of pieces) {
    const p = piece.trim();
    if (p.length >= MIN_SENTENCE_STRIP && priorNorm.includes(normalizeWs(p))) continue;
    out.push(piece);
  }
  return out.join(" ").trim();
}

/**
 * Body text used for triage / extraction / deterministic rank: trailing quotes removed,
 * then blocks that duplicate earlier messages in the same thread are removed.
 *
 * @param {object} message
 * @param {object[]} threadCorpusMessages
 * @returns {string}
 */
export function effectiveClassificationBodyText(message, threadCorpusMessages = []) {
  const stripped = stripQuotedEmailTail(message?.bodyText || "");
  const earlier = earlierThreadMessagesInCorpus(message, threadCorpusMessages);
  if (!earlier.length) return stripped;
  return stripCopyPastedFromEarlierThreadBodies(stripped, earlier);
}
