# AI Control Plane

SaneMail's AI loop is now explicit local product infrastructure. The current
provider is deterministic, but the shape is meant to match a real LLM and
recsys pipeline so we can swap in Ollama or another hosted model later.

## What Exists Now

- prompt registry with pinned versions and SHA-256 hashes
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
- computed `hash`

The hash is included in every AI run and verification run. This gives us a
stable join key when a ranking decision changes because prompt text, schema, or
model settings changed.

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
