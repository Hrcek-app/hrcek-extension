import type { Candidate } from '../../lib/page/candidates';
import type { PictureChoice } from '../../lib/picture';

/** The picture an entry already holds. */
export interface HeldPicture {
  /**
   * Something an `<img>` can show it with — an object URL over bytes
   * fetched with the token. Null when those bytes could not be had: the
   * entry still has a picture, this popup just cannot draw it, and saying
   * so beats an `<img>` that will only ever render broken.
   */
  src: string | null;
}

export interface PictureStateOptions {
  candidates: Candidate[];
  /** The picture the entry already holds, or null if it holds none. */
  held: HeldPicture | null;
  /**
   * Whether this address is already saved. Distinct from `held`: an entry
   * that deliberately has no picture is `held: null, existing: true`, and
   * must not quietly gain one when somebody reopens it to fix a typo.
   */
  existing: boolean;
}

/** One picture on offer: the one the entry holds, or one the page offered. */
export interface PictureItem {
  key: string;
  /** What an `<img>` shows it with; null for a held picture that cannot be shown. */
  src: string | null;
  held: boolean;
}

/** Everything the picture row and the chooser decide, without any DOM. */
export interface PictureState {
  /** Every picture on offer, the held one first. Empty means no row at all. */
  readonly items: readonly PictureItem[];
  included(): boolean;
  setIncluded(included: boolean): void;
  /** The selected picture; null only when nothing is on offer. */
  selected(): PictureItem | null;
  /** Selects the picture with this key. An unknown key changes nothing. */
  select(key: string): void;
  /** Moves the selection one picture along, stopping at either end. */
  step(delta: -1 | 1): void;
  /** Whether there is anything else to pick. */
  canChange(): boolean;
  choice(): PictureChoice;
}

/**
 * The key standing for "the picture it already has". Not an address: the
 * held picture is shown from an object URL, which has nothing to do with
 * wherever the server originally fetched it from. A candidate cannot
 * collide with it — those are all `new URL(…).href`, and none of them
 * begins with a space.
 */
const HELD_KEY = ' held';

export function createPictureState(options: PictureStateOptions): PictureState {
  const { candidates, held, existing } = options;
  const items: PictureItem[] = [
    ...(held === null ? [] : [{ key: HELD_KEY, src: held.src, held: true }]),
    ...candidates.map((candidate) => ({
      key: candidate.url,
      src: candidate.url,
      held: false,
    })),
  ];

  // The held picture when there is one, otherwise the page's first.
  let index = 0;
  // A held picture is a choice already made; a fresh page is a proposal;
  // a saved entry without a picture chose to have none.
  let included = items.length > 0 && (held !== null || !existing);

  return {
    items,

    included: () => included,

    setIncluded(next: boolean): void {
      included = items.length > 0 && next;
    },

    selected: () => items[index] ?? null,

    select(key: string): void {
      const found = items.findIndex((item) => item.key === key);
      if (found !== -1) index = found;
    },

    step(delta: -1 | 1): void {
      index = Math.max(0, Math.min(items.length - 1, index + delta));
    },

    canChange: () => items.length >= 2,

    choice(): PictureChoice {
      // Nothing to clear if there was nothing there.
      if (!included) return held === null ? { kind: 'unchanged' } : { kind: 'none' };
      const item = items[index];
      // Leaving the held picture selected must send no image_url at all.
      if (item === undefined || item.held) return { kind: 'unchanged' };
      return { kind: 'url', url: item.key };
    },
  };
}
