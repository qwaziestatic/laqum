import { describe, expect, it } from 'vitest';
import { bookingIdFromNotification } from '../src/push/tap.js';

describe('a tapped notification opens its booking', () => {
  const id = '3f2b8c1e-9a4d-4c7e-8b1a-2d3e4f5a6b7c';

  it('reads the booking id the API sends', () => {
    expect(bookingIdFromNotification({ bookingId: id, kind: 'hold-reminder' })).toBe(id);
  });

  it('opens nothing for anything else: the data comes from outside the app', () => {
    for (const data of [
      null,
      undefined,
      'x',
      {},
      { bookingId: 42 },
      { bookingId: '../lot/1' },
      { bookingId: `${id}/../../login` },
    ]) {
      expect(bookingIdFromNotification(data), JSON.stringify(data)).toBeNull();
    }
  });
});
