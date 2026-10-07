import { describe, expect, it, vi } from 'vitest';
import type { HrcekClient } from './api/client';
import { HrcekApiError } from './api/errors';
import { loadExisting, submitSave } from './save';
import type { EntryOut } from './api/types';

const ENTRY: EntryOut = {
  id: 1,
  url: 'https://example.com/watch',
  title: 'A watch',
  notes: '',
  tags: [],
  fields: { Price: '129' },
  image: null,
  created_at: '2026-09-13T12:28:12.937Z',
  updated_at: '2026-09-13T12:28:12.937Z',
};

describe('loadExisting', () => {
  it('returns the entry when the address is already held', async () => {
    const client = {
      getEntryByUrl: vi.fn().mockResolvedValue(ENTRY),
    } as unknown as HrcekClient;

    expect(await loadExisting(client, ENTRY.url)).toEqual(ENTRY);
  });

  it('returns null on HRC-CORE-0003 (not held)', async () => {
    const client = {
      getEntryByUrl: vi
        .fn()
        .mockRejectedValue(new HrcekApiError(404, 'HRC-CORE-0003', 'not there')),
    } as unknown as HrcekClient;

    expect(await loadExisting(client, 'https://example.com/nothing')).toBeNull();
  });

  it('rethrows any other failure', async () => {
    const client = {
      getEntryByUrl: vi
        .fn()
        .mockRejectedValue(new HrcekApiError(401, 'HRC-AUTH-0003', 'sign in')),
    } as unknown as HrcekClient;

    await expect(loadExisting(client, ENTRY.url)).rejects.toMatchObject({
      code: 'HRC-AUTH-0003',
    });
  });
});

describe('submitSave', () => {
  it('posts the whole entry through the client', async () => {
    const saveEntry = vi.fn().mockResolvedValue({ status: 'created', entry: ENTRY });
    const client = { saveEntry } as unknown as HrcekClient;

    const outcome = await submitSave(client, {
      url: 'https://example.com/watch',
      title: 'A watch',
      notes: '38mm',
      tags: ['watches'],
      fields: { price: '129.00' },
    });

    expect(saveEntry).toHaveBeenCalledWith({
      url: 'https://example.com/watch',
      title: 'A watch',
      notes: '38mm',
      tags: ['watches'],
      fields: { price: '129.00' },
    });
    expect(outcome).toEqual({ status: 'created', entry: ENTRY, pictureTrouble: null });
  });

  it('omits image_url entirely when the picture did not change', async () => {
    // Leaving image_url out is documented as changing nothing; sending
    // null or "" is not the same thing at all.
    const saveEntry = vi.fn().mockResolvedValue({ status: 'updated', entry: ENTRY });
    const client = { saveEntry } as unknown as HrcekClient;

    await submitSave(client, {
      url: 'https://example.com/watch',
      title: '',
      notes: '',
      tags: [],
      fields: {},
    });

    expect('image_url' in saveEntry.mock.calls[0]![0]).toBe(false);
  });

  it('sends image_url when an address was chosen and the bytes could not be read', async () => {
    const saveEntry = vi.fn().mockResolvedValue({ status: 'updated', entry: ENTRY });
    const client = { saveEntry } as unknown as HrcekClient;

    await submitSave(client, {
      url: 'https://example.com/watch',
      title: '',
      notes: '',
      tags: [],
      fields: {},
      imageUrl: 'https://cdn.example.com/watch.jpg',
    });

    expect(saveEntry.mock.calls[0]![0].image_url).toBe(
      'https://cdn.example.com/watch.jpg',
    );
  });

  it('saves the entry anyway when the server will not fetch the picture', async () => {
    // The server fetches image_url inside the save's transaction, so a
    // picture it cannot reach fails the whole call. A picture never fails
    // the entry: the post goes again without it.
    const saveEntry = vi
      .fn()
      .mockRejectedValueOnce(
        new HrcekApiError(422, 'HRC-IMAGE-0006', 'That image could not be fetched.', {
          host: 'cdn.example.com',
        }),
      )
      .mockResolvedValue({ status: 'created', entry: ENTRY });
    const client = { saveEntry } as unknown as HrcekClient;

    const outcome = await submitSave(client, {
      url: 'https://example.com/watch',
      title: 'A watch',
      notes: '38mm',
      tags: ['watches'],
      fields: {},
      imageUrl: 'https://cdn.example.com/watch.jpg',
    });

    expect(outcome.status).toBe('created');
    // The server's own words, shown to the person and never matched on.
    expect(outcome.pictureTrouble).toEqual({
      kind: 'refused',
      message: 'That image could not be fetched.',
    });
    expect(saveEntry).toHaveBeenCalledTimes(2);
    expect(saveEntry.mock.calls[0]![0].image_url).toBe(
      'https://cdn.example.com/watch.jpg',
    );
    // Not sent as null or "": the attribute is gone entirely, which is
    // the documented way to leave any existing picture alone.
    expect('image_url' in saveEntry.mock.calls[1]![0]).toBe(false);
    // Everything else goes again in full — the retry is the same save.
    expect(saveEntry.mock.calls[1]![0]).toMatchObject({
      url: 'https://example.com/watch',
      title: 'A watch',
      notes: '38mm',
      tags: ['watches'],
    });
  });

  it('retries once only, so a second refusal is the caller’s to handle', async () => {
    const saveEntry = vi
      .fn()
      .mockRejectedValue(new HrcekApiError(422, 'HRC-IMAGE-0006', 'no picture'));
    const client = { saveEntry } as unknown as HrcekClient;

    await expect(
      submitSave(client, {
        url: 'https://example.com/watch',
        title: '',
        notes: '',
        tags: [],
        fields: {},
        imageUrl: 'https://cdn.example.com/watch.jpg',
      }),
    ).rejects.toMatchObject({ code: 'HRC-IMAGE-0006' });
    expect(saveEntry).toHaveBeenCalledTimes(2);
  });

  it('rethrows a failure that is not about the picture', async () => {
    // Only HRC-IMAGE-* means "the picture is what went wrong". A rejected
    // field or an expired token must reach the caller as it always did.
    const saveEntry = vi
      .fn()
      .mockRejectedValue(new HrcekApiError(422, 'HRC-FIELD-0001', 'no such field'));
    const client = { saveEntry } as unknown as HrcekClient;

    await expect(
      submitSave(client, {
        url: 'https://example.com/watch',
        title: '',
        notes: '',
        tags: [],
        fields: { nope: '1' },
        imageUrl: 'https://cdn.example.com/watch.jpg',
      }),
    ).rejects.toMatchObject({ code: 'HRC-FIELD-0001' });
    expect(saveEntry).toHaveBeenCalledTimes(1);
  });

  it('does not retry a save that carried no picture at all', async () => {
    // Nothing to drop, so nothing a second post could do differently.
    const saveEntry = vi
      .fn()
      .mockRejectedValue(new HrcekApiError(422, 'HRC-IMAGE-0001', 'not an image'));
    const client = { saveEntry } as unknown as HrcekClient;

    await expect(
      submitSave(client, {
        url: 'https://example.com/watch',
        title: '',
        notes: '',
        tags: [],
        fields: {},
      }),
    ).rejects.toMatchObject({ code: 'HRC-IMAGE-0001' });
    expect(saveEntry).toHaveBeenCalledTimes(1);
  });

  it('sends title, notes and tags in full, because POST replaces', async () => {
    // A partial send silently clears whatever it left out.
    const saveEntry = vi.fn().mockResolvedValue({ status: 'updated', entry: ENTRY });
    const client = { saveEntry } as unknown as HrcekClient;

    await submitSave(client, {
      url: 'https://example.com/watch',
      title: 'A watch, revisited',
      notes: '38mm',
      tags: ['diving'],
      fields: { Price: '129' },
    });

    expect(saveEntry).toHaveBeenCalledWith({
      url: 'https://example.com/watch',
      title: 'A watch, revisited',
      notes: '38mm',
      tags: ['diving'],
      fields: { Price: '129' },
    });
  });
});
