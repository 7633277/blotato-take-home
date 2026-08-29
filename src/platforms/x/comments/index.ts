import type { CommentsCapability } from '../../../comments/capability.js';
import type { HttpClient } from '../../../core/http-client.js';
import { limits } from './limits.js';
import { listComments } from './list.js';
import { reply } from './reply.js';

/**
 * X API v2 — comments capability. X has no comment object; replies are tweets
 * in the same conversation. No `listReplies`: search has no "children of Y"
 * operator, and the flattened list already carries `parentId`.
 */
export const xComments = (http: HttpClient) =>
  ({
    limits,
    listComments: listComments(http),
    reply: reply(http),
  }) satisfies CommentsCapability;
