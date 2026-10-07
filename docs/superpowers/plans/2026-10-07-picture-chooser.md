# Picture chooser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the popup's 4-tile picture picker with an "Include picture" checkbox, a selected-picture row with a Change button, and a full-popup chooser overlay.

**Architecture:** A DOM-free state model (`popup/picture-state.ts`) owns every selection rule and maps onto the existing `PictureChoice`. Two thin views render it: the form row (`popup/picture-row.ts`) and the chooser overlay (`popup/picture-overlay.ts`). `popup/main.ts` wires them in place of `popup/picker.ts`, which is deleted. Nothing in `lib/` changes.

**Tech Stack:** TypeScript, WXT, Vitest + jsdom, Playwright (Chromium), Lingui (`i18n._` with English ids, `.po` catalogues).

**Spec:** `docs/superpowers/specs/2026-10-07-picture-chooser-design.md`

## Global Constraints

- `src/lib/` never imports from `src/entrypoints/`. The new files live in `src/entrypoints/popup/` and import only types from `lib/`.
- `PictureChoice`, `fetchPictureBytes`, `attachPicture`, `submitSave` are unchanged.
- Untrusted addresses: pictures are drawn by creating elements and assigning `src` as a property — never interpolated into markup. The new views build everything with `createElement`/`textContent`; no `innerHTML` with data.
- Messages are `i18n._('<English text>')` literals; never a message held in a variable. After adding messages, run `pnpm exec lingui extract --clean` and fill every new `msgstr` in `src/locales/sl.po` — a test fails on any untranslated message.
- Popup width stays 440px (`body` in `popup/style.css`). While the chooser is open the body is 580px tall (under both browsers' 600px cap).
- Unit tests are colocated (`*.test.ts` next to the source), start with `// @vitest-environment jsdom` when they touch the DOM, and call `activateLocale('en')` in `beforeEach`.
- Commits: conventional prefix (`feat:`, `test:`…), **no `Co-Authored-By` or other AI trailers**. Never `--no-verify`; the pre-commit hook runs `pnpm typecheck`, `pnpm lint`, `pnpm test`.
- Delivery: two stacked PRs. PR 1 = Tasks 1–3 (new, unused modules) on `picture-chooser-1-views`; PR 2 = Task 4 (wiring, removal, e2e) on `picture-chooser-2-wiring`, based on PR 1.

## Review Focus

1. **Unticking then reticking on a saved entry with a held picture** — must return to `unchanged`, never `none` (a person who changes their mind must not lose the picture). Pinned in Task 1.
2. **Held picture is the only picture (page offers nothing)** — the row shows checkbox + placeholder/picture, no Change; unticking yields `none`. Pinned in Tasks 1 and 2.
3. **Arrow keys at either end of the strip** — the selection stops, it does not wrap or go undefined. Pinned in Tasks 1 and 3.
4. **Closing the chooser twice / Escape after Close** — the overlay and the `choosing` body class are removed exactly once and `onClose` fires once. Pinned in Task 3.
5. **A candidate address containing `"` or markup** — stays an inert `src`, in the row, the preview and the tile. Pinned in Tasks 2 and 3.

---

### Task 1: Picture state model

**Files:**

- Create: `src/entrypoints/popup/picture-state.ts`
- Test: `src/entrypoints/popup/picture-state.test.ts`

**Interfaces:**

- Consumes: `Candidate` from `src/lib/page/candidates.ts` (`{ url, width, height, fromHead }`); `PictureChoice` from `src/lib/picture.ts` (`{kind:'unchanged'} | {kind:'none'} | {kind:'url', url}`).
- Produces (later tasks rely on these exact names):

  ```ts
  export interface HeldPicture {
    src: string | null;
  }
  export interface PictureStateOptions {
    candidates: Candidate[];
    held: HeldPicture | null;
    existing: boolean;
  }
  export interface PictureItem {
    key: string;
    src: string | null;
    held: boolean;
  }
  export interface PictureState {
    readonly items: readonly PictureItem[];
    included(): boolean;
    setIncluded(included: boolean): void;
    selected(): PictureItem | null;
    select(key: string): void;
    step(delta: -1 | 1): void;
    canChange(): boolean;
    choice(): PictureChoice;
  }
  export function createPictureState(options: PictureStateOptions): PictureState;
  ```

- [ ] **Step 1: Write the failing tests**

`src/entrypoints/popup/picture-state.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/entrypoints/popup/picture-state.test.ts`
Expected: FAIL — cannot resolve `./picture-state`.

- [ ] **Step 3: Implement**

`src/entrypoints/popup/picture-state.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/entrypoints/popup/picture-state.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/entrypoints/popup/picture-state.ts src/entrypoints/popup/picture-state.test.ts
git commit -m "feat: model the picture choice without the DOM"
```

---

### Task 2: Picture row in the form

**Files:**

- Create: `src/entrypoints/popup/picture-row.ts`
- Test: `src/entrypoints/popup/picture-row.test.ts`
- Modify: `src/entrypoints/popup/style.css` (append the row's rules)
- Modify: `src/locales/en.po`, `src/locales/sl.po` (via extract, then translate)

**Interfaces:**

- Consumes: `createPictureState`, `PictureState`, `PictureItem` from Task 1.
- Produces:

  ```ts
  export interface PictureRow {
    refresh(): void;
  }
  export function createPictureRow(
    host: HTMLElement,
    state: PictureState,
    openChooser: () => void,
  ): PictureRow;
  /** An <img> for the item, or a placeholder that says it cannot be shown. */
  export function pictureImage(item: PictureItem, className: string): HTMLElement;
  ```

  DOM contract (Task 4 and e2e rely on it): checkbox `#include-picture`; picture `.picture-preview` (`img.picture-preview` or `div.picture-preview.unshowable`); button `#change-picture`. Host is left empty when `state.items` is empty.

- [ ] **Step 1: Write the failing tests**

`src/entrypoints/popup/picture-row.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/entrypoints/popup/picture-row.test.ts`
Expected: FAIL — cannot resolve `./picture-row`.

- [ ] **Step 3: Implement**

`src/entrypoints/popup/picture-row.ts`:

```ts
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
```

Append to `src/entrypoints/popup/style.css`:

```css
/* The picture row. The checkbox sits inside its label, so the theme's
   block label is undone here. */
.picture-include {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-weight: 400;
  font-size: 0.8125rem;
  margin: 0;
}
.picture-body {
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
  margin-top: 0.35rem;
}
.picture-preview {
  flex: 1;
  min-width: 0;
  height: 7rem;
  object-fit: contain;
  background: var(--raised);
  border: 1px solid var(--edge);
  border-radius: var(--radius);
}
.picture-preview.unshowable {
  display: grid;
  place-items: center;
  padding: 0.5rem;
  text-align: center;
  font-size: 0.75rem;
  color: var(--muted);
  border-style: dashed;
}
#change-picture {
  flex: none;
}
```

- [ ] **Step 4: Extract and translate the new messages**

Add the extract script CLAUDE.md documents but `package.json` lacks — in `package.json` `"scripts"`, after `"refresh-schema"`:

```json
    "i18n:extract": "lingui extract --clean",
```

Run: `pnpm i18n:extract`

`--clean` drops messages no longer in the code; none are dropped yet (`picker.ts` still exists). Then in `src/locales/sl.po` fill the new entries:

```po
msgid "Include picture"
msgstr "Vključi sliko"

msgid "Change"
msgstr "Zamenjaj"
```

(`It has a picture that cannot be shown here` is already translated; extract only adds this file to its `#:` references.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/entrypoints/popup/picture-row.test.ts src/lib/i18n`
Expected: PASS, including "leave nothing untranslated".

- [ ] **Step 6: Commit**

```bash
git add package.json src/entrypoints/popup/picture-row.ts src/entrypoints/popup/picture-row.test.ts src/entrypoints/popup/style.css src/locales/en.po src/locales/sl.po
git commit -m "feat: an include-picture row with a way into the chooser"
```

---

### Task 3: Chooser overlay

**Files:**

- Create: `src/entrypoints/popup/picture-overlay.ts`
- Test: `src/entrypoints/popup/picture-overlay.test.ts`
- Modify: `src/entrypoints/popup/style.css` (append the chooser's rules)
- Modify: `src/locales/en.po`, `src/locales/sl.po`

**Interfaces:**

- Consumes: `PictureState` (Task 1); `pictureImage(item, className)` from `./picture-row` (Task 2).
- Produces:

  ```ts
  export function stripEnds(
    scrollLeft: number,
    scrollWidth: number,
    clientWidth: number,
  ): { atStart: boolean; atEnd: boolean };
  export function openPictureChooser(state: PictureState, onClose: () => void): void;
  ```

  DOM contract (e2e relies on it): overlay `.chooser` appended to `document.body`, which gets class `choosing` while open; preview button `.chooser-preview` containing `.chooser-image` and caption `.chooser-caption`; tiles `.chooser-tile` (selected one has `.on` and `aria-pressed="true"`; held one contains `.chooser-current`); steps `.chooser-step`; close button `.chooser-close`.

- [ ] **Step 1: Write the failing tests**

`src/entrypoints/popup/picture-overlay.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/entrypoints/popup/picture-overlay.test.ts`
Expected: FAIL — cannot resolve `./picture-overlay`.

- [ ] **Step 3: Implement**

`src/entrypoints/popup/picture-overlay.ts`:

```ts
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
```

Append to `src/entrypoints/popup/style.css`:

```css
/* Choosing a picture takes over the whole popup. A popup is as tall as
   its content, so the body is made tall while the chooser is open;
   580px stays under both browsers' 600px cap. */
body.choosing {
  height: 580px;
  overflow: hidden;
}
.chooser {
  position: fixed;
  inset: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem;
  background: var(--surface);
}
.chooser-preview {
  position: relative;
  flex: 1;
  min-height: 0;
  display: grid;
  place-items: center;
  padding: 0;
  overflow: hidden;
  background: var(--raised);
  border: 2px solid var(--accent);
  border-radius: var(--radius);
}
.chooser-preview:hover {
  background: var(--raised);
}
.chooser-image {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.chooser-image.unshowable {
  display: grid;
  place-items: center;
  padding: 1rem;
  color: var(--muted);
  font-weight: 400;
}
.chooser-caption {
  position: absolute;
  top: 0.5rem;
  left: 0.5rem;
  padding: 0.1rem 0.5rem;
  border-radius: 99px;
  font-size: 0.75rem;
  color: var(--accent-ink);
  background: var(--accent);
}
.chooser-strip {
  flex: none;
  display: flex;
  align-items: center;
  gap: 0.3rem;
}
.chooser-tiles {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 0.4rem;
  padding: 3px;
  overflow-x: auto;
  scroll-snap-type: x proximity;
  scrollbar-width: thin;
}
.chooser-tile {
  position: relative;
  flex: none;
  width: 4.5rem;
  height: 4.5rem;
  padding: 0;
  overflow: hidden;
  scroll-snap-align: start;
  background: var(--raised);
  border: 1px solid var(--edge);
  border-radius: 0.3rem;
}
.chooser-tile:hover {
  background: var(--raised);
}
.chooser-tile img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.chooser-tile.unshowable {
  border-style: dashed;
}
.chooser-tile.on {
  outline: 3px solid var(--accent);
  outline-offset: -3px;
}
.chooser-current {
  position: absolute;
  inset-inline: 0;
  bottom: 0;
  font-size: 0.625rem;
  font-weight: 400;
  text-align: center;
  color: #fff;
  background: rgb(0 0 0 / 0.6);
}
.chooser-step {
  flex: none;
  width: 1.4rem;
  height: 1.4rem;
  padding: 0;
  font-size: 0.75rem;
  line-height: 1;
  border-radius: 99px;
}
.chooser-step:disabled {
  opacity: 0.35;
  cursor: default;
}
.chooser-close {
  align-self: flex-end;
}
```

- [ ] **Step 4: Extract and translate**

Run: `pnpm i18n:extract`

Fill in `src/locales/sl.po` (the three already-translated messages — `Earlier pictures`, `More pictures`, `The picture it has` — only gain a reference):

```po
msgid "Choose a picture"
msgstr "Izberi sliko"

msgid "Use this picture"
msgstr "Uporabi to sliko"

msgid "Selected"
msgstr "Izbrano"

msgid "Picture {number} of {total}"
msgstr "Slika {number} od {total}"

msgid "current"
msgstr "trenutna"

msgid "Close"
msgstr "Zapri"
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/entrypoints/popup/picture-overlay.test.ts src/lib/i18n`
Expected: PASS.

- [ ] **Step 6: Full gate, commit, open PR 1**

Run: `pnpm typecheck && pnpm lint && pnpm test` — all pass.

```bash
git add src/entrypoints/popup/picture-overlay.ts src/entrypoints/popup/picture-overlay.test.ts src/entrypoints/popup/style.css src/locales/en.po src/locales/sl.po
git commit -m "feat: a full-popup chooser for the picture"
```

Push `picture-chooser-1-views` and open PR 1 against `main`: the new state model and views, not yet wired in.

---

### Task 4: Wire the chooser into the popup, retire the picker

**Files:**

- Modify: `src/entrypoints/popup/main.ts` (imports ~line 20; module state ~lines 46–53; `seededCandidates` ~lines 107–118; `renderForm` ~lines 290–325; `save` ~lines 351–356 and ~line 388)
- Delete: `src/entrypoints/popup/picker.ts`, `src/entrypoints/popup/picker.test.ts`
- Modify: `src/entrypoints/popup/style.css` (delete the old picker rules: `.hero`, `.hero.empty`, `.strip`, `.strip .tiles`, `.tile*`, `.step`, `.expand` — roughly lines 131–203)
- Modify: `tests/e2e/save-flow.spec.ts` (tests at ~lines 345 and 385; add two)
- Modify: `src/locales/en.po`, `src/locales/sl.po` (extract drops the old picker's messages)

**Interfaces:**

- Consumes: `createPictureState`, `HeldPicture`, `PictureState` (Task 1); `createPictureRow` (Task 2); `openPictureChooser` (Task 3). DOM contracts from Tasks 2 and 3.
- Produces: nothing new for other tasks.

- [ ] **Step 1: Write the failing e2e tests**

In `tests/e2e/save-flow.spec.ts`, add after the `heldEntry` helper:

```ts
/**
 * The JSON body of the next entry POST the popup sends. The fake stores
 * every picture at the same serving address, so this is where the
 * address actually chosen can be seen.
 */
function nextEntryPost(popup: Page): Promise<Record<string, unknown>> {
  return popup
    .waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/api/entries/'),
    )
    .then((request) => request.postDataJSON() as Record<string, unknown>);
}

/**
 * Opens the popup seeded with several page pictures. `<img>` loads get a
 * real picture; the popup's own fetch of the bytes is refused, as it is
 * for any picture on a host the extension cannot read — so the save
 * carries `image_url` and the choice is visible on the wire.
 */
async function openPopupWithPictures(
  context: BrowserContext,
  extensionId: string,
  url: string,
  pictures: string[],
): Promise<Page> {
  const popup = await context.newPage();
  await popup.route('https://pictures.example.com/**', (route) =>
    route.request().resourceType() === 'image'
      ? route.fulfill({ path: 'src/public/icon/128.png', contentType: 'image/png' })
      : route.abort('failed'),
  );
  const query = new URLSearchParams({ url, title: 'Pictures' });
  for (const picture of pictures) query.append('candidate', picture);
  await popup.goto(`chrome-extension://${extensionId}/popup.html?${query}`);
  return popup;
}

const PICTURES = [
  'https://pictures.example.com/one.jpg',
  'https://pictures.example.com/two.jpg',
  'https://pictures.example.com/three.jpg',
];
```

Add these tests:

```ts
test('chooses another picture in the chooser and saves that one', async ({
  context,
  extensionId,
}) => {
  await configureToken(context, extensionId);
  const popup = await openPopupWithPictures(
    context,
    extensionId,
    'https://example.com/gallery',
    PICTURES,
  );

  // Proposed without being asked: the page's first picture, ticked.
  await expect(popup.locator('#include-picture')).toBeChecked();
  await expect(popup.locator('img.picture-preview')).toHaveAttribute('src', PICTURES[0]!);

  await popup.click('#change-picture');
  await expect(popup.locator('.chooser')).toBeVisible();
  await expect(popup.locator('.chooser-caption')).toHaveText('Selected');
  await popup.locator('.chooser-tile').nth(1).click();
  await expect(popup.locator('img.chooser-image')).toHaveAttribute('src', PICTURES[1]!);
  await popup.click('.chooser-close');
  await expect(popup.locator('.chooser')).toHaveCount(0);
  await expect(popup.locator('img.picture-preview')).toHaveAttribute('src', PICTURES[1]!);

  const posted = nextEntryPost(popup);
  await popup.click('#save');
  expect((await posted)['image_url']).toBe(PICTURES[1]);
  await expect(popup.locator('#status')).toContainText('Saved.');
});

test('a click on the large picture confirms it', async ({ context, extensionId }) => {
  await configureToken(context, extensionId);
  const popup = await openPopupWithPictures(
    context,
    extensionId,
    'https://example.com/gallery-click',
    PICTURES,
  );

  await popup.click('#change-picture');
  await popup.locator('.chooser-tile').nth(2).click();
  await popup.click('.chooser-preview');
  await expect(popup.locator('.chooser')).toHaveCount(0);

  const posted = nextEntryPost(popup);
  await popup.click('#save');
  expect((await posted)['image_url']).toBe(PICTURES[2]);
});

test('unticking Include picture saves without one', async ({ context, extensionId }) => {
  await configureToken(context, extensionId);
  const address = 'https://example.com/plain';
  const popup = await openPopupWithPictures(context, extensionId, address, PICTURES);

  await popup.uncheck('#include-picture');
  await expect(popup.locator('.picture-preview')).toHaveCount(0);
  await expect(popup.locator('#change-picture')).toHaveCount(0);

  const posted = nextEntryPost(popup);
  await popup.click('#save');
  expect(await posted).not.toHaveProperty('image_url');
  await expect(popup.locator('#status')).toContainText('Saved.');
  expect((await heldEntry(address)).image).toBeNull();
});
```

In the test `shows the picture an entry already holds, fetched with the token`, change the locator:

```ts
const held = popup.locator('img.picture-preview');
```

Replace the whole test `previews pictures while you click through them, and puts the preview away when you move on` with:

```ts
test('removes the picture an entry holds when Include picture is unticked', async ({
  context,
  extensionId,
}) => {
  await configureToken(context, extensionId);
  const address = 'https://example.com/browsable';
  await fetch(`${SERVER}/api/entries/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${FAKE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: address,
      title: 'Browsable',
      image_url: 'https://cdn.example.com/cover.jpg',
    }),
  });

  const popup = await openPopup(context, extensionId, address, 'ignored');

  // A held picture is a choice already made: ticked, shown, and no Change
  // when the page offers nothing else.
  await expect(popup.locator('#include-picture')).toBeChecked();
  await expect(popup.locator('img.picture-preview')).toHaveAttribute('src', /^blob:/);
  await expect(popup.locator('#change-picture')).toHaveCount(0);

  // A change of mind and back keeps it…
  await popup.uncheck('#include-picture');
  await popup.check('#include-picture');
  await expect(popup.locator('img.picture-preview')).toHaveAttribute('src', /^blob:/);

  // …and unticking for good removes it.
  await popup.uncheck('#include-picture');
  await popup.click('#save');
  await expect(popup.locator('#status')).toContainText('Updated.');
  expect((await heldEntry(address)).image).toBeNull();
});
```

- [ ] **Step 2: Run e2e to verify the new tests fail**

Run: `pnpm test:e2e`
Expected: the three new tests and the updated held-picture tests FAIL (no `#include-picture`, `#change-picture`; only one candidate is seeded).

- [ ] **Step 3: Wire up `main.ts`**

Imports — replace

```ts
import { createPicker, type HeldPicture, type Picker } from './picker';
```

with

```ts
import { createPictureState, type HeldPicture, type PictureState } from './picture-state';
import { createPictureRow } from './picture-row';
import { openPictureChooser } from './picture-overlay';
```

Module state — replace

```ts
/** The mounted picture picker; remounted by every renderForm() call. */
let picker: Picker | null = null;
```

with

```ts
/** What the picture row and chooser decided; rebuilt by every renderForm() call. */
let pictures: PictureState | null = null;
```

`seededCandidates` — accept several, so e2e can offer a choice:

```ts
function seededCandidates(): Candidate[] | null {
  if (import.meta.env.MODE === 'e2e') {
    const seeded = new URLSearchParams(window.location.search).getAll('candidate');
    // Shaped like head declarations, which is what a page most often
    // offers: no dimensions to be had until something loads them.
    if (seeded.length > 0) {
      return seeded.map((url) => ({ url, width: 0, height: 0, fromHead: true }));
    }
  }
  return null;
}
```

`renderForm` — replace

```ts
const pictureHost = document.querySelector<HTMLDivElement>('#picture')!;
picker = createPicker(pictureHost, { candidates, held, existing });
// The row is absent, not empty, when the page offered nothing.
if (pictureHost.innerHTML === '') {
  document.querySelector<HTMLDivElement>('#picture-field')!.hidden = true;
}
```

with

```ts
const pictureHost = document.querySelector<HTMLDivElement>('#picture')!;
const state = createPictureState({ candidates, held, existing });
pictures = state;
const row = createPictureRow(pictureHost, state, () =>
  openPictureChooser(state, () => {
    row.refresh();
    // Back where they left from.
    document.querySelector<HTMLButtonElement>('#change-picture')?.focus();
  }),
);
// The row is absent, not empty, when the page offered nothing.
if (state.items.length === 0) {
  document.querySelector<HTMLDivElement>('#picture-field')!.hidden = true;
}
```

Delete the `focusin` listener and its comment block in `renderForm` (the block beginning `// Attached here, once per rendered form, rather than inside the picker:` through `picker?.collapse();\n  });`). Keep the `submit` listener.

In `save()`, delete the opening comment and call:

```ts
// Said here rather than on the form's submit event so that both ways in
// — the button and Enter in the tag field — put the preview away. Not
// every browser focuses a button that was clicked, so focusin alone
// would miss it.
picker?.collapse();
```

and replace

```ts
const choice = picker?.choice() ?? { kind: 'unchanged' as const };
```

with

```ts
const choice = pictures?.choice() ?? { kind: 'unchanged' as const };
```

- [ ] **Step 4: Delete the old picker and its styles**

```bash
git rm src/entrypoints/popup/picker.ts src/entrypoints/popup/picker.test.ts
```

In `src/entrypoints/popup/style.css`, delete the rules `.hero`, `.hero.empty`, `.strip`, `.strip .tiles`, `.tile`, `.tile img`, `.tile.unshowable` (with its comment), `.tile.on`, `.tile:hover`, `.step, .expand`, `.step:disabled`. Confirm nothing else uses them:

Run: `grep -rnE "\b(hero|strip|tile|expand|step)\b" src/entrypoints/popup --include=*.ts`
Expected: only `chooser-…` class names and `state.step`.

- [ ] **Step 5: Drop the retired messages**

Run: `pnpm i18n:extract`
Expected: `--clean` removes `No picture`, `Declared by the page`, `From the page`, `Show the picture larger`, `kept`, `none` from both catalogues. Check with `git diff src/locales` that only those went and nothing still in use did.

- [ ] **Step 6: Run everything**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS.

Run: `pnpm test:e2e`
Expected: PASS, including the three new tests.

- [ ] **Step 7: Manual check in Firefox and Chrome**

`pnpm dev` (Firefox) and `pnpm dev:chrome`, on a page with several pictures (e.g. a news article):

- the popup grows to ~580px on Change and shrinks back on Close;
- the strip fills the width and scrolls; ‹ › scroll by a strip width and disable at the ends;
- Escape in the chooser: note whether it closes only the chooser or the whole popup, in each browser. If Chrome closes the popup, record that in the PR description — the spec says Escape is then not promised there.

- [ ] **Step 8: Commit and open PR 2**

```bash
git add src/entrypoints/popup/main.ts src/entrypoints/popup/style.css tests/e2e/save-flow.spec.ts src/locales/en.po src/locales/sl.po
git commit -m "feat: choose the picture in a full-popup chooser"
```

Push `picture-chooser-2-wiring` and open PR 2 against `picture-chooser-1-views`, with the manual-check notes from Step 7.
