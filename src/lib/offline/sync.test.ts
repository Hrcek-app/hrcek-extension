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

  it("marks a refusal with the server's message and carries on", async () => {
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

  it("sends a picture's address as image_url", async () => {
    const { client, saved, uploads } = fakeClient();
    const picture: QueuedPicture = { kind: 'url', url: 'https://cdn.e.test/p.jpg' };
    const sent = await sendQueued(client, { request, picture });
    expect(saved[0]?.image_url).toBe('https://cdn.e.test/p.jpg');
    expect(uploads).toEqual([]);
    expect(sent.trouble).toBeNull();
  });

  it("uploads a picture's bytes after the entry, named after its address", async () => {
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
