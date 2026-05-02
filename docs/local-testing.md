# Local Testing

The MVP can be tested entirely without Gmail credentials. Gmail OAuth is a
manual integration check once Google credentials are configured.

## Test Levels

### Syntax Check

```sh
bun run check
```

Runs `node --check` over the app, test, and script files.

### Unit Tests

```sh
bun run test
```

Uses Node's built-in test runner through the package script. Current coverage:

- classifier behavior
- Gmail message normalization
- local store idempotency and feedback capture
- AI prompt hashing, local AI loop instrumentation, and synthetic verification

### AI Verification

```sh
bun run ai:verify
```

Runs the synthetic mailbox eval without writing to local app state. The current
suite checks action requests, deadlines, automated FYI mail, and scam/spam
routing.

### HTTP Smoke Test

```sh
bun run smoke
```

Builds the React PWA, creates an isolated temp data directory, seeds demo mail,
starts the API on a random local port, and checks:

- built app shell at `/`
- `/api/status`
- `/api/messages`
- `/api/today`
- `/api/ai/control`
- `/api/ai/run`
- `/api/ai/verify`

The smoke test verifies that the seeded human action item appears in the Today
API and the seeded scam-like message does not.

### PWA E2E Test

```sh
bun run e2e
```

Builds the React PWA, starts the API on an isolated local port with `.e2e-data`,
resets demo data through `/api/demo/reset`, and drives the real app in
Playwright desktop Chromium and a mobile Chrome viewport.

The E2E covers:

- dashboard counts
- Today filtering
- All Mail visibility
- message detail navigation
- feedback submission
- AI Ops prompt visibility
- AI loop run recording
- synthetic verification from the PWA
- local data deletion
- demo data reset

If Chromium has not been installed for Playwright yet:

```sh
bun run --cwd apps/web playwright install chromium
```

### Full Local Verification

```sh
bun run verify
```

Runs syntax checks, unit tests, synthetic AI verification, and the HTTP smoke
test.

## Manual Shell Run

```sh
bun run seed
bun run dev
```

Open:

```text
http://localhost:5173
```

This starts the API on `http://localhost:3000` and the React PWA on
`http://localhost:5173`.

Reset demo data at any time:

```sh
bun run demo:reset
```

Then open AI Ops:

```text
http://localhost:5173/ai
```

## Docker Run

The Docker version runs the same single-process MVP in a container.
Start Docker Desktop or another Docker daemon first.

```sh
docker build -t sanemail .
docker run --rm -p 3000:3000 -v sanemail-data:/data sanemail
```

Seed demo data into the same Docker volume:

```sh
docker run --rm -v sanemail-data:/data sanemail bun run seed
```

## Docker Compose

Start Docker Desktop or another Docker daemon first.

```sh
docker compose build
docker compose run --rm sanemail bun run seed
docker compose up
```

Compose uses the named volume `sanemail-data` for local app data.

## Gmail OAuth Integration Check

After setting Google credentials in `.env` or shell environment:

```sh
bun run dev
```

Then visit:

```text
http://localhost:5173/settings
```

For Docker Compose, put credentials in `.env`:

```text
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth/google/callback
```

Then:

```sh
docker compose up --build
```

## Local Plane Strategy

In development, the app uses two local processes:

- control plane: config, OAuth setup, settings
- data plane: Gmail sync, storage, classification
- serving plane: API on port 3000 and React PWA on port 5173

The Docker production-style run serves the built PWA from the API process. The
next split should happen
when we add durable infrastructure:

- Postgres for metadata and product state
- object storage for raw/source payloads
- queue/worker process for sync and enrichment
- vector store for embeddings

At that point Docker Compose should grow into separate services. Until then, the
production-style Docker run keeps the app simple by serving the built PWA from
the API process.
