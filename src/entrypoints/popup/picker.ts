import { i18n } from '@lingui/core';
import type { Candidate } from '../../lib/page/candidates';
import type { PictureChoice } from '../../lib/picture';

/** The picture an entry already holds. */
export interface HeldPicture {
  /**
   * Something an `<img>` can show it with — an object URL over bytes
   * fetched with the token. Null when those bytes could not be had: the
   * entry still has a picture, this popup just cannot draw it, and a tile
   * that says so beats an `<img>` that will only ever render broken.
   */
  src: string | null;
}

export interface PickerOptions {
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

export interface Picker {
  choice(): PictureChoice;
  /**
   * Puts the large preview away. For the caller to invoke when attention
   * has moved on — clicking through tiles is looking, not leaving, so the
   * picker never closes itself on a click of its own.
   */
  collapse(): void;
}

function escapeAttribute(value: string): string {
  const node = document.createElement('span');
  node.textContent = value;
  return node.innerHTML.replaceAll('"', '&quot;');
}

/** How many tiles the strip shows at once. */
const WINDOW = 4;

/**
 * The key standing for "the picture it already has". Not an address: the
 * held picture is shown from an object URL, which has nothing to do with
 * wherever the server originally fetched it from. A candidate cannot
 * collide with it — those are all `new URL(…).href`, and none of them
 * begins with a space.
 */
const HELD = ' held';

export function createPicker(host: HTMLElement, options: PickerOptions): Picker {
  const { candidates, held, existing } = options;

  // Nothing to offer and nothing to drop: the row is simply absent.
  if (candidates.length === 0 && held === null) {
    host.innerHTML = '';
    return { choice: () => ({ kind: 'unchanged' }), collapse: () => {} };
  }

  /** null means "no picture"; HELD means "leave what it has alone". */
  let selected: string | null =
    held !== null ? HELD : existing ? null : (candidates[0]?.url ?? null);
  // Opens large only on a proposal — a fresh page's first candidate. A
  // picture already held, or an entry that chose to have none, is a
  // choice already made, and opens collapsed on it.
  let expanded = selected !== null && selected !== HELD;
  let start = 0;

  type Tile = { key: string; src: string | null; className: string; label: string };

  function tiles(): Tile[] {
    const list: Tile[] = [
      { key: 'none', src: null, className: 'tile none', label: i18n._('No picture') },
    ];
    if (held !== null) {
      list.push({
        key: HELD,
        src: held.src,
        className: held.src === null ? 'tile held unshowable' : 'tile held',
        // A picture it has but cannot show says so, rather than looking
        // like an empty tile somebody might click away.
        label:
          held.src === null
            ? i18n._('It has a picture that cannot be shown here')
            : i18n._('The picture it has'),
      });
    }
    for (const candidate of candidates) {
      list.push({
        key: candidate.url,
        src: candidate.url,
        className: 'tile',
        label: candidate.fromHead
          ? i18n._('Declared by the page')
          : i18n._('From the page'),
      });
    }
    return list;
  }

  function render(): void {
    const all = tiles();
    const windowed = all.slice(start, start + WINDOW);

    host.innerHTML = `
      <div class="strip">
        <button type="button" class="step" data-step="-1" ${start === 0 ? 'disabled' : ''} aria-label="${escapeAttribute(i18n._('Earlier pictures'))}">‹</button>
        <div class="tiles"></div>
        <button type="button" class="step" data-step="1" ${start + WINDOW >= all.length ? 'disabled' : ''} aria-label="${escapeAttribute(i18n._('More pictures'))}">›</button>
        ${expanded ? '' : `<button type="button" class="expand quiet" aria-label="${escapeAttribute(i18n._('Show the picture larger'))}">⤢</button>`}
      </div>
    `;

    // Built as elements with `src` assigned as a property, never
    // interpolated into markup — a candidate's address is untrusted, and a
    // template string would let a stray `"` break out of the attribute.
    if (expanded) {
      const source = selected === HELD ? (held?.src ?? null) : selected;
      let hero: HTMLElement;
      if (source !== null) {
        const image = document.createElement('img');
        image.className = 'hero';
        image.src = source;
        image.alt = '';
        hero = image;
      } else {
        const empty = document.createElement('div');
        empty.className = 'hero empty';
        empty.textContent =
          selected === HELD ? i18n._('The picture it has') : i18n._('No picture');
        hero = empty;
      }
      host.insertBefore(hero, host.firstChild);
    }

    const box = host.querySelector<HTMLDivElement>('.tiles')!;
    for (const tile of windowed) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className =
        tile.className + (tile.key === (selected ?? 'none') ? ' on' : '');
      button.title = tile.label;
      button.setAttribute('aria-label', tile.label);
      if (tile.src === null) {
        button.textContent = tile.key === HELD ? i18n._('kept') : i18n._('none');
      } else {
        const image = document.createElement('img');
        image.src = tile.src;
        image.alt = '';
        button.append(image);
      }
      button.addEventListener('click', () => {
        selected = tile.key === 'none' ? null : tile.key;
        // The hero follows the click and stays as it was: looking through
        // the tiles is exactly when the large preview is wanted, and a
        // thumbnail is too small to judge a picture by. It closes when
        // attention moves elsewhere — see collapse().
        render();
      });
      box.append(button);
    }

    for (const step of host.querySelectorAll<HTMLButtonElement>('.step')) {
      step.addEventListener('click', () => {
        start = Math.max(
          0,
          Math.min(all.length - 1, start + Number(step.dataset['step']) * WINDOW),
        );
        render();
      });
    }

    host.querySelector<HTMLButtonElement>('.expand')?.addEventListener('click', () => {
      expanded = true;
      render();
    });
  }

  render();

  return {
    collapse(): void {
      // Nothing to put away, and no render to spend: this is called on
      // every focus change in the form.
      if (!expanded) return;
      expanded = false;
      render();
    },

    choice(): PictureChoice {
      // Leaving the held picture selected must send no image_url at all.
      if (selected === HELD) return { kind: 'unchanged' };
      if (selected === null) {
        // Nothing to clear if there was nothing there.
        return held === null ? { kind: 'unchanged' } : { kind: 'none' };
      }
      return { kind: 'url', url: selected };
    },
  };
}
