import type { AppError } from '../core/errors.js';
import type { Platform } from '../core/platform.js';
import type { Result } from '../core/result.js';
import type { PlatformContext } from '../platforms/context.js';
import type { ExternalComment } from './types.js';

/**
 * The comments PORT: what the comments feature needs from a platform.
 * Implemented per platform under `platforms/<name>/comments/`.
 *
 * Optional methods are OPERATIONS the platform may lack: if it can't do
 * something the method is simply absent and the API answers
 * OPERATION_NOT_SUPPORTED instead of pretending.
 *
 * Implementations MUST: return Results (never throw for expected failures),
 * validate upstream JSON with zod (so schema drift surfaces as
 * UPSTREAM_MALFORMED_RESPONSE instead of `undefined` leaking to clients),
 * and put tokens in headers, never in query strings (log/proxy hygiene).
 */
export interface CommentsCapability {
  readonly limits: CommentsLimits;
  /** Top-level comments on the post (platforms without a top-level notion may return the flattened thread with `parentId` set). */
  listComments(ctx: CommentsContext, input: ListCommentsInput): Promise<Result<ExternalPage, AppError>>;
  /** Replies under one comment. Absent when the platform has no such query. */
  listReplies?(ctx: CommentsContext, input: ListRepliesInput): Promise<Result<ExternalPage, AppError>>;
  /** Post a reply as the connected account. Absent when the platform API is read-only. */
  reply?(ctx: CommentsContext, input: ReplyInput): Promise<Result<ExternalComment, AppError>>;
}

export interface CommentsContext extends PlatformContext {
  /** Platform-native id of the published post. */
  readonly externalPostId: string;
}

export interface CommentsLimits {
  readonly maxPageSize: number;
  readonly maxReplyLength: number;
  /**
   * How deep the platform's threads go. 1 = only top-level comments accept
   * replies (Instagram, YouTube, TikTok). `null` = unbounded nesting (X, Facebook).
   * (`null`, not `Infinity`: this object is served as JSON and Infinity serialises to null anyway.)
   */
  readonly maxThreadDepth: number | null;
}

export interface ExternalPage {
  readonly items: readonly ExternalComment[];
  /** `null` = last page. Otherwise the platform-private state the service wraps into the opaque cursor. */
  readonly nextPage: { readonly cursorState: unknown } | null;
}

export interface ListCommentsInput {
  /** Decoded platform-private state from a previous page, or null for the first page. */
  readonly cursorState: unknown | null;
  readonly limit: number;
}

export interface ListRepliesInput extends ListCommentsInput {
  readonly commentId: string;
}

export interface ReplyInput {
  readonly commentId: string;
  readonly text: string;
}

/** Client-facing description of what a platform's comments capability supports. */
export interface CommentsSupport {
  readonly platform: Platform;
  readonly listComments: true;
  readonly listReplies: boolean;
  readonly reply: boolean;
  readonly limits: CommentsLimits;
}

export const describeCommentsSupport = (platform: Platform, c: CommentsCapability): CommentsSupport => ({
  platform,
  listComments: true,
  listReplies: typeof c.listReplies === 'function',
  reply: typeof c.reply === 'function',
  limits: c.limits,
});
