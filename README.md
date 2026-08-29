# Blotato take-home — multi-platform comment system

Retrieve comments on a published post and reply to them, across social platforms, through a REST API.
Fastify + TypeScript, Postgres schema. Instagram and X are implemented; adding a platform is one folder.

```
pnpm install && pnpm test     # service state machine, platform contract × 2, routes
pnpm typecheck
pnpm lint                     # biome: format + lint + import order (pnpm format to fix)
```

## 1. Assumptions

| # | Assumption | Consequence |
|---|---|---|
| A1 | A hardened HTTP client exists (TLS, timeouts, retries w/ backoff, circuit breaking, per-account rate budgets). | `core/http-client.ts` only pins the **contract**: non-2xx *resolves* (so error bodies can be mapped), transport failures *reject*. Tests inject a scripted fake. |
| A2 | Auth, `posts`, `social_accounts` and an encrypted token store with refresh already exist. | One `PostResolver` port returns `{ post, account, credentials }`; the API stub reads `x-user-id`. Production swaps both in. |
| A3 | One Blotato post = one platform publication (`posts.account_id`, `posts.external_post_id`). | Comments hang off `/v2/posts/{postId}`. If a post fans out to N accounts, the same routes work on a `publications` resource. |
| A4 | "Comment" = the platform's native object. On X that's a reply tweet in the conversation. | The normalised model has nullable fields: `null` means *the platform doesn't tell us*, never a guess. |
| A5 | The API is consumed by humans (UI) and agents (MCP). | Machine-readable error `code` + `retryable` + `retryAfterSeconds`; a capabilities endpoint so an agent can discover what it may do. |

## 2. Architecture

### 2.0 Vocabulary

| Term | Meaning | Lives in |
|---|---|---|
| **Platform** | The external system: `instagram`, `x`, … | `core/platform.ts` |
| **Platform adapter** | Everything we can do with one platform — a bag of capabilities | `platforms/<name>/index.ts` |
| **Capability** | One unit a platform may or may not support: `comments` today; `publishing`, `analytics`, `directMessages` later. The interface (port) is owned by the feature that consumes it | `comments/capability.ts` |
| **Operation** | A method inside a capability that may be absent: `listReplies?`, `reply?` | inside the capability |
| **Feature** | Our vertical slice — service, routes, storage — that consumes a capability | `src/comments/` |

```
src/core/          Result, AppError → HTTP status, HttpClient contract + adapter helpers, Platform, entities
src/comments/      FEATURE — platform-agnostic
  capability.ts    CommentsCapability (the port), CommentsContext, limits
  types.ts         Comment / ExternalComment / Page        cursor.ts   opaque cursor codec
  service.ts       tenancy, capability resolution, cursors, reply idempotency. ZERO platform branches.
  http/            Fastify routes, error envelope, auth stub
  repo/            PostResolver (assumed) + ReplyRepository (new), in-memory impls
src/platforms/     ADAPTERS — one folder per platform, one sub-folder per capability
  adapter.ts       PlatformAdapter = { platform, comments?, publishing?… } + PlatformRegistry
  context.ts       PlatformContext (account, credentials, log)
  index.ts         composition root: .register(instagram(http)).register(x(http))
  instagram/
    index.ts       instagram(http) = { platform: 'instagram', comments: instagramComments(http) }
    errors.ts      Graph error → AppError (shared by every Instagram capability)
    comments/      schemas · normalize · list · reply · limits · index
  x/               same shape, no listReplies
```

Dependency direction: `platforms/*` → `comments/capability.ts` (the port) and `core/`; `comments/` never imports a
concrete platform. The only file that knows every platform is `platforms/index.ts`.

### 2.1 Ports and adapters — how a platform is added

```ts
interface CommentsCapability {
  limits: { maxPageSize; maxReplyLength; maxThreadDepth };
  listComments(ctx, { cursorState, limit }): Promise<Result<ExternalPage, AppError>>;
  listReplies?(ctx, { commentId, cursorState, limit }): …;   // optional = operation the platform may lack
  reply?(ctx, { commentId, text }): Promise<Result<ExternalComment, AppError>>;
}

// platforms/x/comments/index.ts — composed from functions, one file per operation
export const xComments = (http: HttpClient) =>
  ({ limits, listComments: listComments(http), reply: reply(http) }) satisfies CommentsCapability;   // no listReplies

// platforms/x/index.ts
export const x = (http: HttpClient) => ({ platform: 'x', comments: xComments(http) }) satisfies PlatformAdapter;
```

Adding LinkedIn: copy the folder shape to `platforms/linkedin/`, add one `.register(...)` line, and run it through
`test/platforms/contract.ts` (token in header, schema-validated normalisation, cursor rejection, error and timeout
mapping). The `Platform` union in `core/platform.ts` already lists the roadmap platforms; a new one is a one-literal
edit there. No existing file's logic changes; the contract test is what makes that *safe* rather than aspirational.

Platform-first (not `comments/providers/*`) because `errors.ts` is about Instagram, not about comments: publishing
and DMs hit the same API and get the same error codes. Each new capability is a sibling folder that reuses it.

**Support is the absence of a key, at both levels.** No `comments` on the adapter ⇒ `422 PLATFORM_NOT_SUPPORTED`.
No `listReplies` on X (search has no "children of Y" query) ⇒ `422 OPERATION_NOT_SUPPORTED`.
`GET /v2/comments/capabilities` reflects this so clients and agents can plan.

### 2.2 Opaque unified cursors

Every platform paginates differently (Graph `after`, X `next_token`, YouTube `pageToken`, LinkedIn offsets).
Clients see one `nextCursor`: `base64url({v:1, p:<platform>, s:<platform state>})`. The service unwraps the envelope
and checks `p`; the adapter validates `s` with its own zod schema. Cross-platform or tampered ⇒ `400`. Not signed,
deliberately: cursors carry no authority — post and account are re-authorised on every request.

### 2.3 One error taxonomy, mapped once

Adapters translate platform failures (Graph `code 190`, X `429` + `x-rate-limit-reset`) into
`AppError { code, retryable, retryAfterSeconds }`; `httpStatusOf(code)` is the only place that knows HTTP. Codes are
grouped by what the caller does next: *fix the request* (400/404) · *wait or change state* (409:
`POST_NOT_PUBLISHED`, `REPLY_CONFLICT`, `ACCOUNT_AUTH_EXPIRED` — 409 not 401, the caller's key is fine, the
*connected account* needs a reconnect) · *give up* (422/403) · *retry* (429/502/504). Every upstream body is
zod-validated: when Meta renames a field we get a loud `502 UPSTREAM_MALFORMED_RESPONSE`, not `undefined` in a
customer's UI. Errors are **values** (`Result<T, AppError>`) from adapter to route; exceptions are for bugs.

### 2.4 Replies: idempotent writes on a non-idempotent third party

A reply is a side effect on a system we don't control; a client retry after a network blip must not post twice.
This is the one thing that genuinely needs storage.

```
(new) ──insert──▶ pending ──platform ok──▶ sent      201; same key ⇒ 201 + Idempotent-Replayed: true, no upstream call
                    │──platform error──▶ failed     4xx/5xx; same key ⇒ retried, row reused (conditional update)
                    │──timeout─────────▶ unknown    504; same key ⇒ 409 REPLY_CONFLICT{unknown} — never auto-retried
                    └──owner died─────▶ unknown    a `pending` row older than the lease (120 s) is expired by the next same-key request
```

Key scope is `(user_id, idempotency_key)` under a partial unique index — **the DB arbitrates races**: two concurrent
same-key requests both `INSERT`, one wins, the other gets `409 REPLY_CONFLICT{pending}`; two concurrent *retries* of a
failed row both `UPDATE … WHERE status = 'failed'`, and again exactly one wins. `request_hash` catches key
reuse with a different payload (`400`). `unknown` is the honest state after a timeout: the reply may exist, we refuse
to guess; a reconciler (not built — `comment_replies_reconcile_idx` is its queue) re-reads the thread and settles the row.

### 2.5 Why not store comments?

Nothing in these requirements needs a mirror — the platform is the source of truth, and serving live avoids stale
data and a sync fleet. So the MVP has one table. A mirror becomes necessary with the first of: comment/DM
automations, a cross-post inbox, analytics, webhooks, or a UI polling without burning Instagram's 200 calls/hour.
The phase-2 schema is drafted (commented out) in the migration; the capability interface doesn't change, the sync
worker is just another caller of `listComments`.

## 3. Database schema

`db/migrations/001_comment_replies.sql`: one new table, `comment_replies` (status enum `pending|sent|failed|unknown`,
platform-native `parent_comment_id`/`external_comment_id`, `idempotency_key`, `request_hash`, error, attempts),
with a partial unique index on `(user_id, idempotency_key)`, a `(post_id, created_at desc)` index for "replies we
sent", and a partial index on `status in ('pending', 'unknown')` — the reconciler's queue: timed-out rows plus
`pending` rows whose owner died. The assumed `users`/`social_accounts`/`posts` tables it references are described at
the top of the file.

## 4. API

Base `/v2`. API-key auth, stubbed as an `x-user-id` header (see A2). Comment ids are platform-native and URL-encoded.
`limit` is 1–100, default 25, capped at the platform's page size; X's floor of 10 means `limit < 10` returns 10.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/comments/capabilities` | Per-platform: `listReplies`, `reply`, `limits` |
| `GET` | `/posts/{postId}/comments?cursor&limit` | Top-level comments (flattened thread with `parentId` on X) |
| `GET` | `/posts/{postId}/comments/{commentId}/replies?cursor&limit` | Replies under a comment |
| `POST` | `/posts/{postId}/comments/{commentId}/replies` + `Idempotency-Key` | Reply as the post's account → `201 { data: Comment }` |

```jsonc
// GET /v2/posts/8c1…/comments?limit=1
{ "data": [ { "id": "17895695668004550", "platform": "instagram", "postId": "8c1…", "parentId": null,
              "author": { "id": "1784…", "username": "fan", "displayName": null, "avatarUrl": null },
              "isFromAccountOwner": false, "text": "love this", "createdAt": "2026-08-02T10:00:00.000Z",
              "likeCount": 3, "replyCount": null, "permalink": null } ],
  "nextCursor": "eyJ2IjoxLCJwIjoiaW5zdGFncmFtIiwicyI6eyJhZnRlciI6IlFWRklVbi4uLiJ9fQ" }

// any error
{ "error": { "code": "RATE_LIMITED", "message": "Instagram rate limit reached", "retryable": true, "retryAfterSeconds": 3600 } }
```

## 5. Platform notes

| | Instagram (Graph) | X (v2) |
|---|---|---|
| List | `GET /{media}/comments`, `after` cursor; only `paging.next` means "more" | `GET tweets/search/recent?query=conversation_id:… is:reply` — whole thread flattened, `parentId` derived, root post excluded; `max_results` floor is 10; 7-day window on basic tiers |
| Replies | `GET /{comment}/replies` | — |
| Reply | `POST /{comment}/replies {message}` → `{id}` only; rest synthesised | `POST tweets {text, reply:{in_reply_to_tweet_id}}` |
| Thread depth | 1 | unbounded |
| Rate limits / gotchas | Graph codes 4/17/32/613; `from` only on own media; comments have no reply-count or permalink fields | 429 + `x-rate-limit-reset`; duplicate text ⇒ 403 |

Endpoint shapes are written from the public docs and fixture-tested, not exercised against live APIs.

## 6. Next, in order

1. Reconciler for `unknown` and lease-expired `pending` replies: re-read the thread (`listReplies`, or `listComments`
   on X) and match `isFromAccountOwner` + text + time; ~50 lines on top of the existing capability.
2. Per-account rate budgets in the HTTP client so one noisy customer can't exhaust a shared app quota.
3. Comment mirror + sync worker (phase-2 schema) — unlocks automations, inbox, analytics, webhooks.
4. Per-adapter metrics (latency, error-code histogram, quota headers); logs already carry `platform/postId/replyId/code`.
5. YouTube, Facebook, LinkedIn, TikTok adapters; `publishing`/`analytics` capabilities beside `comments`.

## 7. Questions I'd ask before this ships

1. Does one post fan out to several accounts? (Decides `posts` vs `publications` as the resource.)
2. Is there a per-account rate-limit budget in the HTTP client, or does each feature self-throttle?
3. Comment automations / inbox on the roadmap? If yes, the mirror lands in the same PR.
4. Should replies be schedulable through the existing scheduler, or always immediate?
5. Is tenancy per user or per workspace? Changes the idempotency-key scope.
6. Expose raw platform payloads (`platformData`) to API customers? Useful, but freezes upstream schemas into our contract.
