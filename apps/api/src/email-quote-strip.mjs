/**
 * Remove trailing quoted / forwarded thread content from plain-text email bodies
 * so triage and extraction focus on the latest authored segment.
 */

/** Gmail/Apple often use narrow NBSP (U+202F) between time and AM/PM — normalize for matchers. */
function normalizeMailWhitespace(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[\u00a0\u202f\u2007\u2009\u200a\ufeff]/g, " ");
}

const QUOTE_STARTERS = [
  // "On … wrote:" may word-wrap across lines; keep non-greedy to first wrote: boundary.
  /\nOn\s[\s\S]{12,4000}?\bwrote:\s*\n/i,
  /\nOn .+\bwrote:\s*\n/i,
  /\nLe .+\ba écrit\s*:\s*\n/i,
  /\nAm .+\bschrieb.+\s*:\s*\n/i,
  /\nFrom:\s*.+\nSent:\s*.+\nTo:/i,
  /\nFrom:\s*.+\nDate:\s*.+\nTo:/i,
  /\n-{3,}\s*Original Message\s*-{3,}\s*\n/i,
  /\n________________________________\nFrom:/i,
  /\nBegin forwarded message:\s*\n/i,
];

/**
 * @param {string} text
 * @returns {string}
 */
export function stripQuotedEmailTail(text) {
  const body = normalizeMailWhitespace(text);
  if (!body) return body;
  let cut = body.length;
  for (const re of QUOTE_STARTERS) {
    const m = re.exec(body);
    if (m && typeof m.index === "number" && m.index >= 0 && m.index < cut) {
      cut = m.index;
    }
  }
  // Lines starting with ">" (including blank ">" spacer lines in nested Gmail quotes)
  const gtBlock = /\n(?:>[ \t]?[^\n]*\n)+/;
  const gm = gtBlock.exec(body);
  if (gm && gm.index >= 20 && gm.index < cut) {
    cut = gm.index;
  }
  return body.slice(0, cut).trimEnd();
}
