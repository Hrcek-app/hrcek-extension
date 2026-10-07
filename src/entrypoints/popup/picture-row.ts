import { i18n } from '@lingui/core';
import type { PictureItem, PictureState } from './picture-state';

export interface PictureRow {
  /** Redraws from the state — after the chooser has changed the selection. */
  refresh(): void;
}

/**
 * An `<img>` for the picture, or a placeholder saying the entry has one
 * that cannot be shown here. `src` is assigned as a property on a created
 * element, never interpolated: a candidate's address is the page's to
 * choose, and a stray `"` must not break out of an attribute.
 */
export function pictureImage(item: PictureItem, className: string): HTMLElement {
  if (item.src === null) {
    const placeholder = document.createElement('div');
    placeholder.className = `${className} unshowable`;
    placeholder.textContent = i18n._('It has a picture that cannot be shown here');
    return placeholder;
  }
  const image = document.createElement('img');
  image.className = className;
  image.src = item.src;
  image.alt = '';
  return image;
}

/**
 * The form's picture row: whether to include a picture, which one, and a
 * way into the chooser. Choosing happens in the chooser; this only shows
 * the outcome.
 */
export function createPictureRow(
  host: HTMLElement,
  state: PictureState,
  openChooser: () => void,
): PictureRow {
  function render(): void {
    host.replaceChildren();
    // Nothing to offer and nothing to drop: the row is simply absent.
    if (state.items.length === 0) return;

    const toggle = document.createElement('label');
    toggle.className = 'picture-include';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = 'include-picture';
    box.checked = state.included();
    box.addEventListener('change', () => {
      state.setIncluded(box.checked);
      render();
      // The redraw replaced the checkbox somebody was just using.
      host.querySelector<HTMLInputElement>('#include-picture')?.focus();
    });
    toggle.append(box, document.createTextNode(i18n._('Include picture')));
    host.append(toggle);

    const selected = state.selected();
    if (!state.included() || selected === null) return;

    const body = document.createElement('div');
    body.className = 'picture-body';
    body.append(pictureImage(selected, 'picture-preview'));
    if (state.canChange()) {
      const change = document.createElement('button');
      change.type = 'button';
      change.id = 'change-picture';
      change.className = 'quiet';
      change.textContent = i18n._('Change');
      change.addEventListener('click', openChooser);
      body.append(change);
    }
    host.append(body);
  }

  render();
  return { refresh: render };
}
