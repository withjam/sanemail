import test from "node:test";
import assert from "node:assert/strict";
import { stripQuotedEmailTail } from "../apps/api/src/email-quote-strip.mjs";

test("stripQuotedEmailTail removes Gmail-style On … wrote block", () => {
  const body = `Sounds good — see you then.\n\nOn Mon, Jan 1, 2024 at 9:00 AM Bob <bob@example.com> wrote:\n> Can you confirm?\n> Thanks`;
  assert.equal(stripQuotedEmailTail(body), "Sounds good — see you then.");
});

test("stripQuotedEmailTail removes Original Message separator", () => {
  const body = `Thanks.\n\n-----Original Message-----\nFrom: someone`;
  assert.equal(stripQuotedEmailTail(body), "Thanks.");
});

test("stripQuotedEmailTail leaves short bodies unchanged", () => {
  assert.equal(stripQuotedEmailTail("Quick question?"), "Quick question?");
});

test("stripQuotedEmailTail handles Gmail On … wrote with narrow NBSP before AM", () => {
  const prep = "Hi Matt,\n\nHere is the template link.\n\nAnd some more notes on the AI-assisted coding round.";
  const nbspTime = "On Thu, May 7, 2026 at 10:01\u202fAM Matt Pileggi <matt@gmail.com> wrote:\n\n>";
  const body = `${prep}\n\n${nbspTime}\n> Hi Darya,\n>\n> Thanks,\n> Matt\n`;
  assert.equal(stripQuotedEmailTail(body), prep);
});

test("stripQuotedEmailTail handles word-wrapped On … wrote header", () => {
  const top = "Prep content here.\n\nFollow the instructions below.";
  const wrapped = `On Thu, May 7, 2026 at 10:01\nAM Matt Pileggi <matt@gmail.com> wrote:\n\n> quoted`;
  assert.equal(stripQuotedEmailTail(`${top}\n\n${wrapped}`), top);
});

test("stripQuotedEmailTail cuts at first standalone quoted-line block when no On header", () => {
  const top = "New note only.\n\nSee below.";
  const body = `${top}\n\n>\n>\n> older thread line one\n> older thread line two\n`;
  assert.equal(stripQuotedEmailTail(body), top);
});
