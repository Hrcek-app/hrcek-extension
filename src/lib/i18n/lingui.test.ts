import { setupI18n } from '@lingui/core';
import { describe, expect, it } from 'vitest';
import { messages as en } from '../../locales/en.po';
import { messages as sl } from '../../locales/sl.po';

/**
 * PROTOTYPE (see the Lingui note). Two things are being judged here, and
 * neither is file format.
 *
 * One: plural forms. Slovenian needs four where English needs two, and
 * our own catalogue cannot express that at all — it can only interpolate,
 * so "2 vnosa" would come out as "2 vnosov" or worse. ICU gets it right,
 * and the .po carries the rule in its header.
 *
 * Two: that a .po compiles and runs inside this build at all — the import
 * below goes through @lingui/vite-plugin.
 */
function slovenian() {
  const i18n = setupI18n();
  i18n.loadAndActivate({ locale: 'sl', messages: sl });
  return i18n;
}

describe('Lingui, in this build', () => {
  it('declines Slovenian through all four forms', () => {
    const i18n = slovenian();
    // Written out at each call rather than held in a constant: the
    // extractor reads literals, so a message behind a variable never
    // reaches the catalogue. That constraint is the price of extraction.
    const entries = '{count, plural, one {# entry} other {# entries}}';

    expect(i18n._(entries, { count: 1 })).toBe('1 vnos');
    expect(i18n._(entries, { count: 2 })).toBe('2 vnosa');
    expect(i18n._(entries, { count: 3 })).toBe('3 vnosi');
    expect(i18n._(entries, { count: 5 })).toBe('5 vnosov');
  });

  it('keeps English to its two forms from the same source string', () => {
    const i18n = setupI18n();
    i18n.loadAndActivate({ locale: 'en', messages: en });

    expect(i18n._('{count, plural, one {# entry} other {# entries}}', { count: 1 })).toBe(
      '1 entry',
    );
    expect(i18n._('{count, plural, one {# entry} other {# entries}}', { count: 2 })).toBe(
      '2 entries',
    );
  });

  it('translates with the English text as the id', () => {
    expect(slovenian()._('Settings')).toBe('Nastavitve');
  });

  it('substitutes named placeholders', () => {
    expect(slovenian()._('Connected as {email}.', { email: 'nina@example.com' })).toBe(
      'Povezani kot nina@example.com.',
    );
  });

  it('falls back to the English id when a translation is missing', () => {
    // The id IS the English, so a gap in a catalogue degrades to English
    // without any fallback wiring — the same behaviour our own catalogue
    // has, for free.
    const i18n = setupI18n();
    i18n.loadAndActivate({ locale: 'sl', messages: {} });

    expect(i18n._('Server address')).toBe('Server address');
  });
});
