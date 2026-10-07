import type { PictureChoice } from '../picture';
import type { Queue, QueuedEntry, QueuedPicture } from './queue';

/**
 * The picture a kept save carries. `previous` is what an already-queued
 * copy had, which "unchanged" means keeping; a fresh save has none.
 */
export function queuedPictureFor(
  choice: PictureChoice,
  bytes: Blob | null,
  previous: QueuedPicture,
): QueuedPicture {
  switch (choice.kind) {
    case 'unchanged':
      return previous;
    case 'none':
      return null;
    case 'url':
      return bytes !== null
        ? { kind: 'bytes', blob: bytes, url: choice.url }
        : { kind: 'url', url: choice.url };
  }
}

/** Throws `QueueFullError` when the queue is full and this is a new address. */
export async function keepForLater(
  queue: Queue,
  server: string,
  request: QueuedEntry['request'],
  picture: QueuedPicture,
  now: number = Date.now(),
): Promise<void> {
  await queue.put({ request, picture, savedAt: now, server });
}

/** Nothing at zero: an empty badge is the resting state. */
export function pendingBadgeText(count: number): string {
  return count === 0 ? '' : String(count);
}
