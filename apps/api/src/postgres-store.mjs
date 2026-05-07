import crypto from "node:crypto";
import pg from "pg";
import { loadConfig } from "./config.mjs";
import { decryptJson, encryptJson, hashSensitiveValue } from "./security.mjs";

let pool;

function config() {
  return loadConfig();
}

function databaseUrl() {
  const url = config().database.url;
  if (!url) {
    throw new Error("STORE_DRIVER=postgres requires DATABASE_URL or POSTGRES_HOST.");
  }
  return url;
}

function db() {
  if (!pool) pool = new pg.Pool({ connectionString: databaseUrl() });
  return pool;
}

async function withClient(callback) {
  const client = await db().connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

export async function databasePing() {
  await withClient((client) => client.query("select 1"));
  return { ok: true };
}

async function withTransaction(callback) {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const result = await callback(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

function nowIso() {
  return new Date().toISOString();
}

function hashValue(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function userIdForAccount(account = {}) {
  return account.userId || account.ownerUserId || account.id || "local:user";
}

function scopeArray(scope) {
  if (Array.isArray(scope)) return scope.filter(Boolean);
  if (!scope) return [];
  return String(scope).split(/\s+/).filter(Boolean);
}

function sourceConnectionMetadata(account = {}) {
  return {
    demo: Boolean(account.demo),
    messagesTotal: account.messagesTotal ?? null,
    threadsTotal: account.threadsTotal ?? null,
    historyId: account.historyId || null,
    tokenExpiresAt: account.tokenExpiresAt || null,
  };
}

function accountFromRow(row) {
  const metadata = row.metadata || {};
  const tokens = row.encrypted_payload
    ? decryptJson(row.encrypted_payload, { purpose: "oauth_tokens" }) || {}
    : {};

  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    email: row.source_email,
    scope: Array.isArray(row.scope) ? row.scope.join(" ") : "",
    messagesTotal: metadata.messagesTotal ?? undefined,
    threadsTotal: metadata.threadsTotal ?? undefined,
    historyId: metadata.historyId || undefined,
    demo: Boolean(metadata.demo),
    accessToken: tokens.accessToken || "",
    refreshToken: tokens.refreshToken || "",
    tokenExpiresAt: tokens.tokenExpiresAt || metadata.tokenExpiresAt || "",
    createdAt: row.created_at?.toISOString?.() || row.created_at,
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
  };
}

async function getAccountById(client, id) {
  const result = await client.query(
    `
      select sc.*, sas.encrypted_payload
      from source_connections sc
      left join source_auth_secrets sas
        on sas.source_connection_id = sc.id
       and sas.secret_kind = 'oauth_tokens'
      where sc.id = $1
        and sc.deleted_at is null
      limit 1
    `,
    [id],
  );
  return result.rows[0] ? accountFromRow(result.rows[0]) : null;
}

async function ensureUser(client, userId, email = null) {
  await client.query(
    `
      insert into users (id, primary_email, updated_at)
      values ($1, $2, now())
      on conflict (id) do update
        set primary_email = coalesce(excluded.primary_email, users.primary_email),
            updated_at = now()
    `,
    [userId, email],
  );
}

async function upsertAccountInClient(client, account) {
  const existing = account.id ? await getAccountById(client, account.id) : null;
  const merged = {
    ...(existing || {}),
    ...account,
    refreshToken: account.refreshToken ?? existing?.refreshToken ?? "",
    accessToken: account.accessToken ?? existing?.accessToken ?? "",
    tokenExpiresAt: account.tokenExpiresAt ?? existing?.tokenExpiresAt ?? "",
  };
  const userId = userIdForAccount(merged);
  const sourceId = merged.id || `${merged.provider}:${merged.email}`;
  const metadata = sourceConnectionMetadata(merged);

  await ensureUser(client, userId, merged.email);
  await client.query(
    `
      insert into source_connections (
        id, user_id, provider, source_email, display_name, status, scope,
        metadata, auth_secret_ref, updated_at
      )
      values ($1, $2, $3, $4, $5, 'active', $6, $7::jsonb, $8, now())
      on conflict (id) do update
        set provider = excluded.provider,
            source_email = excluded.source_email,
            display_name = excluded.display_name,
            status = 'active',
            scope = excluded.scope,
            metadata = excluded.metadata,
            auth_secret_ref = coalesce(excluded.auth_secret_ref, source_connections.auth_secret_ref),
            updated_at = now(),
            deleted_at = null
    `,
    [
      sourceId,
      userId,
      merged.provider || "gmail",
      merged.email || "",
      merged.displayName || merged.email || "",
      scopeArray(merged.scope),
      JSON.stringify(metadata),
      merged.accessToken || merged.refreshToken ? `secret:${sourceId}:oauth_tokens` : null,
    ],
  );

  if (merged.accessToken || merged.refreshToken) {
    const encrypted = encryptJson(
      {
        accessToken: merged.accessToken || "",
        refreshToken: merged.refreshToken || "",
        tokenExpiresAt: merged.tokenExpiresAt || "",
      },
      { purpose: "oauth_tokens" },
    );
    await client.query(
      `
        insert into source_auth_secrets (
          id, user_id, source_connection_id, secret_kind, encrypted_payload,
          key_version, updated_at
        )
        values ($1, $2, $3, 'oauth_tokens', $4::jsonb, $5, now())
        on conflict (source_connection_id, secret_kind) do update
          set encrypted_payload = excluded.encrypted_payload,
              key_version = excluded.key_version,
              updated_at = now()
      `,
      [
        `secret:${sourceId}:oauth_tokens`,
        userId,
        sourceId,
        JSON.stringify(encrypted),
        encrypted.keyVersion,
      ],
    );
  }

  if (merged.historyId) {
    await client.query(
      `
        insert into source_sync_cursors (
          source_connection_id, cursor_kind, cursor_value, last_committed_at, updated_at
        )
        values ($1, 'gmail_history_id', $2, now(), now())
        on conflict (source_connection_id, cursor_kind) do update
          set cursor_value = excluded.cursor_value,
              last_committed_at = excluded.last_committed_at,
              updated_at = now()
      `,
      [sourceId, String(merged.historyId)],
    );
  }

  return getAccountById(client, sourceId);
}

export async function upsertAccount(account) {
  return withTransaction((client) => upsertAccountInClient(client, account));
}

export async function getPrimaryAccount() {
  return withClient(async (client) => {
    const result = await client.query(
      `
        select sc.*, sas.encrypted_payload
        from source_connections sc
        left join source_auth_secrets sas
          on sas.source_connection_id = sc.id
         and sas.secret_kind = 'oauth_tokens'
        where sc.deleted_at is null
          and sc.status <> 'deleted'
        order by sc.created_at asc
        limit 1
      `,
    );
    return result.rows[0] ? accountFromRow(result.rows[0]) : null;
  });
}

export async function getPrimarySourceConnection(userId) {
  if (!userId) throw new Error("getPrimarySourceConnection requires a userId");
  return withClient(async (client) => {
    const result = await client.query(
      `
        select sc.*, sas.encrypted_payload
        from source_connections sc
        left join source_auth_secrets sas
          on sas.source_connection_id = sc.id
         and sas.secret_kind = 'oauth_tokens'
        where sc.deleted_at is null
          and sc.status <> 'deleted'
          and sc.user_id = $1
        order by sc.created_at asc
        limit 1
      `,
      [userId],
    );
    return result.rows[0] ? accountFromRow(result.rows[0]) : null;
  });
}

export async function ensureUserRecord(userId, email = null) {
  if (!userId) throw new Error("ensureUserRecord requires a userId");
  await withClient((client) => ensureUser(client, userId, email));
  return { id: userId, primaryEmail: email };
}

function messageInputHash(message = {}) {
  return hashValue({
    subject: message.subject,
    from: message.from,
    to: message.to,
    date: message.date,
    snippet: message.snippet,
    bodyText: message.bodyText,
    labels: message.sourceLabels || [],
  });
}

function addressJson(value) {
  return JSON.stringify({ raw: value || "" });
}

function addressListJson(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  return JSON.stringify(value ? [{ raw: value }] : []);
}

const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

function parseAddressList(value) {
  if (!value) return [];
  const raw = Array.isArray(value)
    ? value.flatMap((item) => (item && typeof item === "object" ? [item.raw || ""] : [String(item || "")]))
    : [String(value)];
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    for (const piece of String(entry).split(/[,;]/)) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      const match = trimmed.match(EMAIL_REGEX);
      if (!match) continue;
      const email = match[0].toLowerCase();
      if (seen.has(email)) continue;
      seen.add(email);
      const nameMatch = trimmed.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
      const name = nameMatch ? nameMatch[1].trim() : null;
      out.push({ email, name: name || null });
    }
  }
  return out;
}

async function bumpContactFrequency(client, userId, message, sourceAccount, receivedAt) {
  if (!userId) return;
  const userEmail = (sourceAccount?.email || "").toLowerCase();
  const fromEntries = parseAddressList(message.from);
  const sender = fromEntries[0] || null;
  const isSentByUser = userEmail && sender?.email === userEmail;

  if (isSentByUser) {
    const recipients = [
      ...parseAddressList(message.to),
      ...parseAddressList(message.cc),
    ];
    const seen = new Set();
    for (const recipient of recipients) {
      if (!recipient.email || recipient.email === userEmail) continue;
      if (seen.has(recipient.email)) continue;
      seen.add(recipient.email);
      await client.query(
        `
          insert into contact_frequency (
            user_id, contact_email, contact_name,
            sent_count, last_sent_at, updated_at
          )
          values ($1, $2, $3, 1, $4, now())
          on conflict (user_id, contact_email) do update
            set sent_count = contact_frequency.sent_count + 1,
                last_sent_at = greatest(
                  coalesce(contact_frequency.last_sent_at, excluded.last_sent_at),
                  excluded.last_sent_at
                ),
                contact_name = coalesce(contact_frequency.contact_name, excluded.contact_name),
                updated_at = now()
        `,
        [userId, recipient.email, recipient.name, receivedAt],
      );
    }
    return;
  }

  if (!sender || !sender.email || sender.email === userEmail) return;
  await client.query(
    `
      insert into contact_frequency (
        user_id, contact_email, contact_name,
        received_count, last_received_at, updated_at
      )
      values ($1, $2, $3, 1, $4, now())
      on conflict (user_id, contact_email) do update
        set received_count = contact_frequency.received_count + 1,
            last_received_at = greatest(
              coalesce(contact_frequency.last_received_at, excluded.last_received_at),
              excluded.last_received_at
            ),
            contact_name = coalesce(contact_frequency.contact_name, excluded.contact_name),
            updated_at = now()
    `,
    [userId, sender.email, sender.name, receivedAt],
  );
}

function messageFromRow(row) {
  const metadata = row.source_metadata || {};
  const body = row.encrypted_body
    ? decryptJson(row.encrypted_body, { purpose: "message_body" }) || {}
    : {};
  const fromAddr = row.from_addr || {};
  const toAddrs = Array.isArray(row.to_addrs) ? row.to_addrs : [];

  return {
    id: row.id,
    accountId: row.source_connection_id || row.primary_source_connection_id,
    provider: row.provider || metadata.provider || "gmail",
    providerMessageId: row.provider_message_id || metadata.providerMessageId || row.id,
    providerThreadId: row.provider_thread_id || metadata.providerThreadId || "",
    sourceLabels: row.provider_labels || metadata.sourceLabels || [],
    historyId: row.provider_history_id || metadata.historyId || "",
    internalDate: metadata.internalDate || "",
    subject: row.subject || "(no subject)",
    from: fromAddr.raw || metadata.from || "",
    to: toAddrs[0]?.raw || metadata.to || "",
    cc: metadata.cc || "",
    date: row.received_at?.toISOString?.() || row.received_at,
    snippet: row.snippet || "",
    bodyText: body.bodyText || "",
    headers: metadata.headers || {},
    syncedAt: metadata.syncedAt || row.ingested_at?.toISOString?.() || row.ingested_at,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
  };
}

export async function upsertSyncedMessages(account, messages = []) {
  return withTransaction(async (client) => {
    const sourceAccount = await upsertAccountInClient(client, account);
    const userId = sourceAccount.userId || userIdForAccount(sourceAccount);
    let inserted = 0;
    let updated = 0;

    for (const message of messages) {
      const receivedAt = message.date || new Date(Number(message.internalDate) || Date.now()).toISOString();
      const threadId = `${sourceAccount.id}:thread:${message.providerThreadId || message.id}`;
      const inputHash = messageInputHash(message);
      const existed = await client.query("select 1 from messages where id = $1", [message.id]);

      await client.query(
        `
          insert into threads (
            id, user_id, subject_normalized, last_message_at, message_count, updated_at
          )
          values ($1, $2, lower($3), $4, 1, now())
          on conflict (id) do update
            set subject_normalized = excluded.subject_normalized,
                last_message_at = greatest(threads.last_message_at, excluded.last_message_at),
                updated_at = now()
        `,
        [threadId, userId, message.subject || "", receivedAt],
      );

      await client.query(
        `
          insert into messages (
            id, user_id, canonical_thread_id, primary_source_connection_id,
            received_at, sent_at, subject, from_addr, to_addrs, cc_addrs,
            reply_to_addrs, snippet, body_text_ref, content_hash, updated_at
          )
          values (
            $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb,
            $11::jsonb, $12, $13, $14, now()
          )
          on conflict (id) do update
            set canonical_thread_id = excluded.canonical_thread_id,
                primary_source_connection_id = excluded.primary_source_connection_id,
                received_at = excluded.received_at,
                sent_at = excluded.sent_at,
                subject = excluded.subject,
                from_addr = excluded.from_addr,
                to_addrs = excluded.to_addrs,
                cc_addrs = excluded.cc_addrs,
                reply_to_addrs = excluded.reply_to_addrs,
                snippet = excluded.snippet,
                body_text_ref = excluded.body_text_ref,
                content_hash = excluded.content_hash,
                updated_at = now(),
                deleted_at = null
        `,
        [
          message.id,
          userId,
          threadId,
          sourceAccount.id,
          receivedAt,
          message.headers?.date || receivedAt,
          message.subject || "(no subject)",
          addressJson(message.from),
          addressListJson(message.to),
          addressListJson(message.cc),
          addressListJson(message.headers?.["reply-to"]),
          message.snippet || "",
          `message_body:${message.id}`,
          inputHash,
        ],
      );

      await client.query(
        `
          insert into message_source_refs (
            message_id, source_connection_id, provider, provider_message_id,
            provider_thread_id, provider_labels, provider_history_id,
            source_internal_date, source_state, source_metadata, last_seen_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, 'present', $9::jsonb, now())
          on conflict (source_connection_id, provider_message_id) do update
            set message_id = excluded.message_id,
                provider_thread_id = excluded.provider_thread_id,
                provider_labels = excluded.provider_labels,
                provider_history_id = excluded.provider_history_id,
                source_internal_date = excluded.source_internal_date,
                source_state = 'present',
                source_metadata = excluded.source_metadata,
                last_seen_at = now()
        `,
        [
          message.id,
          sourceAccount.id,
          message.provider || sourceAccount.provider || "gmail",
          message.providerMessageId || message.id,
          message.providerThreadId || "",
          message.sourceLabels || [],
          message.historyId || "",
          receivedAt,
          JSON.stringify({
            provider: message.provider || sourceAccount.provider || "gmail",
            providerMessageId: message.providerMessageId || message.id,
            providerThreadId: message.providerThreadId || "",
            sourceLabels: message.sourceLabels || [],
            historyId: message.historyId || "",
            internalDate: message.internalDate || "",
            headers: message.headers || {},
            from: message.from || "",
            to: message.to || "",
            cc: message.cc || "",
            syncedAt: message.syncedAt || nowIso(),
          }),
        ],
      );

      const encryptedBody = encryptJson(
        { bodyText: message.bodyText || "" },
        { purpose: "message_body" },
      );
      await client.query(
        `
          insert into message_bodies (message_id, encrypted_body, body_hash, key_version, updated_at)
          values ($1, $2::jsonb, $3, $4, now())
          on conflict (message_id) do update
            set encrypted_body = excluded.encrypted_body,
                body_hash = excluded.body_hash,
                key_version = excluded.key_version,
                updated_at = now()
        `,
        [message.id, JSON.stringify(encryptedBody), inputHash, encryptedBody.keyVersion],
      );

      await client.query(
        `
          insert into message_classification_state (
            message_id, user_id, state, priority_at, input_hash, updated_at
          )
          values ($1, $2, 'pending', $3, $4, now())
          on conflict (message_id) do update
            set state = case
                  when message_classification_state.input_hash is distinct from excluded.input_hash
                    then 'stale'
                  else message_classification_state.state
                end,
                priority_at = excluded.priority_at,
                input_hash = excluded.input_hash,
                updated_at = now()
        `,
        [message.id, userId, receivedAt, inputHash],
      );

      if (!existed.rowCount) {
        await bumpContactFrequency(client, userId, message, sourceAccount, receivedAt);
      }

      if (existed.rowCount) updated += 1;
      else inserted += 1;
    }

    await client.query(
      `
        insert into ingestion_events (
          user_id, source_connection_id, event_type, metadata, created_at
        )
        values ($1, $2, 'source.sync.completed', $3::jsonb, now())
      `,
      [
        userId,
        sourceAccount.id,
        JSON.stringify({ inserted, updated, count: messages.length }),
      ],
    );

    return { inserted, updated, count: messages.length };
  });
}

async function accountRows(client) {
  const result = await client.query(
    `
      select sc.*, sas.encrypted_payload
      from source_connections sc
      left join source_auth_secrets sas
        on sas.source_connection_id = sc.id
       and sas.secret_kind = 'oauth_tokens'
      where sc.deleted_at is null
        and sc.status <> 'deleted'
      order by sc.created_at asc
    `,
  );
  return result.rows.map(accountFromRow);
}

async function messageRows(client) {
  const result = await client.query(
    `
      select distinct on (m.id)
        m.*,
        msr.source_connection_id,
        msr.provider,
        msr.provider_message_id,
        msr.provider_thread_id,
        msr.provider_labels,
        msr.provider_history_id,
        msr.source_metadata,
        mb.encrypted_body
      from messages m
      left join message_source_refs msr on msr.message_id = m.id
      left join message_bodies mb on mb.message_id = m.id
      where m.deleted_at is null
      order by m.id, m.received_at desc
    `,
  );
  return result.rows.map(messageFromRow).sort(
    (a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime(),
  );
}

async function threadRows(client) {
  const result = await client.query(
    `
      select id, user_id, subject_normalized, last_message_at, message_count, created_at, updated_at
      from threads
      order by last_message_at desc nulls last
    `,
  );
  return result.rows.map((row) => ({
    id: row.id,
    accountId: row.user_id,
    subject: row.subject_normalized,
    lastMessageAt: row.last_message_at?.toISOString?.() || row.last_message_at,
    messageCount: row.message_count,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
  }));
}

async function feedbackRows(client) {
  const result = await client.query(
    `
      select id, user_id, message_id, kind, metadata, created_at
      from feedback
      order by created_at desc
    `,
  );
  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    messageId: row.message_id,
    kind: row.kind,
    metadata: row.metadata || {},
    createdAt: row.created_at?.toISOString?.() || row.created_at,
  }));
}

async function aiRunRows(client, limit = 100) {
  const result = await client.query(
    `
      select run
      from ai_runs
      order by created_at desc
      limit $1
    `,
    [limit],
  );
  return result.rows.map((row) => row.run);
}

async function verificationRunRows(client, limit = 100) {
  const result = await client.query(
    `
      select run
      from ai_verification_runs
      order by created_at desc
      limit $1
    `,
    [limit],
  );
  return result.rows.map((row) => row.run);
}

async function classificationStateRows(client) {
  const result = await client.query(
    `
      select message_id, user_id, state, priority_at, attempt_count,
             next_attempt_at, last_classified_at, current_classification_id,
             classifier_version, input_hash, last_error, created_at, updated_at
      from message_classification_state
      order by priority_at desc
    `,
  );
  return result.rows.map((row) => ({
    messageId: row.message_id,
    userId: row.user_id,
    accountId: row.user_id,
    state: row.state,
    priorityAt: row.priority_at?.toISOString?.() || row.priority_at,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at?.toISOString?.() || row.next_attempt_at,
    lastClassifiedAt: row.last_classified_at?.toISOString?.() || row.last_classified_at,
    currentClassificationId: row.current_classification_id,
    classifierVersion: row.classifier_version,
    inputHash: row.input_hash,
    lastError: row.last_error,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
  }));
}

async function briefingRows(client, limit = 50) {
  const result = await client.query(
    `
      select *
      from briefs
      order by created_at desc
      limit $1
    `,
    [limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    accountId: row.source_connection_id || row.user_id,
    scopeType: row.scope_type,
    sourceConnectionId: row.source_connection_id,
    text: row.text,
    narrative: row.narrative || {},
    callouts: row.callouts || [],
    counts: row.counts || {},
    memory: row.memory || {},
    messageIds: row.input_message_ids || [],
    generatedAt: row.created_at?.toISOString?.() || row.created_at,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
    source: "ai-loop",
    model: row.model,
    prompt: {
      id: row.prompt_id,
      version: row.prompt_version,
    },
  }));
}

async function accountRowsForUser(client, userId) {
  const result = await client.query(
    `
      select sc.*, sas.encrypted_payload
      from source_connections sc
      left join source_auth_secrets sas
        on sas.source_connection_id = sc.id
       and sas.secret_kind = 'oauth_tokens'
      where sc.deleted_at is null
        and sc.status <> 'deleted'
        and sc.user_id = $1
      order by sc.created_at asc
    `,
    [userId],
  );
  return result.rows.map(accountFromRow);
}

async function messageRowsForUser(client, userId) {
  const result = await client.query(
    `
      select distinct on (m.id)
        m.*,
        msr.source_connection_id,
        msr.provider,
        msr.provider_message_id,
        msr.provider_thread_id,
        msr.provider_labels,
        msr.provider_history_id,
        msr.source_metadata,
        mb.encrypted_body
      from messages m
      left join message_source_refs msr on msr.message_id = m.id
      left join message_bodies mb on mb.message_id = m.id
      where m.deleted_at is null
        and m.user_id = $1
      order by m.id, m.received_at desc
    `,
    [userId],
  );
  return result.rows.map(messageFromRow).sort(
    (a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime(),
  );
}

async function threadRowsForUser(client, userId) {
  const result = await client.query(
    `
      select id, user_id, subject_normalized, last_message_at, message_count, created_at, updated_at
      from threads
      where user_id = $1
      order by last_message_at desc nulls last
    `,
    [userId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    accountId: row.user_id,
    subject: row.subject_normalized,
    lastMessageAt: row.last_message_at?.toISOString?.() || row.last_message_at,
    messageCount: row.message_count,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
  }));
}

async function feedbackRowsForUser(client, userId) {
  const result = await client.query(
    `
      select id, user_id, message_id, kind, metadata, created_at
      from feedback
      where user_id = $1
      order by created_at desc
    `,
    [userId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    messageId: row.message_id,
    kind: row.kind,
    metadata: row.metadata || {},
    createdAt: row.created_at?.toISOString?.() || row.created_at,
  }));
}

async function aiRunRowsForUser(client, userId, limit = 100) {
  const result = await client.query(
    `
      select run
      from ai_runs
      where user_id = $1
      order by created_at desc
      limit $2
    `,
    [userId, limit],
  );
  return result.rows.map((row) => row.run);
}

async function classificationStateRowsForUser(client, userId) {
  const result = await client.query(
    `
      select message_id, user_id, state, priority_at, attempt_count,
             next_attempt_at, last_classified_at, current_classification_id,
             classifier_version, input_hash, last_error, created_at, updated_at
      from message_classification_state
      where user_id = $1
      order by priority_at desc
    `,
    [userId],
  );
  return result.rows.map((row) => ({
    messageId: row.message_id,
    userId: row.user_id,
    accountId: row.user_id,
    state: row.state,
    priorityAt: row.priority_at?.toISOString?.() || row.priority_at,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at?.toISOString?.() || row.next_attempt_at,
    lastClassifiedAt: row.last_classified_at?.toISOString?.() || row.last_classified_at,
    currentClassificationId: row.current_classification_id,
    classifierVersion: row.classifier_version,
    inputHash: row.input_hash,
    lastError: row.last_error,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
  }));
}

async function briefingRowsForUser(client, userId, limit = 50) {
  const result = await client.query(
    `
      select *
      from briefs
      where user_id = $1
      order by created_at desc
      limit $2
    `,
    [userId, limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    accountId: row.source_connection_id || row.user_id,
    scopeType: row.scope_type,
    sourceConnectionId: row.source_connection_id,
    text: row.text,
    narrative: row.narrative || {},
    callouts: row.callouts || [],
    counts: row.counts || {},
    memory: row.memory || {},
    messageIds: row.input_message_ids || [],
    generatedAt: row.created_at?.toISOString?.() || row.created_at,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
    source: "ai-loop",
    model: row.model,
    prompt: {
      id: row.prompt_id,
      version: row.prompt_version,
    },
  }));
}

export async function readStoreFor(userId) {
  if (!userId) throw new Error("readStoreFor requires a userId");
  return withClient(async (client) => ({
    schemaVersion: 2,
    oauthStates: [],
    users: [{ id: userId }],
    accounts: await accountRowsForUser(client, userId),
    messages: await messageRowsForUser(client, userId),
    threads: await threadRowsForUser(client, userId),
    classificationState: await classificationStateRowsForUser(client, userId),
    feedback: await feedbackRowsForUser(client, userId),
    events: [],
    queueJobs: [],
    aiRuns: await aiRunRowsForUser(client, userId),
    inboxBriefings: await briefingRowsForUser(client, userId),
    verificationRuns: await verificationRunRows(client),
  }));
}

export async function listAiRunsFor(userId, limit = 50) {
  if (!userId) throw new Error("listAiRunsFor requires a userId");
  return withClient((client) => aiRunRowsForUser(client, userId, limit));
}

export async function clearUserData(userId) {
  if (!userId) throw new Error("clearUserData requires a userId");
  await withClient((client) => client.query("delete from users where id = $1", [userId]));
}

export async function readStore() {
  return withClient(async (client) => ({
    schemaVersion: 2,
    oauthStates: [],
    accounts: await accountRows(client),
    messages: await messageRows(client),
    threads: await threadRows(client),
    classificationState: await classificationStateRows(client),
    feedback: await feedbackRows(client),
    events: [],
    queueJobs: [],
    aiRuns: await aiRunRows(client),
    inboxBriefings: await briefingRows(client),
    verificationRuns: await verificationRunRows(client),
  }));
}

export async function saveOAuthState(state, userId) {
  if (!userId) throw new Error("saveOAuthState requires a userId");
  const stateHash = hashSensitiveValue(state, { purpose: "oauth_state" });
  await withClient(async (client) => {
    await ensureUser(client, userId, null);
    await client.query(
      `
        insert into oauth_states (state_hash, user_id, created_at)
        values ($1, $2, now())
        on conflict (state_hash) do update
          set user_id = excluded.user_id,
              created_at = now()
      `,
      [stateHash, userId],
    );
  });
}

export async function consumeOAuthState(state) {
  const stateHash = hashSensitiveValue(state, { purpose: "oauth_state" });
  return withClient(async (client) => {
    await client.query("delete from oauth_states where created_at < now() - interval '10 minutes'");
    const result = await client.query(
      "delete from oauth_states where state_hash = $1 returning user_id",
      [stateHash],
    );
    if (!result.rowCount) return { ok: false, userId: null };
    return { ok: true, userId: result.rows[0].user_id };
  });
}

export async function saveFeedback(messageId, kind) {
  return withClient(async (client) => {
    const message = await client.query("select user_id from messages where id = $1", [messageId]);
    if (!message.rowCount) throw new Error("Cannot save feedback for an unknown message.");
    await client.query(
      `
        insert into feedback (id, user_id, message_id, kind, created_at)
        values ($1, $2, $3, $4, now())
      `,
      [`feedback_${crypto.randomUUID()}`, message.rows[0].user_id, messageId, kind],
    );
  });
}

export async function recordAiRun(run) {
  const userId = run.input?.accountId || null;
  await withTransaction(async (client) => {
    if (userId) await ensureUser(client, userId, null);
    await client.query(
      `
        insert into ai_runs (id, user_id, run, created_at)
        values ($1, $2, $3::jsonb, $4)
        on conflict (id) do update
          set run = excluded.run,
              created_at = excluded.created_at
      `,
      [run.id, userId, JSON.stringify(run), run.createdAt || nowIso()],
    );

    if (run.output?.briefing && userId) {
      const briefing = run.output.briefing;
      await client.query(
        `
          insert into briefs (
            id, user_id, scope_type, source_connection_id, period_start, period_end,
            trigger, classification_cursor_snapshot, input_message_ids, text,
            narrative, callouts, counts, memory, model_provider, model,
            prompt_id, prompt_version, created_at
          )
          values (
            $1, $2, 'all_sources', null, $3, $4, $5, '{}'::jsonb, $6, $7,
            $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16
          )
          on conflict (id) do nothing
        `,
        [
          `brief_${crypto.randomUUID()}`,
          userId,
          briefing.memory?.since || run.startedAt || nowIso(),
          briefing.generatedAt || run.completedAt || nowIso(),
          run.trigger || "manual",
          briefing.messageIds || [],
          briefing.text || "",
          JSON.stringify(briefing.narrative || {}),
          JSON.stringify(briefing.callouts || []),
          JSON.stringify(briefing.counts || {}),
          JSON.stringify(briefing.memory || {}),
          run.provider?.name || null,
          briefing.model || run.provider?.model || null,
          briefing.prompt?.id || null,
          briefing.prompt?.version || null,
          briefing.generatedAt || run.createdAt || nowIso(),
        ],
      );
    }

    if (run.kind === "classification-batch") {
      const classifiedAt = run.completedAt || run.createdAt || nowIso();
      for (const decision of run.output?.decisions || []) {
        const messageResult = await client.query(
          "select user_id from messages where id = $1",
          [decision.messageId],
        );
        if (!messageResult.rowCount) continue;

        const messageUserId = messageResult.rows[0].user_id;
        const classificationId = `classification_${crypto.randomUUID()}`;
        await client.query(
          `
            insert into message_classifications (
              id, message_id, user_id, system_category, needs_reply,
              automated, possible_junk, direct, score, confidence, reasons,
              action_metadata, summary, model_provider, model, prompt_id, prompt_version,
              input_hash, created_at
            )
            values (
              $1, $2, $3, $4, $5,
              $6, $7, $8, $9, $10, $11::jsonb,
              $12::jsonb, $13, $14, $15, $16, $17,
              $18, $19
            )
          `,
          [
            classificationId,
            decision.messageId,
            messageUserId,
            decision.category,
            Boolean(decision.needsReply),
            Boolean(decision.automated),
            Boolean(decision.possibleJunk),
            Boolean(decision.direct),
            Number(decision.recsysScore || 0),
            Number(decision.confidence || 0),
            JSON.stringify(decision.reasons || []),
            JSON.stringify(decision.extracted || {}),
            typeof decision.summary === "string" && decision.summary.trim() ? decision.summary.trim() : null,
            run.provider?.name || null,
            run.provider?.model || null,
            run.promptRefs?.find((prompt) => prompt.id === "mail-message-classification")?.id || null,
            run.promptRefs?.find((prompt) => prompt.id === "mail-message-classification")?.version || null,
            decision.instrumentation?.inputHash || "",
            classifiedAt,
          ],
        );
        await client.query(
          `
            update message_classification_state
               set state = 'classified',
                   attempt_count = attempt_count + 1,
                   last_classified_at = $2,
                   current_classification_id = $3,
                   classifier_version = $4,
                   input_hash = $5,
                   locked_at = null,
                   locked_by = null,
                   last_error = null,
                   updated_at = now()
             where message_id = $1
          `,
          [
            decision.messageId,
            classifiedAt,
            classificationId,
            run.provider?.classificationModel || run.provider?.model || "deterministic",
            decision.instrumentation?.inputHash || "",
          ],
        );
      }
    }
  });
  return run;
}

export async function listAiRuns(limit = 50) {
  return withClient((client) => aiRunRows(client, limit));
}

export async function listRecentClassifications(userId, limit = 15) {
  if (!userId) return [];
  const cap = Math.min(100, Math.max(1, Math.floor(Number(limit) || 15)));
  return withClient(async (client) => {
    const result = await client.query(
      `
        select
          mc.id,
          mc.message_id,
          mc.system_category,
          mc.needs_reply,
          mc.automated,
          mc.possible_junk,
          mc.direct,
          mc.score,
          mc.confidence,
          mc.reasons,
          mc.summary,
          mc.model_provider,
          mc.model,
          mc.prompt_id,
          mc.prompt_version,
          mc.created_at,
          m.subject,
          m.from_addr,
          m.received_at
        from message_classifications mc
        join messages m on m.id = mc.message_id
        where mc.user_id = $1
          and m.deleted_at is null
        order by mc.created_at desc
        limit $2
      `,
      [userId, cap],
    );
    return result.rows.map((row) => ({
      id: row.id,
      messageId: row.message_id,
      subject: row.subject || "(no subject)",
      from: row.from_addr?.raw || "",
      receivedAt: row.received_at?.toISOString?.() || row.received_at || null,
      category: row.system_category,
      needsReply: Boolean(row.needs_reply),
      automated: Boolean(row.automated),
      possibleJunk: Boolean(row.possible_junk),
      direct: Boolean(row.direct),
      score: Number(row.score || 0),
      confidence: Number(row.confidence || 0),
      reasons: Array.isArray(row.reasons) ? row.reasons : [],
      summary: row.summary || null,
      modelProvider: row.model_provider || null,
      model: row.model || null,
      promptId: row.prompt_id || null,
      promptVersion: row.prompt_version || null,
      classifiedAt: row.created_at?.toISOString?.() || row.created_at,
    }));
  });
}

export async function saveVerificationRun(run) {
  await withClient((client) =>
    client.query(
      `
        insert into ai_verification_runs (id, run, created_at)
        values ($1, $2::jsonb, $3)
        on conflict (id) do update
          set run = excluded.run,
              created_at = excluded.created_at
      `,
      [run.id, JSON.stringify(run), run.createdAt || nowIso()],
    ),
  );
  return run;
}

export async function listVerificationRuns(limit = 50) {
  return withClient((client) => verificationRunRows(client, limit));
}

export async function clearLocalData() {
  await withTransaction(async (client) => {
    await client.query("delete from ai_verification_runs");
    await client.query("delete from oauth_states");
    await client.query("delete from users");
  });
}
