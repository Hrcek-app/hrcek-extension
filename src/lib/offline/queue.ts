import type { SaveRequest } from '../save';

/** Enough to ride out an outage; small enough to review by hand. */
export const MAX_QUEUED = 100;

/** The picture a queued entry will carry: its bytes, else its address. */
export type QueuedPicture =
  { kind: 'bytes'; blob: Blob; url: string } | { kind: 'url'; url: string } | null;

export type QueuedState =
  /** Not yet looked up. */
  | { kind: 'waiting' }
  /** Hrček already holds this address; a person decides. */
  | { kind: 'held' }
  /** Hrček refused it; `message` is the server's own words. */
  | { kind: 'refused'; message: string };

export interface QueuedEntry {
  request: Omit<SaveRequest, 'imageUrl'>;
  picture: QueuedPicture;
  savedAt: number;
  /** The server address in settings when it was saved; only that one gets it. */
  server: string;
  state: QueuedState;
}

export class QueueFullError extends Error {
  constructor() {
    super(`At most ${MAX_QUEUED} entries can wait.`);
    this.name = 'QueueFullError';
  }
}

export interface Queue {
  /** Adds or replaces the copy at this address, as waiting. */
  put(entry: Omit<QueuedEntry, 'state'>): Promise<void>;
  get(url: string): Promise<QueuedEntry | null>;
  /** Oldest first. */
  list(): Promise<QueuedEntry[]>;
  count(): Promise<number>;
  /** With `savedAt`, only if the stored copy is that one. */
  remove(url: string, savedAt?: number): Promise<void>;
  /** Only if the stored copy is the one saved at `savedAt`. */
  mark(url: string, savedAt: number, state: QueuedState): Promise<void>;
}

/**
 * How Hrček matches addresses: trimmed, scheme and host lowercased,
 * nothing else touched. Not `new URL()`, which would add a trailing slash
 * to a bare host and turn one address into another.
 */
export function addressKey(url: string): string {
  const trimmed = url.trim();
  const match = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/is.exec(trimmed);
  if (match === null) return trimmed;
  return match[1]!.toLowerCase() + match[2]!.toLowerCase() + match[3]!;
}

/**
 * Bytes as an ArrayBuffer: a Blob does not survive structured cloning
 * everywhere, an ArrayBuffer does.
 */
type StoredPicture =
  | { kind: 'bytes'; bytes: ArrayBuffer; type: string; url: string }
  | { kind: 'url'; url: string }
  | null;

interface Stored extends Omit<QueuedEntry, 'picture'> {
  key: string;
  picture: StoredPicture;
}

const STORE = 'pending';

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function toStored(entry: QueuedEntry): Promise<Stored> {
  const { picture } = entry;
  return {
    ...entry,
    key: addressKey(entry.request.url),
    // Read before any transaction opens: awaiting inside one ends it.
    picture:
      picture?.kind === 'bytes'
        ? {
            kind: 'bytes',
            bytes: await picture.blob.arrayBuffer(),
            type: picture.blob.type,
            url: picture.url,
          }
        : picture,
  };
}

function fromStored(stored: Stored): QueuedEntry {
  const { picture } = stored;
  return {
    request: stored.request,
    savedAt: stored.savedAt,
    server: stored.server,
    state: stored.state,
    picture:
      picture?.kind === 'bytes'
        ? {
            kind: 'bytes',
            blob: new Blob([picture.bytes], { type: picture.type }),
            url: picture.url,
          }
        : picture,
  };
}

export function openQueue(factory: IDBFactory = indexedDB, name = 'hrcek'): Queue {
  let opened: Promise<IDBDatabase> | null = null;

  function database(): Promise<IDBDatabase> {
    opened ??= new Promise((resolve, reject) => {
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('savedAt', 'savedAt');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return opened;
  }

  /** Reads the copy at `url` and lets `change` act on it, in one transaction. */
  async function update(
    url: string,
    change: (store: IDBObjectStore, current: Stored) => void,
  ): Promise<void> {
    const transaction = (await database()).transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const reading = store.get(addressKey(url));
    reading.onsuccess = () => {
      const current = reading.result as Stored | undefined;
      if (current !== undefined) change(store, current);
    };
    await finished(transaction);
  }

  return {
    async put(entry): Promise<void> {
      const stored = await toStored({ ...entry, state: { kind: 'waiting' } });
      const transaction = (await database()).transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      let full = false;
      const existing = store.getKey(stored.key);
      existing.onsuccess = () => {
        // Replacing never counts against the limit.
        if (existing.result !== undefined) {
          store.put(stored);
          return;
        }
        const counting = store.count();
        counting.onsuccess = () => {
          if (counting.result >= MAX_QUEUED) {
            full = true;
            transaction.abort();
            return;
          }
          store.put(stored);
        };
      };
      try {
        await finished(transaction);
      } catch (error) {
        if (full) throw new QueueFullError();
        throw error;
      }
    },

    async get(url): Promise<QueuedEntry | null> {
      const store = (await database()).transaction(STORE).objectStore(STORE);
      const stored = (await result(store.get(addressKey(url)))) as Stored | undefined;
      return stored === undefined ? null : fromStored(stored);
    },

    async list(): Promise<QueuedEntry[]> {
      const store = (await database()).transaction(STORE).objectStore(STORE);
      const all = (await result(store.index('savedAt').getAll())) as Stored[];
      return all.map(fromStored);
    },

    async count(): Promise<number> {
      const store = (await database()).transaction(STORE).objectStore(STORE);
      return result(store.count());
    },

    remove(url, savedAt): Promise<void> {
      return update(url, (store, current) => {
        if (savedAt === undefined || current.savedAt === savedAt)
          store.delete(current.key);
      });
    },

    mark(url, savedAt, state): Promise<void> {
      return update(url, (store, current) => {
        if (current.savedAt === savedAt) store.put({ ...current, state });
      });
    },
  };
}
