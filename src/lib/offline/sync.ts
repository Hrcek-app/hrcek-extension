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
  /**
   * Why the run ended early: an outage, a refused token, or a lookup
   * Hrček failed to answer for any other reason.
   */
  stopped: 'unavailable' | 'unauthorized' | 'failed' | null;
}

/** Failures that end a run whichever step they come from. */
function stopFor(error: unknown): 'unavailable' | 'unauthorized' | null {
  if (isUnavailable(error)) return 'unavailable';
  if (isAuthFailure(error)) return 'unauthorized';
  return null;
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
 * Whether "Replace with mine" may send this copy now: only one Hrček
 * already holds, and only to the server it was saved for. The waiting
 * page may be stale about either.
 */
export function canReplace(entry: QueuedEntry, serverUrl: string): boolean {
  return entry.server === serverUrl && entry.state.kind === 'held';
}

/**
 * Looks before writing, entry by entry, oldest first. Hrček holding the
 * address already is not this routine's to settle: the entry is held for
 * a person. Only waiting entries meant for `server` are touched, and
 * each is read again before it is handled, so one deleted or replaced
 * meanwhile is left alone. The first sign of an outage, a refused token
 * or a lookup that fails any other way ends the run with everything
 * after it as it was.
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
  for (const listed of await queue.list()) {
    if (listed.server !== server || listed.state.kind !== 'waiting') continue;
    const { url } = listed.request;
    // The list is a snapshot: the person may have deleted this entry, or
    // the popup saved a newer copy, since it was read.
    const entry = await queue.get(url);
    if (
      entry === null ||
      entry.savedAt !== listed.savedAt ||
      entry.state.kind !== 'waiting'
    )
      continue;
    let existing: EntryOut | null;
    try {
      existing = await loadExisting(client, url);
    } catch (error) {
      // Whatever kept Hrček from answering about this entry keeps it from
      // answering about the next one too. Refusing is the send's verdict
      // alone: a lookup that fails says nothing about the entry.
      result.stopped = stopFor(error) ?? 'failed';
      break;
    }
    if (existing !== null) {
      await queue.mark(url, entry.savedAt, { kind: 'held' });
      result.held += 1;
      continue;
    }
    try {
      const sent = await sendQueued(client, entry);
      // Only this copy: the popup may have saved a newer one meanwhile.
      await queue.remove(url, entry.savedAt);
      result.saved += 1;
      if (sent.trouble !== null) result.withoutPicture.push(entry.request.title || url);
    } catch (error) {
      const stop = stopFor(error);
      if (stop !== null) {
        result.stopped = stop;
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
