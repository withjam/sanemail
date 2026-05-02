# AI Control Plane

SaneMail's AI loop is now explicit local product infrastructure. The current
provider is deterministic, but the shape is meant to match a real LLM and
recsys pipeline so we can swap in Ollama or another hosted model later.

## What Exists Now

- prompt registry with pinned versions and SHA-256 hashes
- AI run records with prompt refs, input hashes, spans, model metadata, scores,
  extracted actions, synthetic embeddings, and ranking decisions
- synthetic verification suite over the demo mailbox
- AI Ops PWA route at `/ai`
- API endpoints for control, run history, and verification history

## Local Commands

Run the AI loop against whatever is in the local store:

```sh
bun run ai:run
```

Run the synthetic verification suite without writing to local app state:

```sh
bun run ai:verify
```

Persist a verification run into `data/sanemail.json`:

```sh
bun apps/api/src/ai-verify.mjs --persist
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

For privacy, run inputs record hashes instead of full message bodies. The
decision output still includes enough product-facing metadata for local
debugging, such as subject, sender, category, score, and extracted action cues.

Current spans:

- `mailbox.collect`
- `prompt.resolve`
- `model.mock_inference`
- `recsys.rank`

## Verification

The initial suite checks the local AI loop against synthetic cases for:

- human action requests
- deadlines
- automated FYI mail
- scam-like security messages
- spam-labeled gift card lures

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
