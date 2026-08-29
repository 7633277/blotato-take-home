import type { HttpClient } from '../../core/http-client.js';
import type { PlatformAdapter } from '../adapter.js';
import { instagramComments } from './comments/index.js';

/** Instagram adapter: one key per capability we've implemented. */
export const instagram = (http: HttpClient) =>
  ({
    platform: 'instagram',
    comments: instagramComments(http),
  }) satisfies PlatformAdapter;
