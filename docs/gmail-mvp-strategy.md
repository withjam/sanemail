# Gmail-First Personal MVP Strategy

## Decision

Target personal email users first, with Gmail as the first ingestion source.
Custom-domain MX should remain in the architecture, but it should not be the
primary MVP path because it asks users to change identity and DNS before they
have felt the product value.

The MVP should let a user connect an existing Gmail account, keep using Gmail
and existing phone mail apps, and use SaneMail as an intelligence layer that
gradually becomes their preferred email surface.

SaneMail should not write back to Gmail for the MVP. Gmail is the source of
messages; SaneMail owns curation state, rankings, categories, annotations,
feedback, and read/progress state in its own data model.

## Why Gmail First

- Most personal users already have Gmail and will not move MX records.
- Gmail gives us real-world mail diversity immediately: personal, shopping,
  finance, newsletters, spam, receipts, notifications, travel, and old threads.
- Users can try SaneMail without changing their address or current habits.
- A read-only Gmail integration keeps the initial trust boundary clear: SaneMail
  can improve the experience without changing the user's existing mailbox.

## The Big Caveat

Reading Gmail message bodies, headers, metadata, or attachments requires
restricted Google Workspace/Gmail scopes. A public app that stores, transmits,
or processes that data server-side will need Google's restricted-scope approval
and security posture work.

This is launchable, but it is not a casual OAuth integration. Treat Google
verification as an MVP workstream from day one.

## Recommended MVP Shape

### Ingestion

Use the Gmail API rather than IMAP for the first connector.

Required capabilities:

- Initial sync of recent messages and threads.
- Partial sync using Gmail history IDs.
- Push notifications via Gmail `watch` and Cloud Pub/Sub.
- Periodic fallback polling because Gmail push can be delayed or dropped.
- Reconciliation when Gmail changes outside SaneMail: new mail, deletes, spam
  moves, archives, label changes, and read/unread changes.

Initial scope:

- Use `gmail.readonly` for the MVP. It is sufficient for reading message content
  and for Gmail `watch`/history synchronization.
- Do not request `gmail.modify` unless we later decide Gmail mutation is central
  to the product.

### User Experience

Primary app:

- SaneMail web/mobile experience with `Today`, `Needs Reply`, `Waiting`,
  `FYI`, `Junk Review`, `All Mail`, search, and explanations.

Internal state:

- SaneMail categories, rankings, summaries, junk verdicts, feedback, read state,
  snoozes, pins, and reminders live only in SaneMail.
- Gmail labels and mailbox state are imported as source signals, not as the
  canonical product state.

Default:

- Never mutate Gmail during the MVP.
- Deleting or archiving in Gmail outside SaneMail should be reflected in
  SaneMail after sync, but SaneMail actions should not change Gmail.

### Existing iPhone/Android Mail Apps

We do not need to provide IMAP/JMAP for Gmail users to keep current habits.
Their existing phone clients can continue talking directly to Gmail.

However:

- Existing clients will not show the full SaneMail experience.
- Existing clients also will not reflect SaneMail categories, summaries, or
  junk decisions.
- That is acceptable for MVP because SaneMail is an additive intelligence layer,
  not the mailbox owner.

For custom-domain users later, we should provide IMAP/SMTP compatibility. JMAP is
nice for our own first-party clients and power clients, but it is not necessary
for preserving mainstream phone mail habits.

## Model Strategy

Users should never choose models. SaneMail should choose the cheapest model that
meets the quality bar for each task.

Suggested model tiers:

- Cheap classifier model: category, action likelihood, bulk/junk hints, routing.
- Embedding model: semantic search, thread clustering, sender/contact similarity.
- Stronger summarizer/reasoner: thread summaries, action extraction, explainability.
- Optional expensive fallback: only for ambiguous, high-value, or high-risk mail.

Ollama Cloud is a reasonable early backend because it supports cloud models and
OpenAI-compatible endpoints for chat and embeddings. For production Gmail users,
we must confirm that the model provider/data handling fits Google's Limited Use
requirements and our privacy policy, especially around not using user email to
train generalized models.

## Compliance Workstream

Minimum work before public Gmail launch:

- OAuth consent screen, brand, domain, privacy policy, and terms.
- Precise scope justification.
- In-product disclosure before Gmail connection.
- Data deletion and disconnect flow.
- Encrypted OAuth tokens.
- Encrypted mail-derived data at rest.
- No generalized model training on Gmail data.
- No ad targeting or sale/transfer of user data.
- CASA/security assessment readiness for restricted Gmail scopes.

## Practical Launch Path

### Phase 0: Founder/Private Prototype

- Use Gmail test users or personal-use exception.
- Read-only Gmail ingestion.
- Process only a bounded recent window, such as 30-90 days.
- Build the ranking, junk review, summaries, and feedback loop.

### Phase 1: Trusted Alpha

- Under 100 Google test users if still unverified.
- Keep Gmail read-only.
- Measure user trust: not-junk rescues, hidden important mail, opened Today
  items, and whether users return to raw Gmail.

### Phase 2: Public Gmail Beta

- Complete Google restricted-scope verification and security work.
- Launch with clear positioning: "connect Gmail, keep Gmail, get a sane view.
  We do not change your Gmail."

### Phase 3: Custom Domain / Hosted Mail

- Add MX hosting for users who want SaneMail as the primary mail provider.
- Provide IMAP/SMTP compatibility for legacy clients.
- Consider JMAP for modern sync and first-party app performance.

## References

- Gmail API scopes:
  https://developers.google.com/workspace/gmail/api/auth/scopes
- Gmail API sync:
  https://developers.google.com/workspace/gmail/api/guides/sync
- Gmail API push notifications:
  https://developers.google.com/workspace/gmail/api/guides/push
- Gmail `watch` scope reference:
  https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch
- Gmail history scope reference:
  https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list
- Google Workspace API user data policy:
  https://developers.google.com/workspace/workspace-api-user-data-developer-policy
- Google OAuth app audience and test-user limits:
  https://support.google.com/cloud/answer/15549945
- Ollama Cloud:
  https://docs.ollama.com/cloud
- Ollama OpenAI-compatible API:
  https://docs.ollama.com/api/openai-compatibility
