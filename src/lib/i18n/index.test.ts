import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { availableLocales, resolveLocale } from './index';
import { LOCALE_NAMES } from './catalogues';

describe('resolveLocale', () => {
  const available = ['en', 'sl'];

  it('takes the chosen language when there is a catalogue for it', () => {
    expect(resolveLocale('sl', 'en-GB', available)).toBe('sl');
  });

  it('falls back to the browser when the choice has no catalogue', () => {
    // A language typed into storage by hand, or one dropped in a later
    // version. The browser's own locale is the better guess.
    expect(resolveLocale('de', 'sl', available)).toBe('sl');
  });

  it('matches the browser locale by its base tag', () => {
    expect(resolveLocale(null, 'sl-SI', available)).toBe('sl');
  });

  it('prefers an exact match over the base tag', () => {
    expect(resolveLocale(null, 'sl-SI', ['en', 'sl-SI', 'sl'])).toBe('sl-SI');
  });

  it('answers English when nothing else fits', () => {
    expect(resolveLocale(null, 'fi', available)).toBe('en');
    expect(resolveLocale(null, '', available)).toBe('en');
  });
});

describe('the catalogues', () => {
  it('name every language in its own words', () => {
    for (const locale of availableLocales()) {
      expect(LOCALE_NAMES[locale]).toBeTruthy();
    }
  });

  it('leave nothing untranslated', () => {
    // `lingui extract` reports this as a count; this fails the build on
    // it. Deliberately strict: the catalogue is small, every message has
    // a translation today, and a half-Slovenian interface reads worse
    // than an English one. Relax it the day a language lands in pieces.
    const source = readFileSync('src/locales/sl.po', 'utf8');
    const untranslated = [...source.matchAll(/^msgid (".+")\nmsgstr ""$/gm)].map(
      (match) => match[1],
    );

    expect(untranslated, `untranslated in sl.po: ${untranslated.join(', ')}`).toEqual([]);
  });
});
