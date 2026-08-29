import type { CommentsContext } from '../../../comments/capability.js';
import type { ExternalComment } from '../../../comments/types.js';
import type { Tweet, User } from './schemas.js';

/** Reply tweet (+ expanded author) → platform-agnostic comment. A reply to the post itself is top-level. */
export const toExternal = (
  ctx: CommentsContext,
  t: Tweet,
  users: ReadonlyMap<string, User>,
): ExternalComment => {
  const repliedTo = t.referenced_tweets?.find((rt) => rt.type === 'replied_to')?.id ?? null;
  const u = t.author_id ? users.get(t.author_id) : undefined;
  return {
    id: t.id,
    parentId: repliedTo === ctx.externalPostId ? null : repliedTo,
    author: {
      id: t.author_id ?? null,
      username: u?.username ?? null,
      displayName: u?.name ?? null,
      avatarUrl: u?.profile_image_url ?? null,
    },
    isFromAccountOwner: t.author_id ? t.author_id === ctx.account.externalAccountId : null,
    text: t.text,
    createdAt: new Date(t.created_at).toISOString(),
    likeCount: t.public_metrics?.like_count ?? null,
    replyCount: t.public_metrics?.reply_count ?? null,
    permalink: u ? `https://x.com/${u.username}/status/${t.id}` : null,
  };
};
