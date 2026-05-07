import { clearUserData, upsertAccount, upsertSyncedMessages } from "./store.mjs";

export const DEMO_MESSAGE_COUNT = 200;
export const MOCK_SOURCE_ACCOUNT = {
  id: "mock:demo@example.com",
  userId: "mock:demo@example.com",
  provider: "mock",
  email: "demo@example.com",
  scope: "mock.read",
  historyId: "mock-history",
  demo: true,
};

export function mockSourceAccountFor(userId) {
  return {
    id: `mock:demo:${userId}`,
    userId,
    provider: "mock",
    email: "demo@example.com",
    scope: "mock.read",
    historyId: "mock-history",
    demo: true,
  };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function isoFrom(baseTime, offsetMs) {
  return new Date(baseTime - offsetMs).toISOString();
}

function utcFrom(baseTime, offsetMs) {
  return new Date(baseTime - offsetMs).toUTCString();
}

function ageMs({ hours = 0, days = 0, minutes = 0 }) {
  return days * DAY_MS + hours * HOUR_MS + minutes * 60 * 1000;
}

function pad(value) {
  return String(value + 1).padStart(2, "0");
}

function listUnsubscribe(domain, id) {
  return `<mailto:unsubscribe+${id}@${domain}>`;
}

function demoMessage(account, baseTime, input) {
  const date = isoFrom(baseTime, input.ageMs);
  const internalDate = String(baseTime - input.ageMs);
  return {
    id: `${account.id}:message:${input.id}`,
    accountId: account.id,
    provider: account.provider || "mock",
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

function baseDemoInputs() {
  return [
    {
      id: "demo-lease-review",
      threadId: "thread-lease-review",
      labels: ["INBOX", "UNREAD"],
      ageMs: ageMs({ hours: 1, minutes: 30 }),
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
      ageMs: ageMs({ hours: 3 }),
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
      ageMs: ageMs({ hours: 6 }),
      subject: "Dinner this weekend?",
      from: "Alex Morgan <alex@example.com>",
      snippet: "Are you available Saturday evening?",
      bodyText: "Are you available Saturday evening? We could do the new Thai place at 7.",
    },
    {
      id: "demo-roadmap",
      threadId: "thread-roadmap",
      labels: ["INBOX"],
      ageMs: ageMs({ hours: 10 }),
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
      ageMs: ageMs({ hours: 12 }),
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
      ageMs: ageMs({ hours: 18 }),
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
      ageMs: ageMs({ hours: 22 }),
      subject: "Package delivered",
      from: "Shop Example <receipts@shop.example>",
      snippet: "Your package was delivered at 2:14 PM.",
      bodyText: "Your package was delivered at 2:14 PM. Order DEMO-2026 has arrived.",
    },
    {
      id: "demo-receipt",
      threadId: "thread-receipt",
      labels: ["CATEGORY_UPDATES"],
      ageMs: ageMs({ hours: 28 }),
      subject: "Receipt for your grocery order",
      from: "Local Market <receipts@market.example>",
      snippet: "Thanks for your order. Your receipt is inside.",
      bodyText: "Thanks for your order. Your receipt total was $42.19.",
    },
    {
      id: "demo-newsletter",
      threadId: "thread-newsletter",
      labels: ["CATEGORY_PROMOTIONS"],
      ageMs: ageMs({ days: 2 }),
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
      ageMs: ageMs({ hours: 5 }),
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
      ageMs: ageMs({ minutes: 40 }),
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
      ageMs: ageMs({ hours: 8 }),
      subject: "Congratulations, gift card winner",
      from: "Rewards Team <winner@promo-example.test>",
      snippet: "Congratulations, you are a gift card winner.",
      bodyText:
        "Congratulations, you are a gift card winner. Reply with your details to claim now.",
    },
  ];
}

const actionThreads = [
  {
    from: "Nina Patel <nina@example.com>",
    subject: "Contractor estimate for the porch",
    context: "I sent over the porch repair estimate so we can compare it with the other bid.",
    action: "review the contractor estimate",
    deadline: "by Monday",
    detail: "The main decision is whether to include the railing repair now.",
  },
  {
    from: "Mateo Garcia <mateo@example.com>",
    subject: "Vet appointment plan for Luna",
    context: "The clinic has two openings next week for Luna's annual visit.",
    action: "confirm which vet appointment works",
    deadline: "tomorrow morning",
    detail: "The 8:30 slot is easiest for me, but the afternoon slot is still open.",
  },
  {
    from: "Harper Lee <harper@example.net>",
    subject: "Neighborhood cleanup supplies",
    context: "The neighborhood cleanup is still on for Saturday and I am gathering supplies.",
    action: "let me know if you can bring gloves and trash bags",
    deadline: "by Thursday",
    detail: "We should have enough grabbers, but gloves are running short.",
  },
  {
    from: "Sam Wilson <sam@example.com>",
    subject: "Car repair quote",
    context: "The mechanic sent the quote for the brake work and tire rotation.",
    action: "approve the car repair quote",
    deadline: "today",
    detail: "They can finish it before the weekend if we give them the go-ahead.",
  },
  {
    from: "Avery Brooks <avery@example.org>",
    subject: "Tax organizer packet",
    context: "I started filling out the tax organizer and marked the sections that need another look.",
    action: "review the tax organizer",
    deadline: "by Friday",
    detail: "The charitable giving and home office sections are the only uncertain pieces.",
  },
  {
    from: "Elena Rossi <elena@example.com>",
    subject: "Cabin weekend headcount",
    context: "The cabin host needs a final headcount before they send the access code.",
    action: "confirm the cabin weekend headcount",
    deadline: "tomorrow afternoon",
    detail: "I have you down for two nights unless plans changed.",
  },
  {
    from: "Marcus Brown <marcus@example.net>",
    subject: "Fundraiser flyer draft",
    context: "I cleaned up the fundraiser flyer and put the event details at the top.",
    action: "review the fundraiser flyer",
    deadline: "by Wednesday",
    detail: "Mostly checking that the donation link and time are right.",
  },
  {
    from: "Leah Kim <leah@example.com>",
    subject: "Garden share pickup schedule",
    context: "The garden share pickup window moved because of the holiday.",
    action: "confirm whether Tuesday evening works",
    deadline: "by Monday",
    detail: "I can pick up both boxes if you are stuck at work.",
  },
  {
    from: "Dr. Owens Office <frontdesk@owens.example>",
    subject: "Medical portal form",
    context: "We noticed the pre-visit form is still incomplete in the portal.",
    action: "sign the medical portal form",
    deadline: "by Friday",
    detail: "This message is from the front desk, but it needs your confirmation.",
  },
  {
    from: "Tessa Nguyen <tessa@example.com>",
    subject: "Passport renewal checklist",
    context: "I put together the passport renewal checklist for the kids.",
    action: "review the passport renewal checklist",
    deadline: "this week",
    detail: "The photo requirements changed, so please check that section closely.",
  },
  {
    from: "Coach Ellis <coach@example.edu>",
    subject: "Soccer snack roster",
    context: "We are filling the snack roster for the last three games.",
    action: "let me know which soccer game you can cover",
    deadline: "by Thursday",
    detail: "Fruit and water are plenty; no need for anything elaborate.",
  },
  {
    from: "Owen Miller <owen@example.com>",
    subject: "Moving truck reservation",
    context: "The moving truck reservation is on hold, but they need a card to keep it.",
    action: "confirm the moving truck reservation",
    deadline: "today",
    detail: "The pickup location is the one near the storage unit.",
  },
  {
    from: "Mira Kapoor <mira@example.net>",
    subject: "Home insurance comparison",
    context: "I gathered the home insurance quotes into one note.",
    action: "review the home insurance comparison",
    deadline: "by Monday",
    detail: "The cheaper plan has a higher wind deductible, so that is the tradeoff.",
  },
  {
    from: "Ben Carter <ben@example.com>",
    subject: "Dinner reservation choice",
    context: "I found two dinner reservation options for Friday.",
    action: "confirm which dinner reservation you prefer",
    deadline: "tomorrow evening",
    detail: "One is at 6:30 downtown and the other is 7:15 closer to home.",
  },
  {
    from: "Sofia Martinez <sofia@example.com>",
    subject: "Conference hotel split",
    context: "The conference hotel receipt came through and I split the nights by person.",
    action: "review the hotel split",
    deadline: "by Friday",
    detail: "I want to settle it before everyone forgets the details.",
  },
  {
    from: "Blue Wheel Bikes <service@bluewheel.example>",
    subject: "Bike tune-up pickup",
    context: "Your bike tune-up is nearly complete and we can hold it until the weekend.",
    action: "confirm your bike pickup time",
    deadline: "by Thursday",
    detail: "Reply with a morning or afternoon pickup window.",
  },
  {
    from: "Riley James <riley@example.net>",
    subject: "Volunteer shift swap",
    context: "I cannot make the early volunteer shift after all.",
    action: "let me know if you can swap volunteer shifts",
    deadline: "today",
    detail: "I can take your later shift next month in return.",
  },
  {
    from: "Camila Torres <camila@example.com>",
    subject: "Family photo order",
    context: "The gallery is open and the print credit expires soon.",
    action: "review the family photo order",
    deadline: "by Sunday",
    detail: "I marked three favorites but want your thoughts before ordering.",
  },
  {
    from: "Jonah Reed <jonah@example.org>",
    subject: "Refinance document checklist",
    context: "The lender sent a checklist for the refinance packet.",
    action: "review the refinance document checklist",
    deadline: "by Wednesday",
    detail: "They mostly need income documents and the insurance declaration page.",
  },
  {
    from: "Priya Shah <priya@example.com>",
    subject: "Book club hosting plan",
    context: "I drafted the book club hosting plan with snacks and discussion questions.",
    action: "let me know your thoughts on the hosting plan",
    deadline: "by Friday",
    detail: "We can keep it simple if this is too much for a weeknight.",
  },
];

function buildActionThreadInputs() {
  return actionThreads.flatMap((thread, index) => {
    const id = `golden-action-${pad(index)}`;
    const threadId = `thread-${id}`;
    const olderAge = ageMs({ hours: 36 + index * 9 });
    const newerAge = ageMs({ hours: 30 + index * 9 });

    return [
      {
        id: `${id}-a`,
        threadId,
        labels: ["INBOX"],
        ageMs: olderAge,
        subject: thread.subject,
        from: thread.from,
        snippet: thread.context,
        bodyText: `${thread.context} ${thread.detail}`,
      },
      {
        id: `${id}-b`,
        threadId,
        labels: index % 3 === 0 ? ["INBOX", "UNREAD"] : ["INBOX"],
        ageMs: newerAge,
        subject: `Re: ${thread.subject}`,
        from: thread.from,
        snippet: `Could you ${thread.action} and let me know your thoughts ${thread.deadline}?`,
        bodyText: `Could you ${thread.action} and let me know your thoughts ${thread.deadline}? ${thread.detail}`,
      },
    ];
  });
}

const friendlyThreads = [
  ["Morgan Taylor <morgan@example.com>", "Photos from Sunday", "Sending the photos from Sunday before they vanish into my camera roll.", "The group shot by the river came out better than expected."],
  ["Grace Li <grace@example.net>", "Soup recipe notes", "I typed up the soup recipe with the changes we made last time.", "A little extra ginger made it brighter, so I kept that note in."],
  ["Noah Bennett <noah@example.com>", "Trail notes from the ridge loop", "Sharing the trail notes from the ridge loop for whenever you want them.", "The north entrance was quieter and had easier parking."],
  ["Iris Coleman <iris@example.org>", "Playlist from the drive", "Here is the playlist from the drive home.", "Track seven is the one we were trying to remember."],
  ["Daniel Cho <daniel@example.com>", "Concert recap", "That concert was louder than I expected and completely worth it.", "I found a short writeup that captured the encore nicely."],
  ["June Park <june@example.net>", "Garden tomatoes", "The garden finally produced too many tomatoes at once.", "I left a bag on the porch for you."],
  ["Felix Turner <felix@example.com>", "Birthday photos", "The birthday photos are in a shared folder now.", "I kept the blurry ones out of the main album."],
  ["Mei Lin <mei@example.org>", "Houseplant cuttings", "The pothos cuttings rooted faster than expected.", "I labeled the jar so it does not get mixed up with the basil."],
  ["Amara Singh <amara@example.com>", "Travel notes for Montreal", "I saved the Montreal notes from our last trip.", "The bakery near the park was the place everyone liked."],
  ["Evan Brooks <evan@example.net>", "Recital clip", "The piano recital clip uploaded this morning.", "The audio is quiet but the ending is clear."],
  ["Lena Ortiz <lena@example.com>", "Coffee map", "I made a small map of the coffee places we talked about.", "The new one near the station opens early."],
  ["Victor Chen <victor@example.org>", "Book recommendation", "The book recommendation from dinner is below.", "It starts slowly but pays off by the third chapter."],
];

function buildFriendlyThreadInputs() {
  return friendlyThreads.flatMap(([from, subject, firstBody, secondBody], index) => {
    const id = `golden-friendly-${pad(index)}`;
    const threadId = `thread-${id}`;

    return [
      {
        id: `${id}-a`,
        threadId,
        labels: ["INBOX"],
        ageMs: ageMs({ days: 4 + index }),
        subject,
        from,
        snippet: firstBody,
        bodyText: firstBody,
      },
      {
        id: `${id}-b`,
        threadId,
        labels: ["INBOX"],
        ageMs: ageMs({ days: 3 + index, hours: 8 }),
        subject: `Re: ${subject}`,
        from,
        snippet: secondBody,
        bodyText: secondBody,
      },
    ];
  });
}

const billAndReminderUpdates = [
  ["Northstar Electric Billing <billing@northstar-electric.example>", "Electric bill due Monday", "Your electric bill of $86.42 is due Monday.", "Please pay from your online account or confirm autopay settings."],
  ["City Water Billing <billing@citywater.example>", "Water bill due Friday", "Your water bill of $47.10 is due Friday.", "Autopay is not enabled for this account."],
  ["FiberNet <billing@fibernet.example>", "Internet autopay scheduled", "Your internet autopay of $74.99 is scheduled for tomorrow.", "No action is needed if the card on file is still correct."],
  ["Oak Street Apartments <portal@oakstreet.example>", "Rent payment reminder", "Rent for next month is due by Monday.", "The tenant portal is open for early payment."],
  ["Harbor Mortgage <statements@harbormortgage.example>", "Mortgage statement ready", "Your monthly mortgage statement is ready.", "The statement includes escrow activity for this period."],
  ["Summit Card Services <billing@summitcard.example>", "Credit card payment due", "Your card payment is due Thursday.", "Minimum payment and statement balance are available in the card portal."],
  ["Evergreen Auto Insurance <renewals@evergreen-auto.example>", "Auto insurance renewal", "Your auto insurance renewal documents are ready.", "Review the premium change before the renewal date."],
  ["Civic Health Plan <notifications@civichealth.example>", "Explanation of benefits ready", "A new explanation of benefits is available.", "This is not a bill, but it may help reconcile recent visits."],
  ["Bright Dental <reminders@brightdental.example>", "Dentist appointment reminder", "This is a reminder for your dentist appointment tomorrow morning.", "Arrive ten minutes early to update insurance information."],
  ["Primary Care Associates <notifications@primarycare.example>", "Annual physical reminder", "Your annual physical is scheduled for next week.", "Use the portal to update medication details."],
  ["Green Paws Vet <reminders@greenpaws.example>", "Vet appointment reminder", "Luna's vet appointment is on Tuesday afternoon.", "Reply to the clinic if you need to reschedule."],
  ["Neighborhood Pharmacy <notifications@neighborhoodrx.example>", "Prescription refill ready", "Your prescription refill is ready for pickup.", "The pharmacy will hold it for seven days."],
  ["City Library <notices@citylibrary.example>", "Library hold expires tomorrow", "Your library hold expires tomorrow.", "Pick it up before closing or it will move to the next reader."],
  ["Parking Services <permits@parking.example>", "Parking permit renewal due", "Your parking permit renewal is due by Friday.", "Renew online to avoid an interruption."],
  ["State DMV <notifications@dmv.example>", "Vehicle registration renewal", "Vehicle registration renewal is available online.", "The renewal window closes at the end of the month."],
  ["County Treasurer <billing@countytreasurer.example>", "Property tax installment due", "Your property tax installment is due Monday.", "Payment options are listed in the county portal."],
  ["Maple HOA <billing@maplehoa.example>", "HOA dues reminder", "Quarterly HOA dues are due by Wednesday.", "Late fees start after the grace period."],
  ["SafeBox Storage <billing@safebox.example>", "Storage unit invoice", "Your storage unit invoice is ready.", "Autopay will run tomorrow unless you update payment details."],
  ["CloudKeep <billing@cloudkeep.example>", "Cloud backup subscription renewal", "Your cloud backup subscription renews next week.", "No files are affected by this notice."],
  ["Metro Mobile <billing@metromobile.example>", "Phone plan bill ready", "Your phone plan bill is ready.", "The balance is $62.80 and autopay is scheduled."],
  ["City Gas <statements@citygas.example>", "Gas utility statement", "Your gas utility statement is available.", "Usage is lower than last month."],
  ["Transit Wallet <notifications@transitwallet.example>", "Transit card auto reload", "Your transit card auto reload will run tomorrow.", "The reload amount is $25.00."],
  ["Core Gym <billing@coregym.example>", "Gym membership renewal", "Your gym membership renews on Friday.", "Plan details are available in your member profile."],
  ["Streamly <billing@streamly.example>", "Streaming service renewal", "Your streaming service renews next week.", "The monthly price remains unchanged."],
  ["SecureHome <billing@securehome.example>", "Home security bill", "Your home security bill is ready.", "Autopay will process on Monday."],
  ["CleanWay Waste <billing@cleanway.example>", "Trash service invoice", "Your trash service invoice is available.", "Payment is due by Friday."],
  ["Filter Club <reminders@filterclub.example>", "Water filter replacement reminder", "It is time to replace the kitchen water filter.", "Your next filter ships next week."],
  ["HomeCare Warranty <notices@homecare.example>", "Appliance warranty expires soon", "Your appliance warranty expires soon.", "Review coverage options before the end of the month."],
  ["ClearView Eye Center <reminders@clearview.example>", "Eye exam reminder", "Your eye exam is scheduled for Monday afternoon.", "Bring your current glasses and insurance card."],
  ["Federal Loan Servicing <statements@studentloan.example>", "Student loan payment posted", "Your student loan payment posted successfully.", "Your next due date is listed in the account dashboard."],
  ["DriveLine Finance <statements@driveline.example>", "Car loan statement ready", "Your car loan statement is ready.", "The next payment is due Thursday."],
  ["River Farm CSA <notifications@riverfarm.example>", "CSA pickup reminder", "Your CSA pickup is tomorrow evening.", "This week's box includes greens, potatoes, and apples."],
  ["Town Recreation <notices@townrec.example>", "Swim lesson reminder", "Swim lessons start Saturday morning.", "Bring goggles and arrive ten minutes early."],
  ["Civic Alerts <notifications@civicalerts.example>", "Street sweeping tomorrow", "Street sweeping is scheduled for your block tomorrow.", "Move cars before 8 AM to avoid tickets."],
];

function buildBillAndReminderInputs() {
  return billAndReminderUpdates.map(([from, subject, snippet, bodyText], index) => {
    const id = `golden-bill-${pad(index)}`;
    return {
      id,
      threadId: `thread-${id}`,
      labels: ["CATEGORY_UPDATES"],
      ageMs: ageMs({ days: 2 + (index % 18), hours: index % 5 }),
      subject,
      from,
      snippet,
      bodyText,
      listUnsubscribe: listUnsubscribe("updates.example", id),
    };
  });
}

const receiptAndTravelUpdates = [
  ["ParcelPost <notifications@parcelpost.example>", "Package out for delivery", "Your package is out for delivery today.", "Tracking shows delivery between 1 PM and 5 PM."],
  ["ParcelPost <notifications@parcelpost.example>", "Package delivered to side door", "Your package was delivered to the side door.", "The delivery photo is available in tracking."],
  ["Home Goods Store <receipts@homegoods.example>", "Order confirmation for kitchen shelves", "Thanks for your order.", "Kitchen shelves are expected to ship within three business days."],
  ["Local Market <receipts@market.example>", "Grocery receipt", "Your grocery receipt total was $58.31.", "Thanks for shopping with Local Market."],
  ["Neighborhood Pharmacy <receipts@neighborhoodrx.example>", "Pharmacy receipt", "Your pharmacy receipt is ready.", "Flexible spending details are available in the receipt."],
  ["Harbor Hardware <receipts@harborhardware.example>", "Hardware store receipt", "Your receipt total was $23.44.", "Items purchased: picture hooks, sandpaper, and primer."],
  ["RideShare <receipts@rideshare.example>", "Ride receipt to Union Station", "Your ride receipt is ready.", "Trip distance was 4.8 miles."],
  ["RailLine <tickets@railline.example>", "Train ticket confirmation", "Your train ticket is confirmed.", "Departure is Friday morning from platform information posted day-of."],
  ["Harbor Hotel <reservations@harborhotel.example>", "Hotel reservation reminder", "Your hotel reservation starts next Thursday.", "Check-in opens at 3 PM."],
  ["TableReady <reservations@tableready.example>", "Restaurant reservation confirmed", "Your table for four is confirmed.", "Reservation time is Saturday evening."],
  ["Skyline Air Notifications <notifications@skyline.example>", "Flight itinerary updated", "Your flight itinerary has an updated gate note.", "No schedule change is currently listed."],
  ["Skyline Air Notifications <notifications@skyline.example>", "Boarding pass ready", "Your boarding pass is ready.", "Save it before you leave for the airport."],
  ["Blue Wheel Bikes <service@bluewheel.example>", "Bike repair complete", "Your bike repair is complete.", "Pickup is available during shop hours."],
  ["BeanBox <shipping@beanbox.example>", "Coffee subscription shipped", "Your coffee subscription has shipped.", "This month's roast is from Guatemala."],
  ["Pet Pantry <autoship@petpantry.example>", "Pet food autoship notice", "Your pet food autoship is scheduled.", "Edit the order before Monday to change quantities."],
  ["Shop Example <returns@shop.example>", "Return received", "We received your return.", "Refund processing may take three to five business days."],
  ["Shop Example <billing@shop.example>", "Refund processed", "Your refund has been processed.", "The credit should appear on your original payment method."],
  ["City Museum <tickets@citymuseum.example>", "Museum tickets", "Your museum tickets are ready.", "Tickets are valid for Sunday admission."],
  ["Cineplex <tickets@cineplex.example>", "Movie tickets", "Your movie tickets are confirmed.", "Showtime is Friday evening."],
  ["GaragePay <receipts@garagepay.example>", "Parking receipt", "Your parking receipt is ready.", "Parking duration was two hours and twelve minutes."],
  ["Open Hands <receipts@openhands.example>", "Donation receipt", "Thank you for your donation.", "Your receipt is ready for tax records."],
  ["TaxPrep Online <receipts@taxprep.example>", "Tax software receipt", "Your tax software receipt is available.", "The purchase includes one federal filing."],
  ["Digital Books <receipts@digitalbooks.example>", "Digital book purchase", "Your digital book purchase is complete.", "The book is now in your library."],
  ["Room & Rack <shipping@roomrack.example>", "Home goods order shipped", "Your home goods order has shipped.", "The carrier will update tracking tonight."],
  ["SupperKit <delivery@supperkit.example>", "Meal kit delivery arriving", "Your meal kit delivery arrives tomorrow.", "The box includes cold packs and recipe cards."],
  ["ParcelPost <notifications@parcelpost.example>", "Package delayed", "Your package is delayed due to weather.", "The new estimated delivery date is Monday."],
  ["Furniture Outlet <orders@furnitureoutlet.example>", "Delivery address confirmation", "Please confirm the delivery address on file.", "The carrier will call before delivery."],
  ["Coast Rental Cars <reservations@coastrental.example>", "Rental car confirmation", "Your rental car is confirmed.", "Pickup is at the airport counter."],
];

function buildReceiptAndTravelInputs() {
  return receiptAndTravelUpdates.map(([from, subject, snippet, bodyText], index) => {
    const id = `golden-receipt-${pad(index)}`;
    return {
      id,
      threadId: `thread-${id}`,
      labels: ["CATEGORY_UPDATES"],
      ageMs: ageMs({ days: 3 + (index % 22), hours: (index * 3) % 10 }),
      subject,
      from,
      snippet,
      bodyText,
      listUnsubscribe: listUnsubscribe("receipts.example", id),
    };
  });
}

const mailingListUpdates = [
  ["The Morning Brief <newsletter@morningbrief.example>", "The Morning Brief: housing, transit, and coffee", "Today's local briefing covers housing, transit, and a new coffee shop.", "Read the full issue online when you have time."],
  ["Neighborhood Association <digest@neighborhood.example>", "Neighborhood association digest", "This week's digest includes meeting notes and volunteer updates.", "The next meeting is on the community calendar."],
  ["City Library <newsletter@citylibrary.example>", "Library events this week", "New author talks and kids events are on the calendar.", "Registration links are inside the newsletter."],
  ["City Parks <newsletter@cityparks.example>", "City parks newsletter", "Trail maintenance, pool hours, and volunteer days are listed this week.", "The city parks team sends this update monthly."],
  ["School PTA <newsletter@pta.example.edu>", "PTA weekly update", "The PTA update includes lunch reminders and fundraiser totals.", "Committee notes are linked at the bottom."],
  ["Open Source Weekly <newsletter@opensource.example>", "Open source changelog", "This issue covers dependency updates and community releases.", "Sponsored links are marked in the footer."],
  ["Money Notes <newsletter@moneynotes.example>", "Personal finance weekly", "This week's note covers savings rates and tax planning.", "The calculators are linked in the member section."],
  ["Weeknight Table <newsletter@weeknighttable.example>", "Recipe newsletter: pantry dinners", "Five pantry dinner ideas are included this week.", "The lentil recipe is the reader favorite."],
  ["Running Club <digest@runningclub.example>", "Running club digest", "Group runs, volunteer pacers, and race results are listed.", "Saturday's route starts at the park entrance."],
  ["Design Notes <newsletter@designnotes.example>", "Product design notes", "This issue covers dashboard density and onboarding patterns.", "The case study is a ten-minute read."],
  ["Local Theater <announcements@localtheater.example>", "Local theater announcements", "Spring productions and member previews are now listed.", "Tickets open to members first."],
  ["City Museum <members@citymuseum.example>", "Museum member newsletter", "Member hours and new exhibits are in this month's note.", "Guest pass details are included."],
  ["Climate Action Network <updates@climateaction.example>", "Climate action update", "The monthly update includes policy notes and volunteer events.", "The next call is listed in the calendar section."],
  ["Tech Policy Roundup <newsletter@techpolicy.example>", "Tech policy roundup", "This week's roundup covers privacy hearings and platform rules.", "Links are grouped by region."],
  ["Garden Almanac <newsletter@gardenalmanac.example>", "Gardening tips for May", "May gardening tips include herbs, mulch, and watering reminders.", "The pruning guide is linked near the end."],
  ["Photo Prompts <newsletter@photoprompts.example>", "Photography prompts", "This week's prompts focus on reflections and window light.", "Reader submissions are featured at the bottom."],
  ["Corner Bookstore <newsletter@cornerbooks.example>", "Bookstore staff picks", "Staff picks this week include essays, mysteries, and cookbooks.", "Events are listed below the recommendations."],
  ["Transit Authority <alerts@transit.example>", "Transit service advisory digest", "Weekend service changes are summarized in this advisory.", "Check the route page before traveling."],
  ["Language School <bulletin@languages.example>", "Language class bulletin", "The bulletin includes conversation tables and class openings.", "Registration links are listed by language."],
  ["State University Alumni <newsletter@alumni.example.edu>", "Alumni newsletter", "Campus news, events, and alumni profiles are in this month's issue.", "Reunion registration opens later this month."],
  ["Civic Health Plan <wellness@civichealth.example>", "Wellness newsletter", "This wellness note covers sleep routines and preventive care.", "Benefits links are included for members."],
  ["Community Board <digest@communityboard.example>", "Community board digest", "Posts this week include childcare swaps and free furniture.", "Reply on the board to contact neighbors."],
  ["BuildKit <updates@buildkit.example>", "Product update: May changelog", "The May changelog includes export improvements and bug fixes.", "Admin release notes are linked in the footer."],
  ["DevTools Weekly <newsletter@devtools.example>", "Developer tool release notes", "New CLI flags and editor plugins are highlighted this week.", "Examples are included in the release notes."],
  ["Signal Boost <newsletter@signalboost.example>", "Podcast newsletter", "New episodes and transcript links are ready.", "The interview section starts halfway through."],
  ["Fare Watch <deals@farewatch.example>", "Fare watch: early summer routes", "Early summer route ideas and fare trends are summarized.", "Prices may change before booking."],
  ["Home Seasonal <newsletter@homeseasonal.example>", "Home maintenance checklist", "The seasonal checklist covers gutters, filters, and smoke alarms.", "Print-friendly notes are linked."],
  ["Parent Circle <digest@parentcircle.example>", "Parenting group digest", "The digest includes camp notes and babysitter recommendations.", "The group archive has older threads."],
  ["Local News Desk <newsletter@localnews.example>", "Afternoon local news update", "Today's update covers council notes and school budget news.", "Full stories are on the site."],
  ["Makerspace <schedule@makerspace.example>", "Makerspace schedule", "Shop hours, class times, and open lab sessions are listed.", "Safety orientation is required for new members."],
  ["Continuing Education <catalog@continuinged.example>", "Continuing education catalog", "New short courses are open for registration.", "The spring catalog includes evening classes."],
  ["Volunteer Center <opportunities@volunteercenter.example>", "Volunteer opportunities", "This week's volunteer opportunities include food pantry and tutoring shifts.", "Signup links are sorted by neighborhood."],
  ["Farmers Market <newsletter@farmersmarket.example>", "Farmers market weekly", "This week at the market: strawberries, greens, flowers, and music.", "Vendor notes are included below."],
  ["Budget Buddy <insights@budgetbuddy.example>", "Monthly spending insights", "Your monthly spending insights are ready.", "Categories are compared with last month."],
  ["Still Mind <newsletter@stillmind.example>", "Meditation app newsletter", "This note includes a new five-minute practice.", "Subscriber resources are linked at the bottom."],
  ["Weeknight Table <newsletter@weeknighttable.example>", "Weeknight ideas: beans, greens, noodles", "Quick dinners this week focus on beans, greens, and noodles.", "Shopping notes are inside."],
  ["DesignConf <newsletter@designconf.example>", "Design conference newsletter", "Speaker announcements and workshop updates are available.", "Early registration details are included."],
  ["Public Radio <members@publicradio.example>", "Public radio member update", "Member news, station updates, and event recordings are linked.", "Thank you gifts ship separately."],
  ["Open Hands <impact@openhands.example>", "Charity impact report", "The quarterly impact report is ready.", "Stories from partner organizations are included."],
  ["Security Basics <newsletter@securitybasics.example>", "Cybersecurity tips bulletin", "This bulletin covers password managers and account recovery.", "Examples are written for home use."],
  ["Streamly <picks@streamly.example>", "Streaming picks this week", "New films and comfort watches are highlighted this week.", "Your watchlist is unchanged."],
  ["Trail Journal <newsletter@trailjournal.example>", "Outdoor gear journal", "This week's journal covers day packs and rain shells.", "The buyer guide is linked at the end."],
];

function buildMailingListInputs() {
  return mailingListUpdates.map(([from, subject, snippet, bodyText], index) => {
    const id = `golden-list-${pad(index)}`;
    return {
      id,
      threadId: `thread-${id}`,
      labels: index % 4 === 1 ? ["CATEGORY_FORUMS"] : ["CATEGORY_PROMOTIONS"],
      ageMs: ageMs({ days: 1 + (index % 40), hours: 12 + (index % 7) }),
      subject,
      from,
      snippet,
      bodyText,
      listUnsubscribe: listUnsubscribe("lists.example", id),
    };
  });
}

const spamAndJunk = [
  ["Security Alert <security-alert@secure-login.example>", "Verify your account immediately", "Urgent action required. Verify your account immediately.", "Your password expires today. Follow the secure link to avoid account closure."],
  ["Rewards Center <winner@bonus-prize.example>", "Congratulations, you are selected", "Congratulations, you have been selected for a gift card.", "Reply with your details to claim now."],
  ["Crypto Desk <profit@crypto-returns.example>", "Crypto profit alert", "Guaranteed crypto returns are waiting.", "Limited spots remain for today's private trading pool."],
  ["Account Desk <account-verify@cloud-login.example>", "Password expires today", "Your password expires today.", "Verify your account to keep access."],
  ["Refund Department <refunds@unclaimed-cash.example>", "Unclaimed refund notice", "An unclaimed refund is waiting for confirmation.", "Send your account details to release payment."],
  ["Online Banking <security-alert@bank-check.example>", "Final notice: account locked", "Urgent action required to prevent account lock.", "Verify your account immediately using the link below."],
  ["Prize Office <claims@cash-prize.example>", "Congratulations cash prize winner", "Congratulations, you are a cash prize winner.", "Reply now with your contact details."],
  ["Billing Security <account-verify@payment-hold.example>", "Update payment to avoid closure", "Your account will close unless payment is updated.", "Use the secure form to confirm your password and card."],
  ["Loan Desk <approved@quickloan.example>", "Exclusive loan approved", "Your exclusive loan is approved.", "Act today to receive funds without credit checks."],
  ["Remote Careers <payout@worknow.example>", "Work from home payout", "Earn a guaranteed payout from home.", "Send your profile to activate the offer."],
  ["Invoice Center <billing@invoice-docs.example>", "Invoice overdue", "An invoice is overdue and requires immediate review.", "Open the attached document link to avoid penalties."],
  ["Parcel Support <delivery@parcel-verify.example>", "Delivery failed - verify address", "Delivery failed because your address needs verification.", "Confirm your details now to release the package."],
  ["Tax Service <refund@tax-release.example>", "Tax refund pending", "Your tax refund is pending.", "Verify your bank details to receive the transfer."],
  ["Antivirus Support <renewal@pc-shield.example>", "Antivirus subscription expired", "Your antivirus subscription expired today.", "Renew immediately to prevent data loss."],
  ["Lottery Desk <claims@lottery-office.example>", "Lottery winner notification", "Congratulations, your email was selected as a lottery winner.", "Reply with identification details to claim."],
  ["Bank Security <security-alert@banking-review.example>", "Bank security verification", "Urgent action required on your bank profile.", "Verify your account immediately to prevent suspension."],
  ["Payroll Team <payroll@urgent-forms.example>", "Urgent payroll action required", "Urgent action required for payroll release.", "Confirm your credentials before the next pay cycle."],
  ["Survey Rewards <giftcard@survey-bonus.example>", "Gift card survey reward", "Complete a short survey to claim a gift card.", "Congratulations, this reward is reserved for you."],
  ["Trading Club <alerts@profit-signal.example>", "Guaranteed trading signal", "Today's trading signal can double your account.", "Crypto and options profits are available for members."],
  ["Document Center <account-verify@docsreview.example>", "Account documents require verification", "Verify your account documents today.", "Your access will be restricted without immediate action."],
];

function buildSpamInputs() {
  return spamAndJunk.map(([from, subject, snippet, bodyText], index) => {
    const id = `golden-spam-${pad(index)}`;
    return {
      id,
      threadId: `thread-${id}`,
      labels: ["SPAM"],
      ageMs: ageMs({ hours: 14 + index * 5 }),
      subject,
      from,
      snippet,
      bodyText,
    };
  });
}

function buildGoldenDemoInputs() {
  const inputs = [
    ...baseDemoInputs(),
    ...buildActionThreadInputs(),
    ...buildFriendlyThreadInputs(),
    ...buildBillAndReminderInputs(),
    ...buildReceiptAndTravelInputs(),
    ...buildMailingListInputs(),
    ...buildSpamInputs(),
  ];

  if (inputs.length !== DEMO_MESSAGE_COUNT) {
    throw new Error(`Expected ${DEMO_MESSAGE_COUNT} demo messages; built ${inputs.length}.`);
  }

  return inputs;
}

export function buildDemoMessages(account, baseTime = Date.now()) {
  return buildGoldenDemoInputs().map((input) => demoMessage(account, baseTime, input));
}

export async function resetDemoData({ userId } = {}) {
  if (!userId) throw new Error("resetDemoData requires a userId");
  await clearUserData(userId);
  return syncMockSource({ userId });
}

export async function syncMockSource({ userId, baseTime = Date.now() } = {}) {
  if (!userId) throw new Error("syncMockSource requires a userId");
  const account = await upsertAccount(mockSourceAccountFor(userId));
  const messages = buildDemoMessages(account, baseTime);
  const result = await upsertSyncedMessages(account, messages);
  return { account, result };
}
