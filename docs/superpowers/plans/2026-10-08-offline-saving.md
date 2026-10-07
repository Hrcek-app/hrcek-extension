# Offline saving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep saves made while Hrček is unreachable in a local queue, show how many are waiting, and send them, never blindly over an existing entry, when the person saves again or asks to sync.

**Architecture:** An IndexedDB queue (`lib/offline/queue.ts`) holds waiting entries with their picture bytes. A pure sync routine (`lib/offline/sync.ts`) looks each entry up before sending it. The background script is the only place a sync runs, serialised by a small runner. It owns the badge count and the toolbar context menu. The popup queues a save when Hrček is unavailable, and asks for a sync after every save. A new extension page lists the waiting entries and settles the held ones.

**Tech Stack:** TypeScript, WXT (Firefox MV2 and Chrome MV3), IndexedDB, Vitest (Node and jsdom), `fake-indexeddb` (new dev dependency), Playwright (Chromium), Lingui.

**Spec:** `docs/superpowers/specs/2026-10-08-offline-saving-design.md`

## Global Constraints

- `src/lib/` never imports from `src/entrypoints/`.
- "Unavailable" means exactly `HrcekNetworkError`, or `HrcekApiError` with `status` 502, 503 or 504. Nothing else queues.
- At most 100 queued entries (`MAX_QUEUED = 100`). Re-saving an address already queued replaces it, even when the queue is full.
- One queued copy per address. Addresses are keyed by trimmed text, with the scheme and host lowercased and nothing else changed (a trailing slash or `www.` is a different address).
- Only the background script runs a sync, one at a time. There is no timer. No `alarms`, `notifications` or `unlimitedStorage` permission.
- Already on Hrček means held, and nothing is sent. Held and refused entries are never retried by a sync.
- Badge text: the queued count as a string, `''` at zero, set globally (no `tabId`).
- Messages are `i18n._('<English>')` literals at their call sites, with Slovenian filled in `src/locales/sl.po` after `pnpm i18n:extract`. A server's `message` is shown verbatim.
- Untrusted text (titles, addresses, notes, tags, server messages) is set with `textContent` or as properties, never interpolated into markup.
- Commits: conventional prefixes, no `Co-Authored-By` or other AI trailer, never `--no-verify`.
- Delivery: one `gh stack` with prefix `offline`: `offline/core` (Tasks 1–4), `offline/background` (Task 5), `offline/popup` (Task 6), `offline/pending` (Task 7). Publish with `gh stack submit --auto`, then set titles and bodies with `gh pr edit` (no AI footer).

### Deviations from the spec (rulings to confirm in review)

1. **The popup asks for a sync after its own save, not on opening.** A sync started on open races with the popup's own save of the same address, and the background could send the older queued copy after the popup sent the newer one. "Every time the user wants to save" is met by the save itself.
2. **The permission is `contextMenus` on both browsers.** Firefox accepts `contextMenus` as an alias of `menus`, so one name works on both; only the menu context differs per manifest version (`action` on MV3, `browser_action` on MV2), chosen by `import.meta.env.MANIFEST_VERSION`.
3. **The queue stores picture bytes as an `ArrayBuffer` plus MIME type, not a `Blob`.** A Blob does not survive structured cloning in every environment the tests run in. The queue's API still takes and returns a `Blob`.

## Review Focus

1. **The popup re-saves an address while the background is sending the older queued copy.** The newer copy must survive. Pinned in Task 2: `remove` and `mark` with a stale `savedAt` leave the newer entry alone.
2. **The server address changes in settings between queueing and syncing.** Nothing goes to the new server. Pinned in Task 3 (sync skips it) and Task 7 (the page offers only Delete).
3. **A reverse proxy answers 503 with an HTML page.** This must count as unavailable, not refused. Pinned in Task 1 (`HRC-CLIENT-UNPARSEABLE` with status 503).
4. **The queue is full and the person re-saves an address already in it.** This is a replacement and must succeed. Pinned in Task 2.
5. **The token is revoked between queueing and syncing.** The sync stops and every entry stays as it was. Pinned in Task 3.

---

### Task 1: What counts as unavailable

**Files:**

- Create: `src/lib/offline/unavailable.ts`
- Test: `src/lib/offline/unavailable.test.ts`

**Interfaces:**

- Consumes: `HrcekApiError(status, code, message)`, `HrcekNetworkError(message)` from `src/lib/api/errors.ts`.
- Produces: `export function isUnavailable(error: unknown): boolean`.

- [ ] **Step 1: Branch and write the failing test**

Create the stack in a fresh worktree (`.claude/worktrees/offline`), then the first branch:

```bash
git worktree add --detach .claude/worktrees/offline main
cd .claude/worktrees/offline && pnpm install
git config rerere.enabled true && git config remote.pushDefault origin
gh stack init -p offline core
```

`src/lib/offline/unavailable.test.ts`:

```ts
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

  it('counts a proxy’s HTML 503 page, which arrives unparseable', () => {
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/lib/offline/unavailable.test.ts`
Expected: FAIL, because `./unavailable` cannot be resolved.

- [ ] **Step 3: Implement**

`src/lib/offline/unavailable.ts`:

```ts
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
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run src/lib/offline/unavailable.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/offline/unavailable.ts src/lib/offline/unavailable.test.ts
git commit -m "feat: tell an unavailable Hrček from a refusal"
```

---

### Task 2: The queue

**Files:**

- Create: `src/lib/offline/queue.ts`
- Test: `src/lib/offline/queue.test.ts`
- Modify: `package.json` (dev dependency `fake-indexeddb`)

**Interfaces:**

- Consumes: `SaveRequest` from `src/lib/save.ts`.
- Produces:

  ```ts
  export const MAX_QUEUED = 100;
  export type QueuedPicture =
    { kind: 'bytes'; blob: Blob; url: string } | { kind: 'url'; url: string } | null;
  export type QueuedState =
    { kind: 'waiting' } | { kind: 'held' } | { kind: 'refused'; message: string };
  export interface QueuedEntry {
    request: Omit<SaveRequest, 'imageUrl'>;
    picture: QueuedPicture;
    savedAt: number;
    server: string;
    state: QueuedState;
  }
  export class QueueFullError extends Error {}
  export interface Queue {
    put(entry: Omit<QueuedEntry, 'state'>): Promise<void>;
    get(url: string): Promise<QueuedEntry | null>;
    list(): Promise<QueuedEntry[]>;
    count(): Promise<number>;
    remove(url: string, savedAt?: number): Promise<void>;
    mark(url: string, savedAt: number, state: QueuedState): Promise<void>;
  }
  export function addressKey(url: string): string;
  export function openQueue(factory?: IDBFactory, name?: string): Queue;
  ```

  `put` always stores `state: { kind: 'waiting' }`. `list` is oldest first. `remove` and `mark` with a `savedAt` act only if the stored entry has that `savedAt`.

- [ ] **Step 1: Add the dev dependency**

Run: `pnpm add -D fake-indexeddb`
Expected: `package.json` `devDependencies` gains `fake-indexeddb`.

- [ ] **Step 2: Write the failing test**

`src/lib/offline/queue.test.ts` (Node environment, which has `Blob`):

```ts
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { addressKey, MAX_QUEUED, openQueue, QueueFullError } from './queue';

const SERVER = 'https://hrcek.example.org';

function entry(url: string, savedAt = 1, title = 'T') {
  return {
    request: { url, title, notes: '', tags: [], fields: {} },
    picture: null,
    savedAt,
    server: SERVER,
  };
}

const fresh = () => openQueue(new IDBFactory());

describe('addressKey', () => {
  it('lowercases scheme and host and trims, nothing more', () => {
    expect(addressKey('  HTTPS://Example.COM/Path?Q=1 ')).toBe(
      'https://example.com/Path?Q=1',
    );
  });
  it('keeps a trailing slash and www. as different addresses', () => {
    expect(addressKey('https://example.com/')).not.toBe(
      addressKey('https://example.com'),
    );
    expect(addressKey('https://www.example.com')).not.toBe(
      addressKey('https://example.com'),
    );
  });
});

describe('openQueue', () => {
  it('keeps an entry as waiting and finds it by any spelling of its address', async () => {
    const queue = fresh();
    await queue.put(entry('https://example.com/a'));
    const found = await queue.get('HTTPS://EXAMPLE.com/a');
    expect(found?.request.url).toBe('https://example.com/a');
    expect(found?.state).toEqual({ kind: 'waiting' });
    expect(await queue.get('https://example.com/A')).toBeNull();
  });

  it('replaces the copy at the same address and resets it to waiting', async () => {
    const queue = fresh();
    await queue.put(entry('https://example.com/a', 1, 'old'));
    await queue.mark('https://example.com/a', 1, { kind: 'held' });
    await queue.put(entry('https://example.com/a', 2, 'new'));
    expect(await queue.count()).toBe(1);
    const found = await queue.get('https://example.com/a');
    expect(found?.request.title).toBe('new');
    expect(found?.state).toEqual({ kind: 'waiting' });
  });

  it('lists oldest first', async () => {
    const queue = fresh();
    await queue.put(entry('https://example.com/b', 20));
    await queue.put(entry('https://example.com/a', 10));
    expect((await queue.list()).map((e) => e.request.url)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
  });

  it(`refuses a new address beyond ${MAX_QUEUED}, but still replaces one it holds`, async () => {
    const queue = fresh();
    for (let i = 0; i < MAX_QUEUED; i++)
      await queue.put(entry(`https://example.com/${i}`, i));
    await expect(queue.put(entry('https://example.com/new', 999))).rejects.toBeInstanceOf(
      QueueFullError,
    );
    await queue.put(entry('https://example.com/5', 1000, 'replaced'));
    expect(await queue.count()).toBe(MAX_QUEUED);
    expect((await queue.get('https://example.com/5'))?.request.title).toBe('replaced');
  });

  it('marks and removes only the copy it was asked about', async () => {
    // The popup re-saved while a sync was sending the older copy.
    const queue = fresh();
    await queue.put(entry('https://example.com/a', 1, 'old'));
    await queue.put(entry('https://example.com/a', 2, 'new'));
    await queue.mark('https://example.com/a', 1, { kind: 'refused', message: 'no' });
    await queue.remove('https://example.com/a', 1);
    const found = await queue.get('https://example.com/a');
    expect(found?.request.title).toBe('new');
    expect(found?.state).toEqual({ kind: 'waiting' });

    await queue.mark('https://example.com/a', 2, { kind: 'refused', message: 'no' });
    expect((await queue.get('https://example.com/a'))?.state).toEqual({
      kind: 'refused',
      message: 'no',
    });
    await queue.remove('https://example.com/a');
    expect(await queue.get('https://example.com/a')).toBeNull();
  });

  it('keeps a picture’s bytes, type and address', async () => {
    const queue = fresh();
    const blob = new Blob(['picture-bytes'], { type: 'image/png' });
    await queue.put({
      ...entry('https://example.com/a'),
      picture: { kind: 'bytes', blob, url: 'https://cdn.example.com/p.png' },
    });
    const picture = (await queue.get('https://example.com/a'))?.picture;
    expect(picture?.kind).toBe('bytes');
    if (picture?.kind !== 'bytes') return;
    expect(picture.url).toBe('https://cdn.example.com/p.png');
    expect(picture.blob.type).toBe('image/png');
    expect(await picture.blob.text()).toBe('picture-bytes');
  });

  it('keeps a picture’s address alone when there were no bytes', async () => {
    const queue = fresh();
    await queue.put({
      ...entry('https://example.com/a'),
      picture: { kind: 'url', url: 'https://cdn.example.com/p.png' },
    });
    expect((await queue.get('https://example.com/a'))?.picture).toEqual({
      kind: 'url',
      url: 'https://cdn.example.com/p.png',
    });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run src/lib/offline/queue.test.ts`
Expected: FAIL, because `./queue` cannot be resolved.

- [ ] **Step 4: Implement**

`src/lib/offline/queue.ts`:

```ts
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
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm vitest run src/lib/offline/queue.test.ts`
Expected: PASS. If `fake-indexeddb` rejects a `put` with `DataCloneError`, the stored shape still holds a Blob somewhere; check `toStored`.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/lib/offline/queue.ts src/lib/offline/queue.test.ts
git commit -m "feat: a local queue for saves Hrček could not take"
```

---

### Task 3: Sending queued entries, and the sync

**Files:**

- Create: `src/lib/offline/sync.ts`
- Test: `src/lib/offline/sync.test.ts`

**Interfaces:**

- Consumes: `Queue`, `QueuedEntry`, `QueuedPicture`, `openQueue` (Task 2); `isUnavailable` (Task 1); `loadExisting(client, url)`, `submitSave(client, request)` from `src/lib/save.ts`; `attachPicture(client, entry, choice, bytes)`, `PictureChoice`, `PictureTrouble` from `src/lib/picture.ts`; `isAuthFailure`, `HrcekApiError` from `src/lib/api/errors.ts`.
- Produces:

  ```ts
  export interface Sendable {
    request: QueuedEntry['request'];
    picture: QueuedPicture;
  }
  export interface Sent {
    status: 'created' | 'updated';
    entry: EntryOut;
    trouble: PictureTrouble | null;
  }
  export async function sendQueued(client: HrcekClient, item: Sendable): Promise<Sent>;
  export interface SyncResult {
    saved: number;
    held: number;
    refused: number;
    /** Titles (or addresses, untitled) saved without their picture. */
    withoutPicture: string[];
    stopped: 'unavailable' | 'unauthorized' | null;
  }
  export async function syncQueue(
    client: HrcekClient,
    queue: Queue,
    server: string,
  ): Promise<SyncResult>;
  ```

- [ ] **Step 1: Write the failing test**

`src/lib/offline/sync.test.ts`:

```ts
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { HrcekClient } from '../api/client';
import { HrcekApiError, HrcekNetworkError } from '../api/errors';
import type { EntryIn, EntryOut } from '../api/types';
import { openQueue, type QueuedPicture } from './queue';
import { sendQueued, syncQueue } from './sync';

const SERVER = 'https://hrcek.example.org';
const NOT_HELD = new HrcekApiError(404, 'HRC-CORE-0003', 'Not found.');

function entryOut(url: string, id = 1): EntryOut {
  return {
    id,
    url,
    title: 'server',
    notes: '',
    tags: [],
    fields: {},
    image: null,
    created_at: '2026-10-08T00:00:00Z',
    updated_at: '2026-10-08T00:00:00Z',
  } as EntryOut;
}

/** A fake client: `held` addresses exist; `fail` makes a call throw. */
function fakeClient(
  options: {
    held?: string[];
    fail?: Partial<Record<'lookup' | 'save' | 'upload', (url: string) => unknown>>;
  } = {},
) {
  const saved: EntryIn[] = [];
  const uploads: string[] = [];
  const client = {
    async getEntryByUrl(url: string) {
      const failure = options.fail?.lookup?.(url);
      if (failure) throw failure;
      if (options.held?.includes(url)) return entryOut(url);
      throw NOT_HELD;
    },
    async saveEntry(entry: EntryIn) {
      const failure = options.fail?.save?.(entry.url);
      if (failure) throw failure;
      saved.push(entry);
      return { status: 'created' as const, entry: entryOut(entry.url, saved.length) };
    },
    async uploadImage(_id: number, _bytes: Blob, filename: string) {
      const failure = options.fail?.upload?.(filename);
      if (failure) throw failure;
      uploads.push(filename);
      return entryOut('x');
    },
    async deleteImage() {},
  };
  return { client: client as unknown as HrcekClient, saved, uploads };
}

async function queueWith(...urls: string[]) {
  const queue = openQueue(new IDBFactory());
  let at = 0;
  for (const url of urls) {
    await queue.put({
      request: { url, title: `title of ${url}`, notes: '', tags: [], fields: {} },
      picture: null,
      savedAt: ++at,
      server: SERVER,
    });
  }
  return queue;
}

describe('syncQueue', () => {
  it('sends what Hrček does not hold and removes it from the queue', async () => {
    const queue = await queueWith('https://e.test/a', 'https://e.test/b');
    const { client, saved } = fakeClient();
    const result = await syncQueue(client, queue, SERVER);
    expect(saved.map((e) => e.url)).toEqual(['https://e.test/a', 'https://e.test/b']);
    expect(result).toEqual({
      saved: 2,
      held: 0,
      refused: 0,
      withoutPicture: [],
      stopped: null,
    });
    expect(await queue.count()).toBe(0);
  });

  it('holds what Hrček already has, sending nothing', async () => {
    const queue = await queueWith('https://e.test/a');
    const { client, saved } = fakeClient({ held: ['https://e.test/a'] });
    const result = await syncQueue(client, queue, SERVER);
    expect(saved).toEqual([]);
    expect(result.held).toBe(1);
    expect((await queue.get('https://e.test/a'))?.state).toEqual({ kind: 'held' });
  });

  it('marks a refusal with the server’s message and carries on', async () => {
    const queue = await queueWith('https://e.test/a', 'https://e.test/b');
    const { client, saved } = fakeClient({
      fail: {
        save: (url) =>
          url === 'https://e.test/a'
            ? new HrcekApiError(422, 'HRC-CORE-0002', 'The submitted data is not valid.')
            : undefined,
      },
    });
    const result = await syncQueue(client, queue, SERVER);
    expect(result.refused).toBe(1);
    expect(result.saved).toBe(1);
    expect(saved.map((e) => e.url)).toEqual(['https://e.test/b']);
    expect((await queue.get('https://e.test/a'))?.state).toEqual({
      kind: 'refused',
      message: 'The submitted data is not valid.',
    });
  });

  it('stops at the first sign of an outage, leaving the rest untouched', async () => {
    const queue = await queueWith('https://e.test/a', 'https://e.test/b');
    const { client, saved } = fakeClient({
      fail: { lookup: () => new HrcekApiError(503, 'HRC-CLIENT-UNPARSEABLE', 'down') },
    });
    const result = await syncQueue(client, queue, SERVER);
    expect(result.stopped).toBe('unavailable');
    expect(saved).toEqual([]);
    expect((await queue.list()).map((e) => e.state.kind)).toEqual(['waiting', 'waiting']);
  });

  it('stops when the outage comes mid-send, keeping that entry', async () => {
    const queue = await queueWith('https://e.test/a');
    const { client } = fakeClient({
      fail: { save: () => new HrcekNetworkError('gone') },
    });
    const result = await syncQueue(client, queue, SERVER);
    expect(result.stopped).toBe('unavailable');
    expect((await queue.get('https://e.test/a'))?.state).toEqual({ kind: 'waiting' });
  });

  it('stops when the token is refused, leaving every entry as it was', async () => {
    const queue = await queueWith('https://e.test/a', 'https://e.test/b');
    const { client, saved } = fakeClient({
      fail: { lookup: () => new HrcekApiError(401, 'HRC-AUTH-0002', 'Token refused.') },
    });
    const result = await syncQueue(client, queue, SERVER);
    expect(result.stopped).toBe('unauthorized');
    expect(saved).toEqual([]);
    expect(await queue.count()).toBe(2);
  });

  it('skips entries meant for another server', async () => {
    const queue = await queueWith('https://e.test/a');
    const { client, saved } = fakeClient();
    const result = await syncQueue(client, queue, 'https://other.example.org');
    expect(saved).toEqual([]);
    expect(result.saved).toBe(0);
    expect(await queue.count()).toBe(1);
  });

  it('does not retry held or refused entries', async () => {
    const queue = await queueWith('https://e.test/a', 'https://e.test/b');
    await queue.mark('https://e.test/a', 1, { kind: 'held' });
    await queue.mark('https://e.test/b', 2, { kind: 'refused', message: 'no' });
    const { client, saved } = fakeClient();
    await syncQueue(client, queue, SERVER);
    expect(saved).toEqual([]);
  });

  it('counts an entry whose picture was refused as saved, and names it', async () => {
    const queue = openQueue(new IDBFactory());
    await queue.put({
      request: {
        url: 'https://e.test/a',
        title: 'With picture',
        notes: '',
        tags: [],
        fields: {},
      },
      picture: { kind: 'url', url: 'https://cdn.e.test/p.jpg' },
      savedAt: 1,
      server: SERVER,
    });
    let first = true;
    const { client, saved } = fakeClient({
      fail: {
        save: () => {
          if (!first) return undefined;
          first = false;
          return new HrcekApiError(
            422,
            'HRC-IMAGE-0006',
            'That image could not be fetched.',
          );
        },
      },
    });
    const result = await syncQueue(client, queue, SERVER);
    expect(result.saved).toBe(1);
    expect(result.withoutPicture).toEqual(['With picture']);
    expect(saved).toHaveLength(1);
    expect(saved[0]).not.toHaveProperty('image_url');
    expect(await queue.count()).toBe(0);
  });
});

describe('sendQueued', () => {
  const request = {
    url: 'https://e.test/a',
    title: 'A',
    notes: '',
    tags: [],
    fields: {},
  };

  it('sends a picture’s address as image_url', async () => {
    const { client, saved, uploads } = fakeClient();
    const picture: QueuedPicture = { kind: 'url', url: 'https://cdn.e.test/p.jpg' };
    const sent = await sendQueued(client, { request, picture });
    expect(saved[0]?.image_url).toBe('https://cdn.e.test/p.jpg');
    expect(uploads).toEqual([]);
    expect(sent.trouble).toBeNull();
  });

  it('uploads a picture’s bytes after the entry, named after its address', async () => {
    const { client, saved, uploads } = fakeClient();
    const picture: QueuedPicture = {
      kind: 'bytes',
      blob: new Blob(['x'], { type: 'image/jpeg' }),
      url: 'https://cdn.e.test/cover.jpg',
    };
    await sendQueued(client, { request, picture });
    expect(saved[0]).not.toHaveProperty('image_url');
    expect(uploads).toEqual(['cover.jpg']);
  });

  it('sends no picture at all when there is none', async () => {
    const { client, saved, uploads } = fakeClient();
    const sent = await sendQueued(client, { request, picture: null });
    expect(saved[0]).not.toHaveProperty('image_url');
    expect(uploads).toEqual([]);
    expect(sent.status).toBe('created');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/lib/offline/sync.test.ts`
Expected: FAIL, because `./sync` cannot be resolved.

- [ ] **Step 3: Implement**

`src/lib/offline/sync.ts`:

```ts
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
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run src/lib/offline/sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/offline/sync.ts src/lib/offline/sync.test.ts
git commit -m "feat: sync queued saves, holding what Hrček already has"
```

---

### Task 4: Keeping a save for later, and the background runner

**Files:**

- Create: `src/lib/offline/keep.ts`, `src/lib/offline/runner.ts`
- Test: `src/lib/offline/keep.test.ts`, `src/lib/offline/runner.test.ts`

**Interfaces:**

- Consumes: `Queue`, `QueuedPicture`, `QueuedEntry` (Task 2); `PictureChoice` from `src/lib/picture.ts`.
- Produces:

  ```ts
  // keep.ts
  export function queuedPictureFor(
    choice: PictureChoice,
    bytes: Blob | null,
    previous: QueuedPicture,
  ): QueuedPicture;
  export async function keepForLater(
    queue: Queue,
    server: string,
    request: QueuedEntry['request'],
    picture: QueuedPicture,
    now?: number,
  ): Promise<void>;
  export function pendingBadgeText(count: number): string;
  // runner.ts
  export interface Runner<R> {
    sync(): Promise<R>;
    exclusive<T>(work: () => Promise<T>): Promise<T>;
  }
  export function createRunner<R>(sync: () => Promise<R>): Runner<R>;
  ```

- [ ] **Step 1: Write the failing tests**

`src/lib/offline/keep.test.ts`:

```ts
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { keepForLater, pendingBadgeText, queuedPictureFor } from './keep';
import { openQueue, type QueuedPicture } from './queue';

const previous: QueuedPicture = { kind: 'url', url: 'https://cdn.e.test/old.jpg' };

describe('queuedPictureFor', () => {
  it('keeps the queued picture when the choice is unchanged', () => {
    expect(queuedPictureFor({ kind: 'unchanged' }, null, previous)).toBe(previous);
  });
  it('drops it when the choice is none', () => {
    expect(queuedPictureFor({ kind: 'none' }, null, previous)).toBeNull();
  });
  it('keeps the bytes of a new choice when there are some', () => {
    const blob = new Blob(['x']);
    expect(
      queuedPictureFor({ kind: 'url', url: 'https://e.test/n.jpg' }, blob, null),
    ).toEqual({
      kind: 'bytes',
      blob,
      url: 'https://e.test/n.jpg',
    });
  });
  it('keeps only the address of a new choice when there are no bytes', () => {
    expect(
      queuedPictureFor({ kind: 'url', url: 'https://e.test/n.jpg' }, null, null),
    ).toEqual({
      kind: 'url',
      url: 'https://e.test/n.jpg',
    });
  });
});

describe('keepForLater', () => {
  it('queues the entry for the given server, as waiting', async () => {
    const queue = openQueue(new IDBFactory());
    const request = {
      url: 'https://e.test/a',
      title: 'A',
      notes: '',
      tags: ['x'],
      fields: {},
    };
    await keepForLater(queue, 'https://hrcek.example.org', request, null, 42);
    expect(await queue.get('https://e.test/a')).toEqual({
      request,
      picture: null,
      savedAt: 42,
      server: 'https://hrcek.example.org',
      state: { kind: 'waiting' },
    });
  });
});

describe('pendingBadgeText', () => {
  it('says nothing at zero, and the count otherwise', () => {
    expect(pendingBadgeText(0)).toBe('');
    expect(pendingBadgeText(1)).toBe('1');
    expect(pendingBadgeText(100)).toBe('100');
  });
});
```

`src/lib/offline/runner.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createRunner } from './runner';

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe('createRunner', () => {
  it('shares one sync between callers who ask while it runs', async () => {
    let runs = 0;
    const { open, opened } = gate();
    const runner = createRunner(async () => {
      runs += 1;
      await opened;
      return runs;
    });
    const first = runner.sync();
    const second = runner.sync();
    open();
    expect(await first).toBe(1);
    expect(await second).toBe(1);
    expect(runs).toBe(1);
  });

  it('runs a fresh sync once the last one has finished', async () => {
    let runs = 0;
    const runner = createRunner(async () => ++runs);
    await runner.sync();
    expect(await runner.sync()).toBe(2);
  });

  it('never overlaps exclusive work with a sync', async () => {
    const order: string[] = [];
    const { open, opened } = gate();
    const runner = createRunner(async () => {
      order.push('sync:start');
      await opened;
      order.push('sync:end');
    });
    const syncing = runner.sync();
    const replacing = runner.exclusive(async () => {
      order.push('replace');
    });
    open();
    await Promise.all([syncing, replacing]);
    expect(order).toEqual(['sync:start', 'sync:end', 'replace']);
  });

  it('keeps going after work that failed', async () => {
    const runner = createRunner(async () => 'ok');
    await expect(
      runner.exclusive(() => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(await runner.sync()).toBe('ok');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/lib/offline/keep.test.ts src/lib/offline/runner.test.ts`
Expected: FAIL, because neither module resolves.

- [ ] **Step 3: Implement**

`src/lib/offline/keep.ts`:

```ts
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
```

`src/lib/offline/runner.ts`:

```ts
export interface Runner<R> {
  /** Starts a sync, or joins the one already started. */
  sync(): Promise<R>;
  /** Runs `work` with nothing else running, in the order asked. */
  exclusive<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * One thing at a time in the background: two syncs, or a sync and a
 * "Replace with mine", must never send the same entry twice.
 */
export function createRunner<R>(sync: () => Promise<R>): Runner<R> {
  let tail: Promise<unknown> = Promise.resolve();
  let syncing: Promise<R> | null = null;

  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  }

  return {
    exclusive,
    sync(): Promise<R> {
      syncing ??= exclusive(sync).finally(() => {
        syncing = null;
      });
      return syncing;
    },
  };
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm vitest run src/lib/offline`
Expected: PASS (all offline tests).

- [ ] **Step 5: Full gate, commit, start the next layer**

```bash
git add src/lib/offline/keep.ts src/lib/offline/keep.test.ts src/lib/offline/runner.ts src/lib/offline/runner.test.ts
git commit -m "feat: keep a save for later, and run one sync at a time"
gh stack add background
```

---

### Task 5: The background (runner, badge, menu, permission)

**Files:**

- Modify: `src/lib/platform/action.ts` (badge methods), `src/lib/icon.ts` (`setBadge`)
- Create: `src/lib/platform/menus.ts`
- Modify: `src/entrypoints/background.ts`, `wxt.config.ts` (permission), `docs/store/permissions.md`
- Test: `src/lib/icon.test.ts` (extend), `src/lib/platform/menus.test.ts`
- Modify: `src/locales/en.po`, `src/locales/sl.po`

**Interfaces:**

- Consumes: `openQueue`, `Queue` (Task 2); `syncQueue`, `sendQueued`, `SyncResult` (Task 3); `createRunner`, `pendingBadgeText` (Task 4); `isUnavailable` (Task 1).
- Produces (the message protocol Tasks 6 and 7 use):
  - `{ type: 'hrcek:sync' }` → responds with `SyncResult | null` (null: not configured).
  - `{ type: 'hrcek:queue-changed' }` → repaints the badge and menu; no response.
  - `{ type: 'hrcek:replace', url: string }` → responds with `{ ok: true } | { ok: false; unavailable: boolean; message: string | null }`.
  - Broadcast `{ type: 'hrcek:synced', result: SyncResult | null }` after every sync or replace.
  - `export function setBadge(text: string): Promise<void>` in `src/lib/icon.ts`.
  - `export function toolbarMenuContext(manifestVersion: number): 'action' | 'browser_action'` in `src/lib/platform/menus.ts`.

- [ ] **Step 1: Write the failing tests**

In `src/lib/icon.test.ts`, add `setBadge` to the `./icon` import and, following the file's `setTitle` tests (WXT's `fakeBrowser`, read back rather than spied), append:

```ts
describe('setBadge', () => {
  it('sets the count for every tab at once', async () => {
    await setBadge('3');
    expect(await fakeBrowser.action.getBadgeText({})).toBe('3');
  });

  it('clears it with an empty string', async () => {
    await setBadge('3');
    await setBadge('');
    expect(await fakeBrowser.action.getBadgeText({})).toBe('');
  });

  it('swallows a failure', async () => {
    vi.spyOn(fakeBrowser.action, 'setBadgeText').mockRejectedValueOnce(new Error('gone'));
    await expect(setBadge('1')).resolves.toBeUndefined();
  });
});
```

If `fakeBrowser.action` does not implement `getBadgeText` or `setBadgeBackgroundColor`, give it a stateful stub in a `beforeEach` (a `Map` keyed by `tabId ?? 'global'`) and ledger the ruling. Do not switch to asserting on spies alone.

`src/lib/platform/menus.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { toolbarMenuContext } from './menus';

describe('toolbarMenuContext', () => {
  it('names the toolbar button the way each manifest version does', () => {
    expect(toolbarMenuContext(3)).toBe('action');
    expect(toolbarMenuContext(2)).toBe('browser_action');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/lib/icon.test.ts src/lib/platform/menus.test.ts`
Expected: FAIL, because `setBadge` and `./menus` don't exist.

- [ ] **Step 3: Implement the platform pieces**

`src/lib/platform/action.ts`: extend the interface:

```ts
interface ToolbarAction {
  setIcon(details: { path: Record<number, string>; tabId?: number }): Promise<void>;
  setTitle(details: { title: string; tabId?: number }): Promise<void>;
  setBadgeText(details: { text: string; tabId?: number }): Promise<void>;
  setBadgeBackgroundColor(details: { color: string; tabId?: number }): Promise<void>;
}
```

`src/lib/icon.ts`: append:

```ts
/** The theme's accent, so the count reads as the extension's own. */
const BADGE_COLOUR = '#234e9c';

/**
 * The waiting count, on every tab at once. Global on purpose: the queue
 * belongs to no page. Like the icon, a refusal is not worth a rejection.
 */
export async function setBadge(text: string): Promise<void> {
  try {
    await toolbarAction().setBadgeBackgroundColor({ color: BADGE_COLOUR });
    await toolbarAction().setBadgeText({ text });
  } catch {
    // Nothing to do about it.
  }
}
```

`src/lib/platform/menus.ts`:

```ts
/**
 * The context naming the toolbar button. Rung two of the browser ladder:
 * the manifest version is a build-time constant, passed in so this stays
 * testable.
 */
export function toolbarMenuContext(manifestVersion: number): 'action' | 'browser_action' {
  return manifestVersion === 3 ? 'action' : 'browser_action';
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm vitest run src/lib/icon.test.ts src/lib/platform/menus.test.ts`
Expected: PASS.

- [ ] **Step 5: The permission**

In `wxt.config.ts`, add `'contextMenus'` to `permissions` after `'storage'`, with:

```ts
      // Two items on the toolbar button's own menu — the waiting list and
      // Sync now. Firefox takes `contextMenus` as an alias of `menus`.
      'contextMenus',
```

In `docs/store/permissions.md`, after `## storage`, add:

```md
## `contextMenus`

Adds two items to the menu of the extension's own toolbar button: one
opens the list of entries waiting to be saved to Hrček, the other tries
to save them now. Nothing is added to the menu of web pages.
```

Also extend the `## storage` paragraph with one sentence: "Entries kept
while Hrček cannot be reached live in the extension's own IndexedDB
storage until they are sent or deleted; see `docs/store/privacy.md`."

- [ ] **Step 6: Wire the background**

In `src/entrypoints/background.ts`, add imports:

```ts
import { HrcekApiError } from '../lib/api/errors';
import { setBadge } from '../lib/icon';
import { pendingBadgeText } from '../lib/offline/keep';
import { openQueue } from '../lib/offline/queue';
import { createRunner } from '../lib/offline/runner';
import { sendQueued, syncQueue, type SyncResult } from '../lib/offline/sync';
import { isUnavailable } from '../lib/offline/unavailable';
import { toolbarMenuContext } from '../lib/platform/menus';
```

(Merge `setBadge` into the existing `../lib/icon` import.) Below `savedState`, add:

```ts
const queue = openQueue();
const MENU_PENDING = 'hrcek-pending';
const MENU_SYNC = 'hrcek-sync';

/** Tells every open extension page; nobody listening is not an error. */
function broadcast(message: unknown): void {
  void browser.runtime.sendMessage(message).catch(() => undefined);
}

/** The badge and the menu label follow the queue. */
async function paintPending(): Promise<void> {
  const count = await queue.count().catch(() => 0);
  await setBadge(pendingBadgeText(count));
  try {
    await browser.contextMenus.update(MENU_PENDING, {
      title: i18n._('Waiting to sync ({count})…', { count }),
    });
  } catch {
    // The menu is created at start; an update racing it is harmless.
  }
}

async function syncOnce(): Promise<SyncResult | null> {
  const settings = await loadSettings();
  if (!isConfigured(settings)) return null;
  const client = clientFromSettings(settings, localeFor(settings.language));
  const result = await syncQueue(client, queue, settings.serverUrl);
  if (result.stopped === 'unauthorized') {
    await setIcon('unconfigured');
    await setTitle(toolbarTitle('signInAgain'));
  }
  return result;
}

const runner = createRunner(async () => {
  const result = await syncOnce().catch((error: unknown) => {
    console.warn('[hrcek] sync failed', error);
    return null;
  });
  await paintPending();
  broadcast({ type: 'hrcek:synced', result });
  return result;
});

type ReplaceAnswer =
  { ok: true } | { ok: false; unavailable: boolean; message: string | null };

/** "Replace with mine": sends a held copy as it is, over Hrček's. */
function replace(url: string): Promise<ReplaceAnswer> {
  return runner.exclusive(async () => {
    const settings = await loadSettings();
    const entry = await queue.get(url);
    if (!isConfigured(settings) || entry === null) return { ok: true } as const;
    try {
      const client = clientFromSettings(settings, localeFor(settings.language));
      await sendQueued(client, entry);
      await queue.remove(url, entry.savedAt);
      savedState.mark(url, true);
      return { ok: true } as const;
    } catch (error) {
      return {
        ok: false,
        unavailable: isUnavailable(error),
        message: error instanceof HrcekApiError ? error.message : null,
      } as const;
    } finally {
      await paintPending();
      broadcast({ type: 'hrcek:synced', result: null });
    }
  });
}

function createMenus(): void {
  const contexts = [toolbarMenuContext(import.meta.env.MANIFEST_VERSION)];
  void browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({
      id: MENU_PENDING,
      title: i18n._('Waiting to sync ({count})…', { count: 0 }),
      contexts,
    });
    browser.contextMenus.create({ id: MENU_SYNC, title: i18n._('Sync now'), contexts });
    void paintPending();
  });
}
```

Inside `defineBackground(() => { … })`, after `void paintGlobal();`:

```ts
createMenus();

browser.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === MENU_PENDING) {
    void browser.tabs.create({ url: browser.runtime.getURL('/pending.html') });
  } else if (info.menuItemId === MENU_SYNC) {
    void runner.sync();
  }
});

// sendResponse plus `return true`, not a returned promise: Chrome does
// not take a promise from an onMessage listener everywhere.
browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const asked = message as { type?: string; url?: string };
  if (asked.type === 'hrcek:sync') {
    void runner.sync().then(sendResponse);
    return true;
  }
  if (asked.type === 'hrcek:replace' && asked.url !== undefined) {
    void replace(asked.url).then(sendResponse);
    return true;
  }
  if (asked.type === 'hrcek:queue-changed') void paintPending();
  return undefined;
});
```

In the existing `storage.local.onChanged` listener, after `refreshLanguage()` resolves, also call `createMenus();` so the labels follow a language change.

- [ ] **Step 7: Extract and translate**

Run: `pnpm i18n:extract`. Fill in `src/locales/sl.po`:

```po
msgid "Waiting to sync ({count})…"
msgstr "Čaka na sinhronizacijo ({count})…"

msgid "Sync now"
msgstr "Sinhroniziraj zdaj"
```

- [ ] **Step 8: Gate, build both targets, commit**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm build:chrome`
Expected: all pass. `.output/firefox-mv2/manifest.json` and `.output/chrome-mv3/manifest.json` list `contextMenus`.

```bash
git add src/lib/platform/action.ts src/lib/platform/menus.ts src/lib/platform/menus.test.ts src/lib/icon.ts src/lib/icon.test.ts src/entrypoints/background.ts wxt.config.ts docs/store/permissions.md src/locales/en.po src/locales/sl.po
git commit -m "feat: sync from the background, with a waiting count and a toolbar menu"
gh stack add popup
```

---

### Task 6: The popup keeps a save when Hrček is unavailable

**Files:**

- Create: `src/entrypoints/popup/offline.ts`, `src/entrypoints/popup/offline.test.ts`
- Modify: `src/entrypoints/popup/form.ts` (`queuedToForm`), `src/entrypoints/popup/form.test.ts`
- Modify: `src/entrypoints/popup/main.ts`
- Modify: `tests/fake-hrcek/server.ts` (outage switch), `tests/e2e/save-flow.spec.ts`
- Modify: `src/locales/en.po`, `src/locales/sl.po`

**Interfaces:**

- Consumes: `openQueue`, `QueuedEntry`, `QueueFullError` (Task 2); `sendQueued` (Task 3); `keepForLater`, `queuedPictureFor` (Task 4); `isUnavailable` (Task 1); messages `hrcek:sync` (Task 5).
- Produces:

  ```ts
  // popup/offline.ts
  export type LookupKind = 'found' | 'not-found' | 'unavailable';
  export type PopupNote = 'unavailable' | 'queued' | 'refused' | 'alsoQueued' | null;
  export interface OpenPlan {
    source: 'server' | 'queued' | 'empty';
    note: PopupNote;
    laterButton: boolean;
  }
  export function planOpen(lookup: LookupKind, queued: QueuedEntry | null): OpenPlan;
  // popup/form.ts
  export function queuedToForm(
    entry: QueuedEntry,
    definitions: FieldOut[] | null,
  ): FormState;
  ```

  Fake Hrček: `POST /__outage` (everything else answers 503 with an HTML body), `POST /__restore`; `POST /__reset` also restores.

- [ ] **Step 1: Write the failing unit tests**

`src/entrypoints/popup/offline.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { QueuedEntry, QueuedState } from '../../lib/offline/queue';
import { planOpen } from './offline';

function queued(state: QueuedState): QueuedEntry {
  return {
    request: { url: 'https://e.test/a', title: 'A', notes: '', tags: [], fields: {} },
    picture: null,
    savedAt: 1,
    server: 'https://hrcek.example.org',
    state,
  };
}

describe('planOpen', () => {
  it('opens on the server’s entry when Hrček has it, noting a queued copy', () => {
    expect(planOpen('found', null)).toEqual({
      source: 'server',
      note: null,
      laterButton: false,
    });
    expect(planOpen('found', queued({ kind: 'held' }))).toEqual({
      source: 'server',
      note: 'alsoQueued',
      laterButton: false,
    });
    // Hrček got it after it was queued, before any sync looked.
    expect(planOpen('found', queued({ kind: 'waiting' })).note).toBe('alsoQueued');
  });

  it('opens on the queued copy when Hrček does not have it', () => {
    expect(planOpen('not-found', queued({ kind: 'waiting' }))).toEqual({
      source: 'queued',
      note: 'queued',
      laterButton: false,
    });
    expect(planOpen('not-found', queued({ kind: 'refused', message: 'no' })).note).toBe(
      'refused',
    );
    expect(planOpen('not-found', null)).toEqual({
      source: 'empty',
      note: null,
      laterButton: false,
    });
  });

  it('keeps for later when Hrček is unavailable, on the queued copy if there is one', () => {
    expect(planOpen('unavailable', null)).toEqual({
      source: 'empty',
      note: 'unavailable',
      laterButton: true,
    });
    expect(planOpen('unavailable', queued({ kind: 'waiting' }))).toEqual({
      source: 'queued',
      note: 'unavailable',
      laterButton: true,
    });
  });
});
```

Add to `src/entrypoints/popup/form.test.ts`:

```ts
import { queuedToForm } from './form';

describe('queuedToForm', () => {
  it('fills the form from a queued copy', () => {
    const form = queuedToForm(
      {
        request: {
          url: 'https://e.test/a',
          title: 'A',
          notes: 'n',
          tags: ['x', 'y'],
          fields: { Price: '3' },
        },
        picture: null,
        savedAt: 1,
        server: 'https://hrcek.example.org',
        state: { kind: 'waiting' },
      },
      null,
    );
    expect(form.url).toBe('https://e.test/a');
    expect(form.title).toBe('A');
    expect(form.notes).toBe('n');
    expect(form.tags).toBe('x, y');
    expect(form.fields.map((f) => [f.name, f.value])).toEqual([['Price', '3']]);
  });
});
```

(If `buildFieldInputs(null, { Price: '3' })` shapes fields differently, assert what `entryToForm` produces for the same `fields`. `queuedToForm` must match it.)

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/entrypoints/popup/offline.test.ts src/entrypoints/popup/form.test.ts`
Expected: FAIL, because `./offline` and `queuedToForm` are missing.

- [ ] **Step 3: Implement the helpers**

`src/entrypoints/popup/offline.ts`:

```ts
import type { QueuedEntry } from '../../lib/offline/queue';

export type LookupKind = 'found' | 'not-found' | 'unavailable';

/** Which note to show, as a name; main.ts says it in words. */
export type PopupNote = 'unavailable' | 'queued' | 'refused' | 'alsoQueued' | null;

export interface OpenPlan {
  /** What the form is filled from. */
  source: 'server' | 'queued' | 'empty';
  note: PopupNote;
  /** "Save for later" in place of Save. */
  laterButton: boolean;
}

/**
 * What the popup opens on. Hrček holding the address always wins: the
 * person sees what Save would replace, as ever. Otherwise a queued copy
 * is what they were last working on.
 */
export function planOpen(lookup: LookupKind, queued: QueuedEntry | null): OpenPlan {
  if (lookup === 'found') {
    return {
      source: 'server',
      note: queued === null ? null : 'alsoQueued',
      laterButton: false,
    };
  }
  const source = queued === null ? 'empty' : 'queued';
  if (lookup === 'unavailable') return { source, note: 'unavailable', laterButton: true };
  if (queued === null) return { source, note: null, laterButton: false };
  return {
    source,
    note: queued.state.kind === 'refused' ? 'refused' : 'queued',
    laterButton: false,
  };
}
```

`src/entrypoints/popup/form.ts`: add (with `import type { QueuedEntry } from '../../lib/offline/queue';`):

```ts
/** A queued copy, back in the form it was saved from. */
export function queuedToForm(
  entry: QueuedEntry,
  definitions: FieldOut[] | null,
): FormState {
  const { request } = entry;
  return {
    url: request.url,
    title: request.title,
    notes: request.notes,
    tags: request.tags.join(', '),
    fields: buildFieldInputs(definitions, request.fields),
  };
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm vitest run src/entrypoints/popup/offline.test.ts src/entrypoints/popup/form.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing e2e test, with the fake's outage switch**

`tests/fake-hrcek/server.ts`: next to `entries`/`nextId`, add `let outage = false;`. Inside the request handler, before `if (route === 'POST /__reset')`:

```ts
if (route === 'POST /__outage') {
  outage = true;
  res.writeHead(204).end();
  return;
}
if (route === 'POST /__restore') {
  outage = false;
  res.writeHead(204).end();
  return;
}
// What a reverse proxy says in front of a stopped Hrček: an HTML
// page, not the error envelope — so the client sees it unparseable.
if (outage && !requestUrl.pathname.startsWith('/__')) {
  res
    .writeHead(503, { 'Content-Type': 'text/html' })
    .end('<h1>503 Service Unavailable</h1>');
  return;
}
```

and in `POST /__reset`, add `outage = false;`.

In `tests/e2e/save-flow.spec.ts`, add a helper after `heldEntry`:

```ts
/** The toolbar badge's text, read from the extension's service worker. */
async function badgeText(context: BrowserContext): Promise<string> {
  const [worker] = context.serviceWorkers();
  return worker!.evaluate(() =>
    (
      globalThis as unknown as {
        chrome: { action: { getBadgeText(details: object): Promise<string> } };
      }
    ).chrome.action.getBadgeText({}),
  );
}
```

and the test:

```ts
test('keeps a save made while Hrček is down, and sends it with the next save', async ({
  context,
  extensionId,
}) => {
  await configureToken(context, extensionId);
  await fetch(`${SERVER}/__outage`, { method: 'POST' });
  const address = 'https://example.com/while-down';

  const popup = await openPopup(context, extensionId, address, 'While down');
  await expect(popup.locator('#status')).toContainText("Hrček can't be reached");
  await expect(popup.locator('#save')).toHaveText('Save for later');
  await popup.fill('#notes', 'written offline');
  await popup.click('#save');
  await expect(popup.locator('#status')).toContainText('Kept for later');
  await expect.poll(() => badgeText(context)).toBe('1');

  // Reopened while still down: the queued copy, not an empty form.
  const again = await openPopup(context, extensionId, address, 'ignored');
  await expect(again.locator('#notes')).toHaveValue('written offline');

  await fetch(`${SERVER}/__restore`, { method: 'POST' });
  const next = await openPopup(
    context,
    extensionId,
    'https://example.com/after',
    'After',
  );
  await next.click('#save');
  await expect(next.locator('#status')).toContainText('Saved.');

  await expect.poll(async () => (await heldEntry(address)).notes).toBe('written offline');
  await expect.poll(() => badgeText(context)).toBe('');
});
```

Run: `pnpm test:e2e`
Expected: the new test FAILS at `"Hrček can't be reached"` (today's popup shows an error and keeps nothing).

- [ ] **Step 6: Wire `main.ts`**

Imports to add:

```ts
import { isUnavailable } from '../../lib/offline/unavailable';
import {
  openQueue,
  QueueFullError,
  type QueuedEntry,
  type QueuedPicture,
} from '../../lib/offline/queue';
import { keepForLater, queuedPictureFor } from '../../lib/offline/keep';
import { sendQueued } from '../../lib/offline/sync';
import { planOpen, type LookupKind, type OpenPlan, type PopupNote } from './offline';
import type { PictureChoice } from '../../lib/picture';
import type { EntryOut } from '../../lib/api/types';
```

and add `queuedToForm` to the `./form` import.

Module state, after `heldObjectUrl`:

```ts
/** Saves Hrček could not take yet, shared with the background. */
const queue = openQueue();
/** The copy of this address waiting to be synced, if any. */
let queued: QueuedEntry | null = null;
/** What the form was filled from; decides how Save sends it. */
let source: OpenPlan['source'] = 'empty';
/** True while Hrček is unavailable: Save keeps the entry for later. */
let unavailable = false;
```

Helpers, after `pictureTroubleText`:

```ts
/** The note for a plan, in words. Literals here, so extraction finds them. */
function noteText(note: PopupNote): { kind: 'info' | 'error'; text: string } | null {
  switch (note) {
    case 'unavailable':
      return {
        kind: 'info',
        text: i18n._(
          "Hrček can't be reached. Saving keeps this entry here until it can.",
        ),
      };
    case 'queued':
      return { kind: 'info', text: i18n._('Waiting to be saved to Hrček.') };
    case 'refused':
      return {
        kind: 'error',
        text: i18n._('Hrček refused this entry: {reason}', {
          reason: queued?.state.kind === 'refused' ? queued.state.message : '',
        }),
      };
    case 'alsoQueued':
      return {
        kind: 'info',
        text: i18n._(
          'You also have an unsynced copy of this page — saving here replaces it.',
        ),
      };
    case null:
      return null;
  }
}

/** The queued copy's picture, shown as the picture "it already has". */
function heldFromQueued(picture: QueuedPicture): HeldPicture | null {
  if (heldObjectUrl !== null) URL.revokeObjectURL(heldObjectUrl);
  heldObjectUrl = null;
  if (picture === null) return null;
  if (picture.kind === 'url') return { src: picture.url };
  heldObjectUrl = URL.createObjectURL(picture.blob);
  return { src: heldObjectUrl };
}

/** After every save: the background sends whatever else is waiting. */
function requestSync(): void {
  void browser.runtime.sendMessage({ type: 'hrcek:sync' }).catch(() => undefined);
}

/** Puts the entry in the queue and says so; stays open if it cannot. */
async function keepThisForLater(
  choice: PictureChoice,
  bytes: Blob | null,
): Promise<void> {
  const previous = source === 'queued' ? (queued?.picture ?? null) : null;
  try {
    await keepForLater(
      queue,
      settings!.serverUrl,
      formToSaveRequest(collectForm()),
      queuedPictureFor(choice, bytes, previous),
    );
  } catch (error) {
    setStatus(
      'error',
      error instanceof QueueFullError
        ? i18n._(
            '100 entries are already waiting to be saved. Sync or delete some first.',
          )
        : i18n._('Something went wrong.'),
    );
    return;
  }
  requestSync();
  await finish(
    'success',
    i18n._('Kept for later — it will be saved to Hrček once it can be reached.'),
  );
}
```

`renderForm`: give it a third parameter so a queued copy's picture counts as already chosen without the "Already saved" header:

```ts
function renderForm(form: FormState, existing: boolean, keepsPicture = existing): void {
```

and in it change `createPictureState({ candidates, held, existing })` to `createPictureState({ candidates, held, existing: keepsPicture })`.

`main()`: replace the final `try { … } catch { … }` block (from `try {` / `const existing = url.length > 0 ? await loadExisting(client, url) : null;` to the end of its `catch`) with:

```ts
queued = url.length > 0 ? await queue.get(url).catch(() => null) : null;
let lookup: LookupKind;
let existing: EntryOut | null = null;
try {
  existing = url.length > 0 ? await loadExisting(client, url) : null;
  lookup = existing !== null ? 'found' : 'not-found';
} catch (error) {
  if (isAuthFailure(error)) {
    // Nothing on this form can succeed until there is a new token.
    renderUnauthorized();
    return;
  }
  if (!isUnavailable(error)) {
    lookupFailed = true;
    renderForm(emptyForm(url, title, definitions), false);
    setStatus('error', messageFor(error));
    return;
  }
  lookup = 'unavailable';
}
const plan = planOpen(lookup, queued);
source = plan.source;
unavailable = lookup === 'unavailable';
if (plan.source === 'server') {
  await loadHeldPicture(existing!.image);
  renderForm(entryToForm(existing!, definitions), true);
} else if (plan.source === 'queued') {
  held = heldFromQueued(queued!.picture);
  renderForm(queuedToForm(queued!, definitions), false, true);
} else {
  renderForm(emptyForm(url, title, definitions), false);
}
if (plan.laterButton) {
  document.querySelector<HTMLButtonElement>('#save')!.textContent =
    i18n._('Save for later');
}
const note = noteText(plan.note);
if (note !== null) setStatus(note.kind, note.text);
```

`save()`: replace everything after `setStatus('info', i18n._('Saving…'));` with:

```ts
const choice = pictures?.choice() ?? { kind: 'unchanged' as const };
// Bytes first, from the page itself: Hrček being down does not stop
// that, and they are what a kept entry shows and later uploads.
const bytes = choice.kind === 'url' ? await fetchPictureBytes(choice.url) : null;

// The look-before-write failed or found Hrček unavailable. Posting now
// could blind-replace a held entry, so look again first.
if (lookupFailed || unavailable) {
  try {
    const existing = pageUrl.length > 0 ? await loadExisting(client, pageUrl) : null;
    lookupFailed = false;
    unavailable = false;
    if (existing !== null) {
      await loadHeldPicture(existing.image);
      source = 'server';
      renderForm(entryToForm(existing, definitions), true);
      setStatus(
        'error',
        i18n._(
          'This address is already saved. Review the existing entry, then save again.',
        ),
      );
      return;
    }
  } catch (error) {
    if (isUnavailable(error)) {
      await keepThisForLater(choice, bytes);
      return;
    }
    setStatus('error', messageFor(error));
    return;
  }
}

try {
  const request = formToSaveRequest(collectForm());
  // A queued copy carries its own picture, which "unchanged" keeps. For
  // an entry from Hrček, "unchanged" sends no picture (it keeps its own)
  // and "none" sends none and then deletes it, as before.
  const picture = queuedPictureFor(
    choice,
    bytes,
    source === 'queued' ? (queued?.picture ?? null) : null,
  );
  if (choice.kind !== 'unchanged') setStatus('info', i18n._('Saving the picture…'));
  const sent = await sendQueued(client, { request, picture });
  // A POST cannot remove a picture; dropping the held one takes a DELETE.
  if (choice.kind === 'none' && source !== 'queued') {
    sent.trouble ??= await attachPicture(client, sent.entry, choice, null);
  }
  void browser.runtime
    .sendMessage({ type: 'hrcek:saved', url: sent.entry.url, held: true })
    .catch(() => undefined);
  // This address is on Hrček now; any queued copy of it is spent.
  if (queued !== null) await queue.remove(pageUrl).catch(() => undefined);
  requestSync();
  if (sent.trouble !== null) {
    await finish(
      'error',
      i18n._('Saved, but the picture could not be attached: {reason}', {
        reason: pictureTroubleText(sent.trouble),
      }),
    );
    return;
  }
  await finish(
    'success',
    sent.status === 'created' ? i18n._('Saved.') : i18n._('Updated.'),
  );
} catch (error) {
  if (isUnavailable(error)) {
    await keepThisForLater(choice, bytes);
    return;
  }
  // The entry did not save. Stay open: this is the case where somebody
  // must do something about it.
  setStatus('error', messageFor(error));
}
```

Remove the `submitSave` import if `main.ts` no longer uses it; keep `attachPicture`.

- [ ] **Step 7: Extract, translate, run everything**

Run: `pnpm i18n:extract`. In `src/locales/sl.po`:

```po
msgid "Hrček can't be reached. Saving keeps this entry here until it can."
msgstr "Hrček ni dosegljiv. Ob shranjevanju vnos ostane tukaj, dokler ne bo."

msgid "Waiting to be saved to Hrček."
msgstr "Čaka, da se shrani na Hrček."

msgid "Hrček refused this entry: {reason}"
msgstr "Hrček je ta vnos zavrnil: {reason}"

msgid "You also have an unsynced copy of this page — saving here replaces it."
msgstr "Imate tudi nesinhronizirano kopijo te strani — shranjevanje tukaj jo nadomesti."

msgid "Save for later"
msgstr "Shrani za pozneje"

msgid "100 entries are already waiting to be saved. Sync or delete some first."
msgstr "Na shranjevanje že čaka 100 vnosov. Najprej jih sinhronizirajte ali nekaj izbrišite."

msgid "Kept for later — it will be saved to Hrček once it can be reached."
msgstr "Shranjeno za pozneje — na Hrček bo shranjeno, ko bo dosegljiv."
```

Run: `pnpm typecheck && pnpm lint && pnpm test`, then `pnpm test:e2e`
Expected: all pass, including the new outage test and every existing save-flow test unchanged.

- [ ] **Step 8: Commit, start the last layer**

```bash
git add src/entrypoints/popup tests/fake-hrcek/server.ts tests/e2e/save-flow.spec.ts src/locales/en.po src/locales/sl.po
git commit -m "feat: keep a save for later when Hrček cannot be reached"
gh stack add pending
```

---

### Task 7: The waiting page, the held flow, the privacy statement

**Files:**

- Create: `src/entrypoints/pending/index.html`, `src/entrypoints/pending/main.ts`, `src/entrypoints/pending/view.ts`, `src/entrypoints/pending/view.test.ts`, `src/entrypoints/pending/style.css`
- Create: `tests/e2e/offline.spec.ts`
- Modify: `docs/store/privacy.md`, `src/locales/en.po`, `src/locales/sl.po`

**Interfaces:**

- Consumes: `QueuedEntry` (Task 2); `SyncResult` (Task 3); messages `hrcek:sync`, `hrcek:replace`, `hrcek:queue-changed`, `hrcek:synced` (Task 5); `EntryOut`.
- Produces:

  ```ts
  export interface PendingDeps {
    list(): Promise<QueuedEntry[]>;
    /** The server address in settings, or null when not configured. */
    server(): string | null;
    /** Hrček's current entry at this address; throws as the client does. */
    lookup(url: string): Promise<EntryOut | null>;
    remove(entry: QueuedEntry): Promise<void>;
    replace(
      url: string,
    ): Promise<
      { ok: true } | { ok: false; unavailable: boolean; message: string | null }
    >;
    sync(): Promise<SyncResult | null>;
    open(url: string): void;
    /** Something an <img> can show for a queued picture or a server one. */
    pictureSrc(picture: QueuedEntry['picture']): string | null;
  }
  export interface PendingView {
    refresh(): Promise<void>;
    showResult(result: SyncResult | null): void;
  }
  export function createPendingView(host: HTMLElement, deps: PendingDeps): PendingView;
  ```

  DOM contract (e2e relies on it): `#sync`, `#result`, `#count`, `.pending-entry[data-state=waiting|held|refused|elsewhere]`, `.keep`, `.replace`, `.open`, `.delete`, `.confirm-delete`, `.compare .theirs`, `.compare .mine`, `.empty`.

- [ ] **Step 1: Write the failing view test**

`src/entrypoints/pending/view.test.ts`:

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HrcekNetworkError } from '../../lib/api/errors';
import type { EntryOut } from '../../lib/api/types';
import { activateLocale } from '../../lib/i18n';
import type { QueuedEntry, QueuedState } from '../../lib/offline/queue';
import { createPendingView, type PendingDeps } from './view';

beforeEach(() => activateLocale('en'));

const SERVER = 'https://hrcek.example.org';

function queued(
  url: string,
  state: QueuedState = { kind: 'waiting' },
  server = SERVER,
): QueuedEntry {
  return {
    request: { url, title: `Mine ${url}`, notes: 'my notes', tags: ['mine'], fields: {} },
    picture: null,
    savedAt: 1,
    server,
    state,
  };
}

function theirs(url: string): EntryOut {
  return {
    id: 1,
    url,
    title: 'Theirs',
    notes: 'their notes',
    tags: ['theirs'],
    fields: {},
    image: null,
    created_at: '',
    updated_at: '',
  } as EntryOut;
}

function mount(entries: QueuedEntry[], overrides: Partial<PendingDeps> = {}) {
  let list = [...entries];
  const deps: PendingDeps = {
    list: async () => list,
    server: () => SERVER,
    lookup: async (url) => theirs(url),
    remove: vi.fn(async (entry: QueuedEntry) => {
      list = list.filter((e) => e !== entry);
    }),
    replace: vi.fn(async (url: string) => {
      list = list.filter((e) => e.request.url !== url);
      return { ok: true as const };
    }),
    sync: vi.fn(async () => null),
    open: vi.fn(),
    pictureSrc: () => null,
    ...overrides,
  };
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const view = createPendingView(host, deps);
  return { host, deps, view };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createPendingView', () => {
  it('says nothing is waiting when nothing is', async () => {
    const { host, view } = mount([]);
    await view.refresh();
    expect(host.querySelector('.empty')!.textContent).toBe('Nothing is waiting.');
    expect(host.querySelector('#count')!.textContent).toBe('0');
  });

  it('lists a waiting entry with its title and address, inert', async () => {
    const hostile = queued('https://e.test/<img src=x onerror=alert(1)>');
    const { host, view } = mount([hostile]);
    await view.refresh();
    const article = host.querySelector('.pending-entry[data-state="waiting"]')!;
    expect(article.textContent).toContain('https://e.test/<img src=x onerror=alert(1)>');
    expect(host.querySelectorAll('[onerror]')).toHaveLength(0);
  });

  it('deletes only after a second, explicit confirmation', async () => {
    const entry = queued('https://e.test/a');
    const { host, deps, view } = mount([entry]);
    await view.refresh();
    host.querySelector<HTMLButtonElement>('.delete')!.click();
    expect(deps.remove).not.toHaveBeenCalled();
    host.querySelector<HTMLButtonElement>('.confirm-delete')!.click();
    await flush();
    expect(deps.remove).toHaveBeenCalledWith(entry);
    expect(host.querySelector('.empty')).not.toBeNull();
  });

  it('compares a held entry with what Hrček has, and keeps Hrček’s', async () => {
    const entry = queued('https://e.test/a', { kind: 'held' });
    const { host, deps, view } = mount([entry]);
    await view.refresh();
    await flush();
    expect(host.querySelector('.compare .theirs')!.textContent).toContain('Theirs');
    expect(host.querySelector('.compare .mine')!.textContent).toContain(
      'Mine https://e.test/a',
    );
    host.querySelector<HTMLButtonElement>('.keep')!.click();
    await flush();
    expect(deps.remove).toHaveBeenCalledWith(entry);
  });

  it('replaces Hrček’s entry with the queued copy on request', async () => {
    const { host, deps, view } = mount([queued('https://e.test/a', { kind: 'held' })]);
    await view.refresh();
    await flush();
    host.querySelector<HTMLButtonElement>('.replace')!.click();
    await flush();
    expect(deps.replace).toHaveBeenCalledWith('https://e.test/a');
  });

  it('disables keep and replace when Hrček cannot be reached to compare', async () => {
    const { host, view } = mount([queued('https://e.test/a', { kind: 'held' })], {
      lookup: async () => {
        throw new HrcekNetworkError('down');
      },
    });
    await view.refresh();
    await flush();
    expect(host.querySelector('.compare')!.textContent).toContain(
      "Hrček can't be reached",
    );
    expect(host.querySelector<HTMLButtonElement>('.keep')!.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('.replace')!.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('.open')!.disabled).toBe(false);
  });

  it('shows a refusal in the server’s words, with Open page', async () => {
    const { host, deps, view } = mount([
      queued('https://e.test/a', { kind: 'refused', message: 'Not valid, says Hrček.' }),
    ]);
    await view.refresh();
    expect(
      host.querySelector('.pending-entry[data-state="refused"]')!.textContent,
    ).toContain('Not valid, says Hrček.');
    host.querySelector<HTMLButtonElement>('.open')!.click();
    expect(deps.open).toHaveBeenCalledWith('https://e.test/a');
  });

  it('offers only Delete for an entry meant for another server', async () => {
    const { host, view } = mount([
      queued('https://e.test/a', { kind: 'waiting' }, 'https://old.example.org'),
    ]);
    await view.refresh();
    const article = host.querySelector('.pending-entry[data-state="elsewhere"]')!;
    expect(article.textContent).toContain('https://old.example.org');
    expect(article.querySelector('.delete')).not.toBeNull();
    expect(article.querySelector('.open')).toBeNull();
  });

  it('syncs on request and reports the result', async () => {
    const { host, deps, view } = mount([], {
      sync: vi.fn(async () => ({
        saved: 2,
        held: 1,
        refused: 0,
        withoutPicture: ['Pictured'],
        stopped: null,
      })),
    });
    await view.refresh();
    host.querySelector<HTMLButtonElement>('#sync')!.click();
    await flush();
    expect(deps.sync).toHaveBeenCalled();
    const result = host.querySelector('#result')!.textContent!;
    expect(result).toContain('2 entries saved.');
    expect(result).toContain('Saved without its picture: Pictured');
    expect(result).toContain('1 is already on Hrček and waits for your review.');
  });

  it('says when Hrček could not be reached', () => {
    const { host, view } = mount([]);
    view.showResult({
      saved: 0,
      held: 0,
      refused: 0,
      withoutPicture: [],
      stopped: 'unavailable',
    });
    expect(host.querySelector('#result')!.textContent).toBe("Hrček can't be reached.");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/entrypoints/pending/view.test.ts`
Expected: FAIL, because `./view` cannot be resolved.

- [ ] **Step 3: Implement the view**

`src/entrypoints/pending/view.ts`:

```ts
import { i18n } from '@lingui/core';
import { isUnavailable } from '../../lib/offline/unavailable';
import type { EntryOut } from '../../lib/api/types';
import type { QueuedEntry } from '../../lib/offline/queue';
import type { SyncResult } from '../../lib/offline/sync';

export interface PendingDeps {
  list(): Promise<QueuedEntry[]>;
  server(): string | null;
  lookup(url: string): Promise<EntryOut | null>;
  remove(entry: QueuedEntry): Promise<void>;
  replace(
    url: string,
  ): Promise<{ ok: true } | { ok: false; unavailable: boolean; message: string | null }>;
  sync(): Promise<SyncResult | null>;
  open(url: string): void;
  pictureSrc(picture: QueuedEntry['picture']): string | null;
}

export interface PendingView {
  refresh(): Promise<void>;
  showResult(result: SyncResult | null): void;
}

/** Elements only, text by textContent: every string here is untrusted. */
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

/** Title, notes and tags of one version of an entry. */
function summary(
  className: string,
  heading: string,
  version: { title: string; notes: string; tags: string[] },
  pictureSrc: string | null,
): HTMLElement {
  const box = element('div', className);
  box.append(element('h3', undefined, heading), element('p', 'title', version.title));
  if (version.notes !== '') box.append(element('p', 'notes', version.notes));
  if (version.tags.length > 0) box.append(element('p', 'tags', version.tags.join(', ')));
  if (pictureSrc !== null) {
    const image = element('img', 'picture');
    image.src = pictureSrc;
    image.alt = '';
    box.append(image);
  }
  return box;
}

export function createPendingView(host: HTMLElement, deps: PendingDeps): PendingView {
  host.replaceChildren();
  const header = element('header');
  const count = element('span', undefined, '0');
  count.id = 'count';
  const heading = element('h1', undefined, i18n._('Waiting to sync'));
  heading.append(' ', count);
  const sync = button('', i18n._('Sync now'), () => {
    sync.disabled = true;
    void deps
      .sync()
      .then((result) => {
        showResult(result);
        return refresh();
      })
      .finally(() => {
        sync.disabled = false;
      });
  });
  sync.id = 'sync';
  const result = element('p', 'result');
  result.id = 'result';
  header.append(heading, sync, result);
  const list = element('div', 'entries');
  host.append(header, list);

  function showResult(outcome: SyncResult | null): void {
    const lines: string[] = [];
    if (outcome === null) {
      lines.push(i18n._('Hrček is not configured yet.'));
    } else if (outcome.stopped === 'unavailable') {
      lines.push(i18n._("Hrček can't be reached."));
    } else if (outcome.stopped === 'unauthorized') {
      lines.push(
        i18n._('Your Hrček no longer accepts this token. Make a new one in settings.'),
      );
    } else {
      if (outcome.saved > 0) {
        lines.push(
          i18n._('{count, plural, one {# entry saved.} other {# entries saved.}}', {
            count: outcome.saved,
          }),
        );
      }
      for (const title of outcome.withoutPicture) {
        lines.push(i18n._('Saved without its picture: {title}', { title }));
      }
      if (outcome.held > 0) {
        lines.push(
          i18n._(
            '{count, plural, one {# is already on Hrček and waits for your review.} other {# are already on Hrček and wait for your review.}}',
            { count: outcome.held },
          ),
        );
      }
    }
    result.textContent = lines.join(' ');
  }

  function deleteControls(entry: QueuedEntry): HTMLElement {
    const box = element('span', 'delete-controls');
    const ask = button('delete quiet', i18n._('Delete'), () => {
      const confirm = button('confirm-delete', i18n._('Delete for good'), () => {
        void deps.remove(entry).then(refresh);
      });
      const cancel = button('quiet', i18n._('Cancel'), () => box.replaceChildren(ask));
      box.replaceChildren(confirm, cancel);
    });
    box.append(ask);
    return box;
  }

  function openButton(entry: QueuedEntry): HTMLButtonElement {
    return button('open quiet', i18n._('Open page'), () => deps.open(entry.request.url));
  }

  function held(entry: QueuedEntry, article: HTMLElement): void {
    const compare = element('div', 'compare', i18n._('Loading what Hrček has…'));
    const keep = button('keep', i18n._("Keep what's on Hrček"), () => {
      void deps.remove(entry).then(refresh);
    });
    const replace = button('replace', i18n._('Replace with mine'), () => {
      keep.disabled = true;
      replace.disabled = true;
      void deps.replace(entry.request.url).then(async (answer) => {
        if (!answer.ok) {
          compare.append(
            element(
              'p',
              'trouble',
              answer.unavailable
                ? i18n._("Hrček can't be reached.")
                : (answer.message ?? i18n._('Something went wrong.')),
            ),
          );
          keep.disabled = false;
          replace.disabled = false;
          return;
        }
        await refresh();
      });
    });
    const actions = element('div', 'actions');
    actions.append(keep, replace, openButton(entry));
    article.append(compare, actions);

    void deps.lookup(entry.request.url).then(
      (server) => {
        compare.replaceChildren();
        if (server === null) {
          compare.append(
            element('p', undefined, i18n._('Hrček no longer has this address.')),
          );
        } else {
          compare.append(summary('theirs', i18n._('On Hrček'), server, null));
        }
        compare.append(
          summary('mine', i18n._('Yours'), entry.request, deps.pictureSrc(entry.picture)),
        );
      },
      (error: unknown) => {
        compare.replaceChildren(
          element(
            'p',
            'trouble',
            isUnavailable(error)
              ? i18n._("Hrček can't be reached, so what it has can't be shown.")
              : i18n._('Something went wrong.'),
          ),
        );
        keep.disabled = true;
        replace.disabled = true;
      },
    );
  }

  function render(entry: QueuedEntry): HTMLElement {
    const current = deps.server();
    const state = entry.server !== current ? 'elsewhere' : entry.state.kind;
    const article = element('article', 'pending-entry');
    article.dataset['state'] = state;
    article.append(
      element('h2', undefined, entry.request.title || entry.request.url),
      element('p', 'address', entry.request.url),
      element(
        'p',
        'saved-at',
        i18n._('Saved {when}', {
          when: new Date(entry.savedAt).toLocaleString(i18n.locale),
        }),
      ),
    );
    if (entry.request.tags.length > 0) {
      article.append(element('p', 'tags', entry.request.tags.join(', ')));
    }
    const src = deps.pictureSrc(entry.picture);
    if (src !== null && state !== 'held') {
      const image = element('img', 'picture');
      image.src = src;
      image.alt = '';
      article.append(image);
    }

    if (state === 'elsewhere') {
      article.append(
        element(
          'p',
          'trouble',
          i18n._('Saved for {server}, which is not the one in your settings.', {
            server: entry.server,
          }),
        ),
        deleteControls(entry),
      );
    } else if (state === 'held') {
      held(entry, article);
    } else if (entry.state.kind === 'refused') {
      article.append(
        element(
          'p',
          'trouble',
          i18n._('Hrček refused it: {reason}', { reason: entry.state.message }),
        ),
      );
      const actions = element('div', 'actions');
      actions.append(openButton(entry), deleteControls(entry));
      article.append(actions);
    } else {
      article.append(deleteControls(entry));
    }
    return article;
  }

  async function refresh(): Promise<void> {
    const entries = await deps.list();
    count.textContent = String(entries.length);
    list.replaceChildren(
      ...(entries.length === 0
        ? [element('p', 'empty', i18n._('Nothing is waiting.'))]
        : entries.map(render)),
    );
  }

  return { refresh, showResult };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run src/entrypoints/pending/view.test.ts`
Expected: PASS. Plurals are passed as in `src/lib/i18n/lingui.test.ts`.

- [ ] **Step 5: The page shell and wiring**

`src/entrypoints/pending/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Hrček</title>
  </head>
  <body>
    <main id="app"></main>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

`src/entrypoints/pending/main.ts`:

```ts
import { browser } from 'wxt/browser';
import { clientFromSettings } from '../../lib/client-factory';
import { activateLocale } from '../../lib/i18n';
import { openQueue, type QueuedEntry } from '../../lib/offline/queue';
import type { SyncResult } from '../../lib/offline/sync';
import { loadExisting } from '../../lib/save';
import { isConfigured, loadSettings, type Settings } from '../../lib/settings';
import { createPendingView } from './view';
import '../../lib/ui/theme.css';
import './style.css';

const queue = openQueue();
let settings: Settings | null = null;
let locale = activateLocale(null);
/** Object URLs handed to <img>s, revoked on every redraw. */
let pictureUrls: string[] = [];

function pictureSrc(picture: QueuedEntry['picture']): string | null {
  if (picture === null) return null;
  if (picture.kind === 'url') return picture.url;
  const src = URL.createObjectURL(picture.blob);
  pictureUrls.push(src);
  return src;
}

let view: ReturnType<typeof createPendingView> | null = null;

function mount(): ReturnType<typeof createPendingView> {
  return createPendingView(document.querySelector<HTMLElement>('#app')!, {
    list: () => {
      for (const src of pictureUrls) URL.revokeObjectURL(src);
      pictureUrls = [];
      return queue.list();
    },
    server: () => settings?.serverUrl ?? null,
    lookup: (url) => {
      if (!isConfigured(settings)) return Promise.resolve(null);
      return loadExisting(clientFromSettings(settings, locale), url);
    },
    remove: async (entry) => {
      await queue.remove(entry.request.url, entry.savedAt);
      void browser.runtime
        .sendMessage({ type: 'hrcek:queue-changed' })
        .catch(() => undefined);
    },
    replace: (url) => browser.runtime.sendMessage({ type: 'hrcek:replace', url }),
    sync: () =>
      browser.runtime.sendMessage({ type: 'hrcek:sync' }) as Promise<SyncResult | null>,
    open: (url) => void browser.tabs.create({ url }),
    pictureSrc,
  });
}

browser.runtime.onMessage.addListener((message: unknown) => {
  const told = message as { type?: string; result?: SyncResult | null };
  if (told.type === 'hrcek:synced') {
    if (told.result !== undefined && told.result !== null) view?.showResult(told.result);
    void view?.refresh();
  }
  return undefined;
});

void (async () => {
  settings = await loadSettings();
  locale = activateLocale(settings?.language ?? null);
  // Mounted only now, so the header speaks the chosen language.
  view = mount();
  await view.refresh();
})();
```

`src/entrypoints/pending/style.css`: keep it small and use the theme tokens:

```css
body {
  max-width: 48rem;
  margin: 0 auto;
  padding: 1.5rem 1rem;
  font-size: 0.9rem;
}
header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1rem;
}
header h1 {
  font-size: 1.2rem;
  margin: 0;
  flex: 1;
}
#count {
  color: var(--muted);
  font-weight: 400;
}
.result {
  flex-basis: 100%;
  margin: 0;
  color: var(--muted);
}
.pending-entry {
  border: 1px solid var(--edge);
  border-radius: var(--radius);
  background: var(--raised);
  padding: 0.75rem 1rem;
  margin-bottom: 0.75rem;
}
.pending-entry h2 {
  font-size: 1rem;
  margin: 0 0 0.2rem;
}
.address,
.saved-at,
.tags {
  margin: 0.1rem 0;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.picture {
  max-height: 6rem;
  max-width: 100%;
  border-radius: 0.3rem;
  margin-top: 0.4rem;
}
.trouble {
  color: var(--danger);
}
.compare {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
  margin: 0.6rem 0;
}
.compare h3 {
  font-size: 0.8rem;
  margin: 0 0 0.3rem;
  color: var(--muted);
}
.actions,
.delete-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
.empty {
  color: var(--muted);
}
```

- [ ] **Step 6: Write the held-flow e2e**

`tests/e2e/offline.spec.ts`:

```ts
import type { BrowserContext, Page } from '@playwright/test';
import { expect, SERVER, test } from './fixtures';

const TOKEN = 'hrcek_test_token';

test.beforeEach(async () => {
  await fetch(`${SERVER}/__reset`, { method: 'POST' });
});

async function configure(context: BrowserContext, extensionId: string): Promise<void> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.fill('#server-url', SERVER);
  await page.fill('#token', TOKEN);
  await page.click('#save');
  await expect(page.locator('#status')).toHaveAttribute('data-kind', 'success');
  await page.close();
}

async function keepOffline(
  context: BrowserContext,
  extensionId: string,
  url: string,
  title: string,
): Promise<void> {
  const popup = await context.newPage();
  await popup.goto(
    `chrome-extension://${extensionId}/popup.html?${new URLSearchParams({ url, title })}`,
  );
  await expect(popup.locator('#save')).toHaveText('Save for later');
  await popup.click('#save');
  await expect(popup.locator('#status')).toContainText('Kept for later');
  await popup.close();
}

async function saveDirectly(url: string, title: string): Promise<void> {
  await fetch(`${SERVER}/api/entries/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, title }),
  });
}

async function titleOnServer(url: string): Promise<string | undefined> {
  const response = await fetch(`${SERVER}/api/entries/lookup`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return ((await response.json()) as { title?: string }).title;
}

async function openPending(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/pending.html`);
  return page;
}

test('holds queued saves Hrček already has, and keeps or replaces them on request', async ({
  context,
  extensionId,
}) => {
  await configure(context, extensionId);
  await fetch(`${SERVER}/__outage`, { method: 'POST' });
  await keepOffline(context, extensionId, 'https://example.com/keep', 'Mine (keep)');
  await keepOffline(
    context,
    extensionId,
    'https://example.com/replace',
    'Mine (replace)',
  );
  await fetch(`${SERVER}/__restore`, { method: 'POST' });
  // Saved elsewhere meanwhile — another device, say.
  await saveDirectly('https://example.com/keep', 'Theirs (keep)');
  await saveDirectly('https://example.com/replace', 'Theirs (replace)');

  const page = await openPending(context, extensionId);
  await expect(page.locator('.pending-entry[data-state="waiting"]')).toHaveCount(2);
  await page.click('#sync');
  await expect(page.locator('.pending-entry[data-state="held"]')).toHaveCount(2);
  await expect(page.locator('#result')).toContainText('already on Hrček');

  const keepEntry = page.locator('.pending-entry', {
    hasText: 'https://example.com/keep',
  });
  await expect(keepEntry.locator('.compare .theirs')).toContainText('Theirs (keep)');
  await keepEntry.locator('.keep').click();

  const replaceEntry = page.locator('.pending-entry', {
    hasText: 'https://example.com/replace',
  });
  await expect(replaceEntry.locator('.compare .theirs')).toContainText(
    'Theirs (replace)',
  );
  await replaceEntry.locator('.replace').click();

  await expect(page.locator('.empty')).toBeVisible();
  expect(await titleOnServer('https://example.com/keep')).toBe('Theirs (keep)');
  expect(await titleOnServer('https://example.com/replace')).toBe('Mine (replace)');
});

test('says so when syncing finds Hrček still down', async ({ context, extensionId }) => {
  await configure(context, extensionId);
  await fetch(`${SERVER}/__outage`, { method: 'POST' });
  await keepOffline(context, extensionId, 'https://example.com/still-down', 'Down');
  const page = await openPending(context, extensionId);
  await page.click('#sync');
  await expect(page.locator('#result')).toHaveText("Hrček can't be reached.");
  await expect(page.locator('.pending-entry[data-state="waiting"]')).toHaveCount(1);
});
```

- [ ] **Step 7: The privacy statement**

In `docs/store/privacy.md`, "Kept in the browser", add after the `storage.session` paragraph:

```md
While your Hrček cannot be reached, a save is kept in the extension's
own IndexedDB storage instead: what it would have sent (address,
title, notes, tags, field values), the picture you chose, when it was
saved, and the server address it was meant for. At most 100 are kept.
Each one stays until it is saved to that server or you delete it from
the "Waiting to sync" page, and it is never sent anywhere else.
Removing the extension deletes them all.
```

- [ ] **Step 8: Extract, translate, run everything**

Run: `pnpm i18n:extract`. In `src/locales/sl.po`, fill every new entry:

```po
msgid "Waiting to sync"
msgstr "Čaka na sinhronizacijo"

msgid "Hrček can't be reached."
msgstr "Hrček ni dosegljiv."

msgid "{count, plural, one {# entry saved.} other {# entries saved.}}"
msgstr "{count, plural, one {# vnos shranjen.} two {# vnosa shranjena.} few {# vnosi shranjeni.} other {# vnosov shranjenih.}}"

msgid "Saved without its picture: {title}"
msgstr "Shranjeno brez slike: {title}"

msgid "{count, plural, one {# is already on Hrček and waits for your review.} other {# are already on Hrček and wait for your review.}}"
msgstr "{count, plural, one {# je že na Hrčku in čaka na vaš pregled.} two {# sta že na Hrčku in čakata na vaš pregled.} few {# so že na Hrčku in čakajo na vaš pregled.} other {# jih je že na Hrčku in čakajo na vaš pregled.}}"

msgid "Delete"
msgstr "Izbriši"

msgid "Delete for good"
msgstr "Izbriši dokončno"

msgid "Cancel"
msgstr "Prekliči"

msgid "Open page"
msgstr "Odpri stran"

msgid "Loading what Hrček has…"
msgstr "Nalagam, kar ima Hrček…"

msgid "Keep what's on Hrček"
msgstr "Obdrži, kar je na Hrčku"

msgid "Replace with mine"
msgstr "Zamenjaj z mojim"

msgid "Hrček no longer has this address."
msgstr "Hrček tega naslova nima več."

msgid "On Hrček"
msgstr "Na Hrčku"

msgid "Yours"
msgstr "Vaše"

msgid "Hrček can't be reached, so what it has can't be shown."
msgstr "Hrček ni dosegljiv, zato ni mogoče pokazati, kar ima."

msgid "Saved {when}"
msgstr "Shranjeno {when}"

msgid "Saved for {server}, which is not the one in your settings."
msgstr "Shranjeno za {server}, ki ni strežnik v vaših nastavitvah."

msgid "Hrček refused it: {reason}"
msgstr "Hrček ga je zavrnil: {reason}"

msgid "Nothing is waiting."
msgstr "Nič ne čaka."
```

Run: `pnpm typecheck && pnpm lint && pnpm test`, then `pnpm test:e2e`
Expected: all pass.

- [ ] **Step 9: Manual check in Firefox, commit, publish the stack**

`pnpm dev` (Firefox). With the server stopped:

- save a page: the "Kept for later" toast appears and the badge reads 1;
- right-click the toolbar button: **Waiting to sync (1)…** and **Sync now** appear;
- the waiting page opens from the menu and shows the entry with its picture.

Then start the server and choose **Sync now**: the badge clears.

```bash
git add src/entrypoints/pending tests/e2e/offline.spec.ts docs/store/privacy.md src/locales/en.po src/locales/sl.po
git commit -m "feat: a page for saves waiting to sync, and a way to settle held ones"
gh stack submit --auto
```

Then for each of the four PRs, `gh pr edit <n> --title … --body-file …`: what the layer adds, how it was tested, and for the last one, the manual checks. No AI footer. Afterwards `git checkout --detach` in the worktree and delete the four local branches.
