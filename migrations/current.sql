-- Write the next idempotent migration here. Run `bun run db:current` while iterating.

-- Bind OAuth state values to the user that started the flow, so the callback
-- can attach the resulting account to the right user. Existing rows (if any)
-- are abandoned because they have no associated user; the 10-minute TTL means
-- they would have expired anyway.

alter table oauth_states
  add column if not exists user_id text references users(id) on delete cascade;

create index if not exists oauth_states_user_idx
  on oauth_states (user_id);
