import { describe, expect, it, vi } from 'vitest';
import { attachPicture, fetchPictureBytes, MAX_PICTURE_BYTES } from './picture';
import { HrcekApiError, HrcekNetworkError } from './api/errors';
import type { EntryOut } from './api/types';

const ENTRY: EntryOut = {
  id: 7,
  url: 'https://example.com/watch',
  title: '',
  notes: '',
  tags: [],
  fields: {},
  image: null,
  created_at: '2026-09-13T12:28:12.937Z',
  updated_at: '2026-09-13T12:28:12.937Z',
};

function blob(size: number, type = 'image/jpeg') {
  return new Blob([new Uint8Array(size)], { type });
}

describe('fetchPictureBytes', () => {
  it('answers the bytes when the origin is reachable', async () => {
    const fetchFn = vi.fn(async () => new Response(blob(64))) as unknown as typeof fetch;
    const bytes = await fetchPictureBytes('https://cdn.test/a.jpg', fetchFn);
    expect(bytes?.size).toBe(64);
  });

  it('answers null when the origin refuses, so the address can stand in', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('blocked');
    }) as unknown as typeof fetch;
    expect(await fetchPictureBytes('https://cdn.test/a.jpg', fetchFn)).toBeNull();
  });

  it('answers null for something too large to upload', async () => {
    const fetchFn = vi.fn(
      async () => new Response(blob(MAX_PICTURE_BYTES + 1)),
    ) as unknown as typeof fetch;
    // Falls through to image_url rather than failing the save.
    expect(await fetchPictureBytes('https://cdn.test/huge.jpg', fetchFn)).toBeNull();
  });

  it('answers null for an SVG, which the server refuses', async () => {
    const fetchFn = vi.fn(
      async () => new Response(blob(64, 'image/svg+xml')),
    ) as unknown as typeof fetch;
    expect(await fetchPictureBytes('https://cdn.test/a.svg', fetchFn)).toBeNull();
  });

  it('answers null for an empty body', async () => {
    const fetchFn = vi.fn(async () => new Response(blob(0))) as unknown as typeof fetch;
    expect(await fetchPictureBytes('https://cdn.test/empty.jpg', fetchFn)).toBeNull();
  });
});

describe('attachPicture', () => {
  it('does nothing at all when the picture did not change', async () => {
    const client = { uploadImage: vi.fn(), deleteImage: vi.fn() };
    expect(
      await attachPicture(client as never, ENTRY, { kind: 'unchanged' }, null),
    ).toBeNull();
    expect(client.uploadImage).not.toHaveBeenCalled();
    expect(client.deleteImage).not.toHaveBeenCalled();
  });

  it('uploads the bytes when there are any', async () => {
    const client = { uploadImage: vi.fn(async () => ENTRY), deleteImage: vi.fn() };
    const bytes = blob(32);
    expect(
      await attachPicture(
        client as never,
        ENTRY,
        { kind: 'url', url: 'https://cdn.test/a.jpg' },
        bytes,
      ),
    ).toBeNull();
    expect(client.uploadImage).toHaveBeenCalledWith(7, bytes, 'a.jpg');
  });

  it('leaves the server to fetch the address when there are no bytes', async () => {
    // The entry POST already carried image_url in that case, so there is
    // nothing left to do here.
    const client = { uploadImage: vi.fn(), deleteImage: vi.fn() };
    expect(
      await attachPicture(
        client as never,
        ENTRY,
        { kind: 'url', url: 'https://cdn.test/a.jpg' },
        null,
      ),
    ).toBeNull();
    expect(client.uploadImage).not.toHaveBeenCalled();
  });

  it('deletes the picture when none was chosen and the entry had one', async () => {
    const client = { uploadImage: vi.fn(), deleteImage: vi.fn(async () => undefined) };
    const held = { ...ENTRY, image: { url: '/entries/7/image/', width: 12, height: 8 } };
    expect(await attachPicture(client as never, held, { kind: 'none' }, null)).toBeNull();
    expect(client.deleteImage).toHaveBeenCalledWith(7);
  });

  it('does not delete when there was nothing to delete', async () => {
    const client = { uploadImage: vi.fn(), deleteImage: vi.fn() };
    await attachPicture(client as never, ENTRY, { kind: 'none' }, null);
    expect(client.deleteImage).not.toHaveBeenCalled();
  });

  it('reports a failed upload without failing the entry', async () => {
    // Losing the entry because a thumbnail 404'd would be absurd.
    const client = {
      uploadImage: vi.fn(async () => {
        throw new HrcekApiError(
          422,
          'HRC-CORE-0002',
          'That is not an image Hrček can read.',
        );
      }),
      deleteImage: vi.fn(),
    };
    const trouble = await attachPicture(
      client as never,
      ENTRY,
      { kind: 'url', url: 'https://cdn.test/a.jpg' },
      blob(32),
    );
    // The server's message travels, because the server already translated
    // it for the person reading.
    expect(trouble).toEqual({
      kind: 'refused',
      message: 'That is not an image Hrček can read.',
    });
  });

  it('names an unreachable server rather than quoting its own English', async () => {
    // HrcekNetworkError's text is written by this client, in English, and
    // it ends up inside a sentence the popup has already translated. Said
    // as a shape, the popup can say it in the language it is speaking —
    // quoting it produced "Shranjeno, slike pa ni bilo mogoče priložiti:
    // Could not reach https://…".
    const client = {
      uploadImage: vi.fn(async () => {
        throw new HrcekNetworkError('Could not reach https://hrcek.test.');
      }),
      deleteImage: vi.fn(),
    };
    const trouble = await attachPicture(
      client as never,
      ENTRY,
      { kind: 'url', url: 'https://cdn.test/a.jpg' },
      blob(32),
    );

    expect(trouble).toEqual({ kind: 'unreachable' });
  });

  it('quotes nothing at all for a failure that is neither', async () => {
    // A raw runtime message ("Failed to fetch", a bug's TypeError) is
    // developer-facing and untranslated. The caller says something of its
    // own instead.
    const client = {
      uploadImage: vi.fn(async () => {
        throw new Error('unexpected');
      }),
      deleteImage: vi.fn(),
    };
    const trouble = await attachPicture(
      client as never,
      ENTRY,
      { kind: 'url', url: 'https://cdn.test/a.jpg' },
      blob(32),
    );

    expect(trouble).toEqual({ kind: 'unknown' });
  });
});
