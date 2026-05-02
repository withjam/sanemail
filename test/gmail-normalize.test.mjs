import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGmailMessage } from "../apps/api/src/gmail.mjs";

function b64url(value) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

test("normalizes Gmail metadata and plain text body", () => {
  const account = { id: "gmail:me@example.com" };
  const normalized = normalizeGmailMessage(account, {
    id: "abc",
    threadId: "thread-abc",
    labelIds: ["INBOX"],
    historyId: "42",
    internalDate: "1700000000000",
    snippet: "Could you review this?",
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "Subject", value: "Can you review this?" },
        { name: "From", value: "Alex <alex@example.com>" },
        { name: "To", value: "Me <me@example.com>" },
        { name: "Date", value: "Tue, 14 Nov 2023 22:13:20 GMT" },
        { name: "Message-ID", value: "<abc@example.com>" },
      ],
      parts: [
        {
          mimeType: "text/plain",
          body: { data: b64url("Could you review this?\nThanks.") },
        },
      ],
    },
  });

  assert.equal(normalized.id, "gmail:me@example.com:message:abc");
  assert.equal(normalized.providerThreadId, "thread-abc");
  assert.equal(normalized.subject, "Can you review this?");
  assert.equal(normalized.bodyText, "Could you review this?\nThanks.");
  assert.deepEqual(normalized.sourceLabels, ["INBOX"]);
});

test("falls back to stripped HTML body", () => {
  const account = { id: "gmail:me@example.com" };
  const normalized = normalizeGmailMessage(account, {
    id: "html",
    threadId: "thread-html",
    labelIds: [],
    internalDate: "1700000000000",
    snippet: "",
    payload: {
      mimeType: "text/html",
      headers: [{ name: "Subject", value: "HTML mail" }],
      body: { data: b64url("<p>Hello&nbsp;<strong>there</strong></p>") },
    },
  });

  assert.equal(normalized.bodyText, "Hello there");
});
