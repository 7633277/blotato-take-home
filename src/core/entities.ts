import type { Platform } from './platform.js';

/** Entities ASSUMED to already exist in the system; only the fields this feature reads. */

export interface SocialAccount {
  readonly id: string;
  readonly userId: string;
  readonly platform: Platform;
  /** Platform-native id of the connected identity (IG user id, YT channel id, X user id, ...) */
  readonly externalAccountId: string;
  readonly displayName: string;
}

export type PostStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed';

export interface Post {
  readonly id: string;
  readonly userId: string;
  readonly accountId: string;
  readonly platform: Platform;
  readonly status: PostStatus;
  /** Platform-native id of the published object (IG media id, YT video id, tweet id). Null until published. */
  readonly externalPostId: string | null;
  readonly publishedAt: string | null;
}

export interface AccountCredentials {
  /** A currently-valid access token; refresh/decryption is the credential store's job. */
  readonly accessToken: string;
}
