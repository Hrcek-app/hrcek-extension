// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activateLocale } from '../../lib/i18n';
import { createChipInput } from './chips';

// Nothing renders before a locale is active: the widgets read the shared
// Lingui instance rather than taking a translator.
beforeEach(() => activateLocale('en'));

function mount(tags: string[] = [], suggest = async () => [] as string[]) {
  const host = document.createElement('div');
  document.body.append(host);
  const onSubmit = vi.fn();
  const chips = createChipInput(host, { tags, suggest, onSubmit });
  const input = host.querySelector('input')!;
  return { host, chips, input, onSubmit };
}

function press(input: HTMLInputElement, key: string): void {
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );
}

describe('createChipInput', () => {
  it('commits what was typed when a comma is pressed', () => {
    const { chips, input } = mount();
    input.value = 'watches';
    press(input, ',');
    expect(chips.tags()).toEqual(['watches']);
    expect(input.value).toBe('');
  });

  it('commits what was typed on the right arrow', () => {
    const { chips, input } = mount();
    input.value = 'diving';
    press(input, 'ArrowRight');
    expect(chips.tags()).toEqual(['diving']);
  });

  it('leaves the right arrow alone when the caret is mid-word', () => {
    // Otherwise moving the caret would commit half a tag.
    const { chips, input } = mount();
    input.value = 'diving';
    input.setSelectionRange(2, 2);
    press(input, 'ArrowRight');
    expect(chips.tags()).toEqual([]);
  });

  it('submits on Enter when there is nothing to commit', () => {
    const { input, onSubmit } = mount();
    press(input, 'Enter');
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('commits what was typed and then submits on Enter', () => {
    // Submitting while silently dropping what somebody just typed is the
    // wrong trade.
    const { chips, input, onSubmit } = mount();
    input.value = 'watches';
    press(input, 'Enter');
    expect(chips.tags()).toEqual(['watches']);
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('removes the last chip on backspace in an empty input', () => {
    const { chips, input } = mount(['diving', 'watches']);
    press(input, 'Backspace');
    expect(chips.tags()).toEqual(['diving']);
  });

  it('keeps the chip when backspace has text to delete instead', () => {
    const { chips, input } = mount(['diving']);
    input.value = 'wa';
    press(input, 'Backspace');
    expect(chips.tags()).toEqual(['diving']);
  });

  it('removes a chip when its × is clicked', () => {
    const { host, chips } = mount(['diving', 'watches']);
    host.querySelectorAll<HTMLButtonElement>('.chip button')[0]!.click();
    expect(chips.tags()).toEqual(['watches']);
  });

  it('takes the highlighted suggestion on Enter, and does not submit', async () => {
    const suggest = async () => ['waterproofing', 'watch-straps'];
    const { chips, input, onSubmit } = mount([], suggest);
    input.value = 'wat';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() =>
      expect(document.querySelectorAll('.suggestion').length).toBe(2),
    );

    press(input, 'ArrowDown');
    press(input, 'Enter');
    expect(chips.tags()).toEqual(['waterproofing']);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('asks for a tag in the language that is active', () => {
    activateLocale('sl');
    const { input } = mount();
    activateLocale('en');

    expect(input.placeholder).toBe('Dodaj oznako');
  });
});
