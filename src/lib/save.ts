import type { HrcekClient, SaveResult } from './api/client';
import { HrcekApiError } from './api/errors';
import type { PictureTrouble } from './picture';
import type { EntryOut } from './api/types';

export interface SaveRequest {
  url: string;
  title: string;
  notes: string;
  tags: string[];
  /**
   * Every field the form rendered, empty ones as "" to clear them.
   * `fields` is patched, not replaced, so anything omitted keeps its old
   * value — which is why nothing the form did not show may appear here.
   */
  fields: Record<string, string>;
  /**
   * An address for the server to fetch, when the bytes could not be read
   * here. Left undefined the attribute is not sent at all, and the entry
   * keeps whatever picture it had — omission is the documented no-op.
   */
  imageUrl?: string;
}

/** Look before writing: POST replaces, so the UI must show what it replaces. */
export async function loadExisting(
  client: HrcekClient,
  url: string,
): Promise<EntryOut | null> {
  try {
    return await client.getEntryByUrl(url);
  } catch (error) {
    if (error instanceof HrcekApiError && error.code === 'HRC-CORE-0003') return null;
    throw error;
  }
}

export interface SaveOutcome extends SaveResult {
  /**
   * Why the picture did not come, when the entry only saved because
   * `image_url` was dropped. Null when nothing was dropped — including
   * when no picture was offered at all. Shaped like `attachPicture`'s
   * answer so the caller renders both the same way.
   */
  pictureTrouble: PictureTrouble | null;
}

/**
 * The single submit boundary. A future offline queue slots in here:
 * persist the request when the server is unreachable instead of throwing.
 */
export async function submitSave(
  client: HrcekClient,
  request: SaveRequest,
): Promise<SaveOutcome> {
  const post = (imageUrl: string | undefined): Promise<SaveResult> =>
    client.saveEntry({
      // title, notes and tags always go in full: POST replaces, so a
      // partial send silently clears whatever it left out.
      url: request.url,
      title: request.title,
      notes: request.notes,
      tags: request.tags,
      fields: request.fields,
      ...(imageUrl === undefined ? {} : { image_url: imageUrl }),
    });

  try {
    return { ...(await post(request.imageUrl)), pictureTrouble: null };
  } catch (error) {
    // A picture never fails the entry. The server fetches image_url
    // inside the save's own transaction, so an address it will not go to
    // — a signed URL, a referer check, a host that does not resolve —
    // takes the whole save down with it. Post again without the picture
    // and report the picture separately, the way every other picture
    // failure is reported.
    //
    // The code prefix is the contract; the message is translated and may
    // be reworded, so it is shown and never branched on. Retried once and
    // once only: the second post carries nothing that can fail this way.
    if (
      request.imageUrl === undefined ||
      !(error instanceof HrcekApiError) ||
      !error.code.startsWith('HRC-IMAGE-')
    ) {
      throw error;
    }
    return {
      ...(await post(undefined)),
      pictureTrouble: { kind: 'refused', message: error.message },
    };
  }
}
