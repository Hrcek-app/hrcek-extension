// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activateLocale } from '../../lib/i18n';
import { createPictureState, type HeldPicture } from './picture-state';
import { createPictureRow } from './picture-row';
import type { Candidate } from '../../lib/page/candidates';

beforeEach(() => activateLocale('en'));

const CANDIDATES: Candidate[] = [
  { url: 'https://e.test/og.jpg', width: 0, height: 0, fromHead: true },
  { url: 'https://e.test/a.jpg', width: 800, height: 600, fromHead: false },
];
const HELD: HeldPicture = { src: 'blob:held-picture' };

function mount(
  candidates = CANDIDATES,
  held: HeldPicture | null = null,
  existing = held !== null,
) {
  const host = document.createElement('div');
  document.body.append(host);
  const state = createPictureState({ candidates, held, existing });
  const openChooser = vi.fn();
  const row = createPictureRow(host, state, openChooser);
  const box = () => host.querySelector<HTMLInputElement>('#include-picture');
  const preview = () => host.querySelector<HTMLElement>('.picture-preview');
  const change = () => host.querySelector<HTMLButtonElement>('#change-picture');
  return { host, state, row, openChooser, box, preview, change };
}

describe('createPictureRow', () => {
  it('shows the proposed picture, ticked, with Change', () => {
    const { box, preview, change } = mount();
    expect(box()!.checked).toBe(true);
    expect(preview()!.getAttribute('src')).toBe('https://e.test/og.jpg');
    expect(change()).not.toBeNull();
  });

  it('hides the picture and Change when unticked, and brings both back when ticked', () => {
    const { box, preview, change, state } = mount();
    box()!.click();
    expect(box()!.checked).toBe(false);
    expect(preview()).toBeNull();
    expect(change()).toBeNull();
    expect(state.included()).toBe(false);

    box()!.click();
    expect(preview()!.getAttribute('src')).toBe('https://e.test/og.jpg');
    expect(change()).not.toBeNull();
  });

  it('keeps the focus on the checkbox it redrew', () => {
    const { box } = mount();
    box()!.focus();
    box()!.click();
    expect(document.activeElement).toBe(box());
  });

  it('asks for the chooser on Change', () => {
    const { change, openChooser } = mount();
    change()!.click();
    expect(openChooser).toHaveBeenCalledOnce();
  });

  it('offers no Change when there is only one picture', () => {
    const { change, preview } = mount(CANDIDATES.slice(0, 1));
    expect(preview()).not.toBeNull();
    expect(change()).toBeNull();
  });

  it('starts unticked on a saved entry that has no picture', () => {
    const { box, preview } = mount(CANDIDATES, null, true);
    expect(box()!.checked).toBe(false);
    expect(preview()).toBeNull();
  });

  it('shows the held picture from the bytes it was given', () => {
    const { preview } = mount(CANDIDATES, HELD);
    expect(preview()!.getAttribute('src')).toBe('blob:held-picture');
  });

  it('says a held picture cannot be shown, and still lets it be removed', () => {
    const { preview, box, change, state } = mount([], { src: null });
    expect(preview()!.tagName).toBe('DIV');
    expect(preview()!.textContent).toBe('It has a picture that cannot be shown here');
    expect(change()).toBeNull();
    box()!.click();
    expect(state.choice()).toEqual({ kind: 'none' });
  });

  it('renders nothing when nothing is on offer', () => {
    const { host } = mount([], null);
    expect(host.childElementCount).toBe(0);
  });

  it('draws what the state now selects on refresh', () => {
    const { row, state, preview } = mount();
    state.select('https://e.test/a.jpg');
    row.refresh();
    expect(preview()!.getAttribute('src')).toBe('https://e.test/a.jpg');
  });

  it('keeps a hostile candidate address inert', () => {
    const url = 'https://e.test/x.jpg" onerror="alert(1)';
    const { host, preview } = mount([{ url, width: 800, height: 600, fromHead: false }]);
    expect(preview()!.getAttribute('src')).toBe(url);
    expect(host.querySelectorAll('[onerror]')).toHaveLength(0);
  });

  it('speaks the active language', () => {
    activateLocale('sl');
    const { host } = mount();
    activateLocale('en');
    expect(host.querySelector('.picture-include')!.textContent).toBe('Vključi sliko');
  });
});
