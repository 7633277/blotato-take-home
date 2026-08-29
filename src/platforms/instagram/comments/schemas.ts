import { z } from 'zod';

export const GRAPH = 'https://graph.facebook.com/v21.0';
/** IG Comment fields (no permalink on comments — that's a Media field). Unknown fields make Graph reject the whole call. */
export const FIELDS = 'id,text,timestamp,username,like_count,from{id,username}';

export const CursorState = z.object({ after: z.string().min(1) });

export const IgComment = z.object({
  id: z.string(),
  text: z.string().optional(),
  timestamp: z.string(),
  username: z.string().optional(),
  like_count: z.number().int().optional(),
  from: z.object({ id: z.string(), username: z.string().optional() }).optional(),
});
export type IgComment = z.infer<typeof IgComment>;

export const IgPage = z.object({
  data: z.array(IgComment),
  paging: z
    .object({ cursors: z.object({ after: z.string().optional() }).optional(), next: z.string().optional() })
    .optional(),
});

export const IgCreated = z.object({ id: z.string() });
