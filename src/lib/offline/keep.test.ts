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
