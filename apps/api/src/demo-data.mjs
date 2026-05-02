import { clearLocalData, upsertAccount, upsertSyncedMessages } from "./store.mjs";

function isoFrom(baseTime, offsetMs) {
  return new Date(baseTime - offsetMs).toISOString();
}

function utcFrom(baseTime, offsetMs) {
  return new Date(baseTime - offsetMs).toUTCString();
}

function demoMessage(account, baseTime, input) {
  const date = isoFrom(baseTime, input.ageMs);
  const internalDate = String(baseTime - input.ageMs);
  return {
    id: `${account.id}:message:${input.id}`,
    accountId: account.id,
    provider: "gmail",
    providerMessageId: input.id,
    providerThreadId: input.threadId,
    sourceLabels: input.labels,
    subject: input.subject,
    from: input.from,
    to: input.to || account.email,
    cc: input.cc || "",
    date,
    internalDate,
    snippet: input.snippet,
    bodyText: input.bodyText,
    headers: {
      from: input.from,
      to: input.to || account.email,
      cc: input.cc || "",
      subject: input.subject,
      date: utcFrom(baseTime, input.ageMs),
      "message-id": `<${input.id}@demo.sanemail.local>`,
      "list-unsubscribe": input.listUnsubscribe || "",
    },
    syncedAt: new Date(baseTime).toISOString(),
  };
}

export function buildDemoMessages(account, baseTime = Date.now()) {
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  const inputs = [
    {
      id: "demo-lease-review",
      threadId: "thread-lease-review",
      labels: ["INBOX", "UNREAD"],
      ageMs: 90 * 60 * 1000,
      subject: "Can you review the lease renewal today?",
      from: "Maya Chen <maya@example.com>",
      snippet: "Could you review the lease renewal and let me know if it looks right?",
      bodyText:
        "Could you review the lease renewal and let me know if it looks right? The deadline is tomorrow afternoon.",
    },
    {
      id: "demo-school-form",
      threadId: "thread-school-form",
      labels: ["INBOX"],
      ageMs: 3 * hour,
      subject: "Please sign the school trip form",
      from: "Jordan Rivera <jordan@example.edu>",
      snippet: "Please sign the school trip form by Friday if you can.",
      bodyText:
        "Please sign the school trip form by Friday if you can. I attached the PDF in the original message.",
    },
    {
      id: "demo-dinner",
      threadId: "thread-dinner",
      labels: ["INBOX"],
      ageMs: 6 * hour,
      subject: "Dinner this weekend?",
      from: "Alex Morgan <alex@example.com>",
      snippet: "Are you available Saturday evening?",
      bodyText: "Are you available Saturday evening? We could do the new Thai place at 7.",
    },
    {
      id: "demo-roadmap",
      threadId: "thread-roadmap",
      labels: ["INBOX"],
      ageMs: 10 * hour,
      subject: "Roadmap notes from this morning",
      from: "Priya Shah <priya@example.com>",
      snippet: "Sharing the roadmap notes so they do not get lost.",
      bodyText:
        "Sharing the roadmap notes so they do not get lost. No action needed today, just wanted you to have the context.",
    },
    {
      id: "demo-flight",
      threadId: "thread-flight",
      labels: ["CATEGORY_UPDATES"],
      ageMs: 12 * hour,
      subject: "Flight check-in opens tomorrow",
      from: "Skyline Air Notifications <notifications@skyline.example>",
      snippet: "Check-in opens tomorrow for your flight to Austin.",
      bodyText:
        "Check-in opens tomorrow for your flight to Austin. Your confirmation code is DEMO42.",
      listUnsubscribe: "<mailto:unsubscribe@skyline.example>",
    },
    {
      id: "demo-bank",
      threadId: "thread-bank",
      labels: ["CATEGORY_UPDATES"],
      ageMs: 18 * hour,
      subject: "Your monthly bank statement is ready",
      from: "Northbank Billing <billing@northbank.example>",
      snippet: "Your monthly statement is now available.",
      bodyText:
        "Your monthly statement is now available in online banking. This is a demo message.",
    },
    {
      id: "demo-package",
      threadId: "thread-package",
      labels: ["CATEGORY_UPDATES"],
      ageMs: 22 * hour,
      subject: "Package delivered",
      from: "Shop Example <receipts@shop.example>",
      snippet: "Your package was delivered at 2:14 PM.",
      bodyText: "Your package was delivered at 2:14 PM. Order DEMO-2026 has arrived.",
    },
    {
      id: "demo-receipt",
      threadId: "thread-receipt",
      labels: ["CATEGORY_UPDATES"],
      ageMs: 28 * hour,
      subject: "Receipt for your grocery order",
      from: "Local Market <receipts@market.example>",
      snippet: "Thanks for your order. Your receipt is inside.",
      bodyText: "Thanks for your order. Your receipt total was $42.19.",
    },
    {
      id: "demo-newsletter",
      threadId: "thread-newsletter",
      labels: ["CATEGORY_PROMOTIONS"],
      ageMs: 2 * day,
      subject: "The Sunday digest",
      from: "The Weekly Note <newsletter@weekly.example>",
      snippet: "A calm collection of links for your Sunday.",
      bodyText: "A calm collection of links for your Sunday. Read when you have time.",
      listUnsubscribe: "<mailto:unsubscribe@weekly.example>",
    },
    {
      id: "demo-sale",
      threadId: "thread-sale",
      labels: ["CATEGORY_PROMOTIONS"],
      ageMs: 5 * hour,
      subject: "Weekend sale: limited time offer",
      from: "Deals <no-reply@shop.example>",
      snippet: "Limited time deals selected for you.",
      bodyText: "Limited time deals selected for you. Save on shoes, shirts, and more.",
      listUnsubscribe: "<mailto:unsubscribe@shop.example>",
    },
    {
      id: "demo-security-scam",
      threadId: "thread-security-scam",
      labels: ["INBOX"],
      ageMs: 40 * 60 * 1000,
      subject: "Verify your account immediately",
      from: "Security Alert <security-alert@example-login.test>",
      snippet: "Urgent action required. Verify your account immediately.",
      bodyText:
        "Urgent action required. Verify your account immediately or your password expires.",
    },
    {
      id: "demo-gift-card",
      threadId: "thread-gift-card",
      labels: ["SPAM"],
      ageMs: 8 * hour,
      subject: "Congratulations, gift card winner",
      from: "Rewards Team <winner@promo-example.test>",
      snippet: "Congratulations, you are a gift card winner.",
      bodyText:
        "Congratulations, you are a gift card winner. Reply with your details to claim now.",
    },
  ];

  return inputs.map((input) => demoMessage(account, baseTime, input));
}

export async function resetDemoData() {
  await clearLocalData();
  const account = await upsertAccount({
    id: "gmail:demo@example.com",
    provider: "gmail",
    email: "demo@example.com",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    historyId: "demo-history",
    demo: true,
  });
  const messages = buildDemoMessages(account);
  const result = await upsertSyncedMessages(account, messages);
  return { account, result };
}
