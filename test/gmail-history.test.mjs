import assert from "node:assert/strict";
import test from "node:test";
import { GmailHistoryExpiredError, maxHistoryIdFromMessages } from "../apps/api/src/gmail.mjs";

test("maxHistoryIdFromMessages picks the largest Gmail history id", () => {
  assert.equal(
    maxHistoryIdFromMessages([
      { historyId: "100" },
      { historyId: "99" },
      { historyId: "200" },
      {},
    ]),
    "200",
  );
  assert.equal(maxHistoryIdFromMessages([]), null);
});

test("GmailHistoryExpiredError is identifiable", () => {
  const err = new GmailHistoryExpiredError();
  assert.ok(err instanceof GmailHistoryExpiredError);
  assert.match(err.message, /full sync/i);
});
