import type {
  CommentsCapability,
  CommentsContext,
  ExternalPage,
  ListCommentsInput,
} from '../../../comments/capability.js';
import { parseCursorState } from '../../../comments/cursor.js';
import type { AppError } from '../../../core/errors.js';
import type { HttpClient } from '../../../core/http-client.js';
import { bearer, clamp, parseBody, send } from '../../../core/http-client.js';
import { andThenAsync, err, ok, type Result } from '../../../core/result.js';
import { mapInstagramError } from '../errors.js';
import { limits } from './limits.js';
import { toExternal } from './normalize.js';
import { CursorState, FIELDS, GRAPH, IgPage } from './schemas.js';

/** Both edges (`/{media}/comments`, `/{comment}/replies`) page identically. */
const page = async (
  http: HttpClient,
  ctx: CommentsContext,
  url: string,
  input: ListCommentsInput,
  parentId: string | null,
): Promise<Result<ExternalPage, AppError>> => {
  const cursor = input.cursorState === null ? ok(null) : parseCursorState(CursorState, input.cursorState);
  if (!cursor.ok) return cursor;
  const res = await send(http, 'instagram', {
    method: 'GET',
    url,
    headers: bearer(ctx.credentials.accessToken),
    query: { fields: FIELDS, limit: clamp(input.limit, 1, limits.maxPageSize), after: cursor.value?.after },
  });
  return andThenAsync(res, async (r) => {
    if (r.status >= 400) return err(mapInstagramError(r.status, r.body, r.headers));
    const parsed = parseBody('instagram', IgPage, r.body, ctx.log);
    if (!parsed.ok) return parsed;
    const after = parsed.value.paging?.cursors?.after;
    return ok({
      items: parsed.value.data.map((c) => toExternal(ctx, c, parentId)),
      // Graph always echoes `cursors.after`; only `paging.next` tells us there's more.
      nextPage: parsed.value.paging?.next && after ? { cursorState: { after } } : null,
    });
  });
};

/** GET /{ig-media-id}/comments — top-level comments. */
export const listComments =
  (http: HttpClient): CommentsCapability['listComments'] =>
  (ctx, input) =>
    page(http, ctx, `${GRAPH}/${encodeURIComponent(ctx.externalPostId)}/comments`, input, null);

/** GET /{ig-comment-id}/replies — one level only. */
export const listReplies =
  (http: HttpClient): NonNullable<CommentsCapability['listReplies']> =>
  (ctx, input) =>
    page(http, ctx, `${GRAPH}/${encodeURIComponent(input.commentId)}/replies`, input, input.commentId);
