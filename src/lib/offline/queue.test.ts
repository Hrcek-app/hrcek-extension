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

  it("keeps a picture's bytes, type and address", async () => {
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

  it("keeps a picture's address alone when there were no bytes", async () => {
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
