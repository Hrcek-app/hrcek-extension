import { i18n } from '@lingui/core';
import { addTag, normalizeTag, removeTag, suggestionsFor } from '../../lib/tags';

export interface ChipOptions {
  tags: string[];
  /** Answers the labels beginning with `prefix`; may reject, and then offers none. */
  suggest(prefix: string): Promise<string[]>;
  onSubmit(): void;
}

export interface ChipInput {
  tags(): string[];
}

/** As long as a lookup can take before typing starts to feel watched. */
const SUGGEST_DELAY_MS = 200;

function escapeAttribute(value: string): string {
  const node = document.createElement('span');
  node.textContent = value;
  return node.innerHTML.replaceAll('"', '&quot;');
}

export function createChipInput(host: HTMLElement, options: ChipOptions): ChipInput {
  let tags = [...options.tags];
  let suggestions: string[] = [];
  let highlighted = -1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Rising counter, so a slow answer cannot overwrite a newer one. */
  let generation = 0;

  host.className = 'chips-host';
  host.innerHTML = `
    <div class="chips"><input class="chip-input" placeholder="${escapeAttribute(i18n._('Add a tag'))}" autocomplete="off" /></div>
    <div class="suggestions" hidden></div>
  `;
  const box = host.querySelector<HTMLDivElement>('.chips')!;
  const input = host.querySelector<HTMLInputElement>('.chip-input')!;
  const menu = host.querySelector<HTMLDivElement>('.suggestions')!;

  function renderChips(): void {
    for (const chip of box.querySelectorAll('.chip')) chip.remove();
    for (const tag of tags) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = tag;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', i18n._('Remove {tag}', { tag }));
      remove.addEventListener('click', () => {
        tags = removeTag(tags, tag);
        renderChips();
        input.focus();
      });
      chip.append(remove);
      box.insertBefore(chip, input);
    }
  }

  function renderSuggestions(): void {
    menu.innerHTML = '';
    menu.hidden = suggestions.length === 0;
    suggestions.forEach((name, index) => {
      const row = document.createElement('div');
      row.className = index === highlighted ? 'suggestion on' : 'suggestion';
      row.textContent = name;
      row.addEventListener('mousedown', (event) => {
        // mousedown, not click: the input must not lose focus first.
        event.preventDefault();
        commit(name);
      });
      menu.append(row);
    });
  }

  function clearSuggestions(): void {
    suggestions = [];
    highlighted = -1;
    renderSuggestions();
  }

  function commit(raw: string): boolean {
    const before = tags.length;
    tags = addTag(tags, raw);
    input.value = '';
    clearSuggestions();
    renderChips();
    return tags.length > before;
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const prefix = normalizeTag(input.value);
    if (prefix.length === 0) {
      clearSuggestions();
      return;
    }
    const mine = ++generation;
    timer = setTimeout(() => {
      void options.suggest(prefix).then(
        (labels) => {
          if (mine !== generation) return;
          // Never offer one the entry already carries: the duplicate is
          // prevented by absence rather than by a refusal afterwards.
          suggestions = suggestionsFor(labels, tags);
          highlighted = -1;
          renderSuggestions();
        },
        (error: unknown) => {
          // Suggestions are a convenience. Typing still works without
          // them, so this is for the console, not for the person.
          console.warn('[hrcek] could not read label suggestions', error);
          if (mine === generation) clearSuggestions();
        },
      );
    }, SUGGEST_DELAY_MS);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (suggestions.length === 0) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      highlighted = (highlighted + step + suggestions.length) % suggestions.length;
      renderSuggestions();
      return;
    }

    if (event.key === 'Escape') {
      clearSuggestions();
      return;
    }

    if (event.key === ',') {
      event.preventDefault();
      commit(input.value);
      return;
    }

    if (event.key === 'ArrowRight') {
      // Only at the very end, or moving the caret would commit half a tag.
      const atEnd =
        input.selectionStart === input.value.length &&
        input.selectionStart === input.selectionEnd;
      if (!atEnd || input.value.length === 0) return;
      event.preventDefault();
      commit(input.value);
      return;
    }

    if (event.key === 'Backspace') {
      if (input.value.length > 0 || tags.length === 0) return;
      event.preventDefault();
      tags = tags.slice(0, -1);
      renderChips();
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      if (highlighted >= 0) {
        // Taking a suggestion is the whole gesture; it does not also save.
        commit(suggestions[highlighted]!);
        return;
      }
      // Anything typed but not committed is kept before submitting —
      // submitting and dropping it silently is the wrong trade.
      if (normalizeTag(input.value).length > 0) commit(input.value);
      options.onSubmit();
    }
  });

  input.addEventListener('blur', () => {
    // Leaving the field is as good as a comma: what was typed is meant.
    if (normalizeTag(input.value).length > 0) commit(input.value);
    clearSuggestions();
  });

  renderChips();
  return { tags: () => [...tags] };
}
