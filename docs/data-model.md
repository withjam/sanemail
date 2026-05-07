# Data Model

The first implementation uses `data/sanemail.json` so the ingestion spine can
run locally without database setup. This is a development backing store, not the
production database. The production model should be source-agnostic at the mail
layer and source-specific only at the connector boundary.

The initial Postgres baseline lives in
`migrations/committed/000001-initial-app-schema.sql`, with encrypted local app
storage additions in `000002-secure-app-storage-tables.sql`. Both are managed by
Graphile Migrate. Use `migrations/current.sql` for the next in-progress schema
change.

The core rule is:

- ingestion syncs SaneMail storage with connected sources as quickly and safely
  as possible
- classification, summarization, ranking, and briefing happen after durable
  ingest
- unified product views read canonical messages, not Gmail-shaped records
- provider ids, cursors, labels, and deep links stay attached as source refs so
  SaneMail can reconcile and reference back to the original source

## Store Shape

Current local development shape:

```json
{
  "schemaVersion": 1,
  "oauthStates": [],
  "accounts": [],
  "messages": [],
  "threads": [],
  "feedback": [],
  "events": [],
  "aiRuns": [],
  "inboxBriefings": [],
  "verificationRuns": []
}
```

For local development, `accounts` is the prototype equivalent of
`source_connections`, and Gmail-shaped fields on `messages` are the prototype
equivalent of `message_source_refs`.

## Production Shape

### Users

Owns connected sources, canonical messages, product state, and deletion/export
boundaries.

Important fields:

- `id`
- `primary_email`
- `created_at`
- `deleted_at`

### Source Connections

Represents one connected mailbox or delivery source for a user. A user may have
many source connections, such as personal Gmail, work Gmail, Outlook, IMAP, a
local `mock` source, or a future SaneMail-hosted MX mailbox.

Important fields:

- `id`: stable SaneMail source connection id.
- `user_id`: owner.
- `provider`: `gmail`, `outlook`, `imap`, `mx`, `mock`, or another connector id.
- `source_email`: mailbox/account address at the source.
- `display_name`: user-facing source name.
- `status`: `active`, `paused`, `reauth_required`, `sync_error`, `deleted`.
- `auth_secret_ref`: pointer to encrypted OAuth/token material, never the token
  itself.
- `scope`: source permissions granted.
- `last_successful_sync_at`, `last_failed_sync_at`.
- `created_at`, `updated_at`, `deleted_at`.

Sync cursor fields may live on this table for simple connectors or in
`source_sync_cursors` when provider-specific state becomes more complex.

### Source Sync Cursors

Represents provider-specific sync position for one source connection. This is the
hot-path cursor used by ingestion workers.

Important fields:

- `source_connection_id`.
- `cursor_kind`: `gmail_history_id`, `delta_token`, `imap_uidvalidity_uid`,
  `mx_sequence`, or `backfill_page`.
- `cursor_value`: encrypted or plain provider cursor depending on sensitivity.
- `backfill_before`: oldest message timestamp still needing backfill, when
  applicable.
- `watch_expires_at`: for push-based connectors such as Gmail watch.
- `last_seen_source_at`: newest source message timestamp observed.
- `last_committed_at`: when a sync transaction successfully committed.
- `sync_generation`: monotonically increasing integer for idempotent sync runs.

Cursor updates must commit only after source refs and canonical messages commit.
If ingestion crashes, the next run should safely replay the same provider window.

### Source Sync Runs

Durable operational history for one sync attempt.

Important fields:

- `id`.
- `source_connection_id`.
- `trigger`: `watch`, `poll`, `manual`, `backfill`, `recovery`.
- `started_at`, `completed_at`.
- `status`: `running`, `succeeded`, `failed`, `partial`.
- `cursor_before`, `cursor_after`.
- `messages_seen`, `messages_inserted`, `messages_updated`,
  `source_deletes_seen`.
- `error_code`, `error_message`.

### Messages

Canonical, source-agnostic message record used by product surfaces.

Important fields:

- `id`: SaneMail message id.
- `user_id`: owner.
- `canonical_thread_id`: nullable until threading is resolved.
- `primary_source_connection_id`: source that first created or currently owns
  the canonical record.
- `received_at`: normalized source delivery time.
- `sent_at`: header `Date` when trustworthy.
- `subject`, `from`, `to`, `cc`, `reply_to`.
- `snippet`: safe short preview.
- `body_text_ref`: pointer to encrypted extracted text.
- `raw_ref`: pointer to encrypted raw/source payload in object storage.
- `content_hash`: normalized content hash for idempotency and duplicate
  detection.
- `ingested_at`, `updated_at`, `deleted_at`.

The ingest path should keep this table lean enough to upsert quickly. Large
bodies, raw payloads, attachments, and derived AI artifacts belong in separate
stores or tables.

### Message Source Refs

Provider-specific reference back to the original source. Product views should use
canonical `messages`, but every message must be traceable back to source state.

Important fields:

- `id`.
- `message_id`: canonical SaneMail message.
- `source_connection_id`.
- `provider`: duplicate of the connection provider for query convenience.
- `provider_message_id`.
- `provider_thread_id`.
- `provider_labels`: source labels/folders/categories at sync time.
- `provider_history_id` or equivalent per-message source cursor.
- `source_internal_date`.
- `source_url` or source deep-link metadata when available.
- `source_state`: `present`, `deleted`, `archived`, `spam`, `trash`, `unknown`.
- `last_seen_at`.

Constraints and indexes:

- unique `(source_connection_id, provider_message_id)`.
- index `(message_id)`.
- index `(source_connection_id, source_internal_date desc)`.

### Threads

Canonical SaneMail conversation projection. Threading must not depend on a single
provider's thread id because unified views may combine multiple connections.

Important fields:

- `id`.
- `user_id`.
- `subject_normalized`.
- `last_message_at`.
- `message_count`.
- `created_at`, `updated_at`.

Provider thread ids live in source refs or a `thread_source_refs` table.

### Ingestion Events

Append-only event stream emitted after durable writes.

Important event types:

- `source.sync.started`
- `source.sync.completed`
- `message.ingested`
- `message.updated_from_source`
- `message.source_deleted`
- `message.body_extracted`
- `classification.requested`

Ingestion events should carry ids and hashes, not raw body content.

### Queue Jobs

Production workers should use a durable queue rather than many cron jobs. Queue
payloads carry ids and versions only; workers reload sensitive data from the
database/object store inside their execution boundary.

Core job names:

- `source.sync`: one source connection, one cursor window.
- `classification.batch`: one user, one classifier version, newest pending
  messages first.
- `message-types.discover`: one user taxonomy discovery/update pass.
- `brief.generate`: one user and one brief scope.

Important payload fields:

- `user_id`.
- `source_connection_id`: for source-scoped jobs.
- `classifier_version` and `taxonomy_version`: for classification jobs.
- `trigger` or `reason`: `watch`, `poll`, `post_ingest`, `retry`,
  `taxonomy_changed`, `manual`, etc.
- `requested_at`.

Idempotency keys:

- `source.sync`: `(source_connection_id, trigger, cursor_hint)`.
- `classification.batch`: `(user_id, classifier_version)`.
- `message-types.discover`: `(user_id, taxonomy_version)`.
- `brief.generate`: `(user_id, scope_type, source_connection_id)`.

Concurrency should be serialized per source connection for sync and per user for
classification until row claiming and model-provider rate limits are proven.

### Classification State

LLM classification is intentionally outside the ingest transaction. Ingestion
marks messages as needing classification; batch workers process the backlog.

Classification has two layers:

- system placement: stable operational categories used by the product shell,
  such as `Needs Reply`, `FYI`, `Junk Review`, and `All Mail`
- user message types: dynamic, personalized labels learned from the user's mail
  and behavior, such as `Receipts`, `School Logistics`, `Travel`, `Bills`,
  `Newsletters`, `Security Alerts`, or user-created types

System placement is single-value for predictable routing. User message types are
multi-label because a message can be both `Needs Reply` and `School Logistics`,
or both `FYI` and `Package Updates`.

Important fields on `message_classification_state`:

- `message_id`.
- `user_id`.
- `state`: `pending`, `in_progress`, `classified`, `failed`, `stale`.
- `priority_at`: normally `received_at`, used for recent-first batching.
- `attempt_count`.
- `next_attempt_at`.
- `last_classified_at`.
- `classifier_version`.
- `input_hash`: hash of the message fields used by the classifier.

Important fields on `message_classifications`:

- `id`.
- `message_id`.
- `user_id`.
- `system_category`: `Today`, `Needs Reply`, `FYI`, `Junk Review`, or
  `All Mail`.
- `needs_reply`, `automated`, `possible_junk`, `direct`.
- `score`, `confidence`.
- `reasons`.
- `message_type_ids`: denormalized current type ids for read speed.
- `taxonomy_version`: user taxonomy version used by the classifier.
- `model_provider`, `model`, `prompt_id`, `prompt_version`.
- `input_hash`.
- `created_at`.

Classification writes append a new versioned result and update the current
classification pointer/state. They do not mutate the canonical message.

### User Message Types

Represents the personalized classification vocabulary for one user. These are
the types SaneMail can show, brief, mute, digest, or use as ranking features.

Important fields on `message_types`:

- `id`.
- `user_id`.
- `slug`: stable local identifier, such as `receipts` or `school-logistics`.
- `display_name`.
- `description`: short classifier-facing definition.
- `kind`: `system_seed`, `discovered`, `user_defined`, `imported_source_label`.
- `status`: `candidate`, `active`, `muted`, `archived`.
- `parent_type_id`: optional hierarchy, such as `Shopping` -> `Receipts`.
- `scope`: `all_sources` or `source`.
- `source_connection_id`: nullable unless source-scoped.
- `default_importance`: `high`, `normal`, `low`.
- `brief_policy`: `always`, `important_only`, `daily_digest`, `never`.
- `notification_policy`: `important_only`, `never`, or future push settings.
- `created_from`: `system`, `cluster`, `user`, `source_label`.
- `created_at`, `updated_at`, `archived_at`.

Seed types give cold-start coverage. Discovered types let the product become
better than generic spam folders as it observes mail volume and user behavior.
User-defined types let the user rename, merge, split, mute, or pin categories.

Important fields on `user_classification_taxonomies`:

- `id`.
- `user_id`.
- `version`.
- `active_type_ids`.
- `candidate_type_ids`.
- `prompt_snapshot_hash`.
- `created_at`.

The classifier should snapshot the taxonomy version it used so old decisions can
be explained even after a user renames or changes a type.

### Message Type Assignments

Many-to-many assignment between messages and user message types.

Important fields:

- `message_id`.
- `message_type_id`.
- `user_id`.
- `confidence`.
- `rank`: primary type is rank `1`; secondary types follow.
- `assignment_state`: `current`, `rejected`, `superseded`.
- `evidence`: compact reasons such as sender domain, list id, source label,
  semantic match, extracted entity, or user feedback.
- `classifier_version`.
- `taxonomy_version`.
- `input_hash`.
- `created_at`.

Constraints and indexes:

- unique current assignment `(message_id, message_type_id, assignment_state)`.
- index `(user_id, message_type_id, created_at desc)`.
- index `(user_id, message_type_id, confidence desc)`.

### Message Classification Features

Stores cheap, reusable features that support classification, dynamic type
discovery, search, and ranking without rereading raw body content.

Important fields on `message_features`:

- `message_id`.
- `user_id`.
- `sender_domain`.
- `sender_contact_id`.
- `list_id`, `list_unsubscribe_present`.
- `source_label_keys`: normalized provider/source labels.
- `directness`: `to`, `cc`, `bcc`, `list`, `unknown`.
- `bulk_hint`, `transactional_hint`, `security_hint`, `calendar_hint`.
- `entity_keys`: compact entity refs, such as merchant, school, airline, person.
- `action_kinds`: `reply`, `pay`, `schedule`, `sign`, `review`, `read`, etc.
- `deadline_at`: nullable normalized deadline.
- `text_hash`, `feature_version`.
- `updated_at`.

These are derived metadata. They should be compact and encrypted or tokenized
when needed, especially for entity keys that may contain sensitive values.

### User Behavior Signals

Dynamic classification should learn from what users see and respond to without
turning raw content into analytics exhaust.

Important fields on `message_user_events`:

- `id`.
- `user_id`.
- `message_id`.
- `source_connection_id`.
- `event_type`: `opened`, `brief_clicked`, `replied`, `archived`, `deleted`,
  `marked_done`, `marked_important`, `marked_not_important`, `marked_junk`,
  `rescued_from_junk`, `unsubscribed`, `searched_then_opened`.
- `created_at`.
- `metadata`: minimal ids/counts only.

Important fields on `message_type_stats`:

- `user_id`.
- `message_type_id`.
- `window_key`: `7d`, `30d`, `90d`, `all_time`.
- `messages_seen`, `opened`, `replied`, `marked_important`,
  `marked_not_important`, `marked_junk`, `brief_clicks`, `unsubscribes`.
- `last_message_at`, `last_positive_signal_at`.
- `updated_at`.

Stats inform ranking and type discovery. Raw interaction events should have a
retention policy; aggregate stats can live longer as user-owned personalization
state.

### Type Discovery

The type discovery worker proposes or updates user message types from observed
message clusters and behavior.

Inputs:

- sender/domain/list patterns
- source labels and folders
- semantic features and embeddings
- extracted entities and action kinds
- user behavior signals and feedback outcomes

Outputs:

- candidate `message_types`
- positive and negative example refs
- merge/split suggestions
- taxonomy version updates when accepted or auto-promoted

Auto-promotion should be conservative. Candidate types can be used internally as
features before they become visible user-facing categories.

### Classification Cursors

Tracks where each user's classification worker left off. This is separate from
source sync cursors.

Important fields:

- `user_id`.
- `pipeline`: `message-classification`, `enrichment`, `brief-input`, etc.
- `cursor_received_at`: oldest `received_at` reached during recent-first
  backfill.
- `cursor_message_id`: tie-breaker for stable paging.
- `last_batch_started_at`, `last_batch_completed_at`.
- `last_seen_new_message_at`.
- `classifier_version`.
- `status`: `idle`, `running`, `paused`, `error`.

Batch selection should prefer:

1. pending or stale messages with the newest `received_at`
2. failed messages whose `next_attempt_at` has passed
3. older backfill messages from the cursor

This keeps fresh mail useful quickly while allowing older backlog to progress
without blocking ingestion.

### Briefs

Generated brief artifacts are product state, not source state.

Important fields:

- `id`.
- `user_id`.
- `scope_type`: `all_sources` or `source`.
- `source_connection_id`: nullable for all-source briefs.
- `period_start`, `period_end`: supports daily per-source briefs and all-mail
  daily briefs.
- `trigger`: `post_ingest`, `scheduled_daily`, `manual`, `feedback_update`.
- `classification_cursor_snapshot`: cursor state used to generate the brief.
- `input_message_ids`.
- `text`, `narrative`, `callouts`, `counts`, `memory`.
- `model_provider`, `model`, `prompt_id`, `prompt_version`.
- `created_at`.

The main brief uses `scope_type = all_sources`. Per-source daily briefs use
`scope_type = source`.

### Feedback

Represents SaneMail-owned user feedback.

Examples:

- `important`
- `not-important`
- `junk`
- `not-junk`
- `needs-reply`
- `done`

Feedback does not write back to Gmail or any other source unless a future
explicit source-mutation feature is introduced.

## Ingestion Indexes

Minimum production indexes for fast sync:

- `source_connections(user_id, status)`.
- `source_sync_cursors(source_connection_id, cursor_kind)`.
- `message_source_refs(source_connection_id, provider_message_id)` unique.
- `message_source_refs(source_connection_id, source_internal_date desc)`.
- `messages(user_id, received_at desc, id desc)`.
- `messages(user_id, content_hash)`.
- `message_classification_state(user_id, state, priority_at desc, message_id)`.
- `message_classification_state(next_attempt_at)` for retry pickup.
- `message_types(user_id, status, updated_at desc)`.
- `message_type_assignments(user_id, message_type_id, created_at desc)`.
- `message_features(user_id, sender_domain)`.
- `message_features(user_id, list_id)`.
- `message_user_events(user_id, event_type, created_at desc)`.
- `message_type_stats(user_id, message_type_id, window)`.
- `briefs(user_id, scope_type, source_connection_id, period_end desc)`.

## Fast Ingestion Contract

The ingestion worker should:

1. Load the source connection and cursor.
2. Fetch only the provider delta or bounded backfill page.
3. Store raw/source payloads and safe extracted metadata.
4. Upsert `messages` and `message_source_refs` idempotently.
5. Mark classification state as `pending` or `stale` when relevant input changed.
6. Commit the source cursor after data writes succeed.
7. Emit ingestion events and schedule downstream classification/brief work.

The ingestion worker should not:

- call an LLM
- generate a brief
- wait for embeddings
- write source-specific state into canonical product fields except as normalized
  display/search metadata

## Security Notes

- OAuth tokens must be encrypted at rest.
- Source auth material should be referenced through `auth_secret_ref`, not stored
  in general application tables or job payloads.
- Raw payloads, extracted text, attachments, and AI-derived artifacts must be
  encrypted at rest.
- Source disconnect must delete tokens and derived mail data on request.
- Ingestion events and job logs should carry ids, hashes, counts, and error
  codes, not body content.

## Current Prototype Notes

Demo accounts may include `demo: true` so the UI can show local-only demo
actions instead of trying to sync Gmail.

The current MVP keeps source sync manual: `/api/sync/gmail` and
`/api/sync/mock` call the shared source-sync path directly, and the worker can
process the same path through a manually enqueued `source.sync` job. Automatic
post-ingest classification or brief jobs remain disabled unless
`QUEUE_AUTO_POST_INGEST_JOBS=true`.

## Demo Data

Local demo data is deterministic and can be reset without Gmail:

```sh
bun run demo:reset
```

The API also exposes:

```text
POST /api/demo/reset
```

This clears the local SaneMail store and repopulates it with a demo Gmail-shaped
account plus realistic personal, automated, receipt, notification, and junk-like
messages. It is used by the PWA E2E tests and by the Settings screen's
`Reset demo data` action.

## Planned: Sent Mail Ingestion

Today's Gmail sync only pulls received mail (the default Gmail query excludes
the `SENT` label). We want to extend ingestion to include messages the user
sent, so that we can compute meaningful per-contact engagement signals.

Motivation:

- The `contact_frequency` table tracks `received_count` and `sent_count` per
  `(user_id, contact_email)`. The **ratio of sent-to-received** is the
  strongest local signal for "people the user actively engages with" versus
  ignored mailing lists, transactional senders, and other noise. Without sent
  mail, `sent_count` stays at zero and the ratio is uninformative.
- Reply-rate features improve classification quality (downweight Today/Needs
  Reply for senders the user never replies to; upweight conversations where
  the user has replied recently).
- The brief and Today surfaces can prefer threads the user has historically
  participated in over equally-recent but one-sided threads.

What needs to change:

- `apps/api/src/source-sync.mjs`: run a second Gmail listing pass (or a single
  pass with a query that includes both `INBOX` and `SENT`) and feed the
  resulting messages through the same `upsertSyncedMessages` path.
- The ingest path already keys `contact_frequency` off whether `from_addr`
  matches the source connection's `source_email`, so once `SENT` messages
  flow in, `sent_count` and `last_sent_at` will populate automatically.
- Consider stamping outbound messages on `messages` (e.g. a `direction`
  column or derived view) so product surfaces can filter or color-code them
  without re-parsing addresses.
- Backfill existing connections: a one-time job that pulls historical SENT
  messages for already-connected accounts, bounded by the user's existing
  ingestion window.

OAuth scope check: the existing `gmail.readonly` scope already covers reading
SENT mail, so no additional consent is required.
