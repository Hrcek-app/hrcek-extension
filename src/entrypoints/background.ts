import { browser } from 'wxt/browser';
import { HrcekApiError, isAuthFailure } from '../lib/api/errors';
import { badgeForAnswer, isSaveable, planBadge } from '../lib/badge';
import { clientFromSettings } from '../lib/client-factory';
import { i18n } from '@lingui/core';
import { type BadgeTitle } from '../lib/badge';
import { activateLocale, localeFor } from '../lib/i18n';
import { setBadge, setIcon, setTitle } from '../lib/icon';
import { pendingBadgeText } from '../lib/offline/keep';
import { openQueue } from '../lib/offline/queue';
import { createRunner } from '../lib/offline/runner';
import { canReplace, sendQueued, syncQueue, type SyncResult } from '../lib/offline/sync';
import { isUnavailable } from '../lib/offline/unavailable';
import { toolbarMenuContext } from '../lib/platform/menus';
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

const queue = openQueue();
const MENU_PENDING = 'hrcek-pending';
const MENU_SYNC = 'hrcek-sync';

/** Tells every open extension page; nobody listening is not an error. */
function broadcast(message: unknown): void {
  void browser.runtime.sendMessage(message).catch(() => undefined);
}

/** The badge and the menu label follow the queue. */
async function paintPending(): Promise<void> {
  const count = await queue.count().catch(() => 0);
  await setBadge(pendingBadgeText(count));
  try {
    await browser.contextMenus.update(MENU_PENDING, {
      title: i18n._('Waiting to sync ({count})…', { count }),
    });
  } catch {
    // The menu is created at start; an update racing it is harmless.
  }
}

async function syncOnce(): Promise<SyncResult | null> {
  const settings = await loadSettings();
  if (!isConfigured(settings)) return null;
  const client = clientFromSettings(settings, localeFor(settings.language));
  const result = await syncQueue(client, queue, settings.serverUrl);
  if (result.stopped === 'unauthorized') {
    await setIcon('unconfigured');
    await setTitle(toolbarTitle('signInAgain'));
  }
  return result;
}

const runner = createRunner(async () => {
  const result = await syncOnce().catch((error: unknown) => {
    console.warn('[hrcek] sync failed', error);
    return null;
  });
  await paintPending();
  broadcast({ type: 'hrcek:synced', result });
  return result;
});

type ReplaceAnswer =
  { ok: true } | { ok: false; unavailable: boolean; message: string | null };

/** "Replace with mine": sends a held copy as it is, over Hrček's. */
function replace(url: string): Promise<ReplaceAnswer> {
  return runner.exclusive(async () => {
    try {
      const settings = await loadSettings();
      const entry = await queue.get(url);
      if (!isConfigured(settings) || entry === null) return { ok: true } as const;
      if (!canReplace(entry, settings.serverUrl))
        return { ok: false, unavailable: false, message: null } as const;
      const client = clientFromSettings(settings, localeFor(settings.language));
      await sendQueued(client, entry);
      await queue.remove(url, entry.savedAt);
      savedState.mark(url, true);
      return { ok: true } as const;
    } catch (error) {
      return {
        ok: false,
        unavailable: isUnavailable(error),
        message: error instanceof HrcekApiError ? error.message : null,
      } as const;
    } finally {
      await paintPending();
      broadcast({ type: 'hrcek:synced', result: null });
    }
  });
}

function createMenus(): void {
  const contexts: [ReturnType<typeof toolbarMenuContext>] = [
    toolbarMenuContext(import.meta.env.MANIFEST_VERSION),
  ];
  void browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({
      id: MENU_PENDING,
      title: i18n._('Waiting to sync ({count})…', { count: 0 }),
      contexts,
    });
    browser.contextMenus.create({ id: MENU_SYNC, title: i18n._('Sync now'), contexts });
    void paintPending();
  });
}

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

  createMenus();

  browser.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId === MENU_PENDING) {
      void browser.tabs.create({
        url: browser.runtime.getURL('/pending.html'),
      });
    } else if (info.menuItemId === MENU_SYNC) {
      void runner.sync();
    }
  });

  // sendResponse plus `return true`, not a returned promise: Chrome does
  // not take a promise from an onMessage listener everywhere.
  browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const asked = message as { type?: string; url?: string };
    if (asked.type === 'hrcek:sync') {
      void runner.sync().then(sendResponse);
      return true;
    }
    if (asked.type === 'hrcek:replace' && asked.url !== undefined) {
      void replace(asked.url).then(sendResponse);
      return true;
    }
    if (asked.type === 'hrcek:queue-changed') void paintPending();
    return undefined;
  });

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
      createMenus();
      void paintGlobal();
      void browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (tab?.id !== undefined) void paint(tab.id, tab.url);
      });
    });
  });
});
