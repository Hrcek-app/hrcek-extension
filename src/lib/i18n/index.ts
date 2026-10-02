import { i18n } from '@lingui/core';
import { browser } from 'wxt/browser';
import { CATALOGUES, DEFAULT_LOCALE } from './catalogues';

export function availableLocales(): string[] {
  return Object.keys(CATALOGUES);
}

/**
 * The language to speak. A choice wins when there is a catalogue for it;
 * otherwise the browser's own locale, exactly and then by its base tag
 * ("sl-SI" is a Slovenian browser); otherwise English.
 */
export function resolveLocale(
  chosen: string | null,
  uiLocale: string,
  available: string[] = availableLocales(),
): string {
  if (chosen !== null && available.includes(chosen)) return chosen;
  if (available.includes(uiLocale)) return uiLocale;
  const base = uiLocale.split('-')[0] ?? '';
  if (available.includes(base)) return base;
  return DEFAULT_LOCALE;
}

/** The browser's own language, or English where it cannot be read. */
function uiLocale(): string {
  try {
    return browser.i18n.getUILanguage();
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** `resolveLocale` against this browser. The one call that needs an API. */
export function localeFor(chosen: string | null): string {
  return resolveLocale(chosen, uiLocale());
}

/**
 * Make a language current. Every context calls this once before it renders
 * anything, and again whenever the choice changes.
 *
 * Messages are looked up by their English text, so a message with no
 * translation falls back to its own id and renders in English — a missing
 * translation degrades word by word rather than emptying the interface.
 */
export function activateLocale(chosen: string | null): string {
  const locale = localeFor(chosen);
  i18n.loadAndActivate({ locale, messages: CATALOGUES[locale] ?? {} });
  return locale;
}
