import type { HttpClient } from '../../core/http-client.js';
import type { PlatformAdapter } from '../adapter.js';
import { xComments } from './comments/index.js';

/** X adapter: one key per capability we've implemented. */
export const x = (http: HttpClient) =>
  ({
    platform: 'x',
    comments: xComments(http),
  }) satisfies PlatformAdapter;
