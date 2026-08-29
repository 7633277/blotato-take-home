import type { HttpClient } from '../core/http-client.js';
import { PlatformRegistry } from './adapter.js';
import { instagram } from './instagram/index.js';
import { x } from './x/index.js';

/** Composition root for platform adapters. Adding a platform = one `.register(...)` line. */
export const buildPlatformRegistry = (http: HttpClient): PlatformRegistry =>
  new PlatformRegistry().register(instagram(http)).register(x(http));
