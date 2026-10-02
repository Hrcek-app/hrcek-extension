import type { IconState } from './icon';
import type { Answer } from './saved-state';
import { isConfigured, type Settings } from './settings';

/**
 * Which tooltip, said as a name rather than as words. The decision below
 * knows no language; the entrypoint turns one of these into a message.
 * Deliberately not the message itself — messages are extracted from
 * literals at their call sites, and a decision function is not a place
 * where English belongs.
 */
export type BadgeTitle = 'name' | 'signInAgain';

/** What the toolbar should show, and whether the server still needs asking. */
export interface BadgePlan {
  icon: IconState;
  title: BadgeTitle;
  /** True when this address is worth a lookup; false when it is not. */
  ask: boolean;
}

/** Nothing to save on about:, chrome:// or a file the browser is rendering. */
export function isSaveable(url: string | undefined): url is string {
  return url !== undefined && (url.startsWith('http://') || url.startsWith('https://'));
}

/** The toolbar for an answer already in hand. */
export function badgeForAnswer(answer: Answer): Omit<BadgePlan, 'ask'> {
  // Grey, like unconfigured — because in every way that matters it is:
  // nothing works until there is a new token. The tooltip says which of
  // the two it is.
  if (answer === 'unauthorized') {
    return { icon: 'unconfigured', title: 'signInAgain' };
  }
  // 'unknown' keeps the plain hamster: "we could not ask" is not "you
  // have not saved it".
  return { icon: answer === 'held' ? 'saved' : 'configured', title: 'name' };
}

/**
 * The whole toolbar decision, in one place and with nothing to mock: the
 * background entrypoint is wiring around this.
 *
 * The title is set on every branch, not only the lookup one — a tab
 * badged "sign in again" that navigates to a PDF must stop saying so.
 */
export function planBadge(input: {
  settings: Settings | null;
  url: string | undefined;
  /** An answer needing no request — the save just made, say. */
  known?: Answer;
}): BadgePlan {
  const { settings, url, known } = input;
  if (!isConfigured(settings)) {
    return { icon: 'unconfigured', title: 'name', ask: false };
  }
  // Shown whatever the indicator setting says. That setting governs
  // asking the server about pages you visit; it was never about hiding
  // what you just did yourself — and with a page that cannot host a
  // toast, this tick is the only confirmation a save has.
  if (known !== undefined) return { ...badgeForAnswer(known), ask: false };
  if (!settings.showSavedState || !isSaveable(url)) {
    return { icon: 'configured', title: 'name', ask: false };
  }
  // Colour until proven ticked. A failed lookup leaves it here: "we
  // could not ask" is not "you have not saved it".
  return { icon: 'configured', title: 'name', ask: true };
}
