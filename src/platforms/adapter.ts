import type { CommentsCapability } from '../comments/capability.js';
import { type AppError, appError } from '../core/errors.js';
import type { Platform } from '../core/platform.js';
import { err, ok, type Result } from '../core/result.js';

/**
 * Everything a platform can do for us. One optional key per capability; a
 * feature declares its capability interface (the port), the platform folder
 * implements it (the adapter). Absent key = the platform can't do it, and the
 * feature answers PLATFORM_NOT_SUPPORTED without any per-platform branching.
 *
 * Future capabilities are added here as one line each, e.g.
 *   readonly publishing?: PublishingCapability;      // src/publishing/capability.ts
 *   readonly analytics?: AnalyticsCapability;
 *   readonly directMessages?: DirectMessagesCapability;
 */
export interface PlatformCapabilities {
  readonly comments?: CommentsCapability;
}

export type CapabilityName = keyof PlatformCapabilities;

export interface PlatformAdapter extends PlatformCapabilities {
  readonly platform: Platform;
}

export class PlatformRegistry {
  private readonly adapters = new Map<Platform, PlatformAdapter>();

  register(adapter: PlatformAdapter): this {
    if (this.adapters.has(adapter.platform))
      throw new Error(`Adapter for ${adapter.platform} registered twice`);
    this.adapters.set(adapter.platform, adapter);
    return this;
  }

  /** Typed lookup of one capability; missing platform and missing capability look the same to the caller. */
  capability<K extends CapabilityName>(
    platform: Platform,
    name: K,
  ): Result<NonNullable<PlatformCapabilities[K]>, AppError> {
    const adapter = this.adapters.get(platform);
    const cap = adapter?.[name];
    return cap
      ? ok(cap as NonNullable<PlatformCapabilities[K]>)
      : err(
          appError(
            'PLATFORM_NOT_SUPPORTED',
            `${name} is not supported for ${platform}${adapter ? '' : ' (platform not registered)'}`,
          ),
        );
  }

  list(): readonly PlatformAdapter[] {
    return [...this.adapters.values()];
  }
}
