import { describe, expect, it } from 'vitest';
import { describeError } from '../src/health.js';

describe('describeError', () => {
  it('uses the message when there is one', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('appends a syscall code so the reason is visible', () => {
    const err = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });
    expect(describeError(err)).toBe('connect failed (ECONNREFUSED)');
  });

  it('does not repeat a code already present in the message', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5431'), {
      code: 'ECONNREFUSED',
    });
    expect(describeError(err)).toBe('connect ECONNREFUSED 127.0.0.1:5431');
  });

  it('unwraps an AggregateError, which is what a refused connection looks like', () => {
    // Node tries every resolved address and reports the failures together; the
    // AggregateError's own message is empty, so reading it alone says nothing.
    const err = new AggregateError(
      [
        Object.assign(new Error('connect ECONNREFUSED ::1:5431'), { code: 'ECONNREFUSED' }),
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5431'), {
          code: 'ECONNREFUSED',
        }),
      ],
      '',
    );
    expect(describeError(err)).toBe(
      'AggregateError: connect ECONNREFUSED ::1:5431; connect ECONNREFUSED 127.0.0.1:5431',
    );
  });

  it('falls back to the error name when everything is empty', () => {
    expect(describeError(new AggregateError([], ''))).toBe('AggregateError');
    expect(describeError(new Error(''))).toBe('Error');
  });

  it('handles a thrown non-Error', () => {
    expect(describeError('plain string')).toBe('plain string');
  });
});
