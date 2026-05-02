# SaneMail MVP Build Plan

## Goal

Build the smallest useful SaneMail loop:

Connect Gmail read-only, ingest recent messages into SaneMail-owned storage,
show a faithful `All Mail` view, and generate a first rough `Today` view without
writing anything back to Gmail.

## Constraints

- Gmail is read-only for MVP.
- SaneMail owns all product state.
- Gmail ids, labels, and mailbox changes are source signals, not product state.
- No model choice is exposed to users.
- The first build should run locally before we add infrastructure complexity.

## Milestone 1: Local Ingestion Spine

Status: locally implemented.

Deliverables:

- Local web app shell.
- Gmail OAuth read-only redirect and callback.
- Token storage for local development.
- Manual sync endpoint for recent Gmail messages.
- Message parser for headers and plain text body extraction.
- Local SaneMail store.
- `All Mail` view.
- `Today` view using deterministic heuristics.
- Config docs for Gmail OAuth credentials.
- Local disconnect/delete flow.
- Seed data command for development UI verification.

Success criteria:

- A developer can run the app locally.
- A test user can connect Gmail using `gmail.readonly`.
- The app can sync recent messages.
- Synced messages appear in SaneMail without changing Gmail.
- `Today` produces a plausible first pass from SaneMail-owned state.

Progress:

- [x] Added dependency-free Node server.
- [x] Added Gmail OAuth read-only route and callback.
- [x] Added Gmail API sync for recent messages.
- [x] Added Gmail MIME/header/body normalization.
- [x] Added local JSON store under `data/sanemail.json`.
- [x] Added SaneMail-owned feedback capture.
- [x] Added All Mail view.
- [x] Added Today view with deterministic first-pass ranking.
- [x] Added message detail with rationale.
- [x] Added local disconnect/delete.
- [x] Added seed data.
- [x] Added setup docs.
- [x] Added local `.env` loading with no external dependency.
- [x] Added unit tests for classifier, Gmail normalization, and store behavior.
- [x] Added isolated HTTP smoke test.
- [x] Added Dockerfile and Docker Compose for local MVP runs.
- [x] Documented shell vs Docker local testing.
- [x] Verified syntax with `npm run check`.
- [x] Verified full local suite with `npm run verify`.
- [x] Verified seeded UI pages return HTTP 200.
- [x] Verified Docker Compose config renders successfully.
- [ ] Verify Docker build and Compose run locally.
- [ ] Verify real Gmail OAuth with configured Google credentials.
- [ ] Replace local token storage with encrypted production storage.

## Milestone 2: Durable Backend Shape

Status: pending.

Deliverables:

- Replace local JSON store with Postgres.
- Add schema migrations.
- Add sync cursors and provider-account tables.
- Add idempotent sync job contract.
- Add delete/disconnect data flow.

## Milestone 3: Real React PWA App

Status: locally implemented.

Deliverables:

- Bun-powered TypeScript workspace.
- `apps/api` for Gmail OAuth, sync, storage, and JSON API routes.
- `apps/web` for Vite React PWA.
- TanStack Router routes for `Today`, `All Mail`, message detail, and settings.
- TanStack Query for API cache, mutations, and optimistic feedback.
- PWA manifest and service worker.
- Persisted query cache for offline continuity.
- Mobile viewport smoke tests.

See [frontend-stack.md](/Users/ruckus/workspace/sanemail/docs/frontend-stack.md).

Progress:

- [x] Added Bun workspace layout under `apps/` and `packages/`.
- [x] Moved the existing ingestion/API logic under `apps/api`.
- [x] Replaced server-rendered UI with JSON API routes.
- [x] Added Vite React app under `apps/web`.
- [x] Added TanStack Router routes for home, Today, All Mail, message detail, and settings.
- [x] Added TanStack Query for API cache, sync, disconnect, and feedback mutations.
- [x] Added query persistence for offline-ish desktop/mobile continuity.
- [x] Added PWA manifest and generated service worker via `vite-plugin-pwa`.
- [x] Added responsive app layout with virtualized All Mail list.
- [x] Retired the old `render.mjs` UI.
- [x] Verified React typecheck and production build.
- [x] Verified API/static smoke test with seeded data.
- [x] Added browser-level Playwright E2E coverage for desktop and mobile PWA flows.
- [x] Added deterministic demo reset function, command, and API endpoint.
- [ ] Add IndexedDB/Dexie body cache for richer offline mail access.
- [ ] Add mobile installability and Lighthouse checks.

## Milestone 4: Near-Real-Time Sync

Status: pending.

Deliverables:

- Gmail `watch` setup.
- Cloud Pub/Sub webhook.
- History-based partial sync.
- Fallback polling.
- Full resync recovery when Gmail history cursor expires.

## Milestone 5: Intelligence Layer

Status: pending.

Deliverables:

- Body cleaning and quoted reply trimming.
- Classifier pipeline for human/bulk/junk/action-needed.
- Embeddings for semantic search and clustering.
- Thread summaries and action extraction.
- Feedback capture for personalization.

## Milestone 6: Product Trust

Status: pending.

Deliverables:

- Explain view for every surfaced item.
- Privacy and data deletion UI.
- OAuth disclosure copy.
- Google restricted-scope verification packet.
- Security review checklist.

## Current Execution Notes

- Start dependency-free with Node's built-in HTTP server and `fetch`.
- Use local JSON storage under `data/` for the first runnable spine.
- Keep OAuth and Gmail API code isolated so it can later move behind workers.
- Avoid Gmail mutation entirely.
