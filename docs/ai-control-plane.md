# AI Control Plane

SaneMail's AI loop is now explicit local product infrastructure. The current
provider is deterministic, but the shape is meant to match a real LLM and
recsys pipeline so we can swap in Ollama or another hosted model later.

## What Exists Now

- prompt registry with pinned versions, model bindings, and SHA-256 contract
  hashes
- eval registry that asserts every prompt contract has test coverage
- golden prompt records for aggregate summary and category-breakdown evals
- persisted briefing history so each AI run can see the previous briefing
- AI run records with prompt refs, input hashes, spans, model metadata, scores,
  extracted actions, synthetic embeddings, and ranking decisions
- synthetic verification suite over the 200-message demo mailbox
- optional Arize Phoenix/OpenInference tracing for local observability
- AI Ops PWA route at `/ai`
- API endpoints for control, run history, and verification history

## Local Commands

Run the AI loop against whatever is in the local store:

```sh
bun run ai:run
```

Run the AI loop with Ollama Cloud / DeepSeek:

```sh
ollama pull deepseek-v4-pro:cloud
AI_PROVIDER=ollama OLLAMA_MODEL=deepseek-v4-pro:cloud OLLAMA_THINK=high bun run ai:run
```

Run the synthetic verification suite without writing to local app state:

```sh
bun run ai:verify
bun run ai:eval
```

Persist a verification run into `data/sanemail.json`:

```sh
bun apps/api/src/ai-verify.mjs --persist
```

Send a CLI run to local Phoenix:

```sh
PHOENIX_ENABLED=true bun run ai:run
PHOENIX_ENABLED=true bun run ai:verify
```

Run the PWA/API with Ollama as the runtime AI provider:

```sh
AI_PROVIDER=ollama OLLAMA_MODEL=deepseek-v4-pro:cloud OLLAMA_THINK=high bun run dev
```

## API Surface

```text
GET  /api/ai/control
GET  /api/ai/runs
GET  /api/ai/verification
POST /api/ai/run
POST /api/ai/verify
```

`POST /api/ai/run` records a mailbox curation run. `POST /api/ai/verify`
records an eval run over deterministic synthetic mail.

## Prompt Control

Prompts live in:

```text
apps/api/src/ai/prompts.mjs
```

Every prompt has:

- `id`
- `version`
- `stage`
- `provider`
- `model`
- `temperature`
- `responseSchema`
- `system`
- `userTemplate`
- computed `promptHash`
- computed `modelBindingHash`
- computed `contractHash`

The prompt hash tracks prompt text, variables, and response schema. The
model-binding hash tracks provider, model, temperature, and future runtime
knobs. The contract hash combines both. AI runs and verification runs record the
contract hash so a prompt edit or a model change is treated as the same kind of
reviewable AI behavior change.

Eval definitions live in:

```text
apps/api/src/ai/evals.mjs
```

`bun run ai:eval` currently checks:

- deterministic per-message classification, extraction, and ranking behavior
- golden briefing and carry-over behavior
- coverage for every registered prompt contract, including
  `mail-classification-batch`

This is the local version of the industry-standard loop: pin a prompt/model
contract, run deterministic and golden evals on every change, record traces, and
only promote the contract when the evals pass.

## Queue-Backed Classification Flow

SaneMail should not use a pile of cron jobs for ingestion and classification.
The production flow should use a durable queue, with jobs enqueued by source
events and by completed work. Because the durable backend is already moving to
Postgres, the default queue choice should be Postgres-backed, such as Graphile
Worker or pg-boss. That keeps source cursors, classification backlog state, and
job dedupe in one transactional system. BullMQ/Redis remains a reasonable later
choice if queue throughput needs to scale independently from Postgres.

The queue payloads must contain ids, cursors, versions, and reasons only. They
must not contain raw email bodies, extracted body text, attachments, or full LLM
prompt inputs.

Current local development starts with a free `local-json` queue stored in
`data/sanemail.json`. It is a compatibility scaffold, not the production queue.
Run it with `bun run worker`, or set `QUEUE_WORKER_ENABLED=true` when running
`bun run dev`.

Automatic queue chaining is intentionally disabled for the current MVP. Manual
source sync endpoints update app storage immediately, and manually enqueued
`source.sync` jobs use the same sync path through the worker. Set
`QUEUE_AUTO_POST_INGEST_JOBS=true` only when we are ready for source sync to
enqueue downstream classification and brief work automatically.

To use Postgres/Graphile Worker instead, set `QUEUE_DRIVER=graphile-worker` and
configure `DATABASE_URL` or `POSTGRES_HOST`/`POSTGRES_PORT`/`POSTGRES_DB`/
`POSTGRES_USER`/`POSTGRES_PASSWORD`. The same `bun run worker` command then uses
Graphile Worker's Postgres queue.

Core jobs:

- `source.sync`: sync one source connection from the latest source cursor.
- `classification.batch`: classify the newest pending/stale messages for one
  user and classifier version.
- `message-types.discover`: propose or update dynamic user message types from
  repeated clusters and behavior signals.
- `brief.generate`: generate or refresh an all-source or source-scoped brief
  after classification has produced enough fresh state.

Queue chaining:

1. Gmail watch, fallback polling, manual sync, or backfill enqueues
   `source.sync`.
2. `source.sync` upserts canonical messages and source refs, updates the source
   cursor, marks changed messages as `pending` or `stale`, and, when automatic
   post-ingest jobs are enabled, enqueues `classification.batch` for the owning
   user.
3. `classification.batch` claims a recent-first batch from
   `message_classification_state`, runs the classification chain, persists
   `message_classifications`, `message_type_assignments`, `message_features`,
   and retry state, then enqueues `brief.generate`.
4. If the batch creates enough candidate type evidence or feedback thresholds
   changed, it enqueues `message-types.discover`.
5. `brief.generate` reads classified state, debounces repeated requests per
   user/scope, and writes a new brief.

Concurrency rules:

- `source.sync` should be serialized per `source_connection_id`.
- `classification.batch` should be serialized per `(user_id, classifier_version)`
  at first; later it can use small per-user concurrency if row claiming is
  robust.
- `brief.generate` should be debounced per `(user_id, scope_type,
  source_connection_id)` so bursts of ingested mail do not create many brief
  jobs.
- Failed jobs use exponential retry with a dead-letter state after the retry
  budget is exhausted.

Classification batch selection:

```sql
select message_id
from message_classification_state
where user_id = $1
  and classifier_version = $2
  and state in ('pending', 'stale', 'failed')
  and (next_attempt_at is null or next_attempt_at <= now())
order by
  case when state in ('pending', 'stale') then 0 else 1 end,
  priority_at desc,
  message_id desc
limit $3
for update skip locked;
```

This gives us recent-first behavior without cron. The presence of pending work is
the scheduler.

## Classification Chain

The first production classification chain should be a single batch LLM call
surrounded by deterministic pre/post-processing:

1. Load active user taxonomy, source refs, existing feedback, and aggregate type
   stats.
2. Build compact per-message features from headers/source metadata/body excerpt:
   sender domain, list id, source labels, directness, bulk/security/transactional
   hints, action cues, deadlines, and entity keys.
3. Render `mail-classification-batch` with messages newest-first, the taxonomy,
   policy, and user signals.
4. Validate the structured JSON response against the schema.
5. Reconcile type assignments against the user's taxonomy. Unknown types become
   candidate suggestions unless they exactly match an accepted type alias.
6. Persist versioned classification output and current assignment rows.
7. Enqueue brief generation and optional type discovery work.

The model should return:

- stable `systemCategory`
- attention flags and score
- compact reasons
- extracted action/entity/deadline metadata
- ranked user message-type assignments
- candidate type suggestions with evidence

The current prompt registry includes `mail-classification-batch` as the target
prompt for this queue worker. The older per-message `mail-triage`, `mail-extract`,
and `mail-rank` prompts remain useful for deterministic local verification and
for fallback or eval slices.

## Instrumentation

AI runs are stored in the local JSON store under `aiRuns`. Verification runs
are stored under `verificationRuns`.

Generated inbox briefings are also copied into `inboxBriefings`. The next AI run
uses the latest stored briefing as prior context so still-relevant reminders can
be carried forward instead of disappearing between refreshes.

Briefings are structured for the UI, not just emitted as one paragraph. The
record keeps a conversational `narrative` for the homepage answer and `callouts`
with message IDs for specific emails that should become smart links.

For privacy, run inputs record hashes instead of full message bodies. The
decision output still includes enough product-facing metadata for local
debugging, such as subject, sender, category, score, and extracted action cues.

Current spans:

- `mailbox.collect`
- `prompt.resolve`
- `model.mock_inference`
- `recsys.rank`

## Phoenix

Local dev can export OpenInference/OpenTelemetry traces to Arize Phoenix. The
dev script enables Phoenix by default and points at the standard local endpoint:

```text
PHOENIX_ENABLED=true
PHOENIX_PROJECT_NAME=Sanemail
PHOENIX_COLLECTOR_ENDPOINT=http://localhost:6006
```

Open Phoenix at:

```text
http://localhost:6006
```

Every AI run emits a root trace named `sanemail.ai.mailbox_curation` with child
spans for collection, prompt resolution, mock inference, ranking, synthetic
embedding summary, and per-message decision summaries. Every verification run
emits `sanemail.ai.synthetic_verification` with one child span per eval case.

SaneMail treats Phoenix as observability, not product state. The local JSON store
remains the source of truth for runs and feedback. Phoenix receives trace
metadata for debugging and comparison.

Privacy defaults:

```text
OPENINFERENCE_HIDE_INPUTS=true
OPENINFERENCE_HIDE_INPUT_MESSAGES=true
OPENINFERENCE_HIDE_EMBEDDINGS_VECTORS=true
PHOENIX_ALLOW_SENSITIVE_CONTENT=false
```

We send hashes, scores, categories, prompt hashes, and short derived labels. Raw
email bodies are not sent to Phoenix unless we deliberately change that policy.

## Ollama Provider

The production-shaped provider switch is:

```text
AI_PROVIDER=mock | ollama
```

Ollama defaults:

```text
OLLAMA_HOST=http://127.0.0.1:11434
OLLAMA_MODEL=deepseek-v4-pro:cloud
OLLAMA_THINK=high
OLLAMA_TEMPERATURE=0
AI_TIMEOUT_MS=120000
AI_MAX_RETRIES=2
AI_RUN_LIMIT=12
AI_FALLBACK_TO_MOCK=true
```

`AI_PROVIDER=mock` remains the default because live personal email content should
not be sent to a remote model by accident. Once you explicitly set
`AI_PROVIDER=ollama`, each message is sent through Ollama's `/api/chat` endpoint
with `format: "json"` and the configured `think` value. If Ollama returns a
transient 429/5xx error, SaneMail retries and then falls back to the deterministic
mock decision when `AI_FALLBACK_TO_MOCK=true`.

The run record captures:

- requested provider and model
- resolved provider and model
- thinking character count
- prompt/eval token counts reported by Ollama
- fallback errors, if any
- Phoenix trace ID when tracing is enabled

This lets us inspect real model behavior in Phoenix while keeping deterministic
mock verification as a stable regression baseline.

## Verification

The initial suite checks the local AI loop against synthetic cases for:

- human action requests
- deadlines
- automated FYI mail
- scam-like security messages
- spam-labeled gift card lures
- day-summary briefing output
- day-summary carry-over from the previous briefing
- linked attention callouts for specific messages
- aggregate category breakdown counts and anchor-message categories

Aggregate golden records live in `apps/api/src/ai/golden-records.mjs`. Each
record points at the synthetic feature set, the prompt IDs it is meant to score,
the expected prompt input shape, and the expected output contract.

The suite currently requires a perfect score. That is intentionally strict while
the system is deterministic; once a real model is added, we can split checks into
hard gates and trend metrics.

## Next Step: Real Provider

The provider seam is `apps/api/src/ai/pipeline.mjs`. A real Ollama-backed
provider should keep the same run contract:

- prompt refs and hashes
- model/provider settings
- input hashes
- latency and token estimates or actuals
- status and error fields
- decision output schema
- verification compatibility

Monitoring should come after this: once the loop emits stable traces and evals,
we can add background checks, alert thresholds, and trend dashboards without
changing the product logic.
