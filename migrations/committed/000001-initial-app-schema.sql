--! Previous: -
--! Hash: sha1:5981d2942cf56b83954fc76240038a9a02f1e5ec
--! Message: initial app schema

create extension if not exists pgcrypto;

create table if not exists users (
  id text primary key default gen_random_uuid()::text,
  primary_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists source_connections (
  id text primary key default gen_random_uuid()::text,
  user_id text not null references users(id) on delete cascade,
  provider text not null,
  source_email text not null,
  display_name text,
  status text not null default 'active',
  auth_secret_ref text,
  scope text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  last_successful_sync_at timestamptz,
  last_failed_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists source_sync_cursors (
  id text primary key default gen_random_uuid()::text,
  source_connection_id text not null references source_connections(id) on delete cascade,
  cursor_kind text not null,
  cursor_value text,
  backfill_before timestamptz,
  watch_expires_at timestamptz,
  last_seen_source_at timestamptz,
  last_committed_at timestamptz,
  sync_generation bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_connection_id, cursor_kind)
);

create table if not exists source_sync_runs (
  id text primary key default gen_random_uuid()::text,
  source_connection_id text not null references source_connections(id) on delete cascade,
  trigger text not null,
  status text not null default 'running',
  cursor_before jsonb not null default '{}'::jsonb,
  cursor_after jsonb not null default '{}'::jsonb,
  messages_seen integer not null default 0,
  messages_inserted integer not null default 0,
  messages_updated integer not null default 0,
  source_deletes_seen integer not null default 0,
  error_code text,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists threads (
  id text primary key default gen_random_uuid()::text,
  user_id text not null references users(id) on delete cascade,
  subject_normalized text,
  last_message_at timestamptz,
  message_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists messages (
  id text primary key default gen_random_uuid()::text,
  user_id text not null references users(id) on delete cascade,
  canonical_thread_id text references threads(id) on delete set null,
  primary_source_connection_id text references source_connections(id) on delete set null,
  received_at timestamptz not null,
  sent_at timestamptz,
  subject text not null default '',
  from_addr jsonb not null default '{}'::jsonb,
  to_addrs jsonb not null default '[]'::jsonb,
  cc_addrs jsonb not null default '[]'::jsonb,
  reply_to_addrs jsonb not null default '[]'::jsonb,
  snippet text not null default '',
  body_text_ref text,
  raw_ref text,
  content_hash text,
  ingested_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists message_source_refs (
  id text primary key default gen_random_uuid()::text,
  message_id text not null references messages(id) on delete cascade,
  source_connection_id text not null references source_connections(id) on delete cascade,
  provider text not null,
  provider_message_id text not null,
  provider_thread_id text,
  provider_labels text[] not null default '{}',
  provider_history_id text,
  source_internal_date timestamptz,
  source_url text,
  source_state text not null default 'present',
  source_metadata jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (source_connection_id, provider_message_id)
);

create table if not exists ingestion_events (
  id text primary key default gen_random_uuid()::text,
  user_id text references users(id) on delete cascade,
  source_connection_id text references source_connections(id) on delete cascade,
  message_id text references messages(id) on delete cascade,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists message_classifications (
  id text primary key default gen_random_uuid()::text,
  message_id text not null references messages(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  system_category text not null,
  needs_reply boolean not null default false,
  automated boolean not null default false,
  possible_junk boolean not null default false,
  direct boolean not null default false,
  score numeric(6, 2) not null default 0,
  confidence numeric(5, 4) not null default 0,
  reasons jsonb not null default '[]'::jsonb,
  message_type_ids text[] not null default '{}',
  action_metadata jsonb not null default '{}'::jsonb,
  taxonomy_version integer,
  model_provider text,
  model text,
  prompt_id text,
  prompt_version text,
  input_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists message_classification_state (
  message_id text primary key references messages(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  state text not null default 'pending',
  priority_at timestamptz not null,
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_classified_at timestamptz,
  current_classification_id text references message_classifications(id) on delete set null,
  classifier_version text,
  input_hash text,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists message_types (
  id text primary key default gen_random_uuid()::text,
  user_id text not null references users(id) on delete cascade,
  slug text not null,
  display_name text not null,
  description text not null default '',
  kind text not null default 'discovered',
  status text not null default 'candidate',
  parent_type_id text references message_types(id) on delete set null,
  scope text not null default 'all_sources',
  source_connection_id text references source_connections(id) on delete cascade,
  default_importance text not null default 'normal',
  brief_policy text not null default 'important_only',
  notification_policy text not null default 'important_only',
  created_from text not null default 'system',
  example_message_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists user_classification_taxonomies (
  id text primary key default gen_random_uuid()::text,
  user_id text not null references users(id) on delete cascade,
  version integer not null,
  active_type_ids text[] not null default '{}',
  candidate_type_ids text[] not null default '{}',
  prompt_snapshot_hash text,
  created_at timestamptz not null default now(),
  unique (user_id, version)
);

create table if not exists message_type_assignments (
  id text primary key default gen_random_uuid()::text,
  message_id text not null references messages(id) on delete cascade,
  message_type_id text not null references message_types(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  classification_id text references message_classifications(id) on delete set null,
  confidence numeric(5, 4) not null default 0,
  rank integer not null default 1,
  assignment_state text not null default 'current',
  evidence jsonb not null default '[]'::jsonb,
  classifier_version text,
  taxonomy_version integer,
  input_hash text,
  created_at timestamptz not null default now()
);

create table if not exists message_features (
  message_id text primary key references messages(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  sender_domain text,
  sender_contact_id text,
  list_id text,
  list_unsubscribe_present boolean not null default false,
  source_label_keys text[] not null default '{}',
  directness text not null default 'unknown',
  bulk_hint boolean not null default false,
  transactional_hint boolean not null default false,
  security_hint boolean not null default false,
  calendar_hint boolean not null default false,
  entity_keys text[] not null default '{}',
  action_kinds text[] not null default '{}',
  deadline_at timestamptz,
  text_hash text,
  feature_version text not null default 'v0',
  updated_at timestamptz not null default now()
);

create table if not exists message_user_events (
  id text primary key default gen_random_uuid()::text,
  user_id text not null references users(id) on delete cascade,
  message_id text references messages(id) on delete cascade,
  source_connection_id text references source_connections(id) on delete set null,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists message_type_stats (
  user_id text not null references users(id) on delete cascade,
  message_type_id text not null references message_types(id) on delete cascade,
  window_key text not null,
  messages_seen integer not null default 0,
  opened integer not null default 0,
  replied integer not null default 0,
  marked_important integer not null default 0,
  marked_not_important integer not null default 0,
  marked_junk integer not null default 0,
  brief_clicks integer not null default 0,
  unsubscribes integer not null default 0,
  last_message_at timestamptz,
  last_positive_signal_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, message_type_id, window_key)
);

create table if not exists classification_cursors (
  user_id text not null references users(id) on delete cascade,
  pipeline text not null,
  cursor_received_at timestamptz,
  cursor_message_id text,
  last_batch_started_at timestamptz,
  last_batch_completed_at timestamptz,
  last_seen_new_message_at timestamptz,
  classifier_version text,
  status text not null default 'idle',
  updated_at timestamptz not null default now(),
  primary key (user_id, pipeline)
);

create table if not exists briefs (
  id text primary key default gen_random_uuid()::text,
  user_id text not null references users(id) on delete cascade,
  scope_type text not null default 'all_sources',
  source_connection_id text references source_connections(id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  trigger text not null,
  classification_cursor_snapshot jsonb not null default '{}'::jsonb,
  input_message_ids text[] not null default '{}',
  text text not null default '',
  narrative jsonb not null default '{}'::jsonb,
  callouts jsonb not null default '[]'::jsonb,
  counts jsonb not null default '{}'::jsonb,
  memory jsonb not null default '{}'::jsonb,
  model_provider text,
  model text,
  prompt_id text,
  prompt_version text,
  created_at timestamptz not null default now()
);

create table if not exists feedback (
  id text primary key default gen_random_uuid()::text,
  user_id text not null references users(id) on delete cascade,
  message_id text not null references messages(id) on delete cascade,
  kind text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists source_connections_user_status_idx
  on source_connections (user_id, status);

create index if not exists source_sync_runs_source_started_idx
  on source_sync_runs (source_connection_id, started_at desc);

create index if not exists messages_user_received_idx
  on messages (user_id, received_at desc, id desc);

create index if not exists messages_user_content_hash_idx
  on messages (user_id, content_hash);

create index if not exists message_source_refs_message_idx
  on message_source_refs (message_id);

create index if not exists message_source_refs_source_date_idx
  on message_source_refs (source_connection_id, source_internal_date desc);

create index if not exists ingestion_events_user_created_idx
  on ingestion_events (user_id, created_at desc);

create index if not exists message_classification_state_backlog_idx
  on message_classification_state (user_id, state, priority_at desc, message_id);

create index if not exists message_classification_state_retry_idx
  on message_classification_state (next_attempt_at)
  where state = 'failed';

create index if not exists message_classifications_message_created_idx
  on message_classifications (message_id, created_at desc);

create index if not exists message_types_user_status_idx
  on message_types (user_id, status, updated_at desc);

create unique index if not exists message_types_all_sources_slug_idx
  on message_types (user_id, slug)
  where scope = 'all_sources' and source_connection_id is null;

create unique index if not exists message_types_source_slug_idx
  on message_types (user_id, source_connection_id, slug)
  where scope = 'source';

create unique index if not exists message_type_assignments_current_idx
  on message_type_assignments (message_id, message_type_id)
  where assignment_state = 'current';

create index if not exists message_type_assignments_type_created_idx
  on message_type_assignments (user_id, message_type_id, created_at desc);

create index if not exists message_type_assignments_type_confidence_idx
  on message_type_assignments (user_id, message_type_id, confidence desc);

create index if not exists message_features_sender_domain_idx
  on message_features (user_id, sender_domain);

create index if not exists message_features_list_id_idx
  on message_features (user_id, list_id);

create index if not exists message_user_events_user_type_created_idx
  on message_user_events (user_id, event_type, created_at desc);

create index if not exists briefs_user_scope_period_idx
  on briefs (user_id, scope_type, source_connection_id, period_end desc);

create index if not exists feedback_message_created_idx
  on feedback (message_id, created_at desc);
