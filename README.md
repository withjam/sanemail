# SaneMail

SaneMail is an experimental personal email client that starts as a read-only
intelligence layer over Gmail. It syncs messages into SaneMail-owned state and
builds calmer views without changing the user's Gmail mailbox.

## Current MVP

- Bun workspace with a JSON API and React PWA.
- Gmail read-only OAuth flow.
- Manual recent-message sync.
- Local JSON development store.
- `All Mail` view with virtualized message list.
- First-pass `Today` view.
- Message rationale and feedback buttons.
- AI Ops view with prompt versions, local run traces, Phoenix status, and synthetic verification.
- Local disconnect/delete flow.
- PWA manifest, service worker, and persisted query cache.

## Prerequisites

- Bun 1.3 or newer.
- Optional: Docker Desktop or another Docker daemon for container runs.

## Run Locally

From the repo root:

```sh
cd /Users/ruckus/workspace/sanemail
```

Install dependencies:

```sh
bun install
```

Run the local verification suite:

```sh
bun run check
bun run test
bun run smoke
bun run ai:verify
bun run e2e
bun run verify
```

Start with demo mail:

```sh
bun run seed
bun run dev
```

Open:

```text
http://localhost:5173
```

The API runs at `http://localhost:3000`. The React PWA runs at
`http://localhost:5173` in development.

The seed command creates a deterministic 200-message golden mailbox so the UI
can be tested without Gmail credentials. It is synced from a local `mock` source
connection, so it follows the same source-ingestion shape as real mail.

Reset local data back to the deterministic 200-message demo mailbox:

```sh
bun run demo:reset
```

Seed or resync the synthetic development mailbox without clearing existing local
state:

```sh
curl -X POST http://localhost:3000/api/sync/mock
```

That endpoint runs a manual source sync against the local `mock` source. The
same sync logic is also available to the queue worker through the `source.sync`
job, which lets us exercise async ingestion without turning on automatic queue
chaining.

Run the local AI loop and synthetic verification suite:

```sh
bun run ai:run
bun run ai:verify
bun run ai:eval
```

`bun run ai:run` defaults to a cold-start briefing over the local mailbox for
repeatable dev/eval output. Use `bun apps/api/src/ai-run.mjs --mode=iterative`
to test the memory-aware briefing flow.

Prompt/model changes are evaluated as immutable AI contracts: each prompt has a
prompt hash, model-binding hash, and combined contract hash. `bun run ai:eval`
checks golden behavior plus eval coverage for every prompt contract.

Run the local development queue worker:

```sh
bun run worker
```

The prototype queue is dependency-free and stored in `data/sanemail.json` under
`queueJobs`. It mirrors the production job names we expect to run with a
Postgres-backed queue later: `source.sync`, `classification.batch`,
`message-types.discover`, and `brief.generate`.

Queue work is manual by default. The API will not automatically enqueue
post-ingest classification or brief jobs unless `QUEUE_AUTO_POST_INGEST_JOBS`
is set to `true`; leave it `false` while we are validating fast, secure source
sync. To start the worker alongside `bun run dev`, set:

```sh
QUEUE_WORKER_ENABLED=true bun run dev
```

To use your Docker Postgres as the queue backend, set:

```sh
QUEUE_DRIVER=graphile-worker QUEUE_WORKER_ENABLED=true bun run dev
```

Or keep the API and worker as separate processes:

```sh
QUEUE_DRIVER=graphile-worker bun run dev
QUEUE_DRIVER=graphile-worker bun run worker
```

Use Ollama Cloud with DeepSeek V4 Pro:

```sh
ollama pull deepseek-v4-pro:cloud
AI_PROVIDER=ollama OLLAMA_MODEL=deepseek-v4-pro:cloud OLLAMA_THINK=false OLLAMA_TEMPERATURE=0 bun run ai:run
AI_PROVIDER=ollama OLLAMA_MODEL=deepseek-v4-pro:cloud OLLAMA_THINK=false OLLAMA_TEMPERATURE=0 bun run dev
```

Classification can use a separate fast model while the daily brief keeps the
main reasoning model:

```sh
OLLAMA_CLASSIFICATION_MODEL=your-fast-classifier-model OLLAMA_CLASSIFICATION_THINK=false bun run worker
```

Send local AI traces to Phoenix:

```sh
PHOENIX_ENABLED=true bun run ai:run
PHOENIX_ENABLED=true bun run ai:verify
```

Useful routes:

```text
http://localhost:5173/
http://localhost:5173/today
http://localhost:5173/mail
http://localhost:5173/ai
http://localhost:5173/settings
```

See [docs/local-testing.md](/Users/ruckus/workspace/sanemail/docs/local-testing.md)
for more testing detail.

See [docs/ai-control-plane.md](/Users/ruckus/workspace/sanemail/docs/ai-control-plane.md)
for the current AI loop, prompt control, instrumentation, and verification
contract.

See [docs/gmail-ai-security.md](/Users/ruckus/workspace/sanemail/docs/gmail-ai-security.md)
for the current Gmail AI security and model-provider policy.

When using `bun run dev`, SaneMail enables local Phoenix tracing by default and
exports to the `Sanemail` project at `http://localhost:6006`. Set
`PHOENIX_ENABLED=false` to run without Phoenix.

## Gmail OAuth

Create a `.env` file from `.env.example`:

```sh
cp .env.example .env
```

For local Postgres running in Docker, set either `DATABASE_URL` directly:

```text
DATABASE_URL=postgres://postgres:your_password@127.0.0.1:5432/sanemail
```

or set the parts and let the API build the URL:

```text
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432
POSTGRES_DB=sanemail
POSTGRES_USER=postgres
POSTGRES_PASSWORD=your_password
```

`QUEUE_DATABASE_URL` is optional; leave it blank to reuse `DATABASE_URL` when we
switch the queue driver from `local-json` to a Postgres-backed worker.

To run the app data store on Postgres instead of `data/sanemail.json`, set:

```text
STORE_DRIVER=postgres
APP_SECRET=replace_with_a_long_random_secret
```

`APP_SECRET` is required before SaneMail stores Gmail OAuth tokens or Postgres
message bodies. Use a stable local value; changing it makes previously encrypted
local tokens and message bodies unreadable. `ENCRYPTION_KEY` may be used instead
when you want to manage a raw 32-byte key directly.

Graphile Migrate uses the same database settings. For local development it also
uses a shadow database so it can validate migrations before committing them:

```text
POSTGRES_SHADOW_DB=sanemail_shadow
POSTGRES_ROOT_DB=postgres
SHADOW_DATABASE_URL=
ROOT_DATABASE_URL=
```

Leave `SHADOW_DATABASE_URL` and `ROOT_DATABASE_URL` blank for Docker Postgres;
the scripts derive them from `DATABASE_URL` or the `POSTGRES_*` parts.

Bootstrap the app schema:

```sh
bun run db:bootstrap
```

This creates the main and shadow databases when needed, then applies
committed migrations plus `migrations/current.sql`. While iterating on the
schema, run:

```sh
bun run db:watch
```

When a schema change is ready to become a durable migration:

```sh
bun run db:commit --message "describe the change"
bun run db:migrate
```

`bun run db:reset:dev` is destructive and should only be used against disposable
local databases.

For Gmail OAuth, set:

```text
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth/google/callback
WEB_ORIGIN=http://localhost:5173
```

The app requests only:

```text
https://www.googleapis.com/auth/gmail.readonly
```

For local OAuth testing:

1. Create or choose a Google Cloud project.
2. Enable the Gmail API.
3. Configure the OAuth consent screen.
4. Create an OAuth client for a web application.
5. Add `http://localhost:3000/oauth/google/callback` as an authorized redirect URI.
6. Add your Gmail account as a test user if the app is still in testing mode.
7. Start the app with `bun run dev`.
8. Start OAuth from `http://localhost:5173/settings` or `http://localhost:5173/`.

Do not open `/oauth/google/callback` directly. That route is only valid after
Google redirects back with a short-lived OAuth `code` and SaneMail's generated
`state` value.

See [docs/gmail-oauth-setup.md](/Users/ruckus/workspace/sanemail/docs/gmail-oauth-setup.md)
for the longer OAuth setup notes.

## Important Boundary

The MVP does not write back to Gmail. It does not create labels, archive mail,
mark messages read, send mail, or delete mail in Gmail. SaneMail-owned feedback
and curation state lives only in the local SaneMail store.

## Development Data

Local development data is stored in:

```text
data/sanemail.json
```

This file is ignored by git. Use Settings -> Disconnect to clear local data from
the running app.

Set `DATA_DIR` to isolate local runs or tests:

```sh
DATA_DIR=/tmp/sanemail bun run dev
```

To clear local app data from the UI, open Settings and choose
`Disconnect and delete local data`. This does not change Gmail.

To repopulate the local 200-message golden mailbox from the UI, open Settings
and choose `Reset demo data`. The topbar `Sync demo` action resyncs the mock
source without clearing other local state.

## Docker

The MVP currently runs as one app process. Start Docker Desktop or another
Docker daemon first.

Docker Compose:

```sh
docker compose build
docker compose run --rm sanemail bun run seed
docker compose up
```

Open:

```text
http://localhost:3000
```

The Compose run stores local app data in the named volume `sanemail-data`.

Plain Docker:

```sh
docker build -t sanemail .
docker run --rm -p 3000:3000 -v sanemail-data:/data sanemail
```

Seed demo data into the same Docker volume:

```sh
docker run --rm -v sanemail-data:/data sanemail bun run seed
```

Later, as we add Postgres, queues, workers, object storage, and vector search,
Docker Compose should expand into separate services for those planes.

## Troubleshooting

- `Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET`: seeded demo mode still works,
  but Gmail OAuth needs `.env` credentials.
- `Invalid OAuth callback`: start from `/connect/gmail` instead of opening the
  callback URL directly. In dev, use the buttons in the React app at
  `http://localhost:5173`.
- `listen EPERM` or port issues: make sure nothing else is using port 3000, or
  set `PORT` and `APP_ORIGIN` together.
- Docker build/run issues: start Docker Desktop or another Docker daemon first.
