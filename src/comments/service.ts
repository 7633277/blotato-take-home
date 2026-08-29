import { createHash, randomUUID } from 'node:crypto';
import type { Post } from '../core/entities.js';
import { type AppError, appError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { andThen, err, ok, type Result } from '../core/result.js';
import type { PlatformRegistry } from '../platforms/adapter.js';
import {
  type CommentsCapability,
  type CommentsContext,
  type CommentsSupport,
  describeCommentsSupport,
  type ExternalPage,
} from './capability.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import type { PostResolver, ReplyRecord, ReplyRepository } from './repo/repository.js';
import type { Comment, ExternalComment, Page } from './types.js';

export interface CommentServiceDeps {
  readonly platforms: PlatformRegistry;
  readonly posts: PostResolver;
  readonly replies: ReplyRepository;
  readonly newId?: () => string;
  readonly now?: () => Date;
  /** How long a `pending` row may sit untouched before its owner is presumed dead and it becomes `unknown`. */
  readonly pendingLeaseMs?: number;
}

export interface PageOptions {
  readonly cursor: string | null;
  readonly limit: number;
}

export interface ReplyRequest {
  readonly text: string;
  /** Client-chosen key; same key + same payload ⇒ same result, exactly one upstream reply. */
  readonly idempotencyKey: string | null;
}

export interface ReplyResult {
  readonly comment: Comment;
  /** True when this response was served from a previous, completed request with the same idempotency key. */
  readonly replayed: boolean;
}

interface Resolved {
  readonly post: Post & { externalPostId: string };
  readonly comments: CommentsCapability;
  readonly ctx: CommentsContext;
}

const DEFAULT_LIMIT = 25;
const DEFAULT_PENDING_LEASE_MS = 120_000; // comfortably above the HTTP client's timeout × retries

/**
 * Platform-agnostic orchestration: authorise → resolve the platform's comments
 * capability → translate cursors → call → normalise. No `if (platform === ...)`
 * anywhere here; if you find yourself wanting one, the capability interface is
 * missing an operation.
 */
export class CommentService {
  private readonly newId: () => string;
  private readonly now: () => Date;
  private readonly pendingLeaseMs: number;

  constructor(private readonly deps: CommentServiceDeps) {
    this.newId = deps.newId ?? randomUUID;
    this.now = deps.now ?? (() => new Date());
    this.pendingLeaseMs = deps.pendingLeaseMs ?? DEFAULT_PENDING_LEASE_MS;
  }

  /** Which platforms support which comment operations. */
  support(): CommentsSupport[] {
    return this.deps.platforms
      .list()
      .flatMap((a) => (a.comments ? [describeCommentsSupport(a.platform, a.comments)] : []));
  }

  async listComments(
    userId: string,
    postId: string,
    opts: PageOptions,
    log: Logger,
  ): Promise<Result<Page<Comment>, AppError>> {
    const resolved = await this.resolve(userId, postId, log);
    if (!resolved.ok) return resolved;
    const { post, comments, ctx } = resolved.value;
    const cursorState = opts.cursor === null ? ok(null) : decodeCursor(post.platform, opts.cursor);
    if (!cursorState.ok) return cursorState;
    const page = await comments.listComments(ctx, {
      cursorState: cursorState.value,
      limit: this.limit(opts, comments),
    });
    return andThen(page, (p) => ok(this.toPage(post, p)));
  }

  async listReplies(
    userId: string,
    postId: string,
    commentId: string,
    opts: PageOptions,
    log: Logger,
  ): Promise<Result<Page<Comment>, AppError>> {
    const resolved = await this.resolve(userId, postId, log);
    if (!resolved.ok) return resolved;
    const { post, comments, ctx } = resolved.value;
    if (!comments.listReplies) {
      return err(
        appError(
          'OPERATION_NOT_SUPPORTED',
          `${post.platform} does not expose replies as a separate list; use listComments (replies carry parentId)`,
        ),
      );
    }
    const cursorState = opts.cursor === null ? ok(null) : decodeCursor(post.platform, opts.cursor);
    if (!cursorState.ok) return cursorState;
    const page = await comments.listReplies(ctx, {
      commentId,
      cursorState: cursorState.value,
      limit: this.limit(opts, comments),
    });
    return andThen(page, (p) => ok(this.toPage(post, p)));
  }

  /**
   * Reply state machine (one row in comment_replies per logical request):
   *
   *   (new) ──insert──▶ pending ──platform ok──▶ sent      ⇒ 201, replay on same key ⇒ 201 + replayed
   *                        │──platform error──▶ failed     ⇒ 4xx/5xx; same key may retry ⇒ row reused
   *                        │──timeout──────────▶ unknown   ⇒ 504; same key ⇒ 409 REPLY_CONFLICT{unknown} (never double-post)
   *                        └──owner died (lease expired)──▶ unknown, on the next same-key request
   *
   * Concurrency: every status change that decides who acts is a conditional update, so the DB arbitrates:
   * racing inserts (unique index), racing retries of a failed row, and a late owner racing a lease expiry.
   */
  async reply(
    userId: string,
    postId: string,
    commentId: string,
    req: ReplyRequest,
    log: Logger,
  ): Promise<Result<ReplyResult, AppError>> {
    const resolved = await this.resolve(userId, postId, log);
    if (!resolved.ok) return resolved;
    const { post, comments, ctx } = resolved.value;

    if (!comments.reply)
      return err(
        appError('OPERATION_NOT_SUPPORTED', `Replying to comments is not supported on ${post.platform}`),
      );
    const text = req.text.trim();
    if (text.length === 0) return err(appError('VALIDATION_ERROR', 'Reply text must not be empty'));
    if (text.length > comments.limits.maxReplyLength) {
      return err(
        appError(
          'VALIDATION_ERROR',
          `Reply exceeds ${post.platform}'s limit of ${comments.limits.maxReplyLength} characters`,
          {
            details: { maxReplyLength: comments.limits.maxReplyLength, length: text.length },
          },
        ),
      );
    }

    const requestHash = hashRequest(post.id, commentId, text);
    let record: ReplyRecord;

    const existing =
      req.idempotencyKey === null
        ? null
        : await this.deps.replies.findByIdempotencyKey(userId, req.idempotencyKey);
    if (existing) {
      const verdict = this.judgeExisting(existing, requestHash, post);
      if (verdict.kind === 'return') return verdict.result;
      if (verdict.kind === 'expire') {
        // Pending longer than the lease: whoever owned it is gone, and its platform call may have landed.
        // That is `unknown`, not a retry. Conditional, so a slow owner finishing late still wins.
        await this.deps.replies.transition(existing.id, 'pending', 'unknown', {
          error: { code: 'UPSTREAM_TIMEOUT', message: `No outcome recorded within ${this.pendingLeaseMs}ms` },
        });
        log.warn(
          { platform: post.platform, postId: post.id, replyId: existing.id },
          'comment reply lease expired',
        );
        return err(unknownOutcome(existing.id));
      }
      const claimed = await this.deps.replies.transition(existing.id, 'failed', 'pending', { error: null }); // retry, reusing the row
      if (!claimed) return err(inProgress()); // a concurrent retry claimed it first
      record = claimed;
    } else {
      const created = await this.deps.replies.create({
        id: this.newId(),
        userId,
        postId: post.id,
        accountId: post.accountId,
        platform: post.platform,
        parentCommentId: commentId,
        idempotencyKey: req.idempotencyKey,
        requestHash,
        text,
      });
      if (!created.ok) return err(inProgress()); // lost a race with a concurrent request carrying the same key
      record = created.value;
    }

    const sent = await comments.reply(ctx, { commentId, text });

    if (sent.ok) {
      await this.deps.replies.update(record.id, { status: 'sent', externalCommentId: sent.value.id });
      log.info(
        { platform: post.platform, postId: post.id, replyId: record.id, externalCommentId: sent.value.id },
        'comment reply sent',
      );
      return ok({ comment: this.toComment(post, sent.value), replayed: false });
    }

    const status = sent.error.code === 'UPSTREAM_TIMEOUT' ? 'unknown' : 'failed';
    await this.deps.replies.update(record.id, {
      status,
      error: { code: sent.error.code, message: sent.error.message },
    });
    log.warn(
      { platform: post.platform, postId: post.id, replyId: record.id, code: sent.error.code, status },
      'comment reply not confirmed',
    );
    return err(sent.error);
  }

  // ---------------------------------------------------------------------------

  private judgeExisting(
    existing: ReplyRecord,
    requestHash: string,
    post: Post,
  ): { kind: 'return'; result: Result<ReplyResult, AppError> } | { kind: 'retry' } | { kind: 'expire' } {
    if (existing.requestHash !== requestHash) {
      return {
        kind: 'return',
        result: err(
          appError(
            'VALIDATION_ERROR',
            'This Idempotency-Key was already used with a different post, comment or text',
            { details: { idempotencyKey: 'reused' } },
          ),
        ),
      };
    }
    switch (existing.status) {
      case 'sent':
        return {
          kind: 'return',
          result: ok({ comment: this.replayComment(post, existing), replayed: true }),
        };
      case 'pending':
        return Date.parse(existing.updatedAt) + this.pendingLeaseMs <= this.now().getTime()
          ? { kind: 'expire' }
          : { kind: 'return', result: err(inProgress()) };
      case 'unknown':
        return { kind: 'return', result: err(unknownOutcome(existing.id)) };
      case 'failed':
        return { kind: 'retry' };
    }
  }

  /** Reconstruct the response for a replayed request from what we stored. */
  private replayComment(post: Post, r: ReplyRecord): Comment {
    return {
      id: r.externalCommentId ?? r.id,
      platform: post.platform,
      postId: post.id,
      parentId: r.parentCommentId,
      author: { id: null, username: null, displayName: null, avatarUrl: null },
      isFromAccountOwner: true,
      text: r.text,
      createdAt: r.updatedAt,
      likeCount: null,
      replyCount: null,
      permalink: null,
    };
  }

  private async resolve(userId: string, postId: string, log: Logger): Promise<Result<Resolved, AppError>> {
    const found = await this.deps.posts.resolve(userId, postId);
    if (!found.ok) return found;
    const { post, account, credentials } = found.value;
    if (post.status !== 'published' || post.externalPostId === null) {
      return err(
        appError('POST_NOT_PUBLISHED', `Post is ${post.status}; comments exist only for published posts`),
      );
    }
    const comments = this.deps.platforms.capability(post.platform, 'comments');
    if (!comments.ok) return comments;
    return ok({
      post: { ...post, externalPostId: post.externalPostId },
      comments: comments.value,
      ctx: { account, credentials, externalPostId: post.externalPostId, log },
    });
  }

  private limit(opts: PageOptions, comments: CommentsCapability): number {
    return Math.min(opts.limit || DEFAULT_LIMIT, comments.limits.maxPageSize);
  }

  private toComment(post: Post, c: ExternalComment): Comment {
    return { ...c, platform: post.platform, postId: post.id };
  }

  private toPage(post: Post, p: ExternalPage): Page<Comment> {
    return {
      items: p.items.map((c) => this.toComment(post, c)),
      nextCursor: p.nextPage === null ? null : encodeCursor(post.platform, p.nextPage.cursorState),
    };
  }
}

const inProgress = (): AppError =>
  appError('REPLY_CONFLICT', 'A reply with this Idempotency-Key is already being processed', {
    details: { status: 'pending' },
  });

const unknownOutcome = (replyId: string): AppError =>
  appError(
    'REPLY_CONFLICT',
    'A previous attempt may have been delivered; check the thread before retrying with a new key',
    {
      details: { status: 'unknown', replyId },
    },
  );

const hashRequest = (postId: string, commentId: string, text: string): string =>
  createHash('sha256')
    .update(JSON.stringify([postId, commentId, text]))
    .digest('hex');
