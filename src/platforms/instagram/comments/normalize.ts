import type { CommentsContext } from '../../../comments/capability.js';
import type { ExternalComment } from '../../../comments/types.js';
import type { IgComment } from './schemas.js';

/**
 * IG Graph comment → platform-agnostic comment.
 * `from` is only populated on media owned by the token's user (our case). Reply
 * counts aren't a plain field, so `replyCount` stays null rather than costing a call per comment;
 * comments have no permalink of their own.
 */
export const toExternal = (ctx: CommentsContext, c: IgComment, parentId: string | null): ExternalComment => ({
  id: c.id,
  parentId,
  author: {
    id: c.from?.id ?? null,
    username: c.from?.username ?? c.username ?? null,
    displayName: null,
    avatarUrl: null,
  },
  isFromAccountOwner: c.from ? c.from.id === ctx.account.externalAccountId : null,
  text: c.text ?? '',
  createdAt: new Date(c.timestamp).toISOString(),
  likeCount: c.like_count ?? null,
  replyCount: null,
  permalink: null,
});
