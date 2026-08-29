import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../../src/comments/cursor.js';

describe('opaque cursor', () => {
  it('round-trips arbitrary provider state', () => {
    const c = encodeCursor('youtube', { pageToken: 'CAUQAA' });
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/); // URL-safe, no padding
    expect(decodeCursor('youtube', c)).toEqual({ ok: true, value: { pageToken: 'CAUQAA' } });
  });

  it('refuses a cursor issued for another platform', () => {
    const c = encodeCursor('instagram', { after: 'abc' });
    const r = decodeCursor('youtube', c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('VALIDATION_ERROR');
  });

  it.each([
    '',
    'not-base64!',
    Buffer.from('{"v":2}').toString('base64url'),
    Buffer.from('[1,2]').toString('base64url'),
  ])('rejects garbage %j', (bad) => {
    const r = decodeCursor('x', bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('VALIDATION_ERROR');
  });
});
