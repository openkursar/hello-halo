import { describe, expect, it } from 'vitest';
import { describeFetchError, isRetryableStatus } from '../../utils/retry.js';

describe('Node provider error conversion', () => {
  it('recognizes retryable HTTP metadata on host-supplied errors', () => {
    for (const status of [408, 409, 429, 529, 500, 503, 599]) expect(isRetryableStatus(status)).toBe(true);
    for (const status of [200, 201, 400, 401, 403, 404]) expect(isRetryableStatus(status)).toBe(false);
  });

  it('preserves the JavaScript network cause without duplicating it', () => {
    const error = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }),
    });
    expect(describeFetchError(error)).toBe('fetch failed (ENOTFOUND)');
    expect(describeFetchError(new Error('socket hang up'))).toBe('socket hang up');
    expect(describeFetchError('boom')).toBe('boom');
  });
});
