import { browser } from 'wxt/browser';
import { isAuthFailure } from '../lib/api/errors';
import { badgeForAnswer, isSaveable, planBadge } from '../lib/badge';
import { clientFromSettings } from '../lib/client-factory';
import { i18n } from '@lingui/core';
import { type BadgeTitle } from '../lib/badge';
import { activateLocale, localeFor } from '../lib/i18n';
import { setIcon, setTitle } from '../lib/icon';
import { sessionStore } from '../lib/platform/session-store';
import { loadExisting } from '../lib/save';
import { createSavedState, type Answer } from '../lib/saved-state';
import { isConfigured, loadSettings } from '../lib/settings';

/** Long enough that flicking through tabs costs one request, not ten. */
const LOOKUP_DELAY_MS = 400;

activateLocale(null);

/** Re-read whenever settings change: the language may have changed too. */
async function refreshLanguage(): Promise<void> {
  const settings = await loadSettings();
  activateLocale(settings?.language ?? null);
}

/**
 * The tooltip for a decision that deliberately carries no English. Both
 * messages are literals here so the extractor can find them; `badge.ts`
 * only says which one.
 */
function toolbarTitle(title: BadgeTitle): string {
  return title === 'signInAgain' ? i18n._('Hrček: sign in again') : i18n._('Hrček');
}

const savedState = createSavedState({
  look: async (url) => {
    const settings = await loadSettings();
    if (!isConfigured(settings)) throw new Error('not configured');
    return (
      (await loadExisting(
        clientFromSettings(settings, localeFor(settings.language)),
        url,
      )) !== null
    );
  },
  now: () => Date.now(),
  isUnauthorized: isAuthFailure,
  // Chrome's MV3 worker dies after 30 seconds idle; without this it
  // re-asks the server about every tab it has already asked about.
  store: sessionStore('saved-state'),
});

let pending: ReturnType<typeof setTimeout> | undefined;

/**
 * The toolbar button's resting state, with no tab in mind. Painted once at
 * start and again whenever settings change, so a window whose tabs fire
 * neither onActivated nor onUpdated still shows something other than the
 * manifest's default colour icon.
 */
async function paintGlobal(): Promise<void> {
  await setIcon(isConfigured(await loadSettings()) ? 'configured' : 'unconfigured');
}

/**
 * Wiring only: what to show is `planBadge`'s to decide, in `lib/badge.ts`
 * where it can be tested. `known` carries an answer that needs no
 * request — the save this repaint is confirming.
 */
async function paint(
  tabId: number,
  url: string | undefined,
  known?: Answer,
): Promise<void> {
  const settings = await loadSettings();
  const plan = planBadge({ settings, url, known });
  await setIcon(plan.icon, tabId);
  await setTitle(toolbarTitle(plan.title), tabId);
  if (!plan.ask || !isSaveable(url)) return;

  clearTimeout(pending);
  pending = setTimeout(() => {
    void savedState.get(url).then(async (answer) => {
      const settled = badgeForAnswer(answer);
      await setIcon(settled.icon, tabId);
      await setTitle(toolbarTitle(settled.title), tabId);
    });
  }, LOOKUP_DELAY_MS);
}

export default defineBackground(() => {
  void refreshLanguage();
  void paintGlobal();

  browser.tabs.onActivated.addListener(({ tabId }) => {
    void browser.tabs.get(tabId).then(
      (tab) => paint(tabId, tab.url),
      () => undefined,
    );
  });

  browser.tabs.onUpdated.addListener((tabId, changes, tab) => {
    // Only when the address changed or the page finished arriving; every
    // other update is noise.
    if (changes.url === undefined && changes.status !== 'complete') return;
    void paint(tabId, tab.url);
  });

  // The popup says so the moment it saves, rather than waiting for a
  // lookup to expire.
  browser.runtime.onMessage.addListener((message: unknown) => {
    const saved = message as { type?: string; url?: string; held?: boolean };
    if (saved.type !== 'hrcek:saved' || saved.url === undefined) return undefined;
    const url = saved.url;
    const held = saved.held ?? true;
    savedState.mark(url, held);
    // Repaint with the address the message carried, not a freshly-queried
    // tab.url — they can differ (trailing slash, www., case), and the
    // point is to reflect the entry that was just marked. The answer
    // travels with it: this repaint must say so even with the indicator
    // off, and it costs no request to do it.
    void browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id !== undefined) void paint(tab.id, url, held ? 'held' : 'not-held');
    });
    return undefined;
  });

  browser.storage.local.onChanged.addListener((changes) => {
    if (!('settings' in changes)) return;
    // A new token deserves a fresh ask, and the language may have
    // changed with it.
    savedState.reset();
    void refreshLanguage().then(() => {
      void paintGlobal();
      void browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (tab?.id !== undefined) void paint(tab.id, tab.url);
      });
    });
  });
});
