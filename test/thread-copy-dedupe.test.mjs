import test from "node:test";
import assert from "node:assert/strict";
import {
  earlierThreadMessagesInCorpus,
  effectiveClassificationBodyText,
  stripCopyPastedFromEarlierThreadBodies,
} from "../apps/api/src/thread-copy-dedupe.mjs";

const threadId = "thread-copy-1";

test("earlierThreadMessagesInCorpus returns only same-thread strictly earlier messages", () => {
  const m1 = {
    id: "a",
    providerThreadId: threadId,
    date: "2026-01-01T10:00:00.000Z",
    bodyText: "First body",
  };
  const m2 = {
    id: "b",
    providerThreadId: threadId,
    date: "2026-01-01T12:00:00.000Z",
    bodyText: "Second",
  };
  const corpus = [m2, m1];
  const earlier = earlierThreadMessagesInCorpus(m2, corpus);
  assert.equal(earlier.length, 1);
  assert.equal(earlier[0].id, "a");
});

test("stripCopyPastedFromEarlierThreadBodies removes pasted paragraph", () => {
  const prior =
    "We need you to review the attached contract by Friday and let us know if you have questions.";
  const current = `Sounds good, I'll take a look today.\n\n${prior}`;
  const earlier = [{ bodyText: prior, id: "old" }];
  const out = stripCopyPastedFromEarlierThreadBodies(current, earlier);
  assert.match(out, /Sounds good/);
  assert.doesNotMatch(out, /attached contract/);
});

test("effectiveClassificationBodyText uses corpus for same thread", () => {
  const priorText =
    "Please confirm you received this long notice about the policy change effective next month.";
  const m1 = {
    id: "x1",
    providerThreadId: threadId,
    date: "2026-01-02T09:00:00.000Z",
    bodyText: priorText,
  };
  const m2 = {
    id: "x2",
    providerThreadId: threadId,
    date: "2026-01-02T15:00:00.000Z",
    bodyText: `Got it.\n\n${priorText}`,
  };
  const corpus = [m1, m2];
  const eff = effectiveClassificationBodyText(m2, corpus);
  assert.match(eff, /Got it/);
  assert.doesNotMatch(eff, /policy change/);
});
