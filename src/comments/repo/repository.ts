import type { AccountCredentials, Post, SocialAccount } from '../../core/entities.js';
import type { AppError, ErrorCode } from '../../core/errors.js';
import type { Platform } from '../../core/platform.js';
import type { Result } from '../../core/result.js';

/**
 * ASSUMED existing: everything the platform already knows about a post —
 * the row itself, the account it was published from, and a currently-valid
 * token for that account (decrypted/refreshed by the caller's token store).
 * Fails with NOT_FOUND (also for other tenants' posts: no existence leak) or
 * ACCOUNT_AUTH_EXPIRED (refresh impossible; user must reconnect).
 */
export interface PostContext {
  readonly post: Post;
  readonly account: SocialAccount;
  readonly credentials: AccountCredentials;
}

export interface PostResolver {
  resolve(userId: string, postId: string): Promise<Result<PostContext, AppError>>;
}

/** NEW: the one table this feature adds. */
export type ReplyStatus = 'pending' | 'sent' | 'failed' | 'unknown';

export interface ReplyRecord {
  readonly id: string;
  readonly userId: string;
  readonly postId: string;
  readonly accountId: string;
  readonly platform: Platform;
  readonly parentCommentId: string;
  readonly externalCommentId: string | null;
  readonly idempotencyKey: string | null;
  readonly requestHash: string;
  readonly text: string;
  readonly status: ReplyStatus;
  readonly error: { code: ErrorCode; message: string } | null;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type NewReplyRecord = Omit<
  ReplyRecord,
  'createdAt' | 'updatedAt' | 'attempts' | 'status' | 'externalCommentId' | 'error'
>;

export type ReplyPatch = Partial<Pick<ReplyRecord, 'status' | 'externalCommentId' | 'error'>>;

export interface ReplyRepository {
  findByIdempotencyKey(userId: string, key: string): Promise<ReplyRecord | null>;
  /** Inserts as `pending`, attempts = 1. Fails with 'DUPLICATE' when (userId, idempotencyKey) exists — the DB arbitrates concurrent inserts. */
  create(record: NewReplyRecord): Promise<Result<ReplyRecord, 'DUPLICATE'>>;
  /**
   * Compare-and-set: move `id` from `from` to `to` (applying `patch`) and return the row, or null if it is
   * no longer in `from` — the DB arbitrates concurrent retries and lease expiries the same way it
   * arbitrates inserts (SQL: `UPDATE … WHERE id = $1 AND status = $2`, check the row count).
   * Moving to `pending` counts as a new attempt.
   */
  transition(
    id: string,
    from: ReplyStatus,
    to: ReplyStatus,
    patch?: Omit<ReplyPatch, 'status'>,
  ): Promise<ReplyRecord | null>;
  /** Unconditional write for outcomes we know for certain (the platform answered). */
  update(id: string, patch: ReplyPatch): Promise<ReplyRecord>;
}
