--! Previous: sha1:5981d2942cf56b83954fc76240038a9a02f1e5ec
--! Hash: sha1:c2d663802d1fcdefbe0ad492db78cfa1d476b1cc
--! Message: secure app storage tables

create table if not exists oauth_states (
  state_hash text primary key,
  created_at timestamptz not null default now()
);

create table if not exists source_auth_secrets (
  id text primary key default gen_random_uuid()::text,
  user_id text not null references users(id) on delete cascade,
  source_connection_id text not null references source_connections(id) on delete cascade,
  secret_kind text not null,
  encrypted_payload jsonb not null,
  key_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_connection_id, secret_kind)
);

create table if not exists message_bodies (
  message_id text primary key references messages(id) on delete cascade,
  encrypted_body jsonb not null,
  body_hash text not null,
  key_version text not null,
  updated_at timestamptz not null default now()
);

create table if not exists ai_runs (
  id text primary key,
  user_id text references users(id) on delete cascade,
  run jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists ai_verification_runs (
  id text primary key,
  run jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists oauth_states_created_idx
  on oauth_states (created_at);

create index if not exists source_auth_secrets_source_kind_idx
  on source_auth_secrets (source_connection_id, secret_kind);

create index if not exists ai_runs_user_created_idx
  on ai_runs (user_id, created_at desc);

create index if not exists ai_verification_runs_created_idx
  on ai_verification_runs (created_at desc);
