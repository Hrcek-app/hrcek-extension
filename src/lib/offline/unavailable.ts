import { HrcekApiError, HrcekNetworkError } from '../api/errors';

/** What a reverse proxy in front of a stopped Hrček answers. */
const UNAVAILABLE_STATUSES = new Set([502, 503, 504]);

/**
 * Whether waiting could fix this failure. Only then is a save kept for
 * later: a refused token or a validation error will still be refused
 * tomorrow, and keeping it would only hide that.
 */
export function isUnavailable(error: unknown): boolean {
  if (error instanceof HrcekNetworkError) return true;
  return error instanceof HrcekApiError && UNAVAILABLE_STATUSES.has(error.status);
}
