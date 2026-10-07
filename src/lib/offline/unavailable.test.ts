import { describe, expect, it } from 'vitest';
import { HrcekApiError, HrcekNetworkError } from '../api/errors';
import { isUnavailable } from './unavailable';

describe('isUnavailable', () => {
  it('counts a request that never got an answer', () => {
    expect(isUnavailable(new HrcekNetworkError('Could not reach it.'))).toBe(true);
  });

  it.each([502, 503, 504])('counts a %i answer', (status) => {
    expect(isUnavailable(new HrcekApiError(status, 'HRC-X', 'down'))).toBe(true);
  });

  it("counts a proxy's HTML 503 page, which arrives unparseable", () => {
    expect(
      isUnavailable(new HrcekApiError(503, 'HRC-CLIENT-UNPARSEABLE', 'unreadable')),
    ).toBe(true);
  });

  it.each([400, 401, 403, 404, 422, 500])('does not count a %i answer', (status) => {
    expect(isUnavailable(new HrcekApiError(status, 'HRC-X', 'no'))).toBe(false);
  });

  it('does not count anything else', () => {
    expect(isUnavailable(new TypeError('bug'))).toBe(false);
    expect(isUnavailable(null)).toBe(false);
  });
});
