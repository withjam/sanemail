# MVP Data Model

The first implementation uses `data/sanemail.json` so the ingestion spine can
run locally without database setup. This is a development backing store, not the
production database.

## Store Shape

```json
{
  "schemaVersion": 1,
  "oauthStates": [],
  "accounts": [],
  "messages": [],
  "threads": [],
  "feedback": [],
  "events": []
}
```

## Accounts

Represents a connected provider account.

Important fields:

- `id`: stable SaneMail account id, such as `gmail:user@example.com`.
- `provider`: currently `gmail`.
- `email`: Gmail email address.
- `historyId`: latest known Gmail mailbox history cursor.
- `scope`: OAuth scope granted for this connection.
- `accessToken`, `refreshToken`, `tokenExpiresAt`: local dev token fields.

Production notes:

- OAuth tokens must be encrypted at rest.
- Account disconnect must delete tokens and derived mail data on request.

Demo accounts may include `demo: true` so the UI can show local-only demo
actions instead of trying to sync Gmail.

## Messages

Represents a Gmail message imported into SaneMail.

Important fields:

- `id`: SaneMail message id.
- `providerMessageId`: Gmail message id.
- `providerThreadId`: Gmail thread id.
- `sourceLabels`: Gmail labels at sync time. These are source signals only.
- `subject`, `from`, `to`, `cc`, `date`, `snippet`, `bodyText`: display and
  understanding inputs.
- `headers`: selected headers useful for threading and classification.
- `syncedAt`: when SaneMail last imported the message.

Production notes:

- Raw/source payloads should move to object storage.
- Parsed metadata should move to Postgres.
- Embeddings should move to a vector index.

## Threads

Represents a lightweight SaneMail thread projection over provider thread ids.

Important fields:

- `id`: SaneMail thread id.
- `providerThreadId`: Gmail thread id.
- `subject`: latest observed subject.
- `lastMessageAt`: latest known message timestamp.

## Feedback

Represents SaneMail-owned user feedback.

Examples:

- `important`
- `not-important`
- `junk`
- `not-junk`
- `needs-reply`
- `done`

Feedback does not write back to Gmail.

## Events

Represents local operational history, such as completed syncs.

Production notes:

- Replace with durable job logs and metrics.
- Keep audit events for message ranking, quarantine, and deletion decisions.

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
