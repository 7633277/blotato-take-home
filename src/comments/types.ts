import { z } from 'zod';
import type { Platform } from '../core/platform.js';

export const CommentAuthorSchema = z.object({
  id: z.string().nullable(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().url().nullable(),
});
export type CommentAuthor = z.infer<typeof CommentAuthorSchema>;

/**
 * What a platform returns: everything the platform knows about a comment,
 * nothing about Blotato. Fields a platform can't supply are `null`, never
 * guessed, so clients can tell "zero likes" from "unknown".
 */
export const ExternalCommentSchema = z.object({
  /** Platform-native comment id. Opaque to us; stable; used in URLs. */
  id: z.string().min(1),
  /** Platform-native id of the parent comment, or null for a top-level comment on the post. */
  parentId: z.string().nullable(),
  author: CommentAuthorSchema,
  /** Whether the comment was written by the connected account itself (e.g. our own reply). */
  isFromAccountOwner: z.boolean().nullable(),
  text: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  likeCount: z.number().int().nonnegative().nullable(),
  replyCount: z.number().int().nonnegative().nullable(),
  permalink: z.string().url().nullable(),
});
export type ExternalComment = z.infer<typeof ExternalCommentSchema>;

export interface Comment extends ExternalComment {
  readonly platform: Platform;
  /** Blotato post id the comment belongs to. */
  readonly postId: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  /** Opaque; pass back as `?cursor=` to get the next page. Null = no more pages. */
  readonly nextCursor: string | null;
}
