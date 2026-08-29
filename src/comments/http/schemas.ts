import { z } from 'zod';

export const PostParams = z.object({ postId: z.string().min(1) });
export const CommentParams = PostParams.extend({ commentId: z.string().min(1).max(512) });

export const PageQuery = z.object({
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const ReplyBody = z.object({
  text: z.string().min(1).max(10_000), // platform-specific ceilings enforced by the provider limits
});

export const IdempotencyKeyHeader = z.string().min(1).max(255);
