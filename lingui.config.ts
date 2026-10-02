import { defineConfig } from '@lingui/cli';
import { formatter } from '@lingui/format-po';

/**
 * PROTOTYPE. Only the options page is wired to Lingui; the popup and the
 * background still use src/lib/i18n. See docs/reports/… for the comparison.
 *
 * Catalogues are PO: the English and its translation sit on adjacent
 * lines, with the source location above them, which is the whole point of
 * trying this.
 */
export default defineConfig({
  sourceLocale: 'en',
  locales: ['en', 'sl'],
  catalogs: [
    {
      path: '<rootDir>/src/locales/{locale}',
      include: ['src'],
    },
  ],
  // The line numbers in `#:` references churn on every edit and say little
  // in a catalogue this size; the file path alone is enough to find a
  // message.
  // `explicitIdAsDefault` is what makes the English text the id. Without
  // it Lingui hashes each message into something like "2P1Vhw", which only
  // works if a build-time macro rewrites the call sites to use that hash —
  // precisely the macro this option exists to avoid.
  format: formatter({ lineNumbers: false, explicitIdAsDefault: true }),
});
