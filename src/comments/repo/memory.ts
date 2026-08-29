import type { Post, SocialAccount } from '../../core/entities.js';
import { type AppError, appError } from '../../core/errors.js';
import { err, ok, type Result } from '../../core/result.js';
import type {
  NewReplyRecord,
  PostContext,
  PostResolver,
  ReplyPatch,
  ReplyRecord,
  ReplyRepository,
  ReplyStatus,
} from './repository.js';

/** In-memory implementations, used by tests. Production binds Postgres-backed ones. */

export class InMemoryPostResolver implements PostResolver {
  constructor(
    private readonly posts: readonly Post[],
    private readonly accounts: readonly SocialAccount[],
    private readonly tokens: Readonly<Record<string, string>>, // accountId → access token
  ) {}

  async resolve(userId: string, postId: string): Promise<Result<PostContext, AppError>> {
    const post = this.posts.find((p) => p.id === postId && p.userId === userId);
    if (!post) return err(appError('NOT_FOUND', 'Post not found'));
    const account = this.accounts.find((a) => a.id === post.accountId);
    const token = account && this.tokens[account.id];
    if (!account || !token)
      return err(appError('ACCOUNT_AUTH_EXPIRED', 'Account has no valid token; reconnect it'));
    return ok({ post, account, credentials: { accessToken: token } });
  }
}

export class InMemoryReplyRepository implements ReplyRepository {
  readonly rows = new Map<string, ReplyRecord>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  async findByIdempotencyKey(userId: string, key: string): Promise<ReplyRecord | null> {
    for (const r of this.rows.values()) if (r.userId === userId && r.idempotencyKey === key) return r;
    return null;
  }

  async create(record: NewReplyRecord): Promise<Result<ReplyRecord, 'DUPLICATE'>> {
    if (
      record.idempotencyKey !== null &&
      (await this.findByIdempotencyKey(record.userId, record.idempotencyKey))
    )
      return err('DUPLICATE');
    const ts = this.now().toISOString();
    const row: ReplyRecord = {
      ...record,
      status: 'pending',
      externalCommentId: null,
      error: null,
      attempts: 1,
      createdAt: ts,
      updatedAt: ts,
    };
    this.rows.set(row.id, row);
    return ok(row);
  }

  async transition(
    id: string,
    from: ReplyStatus,
    to: ReplyStatus,
    patch: Omit<ReplyPatch, 'status'> = {},
  ): Promise<ReplyRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.status !== from) return null;
    const next: ReplyRecord = {
      ...row,
      ...patch,
      status: to,
      attempts: row.attempts + (to === 'pending' ? 1 : 0),
      updatedAt: this.now().toISOString(),
    };
    this.rows.set(id, next);
    return next;
  }

  async update(id: string, patch: ReplyPatch): Promise<ReplyRecord> {
    const row = this.rows.get(id);
    if (!row) throw new Error(`reply ${id} not found`);
    const next: ReplyRecord = { ...row, ...patch, updatedAt: this.now().toISOString() };
    this.rows.set(id, next);
    return next;
  }
}
