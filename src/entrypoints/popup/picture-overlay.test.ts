// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateLocale } from '../../lib/i18n';
import { createPictureState, type HeldPicture } from './picture-state';
import { openPictureChooser, stripEnds } from './picture-overlay';
import type { Candidate } from '../../lib/page/candidates';

beforeEach(() => activateLocale('en'));
afterEach(() => {
  document.body.replaceChildren();
  document.body.className = '';
});

const CANDIDATES: Candidate[] = [
  { url: 'https://e.test/og.jpg', width: 0, height: 0, fromHead: true },
  { url: 'https://e.test/a.jpg', width: 800, height: 600, fromHead: false },
  { url: 'https://e.test/b.jpg', width: 400, height: 300, fromHead: false },
];
const HELD: HeldPicture = { src: 'blob:held-picture' };

function open(candidates = CANDIDATES, held: HeldPicture | null = null) {
  const state = createPictureState({ candidates, held, existing: held !== null });
  const onClose = vi.fn();
  openPictureChooser(state, onClose);
  const overlay = () => document.querySelector<HTMLElement>('.chooser');
  const tiles = () => [...document.querySelectorAll<HTMLButtonElement>('.chooser-tile')];
  const image = () => document.querySelector<HTMLElement>('.chooser-image');
  const key = (name: string) =>
    overlay()!.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
    );
  return { state, onClose, overlay, tiles, image, key };
}

describe('openPictureChooser', () => {
  it('covers the popup with the selected picture, captioned as selected', () => {
    const { overlay, image } = open();
    expect(overlay()).not.toBeNull();
    expect(document.body.classList.contains('choosing')).toBe(true);
    expect(image()!.getAttribute('src')).toBe('https://e.test/og.jpg');
    expect(document.querySelector('.chooser-caption')!.textContent).toBe('Selected');
  });

  it('offers every picture in the strip, the held one first and marked current', () => {
    const { tiles } = open(CANDIDATES, HELD);
    expect(tiles()).toHaveLength(4);
    expect(tiles()[0]!.querySelector('img')!.getAttribute('src')).toBe(
      'blob:held-picture',
    );
    expect(tiles()[0]!.querySelector('.chooser-current')!.textContent).toBe('current');
    expect(tiles()[1]!.querySelector('.chooser-current')).toBeNull();
  });

  it('marks the selected tile and focuses it on open', () => {
    const { tiles } = open();
    expect(tiles()[0]!.classList.contains('on')).toBe(true);
    expect(tiles()[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(tiles()[1]!.getAttribute('aria-pressed')).toBe('false');
    expect(document.activeElement).toBe(tiles()[0]);
  });

  it('selects a clicked tile and the preview follows', () => {
    const { tiles, image, state, overlay } = open();
    tiles()[2]!.click();
    expect(state.choice()).toEqual({ kind: 'url', url: 'https://e.test/b.jpg' });
    expect(image()!.getAttribute('src')).toBe('https://e.test/b.jpg');
    expect(tiles()[2]!.classList.contains('on')).toBe(true);
    expect(tiles()[0]!.classList.contains('on')).toBe(false);
    expect(overlay()).not.toBeNull(); // looking, not leaving
  });

  it('closes on a click of the preview, keeping the selection', () => {
    const { tiles, state, overlay, onClose } = open();
    tiles()[1]!.click();
    document.querySelector<HTMLButtonElement>('.chooser-preview')!.click();
    expect(overlay()).toBeNull();
    expect(document.body.classList.contains('choosing')).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
    expect(state.choice()).toEqual({ kind: 'url', url: 'https://e.test/a.jpg' });
  });

  it('closes on Close, keeping the selection', () => {
    const { tiles, state, overlay, onClose } = open();
    tiles()[2]!.click();
    document.querySelector<HTMLButtonElement>('.chooser-close')!.click();
    expect(overlay()).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
    expect(state.choice()).toEqual({ kind: 'url', url: 'https://e.test/b.jpg' });
  });

  it('closes on Escape, keeping the selection, and only once', () => {
    const { tiles, overlay, onClose, state } = open();
    tiles()[1]!.click();
    const chooser = overlay()!;
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    const notDefault = chooser.dispatchEvent(escape);
    expect(notDefault).toBe(false); // preventDefault: the popup itself must not see it
    expect(overlay()).toBeNull();
    // A second Escape reaching the detached chooser, then Close on it,
    // must not report a second close.
    chooser.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    chooser.querySelector<HTMLButtonElement>('.chooser-close')!.click();
    expect(onClose).toHaveBeenCalledOnce();
    expect(state.choice()).toEqual({ kind: 'url', url: 'https://e.test/a.jpg' });
  });

  it('moves the selection with the arrow keys, stopping at either end', () => {
    const { key, state, tiles, image } = open();
    key('ArrowLeft');
    expect(state.selected()!.key).toBe('https://e.test/og.jpg');
    key('ArrowRight');
    key('ArrowRight');
    key('ArrowRight');
    expect(state.selected()!.key).toBe('https://e.test/b.jpg');
    expect(image()!.getAttribute('src')).toBe('https://e.test/b.jpg');
    expect(document.activeElement).toBe(tiles()[2]);
  });

  it('shows a held picture that cannot be shown as a placeholder, in the preview and the tile', () => {
    const { tiles } = open(CANDIDATES, { src: null });
    expect(document.querySelector('.chooser-image')!.textContent).toBe(
      'It has a picture that cannot be shown here',
    );
    expect(tiles()[0]!.querySelector('img')).toBeNull();
    expect(tiles()[0]!.classList.contains('unshowable')).toBe(true);
    expect(tiles()[0]!.getAttribute('aria-label')).toBe(
      'It has a picture that cannot be shown here',
    );
  });

  it('labels each candidate tile by its place', () => {
    const { tiles } = open();
    expect(tiles()[1]!.getAttribute('aria-label')).toBe('Picture 2 of 3');
  });

  it('keeps a hostile candidate address inert', () => {
    const url = 'https://e.test/x.jpg" onerror="alert(1)';
    open([{ url, width: 800, height: 600, fromHead: false }, CANDIDATES[0]!]);
    expect(document.querySelector('.chooser-image')!.getAttribute('src')).toBe(url);
    expect(document.querySelectorAll('[onerror]')).toHaveLength(0);
  });

  it('speaks the active language', () => {
    activateLocale('sl');
    open();
    activateLocale('en');
    expect(document.querySelector('.chooser-close')!.textContent).toBe('Zapri');
  });
});

describe('openPictureChooser, with focus outside it', () => {
  // Firefox and Safari on macOS do not focus a clicked button, and a
  // focused step button that becomes disabled drops focus to <body>.
  // Either way the keys must still reach the chooser.
  it('still closes on Escape when the key lands on the body', () => {
    const { overlay, onClose } = open();
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(overlay()).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('still moves the selection when an arrow lands on the body', () => {
    const { state } = open();
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(state.selected()!.key).toBe('https://e.test/a.jpg');
  });

  it('stops listening once closed', () => {
    const { state } = open();
    document.querySelector<HTMLButtonElement>('.chooser-close')!.click();
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(state.selected()!.key).toBe('https://e.test/og.jpg');
  });
});

describe('openPictureChooser, over the form', () => {
  it('makes what it covers inert while open, and gives it back on close', () => {
    // The form under the chooser is invisible; Tab must not reach it, nor
    // Enter submit it, while somebody is choosing.
    const app = document.createElement('div');
    const alreadyInert = document.createElement('div');
    alreadyInert.setAttribute('inert', '');
    document.body.append(app, alreadyInert);

    open();
    expect(app.hasAttribute('inert')).toBe(true);
    expect(document.querySelector<HTMLElement>('.chooser')!.hasAttribute('inert')).toBe(
      false,
    );

    document.querySelector<HTMLButtonElement>('.chooser-close')!.click();
    expect(app.hasAttribute('inert')).toBe(false);
    // Something inert for its own reasons stays that way.
    expect(alreadyInert.hasAttribute('inert')).toBe(true);
  });
});

describe('stripEnds', () => {
  it('is at both ends when everything fits', () => {
    expect(stripEnds(0, 400, 400)).toEqual({ atStart: true, atEnd: true });
  });
  it('is at the start before any scrolling', () => {
    expect(stripEnds(0, 900, 400)).toEqual({ atStart: true, atEnd: false });
  });
  it('is at the end when scrolled all the way, allowing a sub-pixel remainder', () => {
    expect(stripEnds(499.5, 900, 400)).toEqual({ atStart: false, atEnd: true });
  });
  it('is at neither in the middle', () => {
    expect(stripEnds(200, 900, 400)).toEqual({ atStart: false, atEnd: false });
  });
});
