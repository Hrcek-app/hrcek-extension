import type { HrcekClient } from '../api/client';
import { HrcekApiError, isAuthFailure } from '../api/errors';
import type { EntryOut } from '../api/types';
import { attachPicture, type PictureChoice, type PictureTrouble } from '../picture';
import { loadExisting, submitSave } from '../save';
import type { Queue, QueuedEntry, QueuedPicture } from './queue';
import { isUnavailable } from './unavailable';

export interface Sendable {
  request: QueuedEntry['request'];
  picture: QueuedPicture;
}

export interface Sent {
  status: 'created' | 'updated';
  entry: EntryOut;
  /** Why the picture did not attach; null when it did, or there was none. */
  trouble: PictureTrouble | null;
}

export interface SyncResult {
  saved: number;
  held: number;
  refused: number;
  /** Titles (or addresses, untitled) saved without their picture. */
  withoutPicture: string[];
  stopped: 'unavailable' | 'unauthorized' | null;
}

/**
 * Sends one entry the way the popup sends one: bytes uploaded after the
 * entry, else the address as `image_url`, and a picture never failing
 * the entry. Throws whatever the entry's own save throws.
 */
export async function sendQueued(client: HrcekClient, item: Sendable): Promise<Sent> {
  const { picture } = item;
  const choice: PictureChoice =
    picture === null ? { kind: 'unchanged' } : { kind: 'url', url: picture.url };
  const bytes = picture?.kind === 'bytes' ? picture.blob : null;
  const outcome = await submitSave(client, {
    ...item.request,
    ...(picture?.kind === 'url' ? { imageUrl: picture.url } : {}),
  });
  const trouble =
    outcome.pictureTrouble ?? (await attachPicture(client, outcome.entry, choice, bytes));
  return { status: outcome.status, entry: outcome.entry, trouble };
}

/**
 * Looks before writing, entry by entry, oldest first. Hrček holding the
 * address already is not this routine's to settle: the entry is held for
 * a person. Only waiting entries meant for `server` are touched; the
 * first sign of an outage or a refused token ends the run with
 * everything after it as it was.
 */
export async function syncQueue(
  client: HrcekClient,
  queue: Queue,
  server: string,
): Promise<SyncResult> {
  const result: SyncResult = {
    saved: 0,
    held: 0,
    refused: 0,
    withoutPicture: [],
    stopped: null,
  };
  for (const entry of await queue.list()) {
    if (entry.server !== server || entry.state.kind !== 'waiting') continue;
    const { url } = entry.request;
    try {
      if ((await loadExisting(client, url)) !== null) {
        await queue.mark(url, entry.savedAt, { kind: 'held' });
        result.held += 1;
        continue;
      }
      const sent = await sendQueued(client, entry);
      // Only this copy: the popup may have saved a newer one meanwhile.
      await queue.remove(url, entry.savedAt);
      result.saved += 1;
      if (sent.trouble !== null) result.withoutPicture.push(entry.request.title || url);
    } catch (error) {
      if (isUnavailable(error)) {
        result.stopped = 'unavailable';
        break;
      }
      if (isAuthFailure(error)) {
        result.stopped = 'unauthorized';
        break;
      }
      if (error instanceof HrcekApiError) {
        await queue.mark(url, entry.savedAt, { kind: 'refused', message: error.message });
        result.refused += 1;
        continue;
      }
      throw error;
    }
  }
  return result;
}
