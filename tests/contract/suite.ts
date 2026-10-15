import { describe, expect, it } from 'vitest';
import { HrcekClient } from '../../src/lib/api/client';
import type { HrcekApiError } from '../../src/lib/api/errors';
import { loadExisting, submitSave } from '../../src/lib/save';
// Constants, not behaviour: the fake refuses this address, and a real
// Hrček cannot resolve it either, so both answer HRC-IMAGE-*.
import { PIXEL_PNG, UNFETCHABLE_IMAGE_URL } from '../fake-hrcek/server';

export interface ContractTarget {
  baseUrl: string;
  token: string;
  /** Unique per run so re-runs against a real server never collide. */
  runId: string;
}

/**
 * Credentials for minting a token. Passed separately from the target
 * factory because the skip decision is made while tests are collected,
 * before any beforeAll hook has run.
 */
export interface ContractCredentials {
  identifier: string;
  password: string;
}

export function runContractSuite(
  name: string,
  target: () => ContractTarget,
  credentials?: ContractCredentials,
): void {
  describe(`Hrček API contract (${name})`, () => {
    const client = () => new HrcekClient(target().baseUrl, target().token);
    const testUrl = (slug: string) =>
      `https://contract-tests.example.com/${target().runId}/${slug}`;

    it('reports health', async () => {
      expect((await client().health()).status).toBe('ok');
    });

    // Needs samastur/hrcek#53 on the real server: until that lands,
    // POST /api/auth/tokens requires a session and this run fails, which
    // is the signal that the extension's flow is still blocked.
    it.skipIf(credentials === undefined)(
      'mints a working token from credentials, without expiry',
      async () => {
        const { identifier, password } = credentials!;
        const name = `contract test ${target().runId.slice(0, 8)}`;

        const created = await new HrcekClient(target().baseUrl, null).createToken(
          name,
          identifier,
          password,
        );

        expect(created.name).toBe(name);
        expect(created.expires_at).toBeNull();
        // The point of the exercise: the new token authenticates.
        const asNewToken = new HrcekClient(target().baseUrl, created.token);
        expect((await asNewToken.me()).email).toContain('@');
      },
    );

    it('identifies the token owner', async () => {
      expect((await client().me()).email).toContain('@');
    });

    it('creates, then updates, an entry at the same address', async () => {
      const url = testUrl('upsert');
      const first = await client().saveEntry({ url, title: 'first' });
      expect(first.status).toBe('created');

      const second = await client().saveEntry({ url, title: 'second' });
      expect(second.status).toBe('updated');
      expect(second.entry.id).toBe(first.entry.id);
      expect(second.entry.title).toBe('second');
    });

    it('answers null for an address not held', async () => {
      expect(await loadExisting(client(), testUrl('never-saved'))).toBeNull();
    });

    it('finds a held address via the lookup', async () => {
      const url = testUrl('lookup');
      await client().saveEntry({ url });
      expect((await loadExisting(client(), url))?.url).toBe(url);
    });

    it('rejects an unknown field name with HRC-FIELD-0001', async () => {
      const error = await client()
        .saveEntry({ url: testUrl('bad-field'), fields: { 'no-such-field-x': '1' } })
        .then(
          () => null,
          (e: { code?: string }) => e,
        );
      expect(error?.code).toBe('HRC-FIELD-0001');
    });

    it('upsert replaces notes/tags but patches fields', async () => {
      const url = testUrl('upsert-semantics');
      const first = await client().saveEntry({
        url,
        title: 'first',
        notes: 'original notes',
        tags: ['a', 'b'],
        fields: { price: '10' },
      });
      expect(first.status).toBe('created');
      expect(first.entry.fields.Price).toBe('10');

      // Second save omits notes/tags/fields entirely except title.
      const second = await client().saveEntry({ url, title: 'second' });
      expect(second.status).toBe('updated');
      expect(second.entry.id).toBe(first.entry.id);
      expect(second.entry.notes).toBe(''); // replaced (omitted -> cleared)
      expect(second.entry.tags).toEqual([]); // replaced (omitted -> cleared)
      expect(second.entry.fields.Price).toBe('10'); // patched -> survives
    });

    it('clears a field by submitting an empty string', async () => {
      const url = testUrl('clear-field');
      const created = await client().saveEntry({ url, fields: { price: '5' } });
      expect(created.entry.fields.Price).toBe('5');

      const cleared = await client().saveEntry({ url, fields: { price: '' } });
      expect(cleared.entry.fields.Price).toBeUndefined();
    });

    it('agrees with the client on address normalization when matching for update', async () => {
      // target() mints a fresh runId per call — capture it once so both
      // requests below address the same entry.
      const runId = target().runId;
      const first = await client().saveEntry({
        url: `https://contract-tests.example.com/${runId}/norm`,
      });
      expect(first.status).toBe('created');

      const variant = `  HTTPS://Contract-Tests.example.com/${runId}/norm  `;
      const second = await client().saveEntry({ url: variant });
      expect(second.status).toBe('updated');
      expect(second.entry.id).toBe(first.entry.id);
    });

    it('refuses the whole save when it will not fetch the picture', async () => {
      // The fetch happens inside save_entry's transaction, so an address
      // the server will not go to takes the entry down with it. This is
      // the behaviour the popup has to survive, not an edge case: the
      // bytes path only works for a picture on the page's own host.
      const url = testUrl('picture-refused');
      const error = await client()
        .saveEntry({ url, title: 'has a picture', image_url: UNFETCHABLE_IMAGE_URL })
        .then(
          () => null,
          (e: { code?: string; status?: number }) => e,
        );

      expect(error?.status).toBe(422);
      expect(error?.code).toMatch(/^HRC-IMAGE-/);
      // Nothing was left behind for a client to find later.
      expect(await loadExisting(client(), url)).toBeNull();
    });

    it('saves the entry anyway, through submitSave, when the picture is refused', async () => {
      // A picture never fails the entry. submitSave posts again without
      // image_url and hands back the server's account of the picture.
      const url = testUrl('picture-never-fails-the-entry');
      const outcome = await submitSave(client(), {
        url,
        title: 'A watch',
        notes: '38mm',
        tags: ['watches'],
        fields: {},
        imageUrl: UNFETCHABLE_IMAGE_URL,
      });

      expect(outcome.status).toBe('created');
      expect(outcome.pictureTrouble).toBeTruthy();
      expect(outcome.entry.title).toBe('A watch');
      expect(outcome.entry.tags).toEqual(['watches']);
      expect(outcome.entry.image).toBeNull();
      expect((await loadExisting(client(), url))?.title).toBe('A watch');
    });

    it("serves an entry's picture to the token that owns it", async () => {
      // image.url sits outside /api/, and needs Hrcek-app/hrcek#96 on the
      // real server: before it, the token was sent to the sign-in page.
      const { entry } = await client().saveEntry({ url: testUrl('picture-served') });
      const pictured = await client().uploadImage(
        entry.id,
        new Blob([PIXEL_PNG], { type: 'image/png' }),
        'pixel.png',
      );

      const bytes = await client().fetchImage(pictured.image!.url);
      expect(bytes.type).toMatch(/^image\//);
      expect(bytes.size).toBeGreaterThan(0);
    });

    it('describes the fields an entry may carry', async () => {
      const fields = await client().listFields();
      // Never assert on Price or Priority: they are a fresh account's
      // defaults, renameable and deletable by their owner.
      for (const field of fields) {
        expect(typeof field.name).toBe('string');
        expect(['text', 'number', 'choice']).toContain(field.kind);
        expect(Array.isArray(field.options)).toBe(true);
        // Options are how a client learns a choice field's choices; every
        // other kind has none.
        if (field.kind !== 'choice') expect(field.options).toEqual([]);
      }
    });

    it('serves the labels an entry carries, and narrows them by prefix', async () => {
      // Unique per run, so this passes against a real account that already
      // has labels of its own.
      const tag = `contract-${target().runId.slice(0, 8)}`;
      await client().saveEntry({ url: testUrl('labels'), tags: [tag] });

      // A plain call returns the first page, up to a thousand labels. On an
      // account near that ceiling a brand-new tag need not be on it, so the
      // unbounded call is checked for shape only — the narrowed call below
      // is what proves the tag is really there, and its prefix is unique to
      // this run.
      const all = await client().listLabels();
      for (const label of all) expect(typeof label.name).toBe('string');

      const narrowed = await client().listLabels({ startsWith: tag.slice(0, 12) });
      expect(narrowed.map((label) => label.name)).toContain(tag);

      const elsewhere = await client().listLabels({ startsWith: 'zzz-no-such-prefix-' });
      expect(elsewhere).toEqual([]);
    });

    it('answers in the language the client asked for, and in English otherwise', async () => {
      const missing = testUrl('language');

      const slovenian = await new HrcekClient(
        target().baseUrl,
        target().token,
        undefined,
        {
          acceptLanguage: 'sl',
        },
      )
        .getEntryByUrl(missing)
        .then(
          () => null,
          (error: unknown) => error as HrcekApiError,
        );
      const english = await client()
        .getEntryByUrl(missing)
        .then(
          () => null,
          (error: unknown) => error as HrcekApiError,
        );

      // The code is the contract and never changes with the language.
      expect(slovenian?.code).toBe('HRC-CORE-0003');
      expect(english?.code).toBe('HRC-CORE-0003');
      expect(slovenian?.message).not.toBe(english?.message);
    });
  });
}
