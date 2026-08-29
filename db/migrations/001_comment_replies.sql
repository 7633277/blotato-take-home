-- ---------------------------------------------------------------------------
-- Comment system — storage
--
-- Deliberately minimal. Comments live on the platforms; we do NOT mirror them
-- for the MVP (see README "Why not store comments?"). The only thing we must
-- persist is our own WRITES, because a reply is a non-idempotent side effect
-- on a third-party system: a client retry after a network timeout must not
-- post the same reply twice, and we need an audit trail of what Blotato did
-- on the user's behalf.
--
-- Assumed existing tables (columns shown are the ones this feature reads):
--   users(id uuid pk)
--   social_accounts(id uuid pk, user_id uuid, platform text, external_account_id text, display_name text)
--   posts(id uuid pk, user_id uuid, account_id uuid, platform text, status text,
--         external_post_id text, published_at timestamptz)
-- ---------------------------------------------------------------------------

create type comment_reply_status as enum (
  'pending',  -- row inserted, platform call in flight
  'sent',     -- platform acknowledged; external_comment_id populated
  'failed',   -- platform rejected (error_code/error_message populated); may be retried with the same key via a conditional update
  'unknown'   -- platform call timed out: it MAY have succeeded. Never auto-retried; reconciled out-of-band.
);

create table comment_replies (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(id),
  post_id             uuid not null references posts(id),
  account_id          uuid not null references social_accounts(id),
  platform            text not null,
  parent_comment_id   text not null,               -- platform-native id of the comment replied to
  external_comment_id text,                        -- platform-native id of the created reply (once known)
  idempotency_key     text,                        -- client supplied; null = client opted out of idempotency
  request_hash        text not null,               -- sha256(post_id, parent_comment_id, text): detects key reuse with a different payload
  text                text not null,
  status              comment_reply_status not null default 'pending',
  error_code          text,
  error_message       text,
  attempts            integer not null default 1,           -- the insert is the first attempt; retries do `set attempts = attempts + 1 where status = 'failed'`
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Idempotency: one row per (tenant, key). Partial so opted-out rows don't collide.
create unique index comment_replies_idempotency_uq
  on comment_replies (user_id, idempotency_key) where idempotency_key is not null;

-- "Replies we sent on this post", newest first (UI / audit / support).
create index comment_replies_post_idx on comment_replies (post_id, created_at desc);

-- Work queue for the reconciler: 'unknown' rows, plus 'pending' rows whose owner died (older than the
-- service's lease, 120 s by default) — both are resolved by re-reading the thread, never by re-sending.
create index comment_replies_reconcile_idx on comment_replies (updated_at) where status in ('pending', 'unknown');

-- Keep `updated_at` honest.
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger comment_replies_touch before update on comment_replies
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- PHASE 2 (not created now — documented so the shape is agreed early):
-- a read mirror of comments, needed the moment we want any of: DM/comment
-- automations ("reply when someone comments X"), an inbox across posts,
-- analytics, webhooks, or serving the UI without burning platform quota.
--
-- create table comments (
--   id                  uuid primary key default gen_random_uuid(),
--   post_id             uuid not null references posts(id),
--   platform            text not null,
--   external_id         text not null,
--   parent_external_id  text,
--   author_external_id  text, author_username text, author_display_name text, author_avatar_url text,
--   is_from_account_owner boolean,
--   text                text not null,
--   like_count          integer, reply_count integer,
--   created_at          timestamptz not null,
--   first_seen_at       timestamptz not null default now(),
--   last_synced_at      timestamptz not null default now(),
--   deleted_at          timestamptz,               -- soft delete when it disappears upstream
--   raw                 jsonb,                     -- original payload for debugging / re-normalising
--   unique (platform, external_id)
-- );
-- create index comments_post_created_idx on comments (post_id, created_at desc);
-- create table comment_sync_state (
--   post_id uuid primary key references posts(id),
--   last_synced_at timestamptz, last_cursor text, next_sync_at timestamptz, failures integer default 0
-- );
-- ---------------------------------------------------------------------------
