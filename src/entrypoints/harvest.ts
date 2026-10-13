import type { RawCandidate } from '../lib/page/candidates';

/**
 * Reads the pictures this page offers. Injected on demand when the popup
 * opens, under activeTab — not registered, because the extension has no
 * business running on every page you load.
 *
 * It answers a message rather than a return value: MV2 and MV3 disagree
 * about what an injected file's result is. The message itself is not the
 * same on both browsers, though — see the listener at the bottom.
 */
const HEAD_SELECTORS = [
  'meta[property="og:image"]',
  'meta[property="og:image:secure_url"]',
  'meta[name="twitter:image"]',
  'meta[name="twitter:image:src"]',
  'link[rel="image_src"]',
  'meta[itemprop="image"]',
];

function absolute(raw: string | null): string | null {
  if (raw === null || raw.trim().length === 0) return null;
  try {
    return new URL(raw, document.baseURI).href;
  } catch {
    return null;
  }
}

function collect(): RawCandidate[] {
  const found: RawCandidate[] = [];

  for (const selector of HEAD_SELECTORS) {
    for (const node of document.querySelectorAll(selector)) {
      const url = absolute(node.getAttribute('content') ?? node.getAttribute('href'));
      // Size is unknown here, and the ranking knows not to hold that
      // against a head declaration.
      if (url !== null) found.push({ url, width: 0, height: 0, fromHead: true });
    }
  }

  for (const image of document.images) {
    const lazy = showsPlaceholder(image) ? absolute(lazySource(image)) : null;
    // currentSrc, so srcset and <picture> give what is actually shown.
    const url = lazy ?? absolute(image.currentSrc || image.src);
    if (url === null) continue;
    // naturalWidth is 0 for an image that has not loaded — a lazy one
    // below the fold — and a placeholder's size is not the picture's, so
    // the rendered box stands in.
    const width = (lazy === null && image.naturalWidth) || image.width;
    const height = (lazy === null && image.naturalHeight) || image.height;
    found.push({ url, width, height, fromHead: false });
  }

  return found;
}

/**
 * Whether a lazy loader may still be holding the real picture back:
 * nothing shown yet, an inline stand-in, or a blank pixel.
 */
function showsPlaceholder(image: HTMLImageElement): boolean {
  const shown = image.currentSrc || image.src;
  return (
    shown === '' ||
    shown.startsWith('data:') ||
    (image.naturalWidth <= 1 && image.naturalHeight <= 1)
  );
}

// The attributes the common lazy loaders keep the real address in.
const LAZY_SOURCES = ['data-src', 'data-lazy-src', 'data-original'];
const LAZY_SOURCE_SETS = ['data-srcset', 'data-lazy-srcset'];

function lazySource(image: HTMLImageElement): string | null {
  for (const name of LAZY_SOURCES) {
    const value = image.getAttribute(name);
    if (value !== null && value.trim().length > 0) return value;
  }
  for (const name of LAZY_SOURCE_SETS) {
    const value = image.getAttribute(name);
    if (value !== null) return largest(value);
  }
  return null;
}

/** The largest picture a srcset offers, by its w or x descriptor. */
function largest(srcset: string): string | null {
  let best: { url: string; size: number } | null = null;
  // Split only at a comma followed by space: an address may hold a comma.
  for (const entry of srcset.split(/,\s+/)) {
    const [url, descriptor = '1x'] = entry.trim().split(/\s+/);
    if (url === undefined || url.length === 0) continue;
    const size = Number.parseFloat(descriptor) || 1;
    if (best === null || size > best.size) best = { url, size };
  }
  return best?.url ?? null;
}

export default defineUnlistedScript(() => {
  const flag = '__hrcekHarvestReady';
  const scope = window as unknown as Record<string, unknown>;
  // Injected once per popup opening; a second injection must not add a
  // second listener, or every answer would arrive twice.
  if (scope[flag] === true) return;
  scope[flag] = true;

  browser.runtime.onMessage.addListener(
    (
      message: unknown,
      _sender: unknown,
      sendResponse: (response: { candidates: RawCandidate[] }) => void,
    ) => {
      // Not ours: answer undefined synchronously, which leaves the message
      // to whatever else is listening rather than swallowing it.
      if ((message as { type?: string }).type !== 'hrcek:harvest') return undefined;
      // sendResponse + `return true`, never a returned Promise. Answering
      // with a Promise is a Firefox (and webextension-polyfill) extra, and
      // WXT ships no polyfill: on Chrome the returned value is discarded,
      // the channel closes, and the caller is handed undefined. This form
      // works on both.
      sendResponse({ candidates: collect() });
      return true;
    },
  );
});
