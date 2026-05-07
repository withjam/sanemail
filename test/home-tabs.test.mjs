import assert from "node:assert/strict";
import test from "node:test";
import { buildDemoMessages } from "../apps/api/src/demo-data.mjs";
import { getClassifiedMessages } from "../apps/api/src/classifier.mjs";
import { buildHomeTabs } from "../apps/api/src/server.mjs";

const account = {
  id: "gmail:demo@example.com",
  provider: "gmail",
  email: "demo@example.com",
  demo: true,
};

function syntheticMessages() {
  const store = {
    messages: buildDemoMessages(account),
    feedback: [],
  };
  return getClassifiedMessages(store, account).sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );
}

test("home tabs expose distinct categorized demo mailbox slices", () => {
  const tabs = buildHomeTabs(syntheticMessages());
  const ids = Object.fromEntries(
    Object.entries(tabs).map(([tab, messages]) => [tab, messages.map((message) => message.id)]),
  );

  assert.equal(tabs.mostRecent.length, 8);
  assert.equal(tabs.needsReply.length, 8);
  assert.equal(tabs.upcoming.length, 8);
  assert.notDeepEqual(ids.mostRecent, ids.needsReply);
  assert.notDeepEqual(ids.mostRecent, ids.upcoming);
  assert.notDeepEqual(ids.needsReply, ids.upcoming);

  assert.equal(tabs.mostRecent.every((message) => !message.sane.needsReply), true);
  assert.equal(tabs.needsReply.every((message) => message.sane.needsReply), true);
  assert.equal(tabs.upcoming.every((message) => !message.sane.needsReply), true);
  assert.equal(tabs.upcoming.every((message) => !message.sane.possibleJunk), true);

  assert.equal(tabs.mostRecent[0].subject, "Your monthly bank statement is ready");
  assert.equal(tabs.needsReply[0].subject, "Can you review the lease renewal today?");
  assert.equal(tabs.upcoming[0].subject, "Flight check-in opens tomorrow");
});
