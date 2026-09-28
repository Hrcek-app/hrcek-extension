import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The toast renders inside a shadow root, which inherits no stylesheet, so
 * it repeats the theme's colours as literals instead of reading the
 * tokens. That copy is invisible to anyone editing the palette: when the
 * website changed its accent, `theme.css` needed three edits and the toast
 * needed none — and nothing would have said so had the answer been
 * different.
 *
 * So: every colour the toast draws itself with must be a colour the theme
 * actually defines. A token edited in one place and not the other leaves
 * the toast holding a value `theme.css` no longer contains, and this fails.
 */
const THEME = readFileSync('src/lib/ui/theme.css', 'utf8');
const TOAST = readFileSync('src/entrypoints/toast.ts', 'utf8');

function hexColours(source: string): string[] {
  return [...source.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) =>
    match[0].toLowerCase(),
  );
}

describe('the toast’s inlined palette', () => {
  it('uses only colours the theme defines', () => {
    const defined = new Set(hexColours(THEME));
    const strays = [...new Set(hexColours(TOAST))].filter(
      (colour) => !defined.has(colour),
    );

    expect(strays, `not in src/lib/ui/theme.css: ${strays.join(', ')}`).toEqual([]);
  });

  it('draws with more than one colour, so the check above has something to check', () => {
    // Guards the guard: a toast that stopped using literals — or a regex
    // that stopped matching them — would otherwise pass silently.
    expect(new Set(hexColours(TOAST)).size).toBeGreaterThan(3);
  });
});
