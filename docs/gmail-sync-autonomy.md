# Gmail sync: autonomy plan

This document captures how we align with [Synchronize clients with Gmail](https://developers.google.com/workspace/gmail/api/guides/sync), what is implemented today, and how we roll out **incremental sync**, **batching**, **push**, and **scheduled** jobs.

## Google’s model (summary)

1. **Full sync** — `users.messages.list` for IDs, then `messages.get` (typically batched) with `format=FULL` or `RAW` on first ingest; merge into the store; persist a **`historyId` cursor** from the newest synced material (per Google: often the first ID in the list response, or equivalently the highest message `historyId` among fetched messages).
2. **Partial sync** — `users.history.list` with `startHistoryId` equal to the last committed cursor; apply adds / label changes / deletes; advance the cursor from the **`historyId` field on the `history.list` response** (mailbox history after the returned changes).
3. **History expiry** — If `startHistoryId` is outside the retained window, `history.list` returns **404**; the client must **fall back to full sync** and establish a new cursor.
4. **Push** — [Gmail push notifications](https://developers.google.com/workspace/gmail/api/guides/push) should trigger partial sync when possible, reducing blind polling.
5. **Efficiency** — Use **batch HTTP** for many `messages.get` calls; use **`format=MINIMAL`** when only labels/metadata changed (optional optimization).

## SaneMail routines

| Routine | Purpose |
|--------|---------|
| **Latest window (“sync” / ingest next)** | Bring inbox state up to date for the product query (`SYNC_QUERY`, `newer_than`, etc.). Uses **incremental** (`history.list`) when a cursor exists and incremental sync is enabled; otherwise **full window** (`messages.list` + `messages.get`). |
| **Backfill older** | Older mail than the current store window, bounded by `SYNC_BACKFILL_CUTOFF_DAYS` / query. Stays list + get; not driven by `history.list`. |
| **Manual sync button** | Same code paths as above; **deduped** queue jobs (`defaultJobKey` per source + trigger + `cursorHint`) avoid stacking duplicate pending work. Repeated sync does **not** duplicate rows (upsert keys), but **does** consume Gmail quota unless incremental skips unchanged mail. |

## Cursor storage

- **Postgres:** `source_sync_cursors` row with `cursor_kind = 'gmail_history_id'` (see `upsertAccount` in `postgres-store.mjs`).
- **JSON store:** `account.historyId` in `sanemail.json` via `upsertAccount`.
- Account reads merge **`source_sync_cursors` over OAuth metadata** so the committed cursor wins over the initial OAuth `users.getProfile` snapshot.

## Implementation phases

### Phase A — Incremental partial sync (shipped in code)

- **`users.history.list`** pagination in `gmail.mjs` (`listHistoryPage`, `syncIncrementalFromHistory`); collects IDs from `messagesAdded`, `labelsAdded`, `labelsRemoved`.
- On **404**, `syncSourceConnection` falls back to full-window sync (`syncRecentMessages`) and re-seeds the cursor from fetched messages.
- After sync, persist **`historyId`**: mailbox id from the last `history.list` page when incremental succeeds; otherwise **`max(message.historyId)`** from the full window. Postgres loads committed cursor via **`source_sync_cursors`** join (`gmail_sync_history_id`).
- **`messagesDeleted`:** IDs are collected in `syncIncrementalFromHistory` (`deletedIds`) but not yet applied to the store (soft-delete / tombstone next).

### Phase B — Autonomous scheduling

- **Push:** `users.watch` + Pub/Sub; HTTPS endpoint verifies and enqueues `source.sync` with `trigger: push` (incremental).
- **Cron / delayed jobs:** Periodically enqueue incremental sync per connected source (deduped), as a safety net if push is delayed.
- **Watch renewal:** Renew before **7-day** mailbox watch expiry.

### Phase C — API efficiency

- **Batch `messages.get`** via the [Gmail batch API](https://developers.google.com/workspace/gmail/api/guides/batch).
- **`format=MINIMAL`** for label-only updates where bodies are unchanged.

### Phase D — Product / ops

- Metrics: history 404 rate, messages fetched vs skipped, watch renewals, quota estimates.
- Feature flags: `SYNC_GMAIL_INCREMENTAL` to disable incremental sync for debugging.

## Related code

- `apps/api/src/gmail.mjs` — Gmail HTTP helpers, full and incremental fetch.
- `apps/api/src/source-sync.mjs` — Orchestration, backfill, cursor hints.
- `apps/api/src/postgres-store.mjs` — Cursor persistence and account hydration.
- `apps/api/src/queue.mjs` — Job keys and `source.sync` enqueue.
- `apps/api/src/worker.mjs` — Worker handler for `source.sync`.
