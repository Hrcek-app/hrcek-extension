import { i18n } from '@lingui/core';
import { pictureImage } from './picture-row';
import type { PictureState } from './picture-state';

/**
 * Whether the strip can scroll further either way. Kept apart from the
 * DOM so it can be tested without a layout engine; one pixel of slack
 * absorbs the fractional scroll positions zoomed pages produce.
 */
export function stripEnds(
  scrollLeft: number,
  scrollWidth: number,
  clientWidth: number,
): { atStart: boolean; atEnd: boolean } {
  return {
    atStart: scrollLeft <= 1,
    atEnd: scrollLeft + clientWidth >= scrollWidth - 1,
  };
}

function button(className: string, text: string, label?: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = text;
  if (label !== undefined) element.setAttribute('aria-label', label);
  return element;
}

/**
 * Takes over the whole popup to choose a picture. Selecting is choosing:
 * there is no cancel, so Close, Escape and a click on the preview all
 * leave with whatever is selected.
 */
export function openPictureChooser(state: PictureState, onClose: () => void): void {
  const overlay = document.createElement('div');
  overlay.className = 'chooser';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', i18n._('Choose a picture'));

  const preview = button('chooser-preview', '', i18n._('Use this picture'));
  const caption = document.createElement('span');
  caption.className = 'chooser-caption';
  caption.textContent = i18n._('Selected');

  const strip = document.createElement('div');
  strip.className = 'chooser-strip';
  const earlier = button('chooser-step quiet', '‹', i18n._('Earlier pictures'));
  const later = button('chooser-step quiet', '›', i18n._('More pictures'));
  const tiles = document.createElement('div');
  tiles.className = 'chooser-tiles';

  const total = state.items.length;
  const tileButtons = state.items.map((item, position) => {
    const label = item.held
      ? item.src === null
        ? i18n._('It has a picture that cannot be shown here')
        : i18n._('The picture it has')
      : i18n._('Picture {number} of {total}', { number: position + 1, total });
    const tile = button('chooser-tile', '', label);
    tile.dataset['key'] = item.key;
    tile.title = label;
    // Built as an element with `src` as a property — see pictureImage.
    if (item.src !== null) {
      const image = document.createElement('img');
      image.src = item.src;
      image.alt = '';
      tile.append(image);
    } else {
      tile.classList.add('unshowable');
    }
    if (item.held) {
      const badge = document.createElement('span');
      badge.className = 'chooser-current';
      badge.textContent = i18n._('current');
      tile.append(badge);
    }
    tile.addEventListener('click', () => {
      state.select(item.key);
      update();
    });
    return tile;
  });
  tiles.append(...tileButtons);
  strip.append(earlier, tiles, later);

  const close = button('chooser-close', i18n._('Close'));
  overlay.append(preview, strip, close);

  function selectedTile(): HTMLButtonElement | undefined {
    const key = state.selected()?.key;
    return tileButtons.find((tile) => tile.dataset['key'] === key);
  }

  function update(): void {
    const selected = state.selected();
    if (selected !== null)
      preview.replaceChildren(pictureImage(selected, 'chooser-image'), caption);
    for (const tile of tileButtons) {
      const on = tile.dataset['key'] === selected?.key;
      tile.classList.toggle('on', on);
      tile.setAttribute('aria-pressed', String(on));
    }
    // Absent in jsdom, which has no layout to scroll.
    selectedTile()?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  function updateSteps(): void {
    const ends = stripEnds(tiles.scrollLeft, tiles.scrollWidth, tiles.clientWidth);
    earlier.disabled = ends.atStart;
    later.disabled = ends.atEnd;
  }

  let open = true;
  function finish(): void {
    if (!open) return;
    open = false;
    overlay.remove();
    document.body.classList.remove('choosing');
    window.removeEventListener('resize', updateSteps);
    onClose();
  }

  preview.addEventListener('click', finish);
  close.addEventListener('click', finish);
  earlier.addEventListener('click', () =>
    tiles.scrollBy?.({ left: -tiles.clientWidth, behavior: 'smooth' }),
  );
  later.addEventListener('click', () =>
    tiles.scrollBy?.({ left: tiles.clientWidth, behavior: 'smooth' }),
  );
  tiles.addEventListener('scroll', updateSteps);
  window.addEventListener('resize', updateSteps);

  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      // Chrome may close the whole popup on Escape before this runs; where
      // it does not, the popup must not see it either.
      event.preventDefault();
      finish();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      state.step(event.key === 'ArrowLeft' ? -1 : 1);
      update();
      selectedTile()?.focus();
    }
  });

  // The popup is as tall as its content; `choosing` makes it tall enough
  // for a picture worth judging, and leaving puts it back.
  document.body.classList.add('choosing');
  document.body.append(overlay);
  update();
  updateSteps();
  // Widths are only known after layout.
  requestAnimationFrame(updateSteps);
  selectedTile()?.focus();
}
