import type { AccountCredentials, SocialAccount } from '../core/entities.js';
import type { Logger } from '../core/logger.js';

/** What every capability call receives: who we act as, with what, and where to log. Features extend it. */
export interface PlatformContext {
  readonly account: SocialAccount;
  readonly credentials: AccountCredentials;
  readonly log: Logger;
}
