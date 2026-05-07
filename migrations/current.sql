-- Write the next idempotent migration here. Run `bun run db:current` while iterating.

-- Bind OAuth state values to the user that started the flow, so the callback
-- can attach the resulting account to the right user. Existing rows (if any)
-- are abandoned because they have no associated user; the 10-minute TTL means
-- they would have expired anyway.

alter table oauth_states
  add column if not exists user_id text references users(id) on delete cascade;

create index if not exists oauth_states_user_idx
  on oauth_states (user_id);

-- One-sentence summary written by the classifier when the message body has
-- enough content to be worth summarizing. NULL when skipped (short message,
-- deterministic fallback, or LLM omitted it).

alter table message_classifications
  add column if not exists summary text;

-- Per-user, per-contact rolling counts. Increments on ingest so the data is
-- deterministic (does not depend on classification running). sent_count is
-- bumped for each recipient when the user themselves is the sender; otherwise
-- received_count is bumped for the from address. The sent/received ratio is
-- the signal we want for "people the user actually engages with".

create table if not exists contact_frequency (
  user_id text not null references users(id) on delete cascade,
  contact_email text not null,
  contact_name text,
  received_count bigint not null default 0,
  sent_count bigint not null default 0,
  first_seen_at timestamptz not null default now(),
  last_received_at timestamptz,
  last_sent_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, contact_email)
);

create index if not exists contact_frequency_user_received_idx
  on contact_frequency (user_id, received_count desc);

create index if not exists contact_frequency_user_sent_idx
  on contact_frequency (user_id, sent_count desc);
