import { browser } from 'wxt/browser';
import { clientFromSettings } from '../../lib/client-factory';
import { activateLocale } from '../../lib/i18n';
import { openQueue, type QueuedEntry } from '../../lib/offline/queue';
import type { SyncResult } from '../../lib/offline/sync';
import { loadExisting } from '../../lib/save';
import { isConfigured, loadSettings, type Settings } from '../../lib/settings';
import { createPendingView, type PendingDeps } from './view';
import '../../lib/ui/theme.css';
import './style.css';

const queue = openQueue();
let settings: Settings | null = null;
let locale = activateLocale(null);
/** Object URLs handed to <img>s, revoked on every redraw. */
let pictureUrls: string[] = [];

function pictureSrc(picture: QueuedEntry['picture']): string | null {
  if (picture === null) return null;
  if (picture.kind === 'url') return picture.url;
  const src = URL.createObjectURL(picture.blob);
  pictureUrls.push(src);
  return src;
}

async function serverPicture(
  image: Parameters<PendingDeps['serverPicture']>[0],
): Promise<string | null> {
  if (image === null || !isConfigured(settings)) return null;
  try {
    const blob = await clientFromSettings(settings, locale).fetchImage(image.url);
    const src = URL.createObjectURL(blob);
    pictureUrls.push(src);
    return src;
  } catch {
    return null;
  }
}

let view: ReturnType<typeof createPendingView> | null = null;

function mount(): ReturnType<typeof createPendingView> {
  return createPendingView(document.querySelector<HTMLElement>('#app')!, {
    list: () => {
      for (const src of pictureUrls) URL.revokeObjectURL(src);
      pictureUrls = [];
      return queue.list();
    },
    server: () => settings?.serverUrl ?? null,
    lookup: (url) => {
      if (!isConfigured(settings)) return Promise.resolve(null);
      return loadExisting(clientFromSettings(settings, locale), url);
    },
    remove: async (entry) => {
      await queue.remove(entry.request.url, entry.savedAt);
      void browser.runtime
        .sendMessage({ type: 'hrcek:queue-changed' })
        .catch(() => undefined);
    },
    replace: (url) => browser.runtime.sendMessage({ type: 'hrcek:replace', url }),
    sync: () =>
      browser.runtime.sendMessage({ type: 'hrcek:sync' }) as Promise<SyncResult | null>,
    open: (url) => void browser.tabs.create({ url }),
    pictureSrc,
    serverPicture,
  });
}

browser.runtime.onMessage.addListener((message: unknown) => {
  const told = message as { type?: string; result?: SyncResult | null };
  if (told.type === 'hrcek:synced') {
    if (told.result !== undefined && told.result !== null) view?.showResult(told.result);
    void view?.refresh();
  }
  return undefined;
});

void (async () => {
  settings = await loadSettings();
  locale = activateLocale(settings?.language ?? null);
  // Mounted only now, so the header speaks the chosen language.
  view = mount();
  await view.refresh();
})();
