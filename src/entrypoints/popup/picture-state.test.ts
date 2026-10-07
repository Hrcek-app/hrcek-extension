import { describe, expect, it } from 'vitest';
import { createPictureState, type HeldPicture } from './picture-state';
import type { Candidate } from '../../lib/page/candidates';

const CANDIDATES: Candidate[] = [
  { url: 'https://e.test/og.jpg', width: 0, height: 0, fromHead: true },
  { url: 'https://e.test/a.jpg', width: 800, height: 600, fromHead: false },
  { url: 'https://e.test/b.jpg', width: 400, height: 300, fromHead: false },
];

/** What main.ts hands over: an object URL over bytes fetched with the token. */
const HELD: HeldPicture = { src: 'blob:held-picture' };

describe('createPictureState', () => {
  describe('a new address', () => {
    it('includes the first candidate, so the common case is one click on Save', () => {
      const state = createPictureState({
        candidates: CANDIDATES,
        held: null,
        existing: false,
      });
      expect(state.included()).toBe(true);
      expect(state.selected()?.key).toBe('https://e.test/og.jpg');
      expect(state.choice()).toEqual({ kind: 'url', url: 'https://e.test/og.jpg' });
    });

    it('sends nothing when unticked', () => {
      const state = createPictureState({
        candidates: CANDIDATES,
        held: null,
        existing: false,
      });
      state.setIncluded(false);
      expect(state.choice()).toEqual({ kind: 'unchanged' });
    });

    it('remembers the selection across untick and retick', () => {
      const state = createPictureState({
        candidates: CANDIDATES,
        held: null,
        existing: false,
      });
      state.select('https://e.test/b.jpg');
      state.setIncluded(false);
      state.setIncluded(true);
      expect(state.choice()).toEqual({ kind: 'url', url: 'https://e.test/b.jpg' });
    });
  });

  describe('a saved entry that holds a picture', () => {
    it('lists the held picture first and selects it', () => {
      const state = createPictureState({
        candidates: CANDIDATES,
        held: HELD,
        existing: true,
      });
      expect(state.items[0]).toEqual({
        key: expect.any(String),
        src: 'blob:held-picture',
        held: true,
      });
      expect(state.items.slice(1).map((item) => item.src)).toEqual(
        CANDIDATES.map((c) => c.url),
      );
      expect(state.selected()?.held).toBe(true);
      expect(state.included()).toBe(true);
    });

    it('leaves the held picture alone when it stays selected', () => {
      const state = createPictureState({
        candidates: CANDIDATES,
        held: HELD,
        existing: true,
      });
      expect(state.choice()).toEqual({ kind: 'unchanged' });
    });

    it('replaces it when a candidate is selected', () => {
      const state = createPictureState({
        candidates: CANDIDATES,
        held: HELD,
        existing: true,
      });
      state.select('https://e.test/a.jpg');
      expect(state.choice()).toEqual({ kind: 'url', url: 'https://e.test/a.jpg' });
    });

    it('removes it when unticked', () => {
      const state = createPictureState({
        candidates: CANDIDATES,
        held: HELD,
        existing: true,
      });
      state.setIncluded(false);
      expect(state.choice()).toEqual({ kind: 'none' });
    });

    it('keeps it after a change of mind — untick then retick is unchanged, not none', () => {
      const state = createPictureState({
        candidates: CANDIDATES,
        held: HELD,
        existing: true,
      });
      state.setIncluded(false);
      state.setIncluded(true);
      expect(state.choice()).toEqual({ kind: 'unchanged' });
    });

    it('treats a picture that cannot be shown like any other held picture', () => {
      const state = createPictureState({
        candidates: [],
        held: { src: null },
        existing: true,
      });
      expect(state.items).toEqual([{ key: expect.any(String), src: null, held: true }]);
      expect(state.choice()).toEqual({ kind: 'unchanged' });
      state.setIncluded(false);
      expect(state.choice()).toEqual({ kind: 'none' });
    });

    it('offers no change when the held picture is the only one', () => {
      const state = createPictureState({ candidates: [], held: HELD, existing: true });
      expect(state.canChange()).toBe(false);
    });
  });

  describe('a saved entry that holds no picture', () => {
    it('starts unticked, so fixing a typo does not quietly add a picture', () => {
      const state = createPictureState({
        candidates: CANDIDATES,
        held: null,
        existing: true,
      });
      expect(state.included()).toBe(false);
      expect(state.choice()).toEqual({ kind: 'unchanged' });
    });

    it('adds the first candidate once ticked', () => {
      const state = createPictureState({
        candidates: CANDIDATES,
        held: null,
        existing: true,
      });
      state.setIncluded(true);
      expect(state.choice()).toEqual({ kind: 'url', url: 'https://e.test/og.jpg' });
    });
  });

  describe('nothing on offer', () => {
    it('has no items, is not included, and changes nothing', () => {
      const state = createPictureState({ candidates: [], held: null, existing: false });
      expect(state.items).toEqual([]);
      expect(state.selected()).toBeNull();
      state.setIncluded(true);
      expect(state.included()).toBe(false);
      expect(state.choice()).toEqual({ kind: 'unchanged' });
    });
  });

  describe('selection', () => {
    it('can change only with two or more pictures', () => {
      expect(
        createPictureState({
          candidates: CANDIDATES.slice(0, 1),
          held: null,
          existing: false,
        }).canChange(),
      ).toBe(false);
      expect(
        createPictureState({
          candidates: CANDIDATES.slice(0, 2),
          held: null,
          existing: false,
        }).canChange(),
      ).toBe(true);
    });

    it('ignores a key it does not know', () => {
      const state = createPictureState({
        candidates: CANDIDATES,
        held: null,
        existing: false,
      });
      state.select('https://e.test/nowhere.jpg');
      expect(state.selected()?.key).toBe('https://e.test/og.jpg');
    });

    it('steps along the pictures and stops at either end', () => {
      const state = createPictureState({
        candidates: CANDIDATES,
        held: null,
        existing: false,
      });
      state.step(-1);
      expect(state.selected()?.key).toBe('https://e.test/og.jpg');
      state.step(1);
      state.step(1);
      expect(state.selected()?.key).toBe('https://e.test/b.jpg');
      state.step(1);
      expect(state.selected()?.key).toBe('https://e.test/b.jpg');
    });
  });
});
