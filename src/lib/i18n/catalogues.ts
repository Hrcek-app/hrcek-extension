import type { Messages } from '@lingui/core';
import { messages as en } from '../../locales/en.po';
import { messages as sl } from '../../locales/sl.po';

export const DEFAULT_LOCALE = 'en';

/**
 * The compiled catalogues, keyed by locale. `@lingui/vite-plugin` turns
 * each .po into this on import; nothing compiled is committed.
 *
 * Loaded statically rather than on demand, which a dynamic import would
 * allow: the background is a classic script on both targets — MV3 declares
 * no `type: module` and MV2 uses `scripts` — and a service worker cannot
 * dynamic-import at all. Two small catalogues in every entry is the price,
 * and it keeps rendering synchronous. Worth revisiting at the fifth
 * language, not the second.
 */
export const CATALOGUES: Record<string, Messages> = { en, sl };

/**
 * What each language calls itself. The only naming that helps somebody
 * who has landed in a language they cannot read.
 */
export const LOCALE_NAMES: Record<string, string> = {
  en: 'English',
  sl: 'Slovenščina',
};
