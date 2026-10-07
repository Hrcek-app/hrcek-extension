import type { HrcekClient } from './api/client';
import { HrcekApiError, HrcekNetworkError } from './api/errors';
import type { EntryOut } from './api/types';

/** The server's limit. Above it, the address stands in for the bytes. */
export const MAX_PICTURE_BYTES = 10 * 1024 * 1024;

/** What the picker decided. `unchanged` is the common case. */
export type PictureChoice =
  { kind: 'unchanged' } | { kind: 'none' } | { kind: 'url'; url: string };

/**
 * The bytes, if they can be had. This succeeds when the extension already
 * has access to that origin — which activeTab grants for the tab you are
 * on, so a picture served from the page's own host works, and one on a
 * CDN usually does not. Null means "use image_url instead", never "fail".
 */
export async function fetchPictureBytes(
  url: string,
  fetchFn: typeof fetch = (...args) => fetch(...args),
): Promise<Blob | null> {
  try {
    // No cookies: reading a picture is not worth handing somebody else's
    // site a credential it did not ask this extension for.
    const response = await fetchFn(url, { credentials: 'omit' });
    if (!response.ok) return null;
    const bytes = await response.blob();
    if (bytes.size === 0 || bytes.size > MAX_PICTURE_BYTES) return null;
    // SVG is refused outright by the server; no point spending an upload.
    if (bytes.type.includes('svg')) return null;
    return bytes;
  } catch {
    return null;
  }
}

function filenameFor(url: string): string {
  try {
    const name = new URL(url).pathname.split('/').pop() ?? '';
    return name.length > 0 ? name : 'picture';
  } catch {
    return 'picture';
  }
}

/**
 * Why a picture did not attach, said as a shape rather than as words.
 * The caller renders it: this message ends up inside a sentence that has
 * already been translated, and nothing in `lib/` knows the language.
 */
export type PictureTrouble =
  /** The server refused and said why, in the reader's own language. */
  | { kind: 'refused'; message: string }
  /** The server could not be reached at all. */
  | { kind: 'unreachable' }
  /** Anything else: a raw runtime error, nothing worth quoting. */
  | { kind: 'unknown' };

function troubleFor(error: unknown): PictureTrouble {
  // The server's message is translated and made for people — pass it on.
  if (error instanceof HrcekApiError) return { kind: 'refused', message: error.message };
  // This one the client wrote, in English. Naming the shape instead lets
  // the caller say it in the language the rest of the popup is speaking.
  if (error instanceof HrcekNetworkError) return { kind: 'unreachable' };
  // A raw runtime message ("Failed to fetch", a bug's TypeError) is
  // developer-facing and untranslated. Never show one.
  return { kind: 'unknown' };
}

/**
 * Finishes what the entry POST could not. The POST already carried
 * `image_url` when the bytes were unavailable, so only two things are
 * left: uploading bytes when there are any, and deleting a picture that
 * was dropped — a POST cannot remove one.
 *
 * Answers why the picture failed, and null when it did not. A picture
 * never fails the entry: the entry is already saved by the time this runs.
 */
export async function attachPicture(
  client: HrcekClient,
  entry: EntryOut,
  choice: PictureChoice,
  bytes: Blob | null,
): Promise<PictureTrouble | null> {
  try {
    if (choice.kind === 'unchanged') return null;
    if (choice.kind === 'none') {
      // 404 is what "there was none to remove" looks like; asking for a
      // delete that was not needed is not a failure worth reporting.
      if (entry.image !== null) await client.deleteImage(entry.id);
      return null;
    }
    if (bytes !== null) {
      await client.uploadImage(entry.id, bytes, filenameFor(choice.url));
    }
    return null;
  } catch (error) {
    return troubleFor(error);
  }
}
