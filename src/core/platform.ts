/**
 * Adding a platform = add its literal here + a `platforms/<name>/` folder + one
 * `.register(...)` line in `platforms/index.ts`. Keeping this a closed union
 * (rather than `string`) means the compiler flags every place that would need
 * to care. Feature code (`src/comments/`) has no per-platform branches — by design.
 */
export const PLATFORMS = [
  'instagram',
  'youtube',
  'x',
  'facebook',
  'linkedin',
  'tiktok',
  'threads',
  'pinterest',
  'bluesky',
] as const;
export type Platform = (typeof PLATFORMS)[number];
