import assert from "node:assert/strict";
import test from "node:test";
import { findMessageForUserRef } from "../apps/api/src/message-resolve.mjs";

const account = { id: "gmail:user@example.com", email: "user@example.com", provider: "gmail" };

test("findMessageForUserRef resolves canonical id", () => {
  const store = {
    accounts: [account],
    messages: [
      {
        id: "gmail:user@example.com:message:abc123",
        accountId: account.id,
        providerMessageId: "abc123",
        subject: "Hi",
      },
    ],
  };
  const m = findMessageForUserRef(store, "gmail:user@example.com:message:abc123");
  assert.equal(m?.id, "gmail:user@example.com:message:abc123");
});

test("findMessageForUserRef resolves provider message id", () => {
  const store = {
    accounts: [account],
    messages: [
      {
        id: "gmail:user@example.com:message:abc123",
        accountId: account.id,
        providerMessageId: "abc123",
        subject: "Hi",
      },
    ],
  };
  const m = findMessageForUserRef(store, "abc123");
  assert.equal(m?.providerMessageId, "abc123");
});

test("findMessageForUserRef ignores other users messages", () => {
  const store = {
    accounts: [account],
    messages: [
      {
        id: "gmail:other@example.com:message:secret",
        accountId: "gmail:other@example.com",
        providerMessageId: "secret",
        subject: "Nope",
      },
    ],
  };
  assert.equal(findMessageForUserRef(store, "secret"), null);
});
