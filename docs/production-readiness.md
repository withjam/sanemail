# Path to Production Server Readiness

This document tracks what's required to move SaneMail from a single-user local
prototype to a beta-capable, multi-tenant deployment on Fly.io. It is the
working plan, not aspirational design — each section identifies the current
gap, the target state, and the change needed.

## Target Stack

- **Compute:** Fly.io (single image, two processes: `web` + `worker`).
- **Database:** Neon Postgres (pooled for `web`, direct for `worker`).
- **Auth:** Supabase Auth (JWT issuer; we verify tokens, we do not store them).
- **Mail Provider OAuth:** Google OAuth 2.0 client owned by our Google Cloud
  project; user access/refresh tokens stored encrypted in Neon.
- **LLM:** Ollama Cloud (or equivalent hosted endpoint).
- **Static web app:** served by the same Fly app from `apps/web/dist`.
- **Local development:** unchanged. Same image, `.env` instead of Fly secrets,
  optional local Postgres or a Neon dev branch.

## Single-Tenant Assumptions to Remove

The current server picks `store.accounts[0]` everywhere. Every route, every
store helper, and every AI pipeline call assumes one account. Multi-tenancy
requires removing that assumption end to end.

Specific call sites to refactor:

- `apps/api/src/server.mjs` — every `routeStatus`, `routeHome`, `routeMessages`,
  `routeToday`, `routeMessage`, `routeAiControl`, `routeSyncGmail`,
  `routeSyncMock`, `routeAiIngestionSynthesize`, `routeAiClassifyUnclassified`,
  `routeAiRun`, `routeDisconnect`, `routeDemoReset`.
- `apps/api/src/store.mjs` — `getPrimaryAccount`, `readStore`, all of the
  classification-state and inbox-briefing helpers.
- `apps/api/src/ai/pipeline.mjs` — `runDailyBrief`, `runClassificationBatch`
  scope-by-account.
- `apps/api/src/source-sync.mjs` and `apps/api/src/post-ingest-jobs.mjs` —
  scoped to a `userId` + `sourceConnectionId`.

The contract becomes: **every request and every job carries a `userId`**, and
every query filters by it. There is no implicit "the account."

## Authentication and Authorization

### Current state

- No auth on `/api/*`. Anyone who reaches the URL gets the first account's
  inbox.
- OAuth state for the Gmail connect flow is the only thing protected, and only
  against CSRF on that one redirect.

### Target state

- **Supabase Auth** issues JWTs. The web app keeps the session via the Supabase
  JS client. The API verifies `Authorization: Bearer <jwt>` on every `/api/*`
  request using Supabase's JWKS.
- Verified `sub` (Supabase user UUID) becomes our canonical `user_id`. We
  persist a row in our own `users` table on first sight to attach app-side
  metadata (preferences, plan, etc.) without coupling to Supabase tables.
- **Authorization:** every store helper takes `userId` and queries scope by it.
  No global "get the first account" function survives.
- **CSRF:** mutations require either the bearer token (default for our SPA) or
  a same-site cookie + Origin allowlist if we ever add cookie auth.
- **CORS:** allowlist driven by `WEB_ORIGIN`. Reject everything else. Today
  there is no CORS handling at all.
- **Rate limiting:** per-user token bucket on AI routes (`/api/ai/run`,
  `/api/ai/verify`, `/api/ai/ingestion/*`) and per-IP on the OAuth callback.
  Memory-backed is fine for one Fly machine; Postgres-backed counter when we
  scale beyond one.
- **Body size limit:** `parseJsonBody` in `server.mjs` reads the entire request
  with no cap. Add a 1 MB ceiling and 10s read timeout.

### Implementation order

1. Add `verifySupabaseJwt(request)` middleware. Reject unauth'd `/api/*`
   except `/api/status` (public health-ish).
2. Introduce a `users` table; upsert on first authenticated request.
3. Refactor `store.mjs` and `postgres-store.mjs` to take `userId` on every
   read/write. Delete every `store.accounts[0]` access.
4. Refactor every route to pull `userId` from the verified JWT and pass it
   through.
5. Add CORS allowlist, body-size cap, request timeout, rate limit.

## Storage: Move Off the JSON File

### Current state

- Default `STORE_DRIVER=json` writes everything (accounts, messages, threads,
  classification state, AI runs, briefings, queue jobs, OAuth states, events,
  feedback, verification runs) to `data/sanemail.json`.
- `mutateStore` in `apps/api/src/store.mjs` does `read → mutate → write`
  with no lock. Two concurrent requests on the same process can drop a write.
- A Postgres path exists in `apps/api/src/postgres-store.mjs` (851 lines,
  feature-complete), gated by `STORE_DRIVER=postgres`.
- Migrations live in `migrations/committed/` and run via `graphile-migrate`.
  `migrations/current.sql` is empty.

### Target state

- **`STORE_DRIVER=postgres` is the only supported value in production.** The
  JSON store remains as a developer-only convenience and refuses to start when
  `NODE_ENV=production` or when `DATABASE_URL` is set.
- The server boots with a verified DB connection; missing `DATABASE_URL` is a
  fatal error in prod.
- All writes go through transactions in `postgres-store.mjs`. No code path
  reads the full store into memory.
- OAuth tokens, Gmail message bodies, and any future PII columns are encrypted
  at rest with `encryptJson`/`decryptJson` (already in place for tokens; extend
  to message bodies).
- Encryption key version is honored on read so we can rotate keys without a
  bulk re-encrypt; today we read `encryptionKeyVersion` but only one version
  is supported.

### Implementation order

1. Make `loadConfig()` enforce `STORE_DRIVER=postgres` + non-empty
   `DATABASE_URL` when `NODE_ENV=production`.
2. Audit `postgres-store.mjs` for any code path that still calls into the JSON
   store; remove or gate.
3. Add a `release_command` on Fly that runs `graphile-migrate migrate` before
   the new release takes traffic.
4. Encrypt message bodies in `postgres-store.mjs` ingestion paths (currently
   stored as plaintext on the `messages` table).
5. Add multi-version key support in `security.mjs`: load `ENCRYPTION_KEYS` as a
   map of `{ version: keyBytes }`, decrypt with the version recorded on the
   payload, encrypt with the active version.
6. Delete the `data/` volume from the deployment surface — the Fly app no
   longer needs persistent local storage.

## Gmail OAuth at Scale

### Current state

- One Google Cloud OAuth client; redirect URI is env-driven.
- We use the `gmail.readonly` scope, which Google classifies as **restricted**.
- OAuth state is generated per-request and stored in `oauth_states`. Tokens
  are encrypted with the app-wide key.

### Target state

- `oauth_states` rows carry the requesting `user_id` so the callback can
  verify state belongs to the same logged-in user.
- Token rows are scoped to a `source_connections` table keyed by `user_id`;
  one user can connect multiple Gmail accounts.
- Refresh-token rotation handled inside `gmail.mjs`: any 401 triggers a token
  refresh, re-encrypt, and persist in a transaction.
- **Verification:** beta runs in Google's "Testing" mode (up to 100 test
  users, must be added by email). Production launch beyond 100 users requires
  Google OAuth verification + a CASA Tier 2 security assessment for the
  restricted scope. Plan for this around 50 users so we have runway.
- Consider switching low-value reads to `gmail.metadata` (sensitive scope, not
  restricted) where the brief doesn't need bodies. Out of scope for the first
  pass but worth flagging.

## HTTP Hygiene

The current `apps/api/src/server.mjs` is a single `http.createServer` with
hand-rolled routing. Production needs:

- `/health` — DB ping + queue health, returns 200 only when both pass.
- `/ready` — same as `/health` but stricter, used by Fly's release gate.
- Graceful shutdown: SIGTERM closes the HTTP server, drains in-flight
  requests, waits for outstanding AI runs to complete or hit
  `AI_TIMEOUT_MS`, closes the pg pool. Today the server has no signal handler.
- Structured request logging (`{ requestId, userId, route, statusCode,
  durationMs }`). Today logging is `console.log`/`console.error` only.
- Error reporting (Sentry or equivalent) on 5xx responses and worker job
  failures.
- Request ID middleware so logs correlate across web + worker.

## Worker Process

- Today: `apps/api/src/worker.mjs` runs an infinite poll loop. Fine on Fly as
  a second process, but it never autostops, so it always bills.
- Target: keep the polling worker for the beta. Once load patterns are
  understood, switch to a scheduled worker (Fly cron or external scheduler
  pinging `runWorkerOnce`) so the worker machine can autostop too.
- Graceful shutdown: SIGTERM finishes the current job, exits the loop. Today
  the loop has `noHandleSignals: false` for graphile, but the local fallback
  loop never returns.

## Fly.io Configuration

- `fly.toml` defines two processes:
  - `web`: `bun run start`, `auto_stop_machines = "stop"`,
    `min_machines_running = 0`.
  - `worker`: `bun run worker`, `min_machines_running = 1` (until we move to
    cron-triggered).
- HTTP health check on `/health`.
- `release_command = "bun run db:migrate"`.
- All secrets via `fly secrets set` — never committed:
  `DATABASE_URL`, `QUEUE_DATABASE_URL`, `APP_SECRET`, `ENCRYPTION_KEY`,
  `ENCRYPTION_KEY_VERSION`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `SUPABASE_URL`, `SUPABASE_JWT_SECRET` or JWKS URL, `OLLAMA_HOST`,
  `OLLAMA_API_KEY`.
- Use Neon's pooled connection string for `DATABASE_URL` (web), direct for
  `QUEUE_DATABASE_URL` (worker, since `graphile-worker` opens long-lived
  connections and uses `LISTEN/NOTIFY`).

## Local Development Parity

- The same Docker image runs locally and on Fly. `docker-compose.yml` already
  works for local; keep it as the dev quickstart.
- Local can either:
  - Point at a **Neon dev branch** (recommended — true parity, free), or
  - Run a local Postgres via the existing compose setup.
- `.env.example` updated to include the Supabase keys, Neon URL placeholder,
  and a note that `STORE_DRIVER=json` is dev-only.
- Verification (`bun run verify`) continues to pass against either backend.

## Phased Rollout

The work above is large. Tackle in this order so each phase is independently
shippable.

### Phase 1 — Multi-tenant API (no deploy) — ✅ Complete

Delivered:

- Supabase JWT verification middleware (HS256), `requireUser`, dev bypass
  via `DEV_USER_ID` (refused in production).
- `users` table + `ensureUserRecord` upsert on first authenticated request.
- User-scoped store APIs: `readStoreFor`, `listAiRunsFor`, `clearUserData`,
  `getPrimarySourceConnection`, `ensureUserRecord`.
- Every `/api/*` route now derives `userId` from the request; no
  `store.accounts[0]` survives in route code.
- `oauth_states.user_id` migration; `consumeOAuthState` returns the bound
  user.
- Worker job payloads require `userId`.
- 12 JWT tests + 3 isolation tests, all green; full `bun run verify`
  passes.
- Web app wired to Supabase: sign-in/sign-up screen, session-aware
  `apiFetch`, sign-out, query cache flushed on identity change. Gmail
  connect routed through a JSON endpoint that can carry the bearer.

Exit criteria met: two seeded users hit `/api/home` with their own JWTs
and see only their own data.

### Phase 2 — Production hygiene — In progress

Tracked at the top of this document. The five items below in this order:

1. **Storage gate.** `loadConfig()` refuses `STORE_DRIVER=json` and falls
   back to a fatal error when `NODE_ENV=production`. Same gate forbids
   `DEV_USER_ID` in prod (already in place; verify covered by tests).
2. **Lifecycle endpoints + graceful shutdown.** Add `/health` (returns 200
   when DB ping succeeds) and `/ready` (stricter, used by the Fly release
   gate). SIGTERM closes the HTTP server, drains in-flight requests, exits
   the worker poll loop.
3. **Request hardening.** CORS allowlist driven by `WEB_ORIGIN`; bounded
   `parseJsonBody` (1 MB, 10s read timeout); reject everything else.
4. **Rate limiting.** Per-user token bucket on AI routes
   (`/api/ai/run`, `/api/ai/verify`, `/api/ai/ingestion/*`) and per-IP on
   the OAuth callback. In-memory is fine for a single Fly machine; Postgres
   counter when we scale.
5. **Structured logging.** `console.log` replaced with single-line JSON
   per request: `{ ts, level, requestId, userId, route, status, durMs }`.
   Errors include the stack. Worker jobs share the same shape.

Deferred to Phase 4 (not blockers for first beta):

- Encryption key versioning (multi-version `decryptJson`).
- Encrypt message bodies at rest in the JSON store path. (Postgres path
  already encrypts.)
- Sentry / external error reporting.

Exit criteria: server passes the abuse checklist —
- oversized body returns 413 without crashing.
- missing/expired/tampered JWT returns 401 without leaking data.
- replayed OAuth state is rejected.
- AI route bursts past the rate limit return 429.
- SIGTERM during a run drains cleanly; no half-written rows.
- `STORE_DRIVER=json` with `NODE_ENV=production` refuses to start.

### Phase 3 — Fly + Neon deploy (private beta)

- `fly.toml` with `web` + `worker` processes.
- Fly secrets populated.
- Neon project provisioned (prod branch + dev branch).
- `release_command` runs `graphile-migrate migrate`.
- Commit `migrations/current.sql` (the `oauth_states.user_id` change from
  Phase 1) before the first deploy.
- Remove the legacy `GET /api/connect/gmail` route — it's dead code now
  that the SPA uses `POST /api/connect/gmail/start`.
- Google OAuth client configured with the Fly hostname; up to 100 invited
  test users.

Exit criteria: a brand-new test user can sign up via Supabase, connect
Gmail, and get a daily brief end-to-end on the deployed instance.

### Phase 4 — Pre-public-launch

- Encryption key versioning (rotation without re-encrypting all rows).
- Encrypt message bodies in the JSON store path (defensive; JSON is
  dev-only in prod).
- Sentry (or equivalent) wired up for the API and worker.
- Google OAuth verification + CASA assessment kicked off.
- Move worker from polling to scheduled triggers so it autostops.
- Postgres-backed rate limiting (multi-instance safe).
- Backups: enable Neon point-in-time recovery on the prod branch (it is by
  default; verify retention).
- Runbook: how to rotate `ENCRYPTION_KEY`, how to revoke a user's tokens,
  how to roll back a bad migration.

Exit criteria: app passes Google OAuth verification, ready to serve users
beyond the 100-test-user cap.

## Out of Scope for This Document

- Frontend hardening (CSP, SRI, error boundaries) — tracked separately.
- AI evaluation gating in CI — covered by `docs/ai-control-plane.md`.
- Multi-region deploy — defer until we have evidence we need it.
