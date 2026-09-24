import { describe, expect, it } from 'vitest';
import { latestOnly } from '../src/latest.js';

/**
 * Home fetches lots for a quick position and again for the fresh one; the
 * responses can arrive in either order. Only the newest may apply.
 */
describe('latestOnly', () => {
  it('lets only the newest ticket apply', () => {
    const latest = latestOnly();
    const quick = latest.take();
    const fresh = latest.take();

    // The fresh response arrives first and applies; the quick one, late, does not.
    expect(latest.isCurrent(fresh)).toBe(true);
    expect(latest.isCurrent(quick)).toBe(false);
  });

  it('keeps a ticket current until another request starts', () => {
    const latest = latestOnly();
    const only = latest.take();
    expect(latest.isCurrent(only)).toBe(true);
    latest.take();
    expect(latest.isCurrent(only)).toBe(false);
  });

  it('gives independent screens independent sequences', () => {
    const a = latestOnly();
    const b = latestOnly();
    const ticket = a.take();
    b.take();
    expect(a.isCurrent(ticket)).toBe(true);
  });
});
