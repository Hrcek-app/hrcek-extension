// @vitest-environment jsdom
// Not colocated: every file directly under src/entrypoints/ is an
// entrypoint to WXT, so a harvest.test.ts beside harvest.ts would be
// built and shipped inside the zip.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import harvest from '../../src/entrypoints/harvest';
import type { RawCandidate } from '../../src/lib/page/candidates';

type Listener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => unknown;

/** Runs the injected script and hands back whatever it registered. */
function inject(): Listener[] {
  const listeners: Listener[] = [];
  vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener').mockImplementation(
    (listener: unknown) => {
      listeners.push(listener as Listener);
    },
  );
  harvest.main!();
  return listeners;
}

describe('the harvest script', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // The double-injection guard lives on the window, which jsdom keeps
    // for the whole file.
    delete (window as unknown as Record<string, unknown>)['__hrcekHarvestReady'];
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  it('answers with sendResponse and returns true, the one form both browsers understand', () => {
    // Chrome discards a Promise returned from onMessage: the channel
    // closes and the caller is handed undefined, which looks exactly like
    // a page with no pictures. This is the regression that hid the whole
    // picture feature on Chrome.
    document.head.innerHTML =
      '<meta property="og:image" content="https://example.com/og.jpg" />';
    const [listener] = inject();
    const sendResponse = vi.fn();

    const answer = listener!({ type: 'hrcek:harvest' }, {}, sendResponse);

    expect(answer).toBe(true);
    expect(sendResponse).toHaveBeenCalledTimes(1);
    const { candidates } = sendResponse.mock.calls[0]![0] as {
      candidates: RawCandidate[];
    };
    expect(candidates).toEqual([
      { url: 'https://example.com/og.jpg', width: 0, height: 0, fromHead: true },
    ]);
  });

  it('leaves a message of another type alone, answering undefined synchronously', () => {
    // Returning true here would hold the channel open for an answer that
    // never comes, and block whatever else is listening.
    const [listener] = inject();
    const sendResponse = vi.fn();

    expect(listener!({ type: 'something:else' }, {}, sendResponse)).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('adds one listener however often it is injected', () => {
    // The popup injects on every open; a second listener would answer
    // every message twice.
    const listeners = inject();
    harvest.main!();

    expect(listeners).toHaveLength(1);
  });

  describe('lazily loaded pictures', () => {
    /** The pictures the page offers, in the order the harvest found them. */
    function harvested(): RawCandidate[] {
      const [listener] = inject();
      const sendResponse = vi.fn();
      listener!({ type: 'hrcek:harvest' }, {}, sendResponse);
      return (sendResponse.mock.calls[0]![0] as { candidates: RawCandidate[] })
        .candidates;
    }

    /** jsdom never loads an image, so its natural size is set by hand. */
    function loaded(selector: string, width: number, height: number): void {
      const image = document.querySelector(selector)!;
      Object.defineProperty(image, 'naturalWidth', { value: width });
      Object.defineProperty(image, 'naturalHeight', { value: height });
    }

    const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

    it('offers the address a loader keeps in data-src while a placeholder is shown', () => {
      document.body.innerHTML = `<img src="${PLACEHOLDER}" data-src="/real.jpg" width="400" height="300">`;

      expect(harvested()).toEqual([
        {
          url: 'http://localhost:3000/real.jpg',
          width: 400,
          height: 300,
          fromHead: false,
        },
      ]);
    });

    it('reads data-lazy-src and data-original when there is no data-src', () => {
      document.body.innerHTML =
        '<img data-lazy-src="/a.jpg" width="200" height="200">' +
        '<img data-original="/b.jpg" width="200" height="200">';

      expect(harvested().map((c) => c.url)).toEqual([
        'http://localhost:3000/a.jpg',
        'http://localhost:3000/b.jpg',
      ]);
    });

    it('takes the largest picture of a data-srcset', () => {
      document.body.innerHTML =
        `<img src="${PLACEHOLDER}" data-srcset="/s.jpg 400w, /l.jpg 1600w, /m.jpg 800w" width="400" height="300">` +
        `<img data-lazy-srcset="/one.jpg 1x, /two.jpg 2x" width="400" height="300">`;

      expect(harvested().map((c) => c.url)).toEqual([
        'http://localhost:3000/l.jpg',
        'http://localhost:3000/two.jpg',
      ]);
    });

    it('sees past a blank picture a loader shows in the meantime', () => {
      document.body.innerHTML =
        '<img src="/blank.gif" data-src="/real.jpg" width="400" height="300">';
      loaded('img', 1, 1);

      expect(harvested()).toEqual([
        {
          url: 'http://localhost:3000/real.jpg',
          width: 400,
          height: 300,
          fromHead: false,
        },
      ]);
    });

    it('keeps a picture that has loaded, whatever its data-src says', () => {
      // srcset may have picked a sharper copy than the loader's own.
      document.body.innerHTML =
        '<img src="/shown.jpg" data-src="/small.jpg" width="400" height="300">';
      loaded('img', 1600, 1200);

      expect(harvested()).toEqual([
        {
          url: 'http://localhost:3000/shown.jpg',
          width: 1600,
          height: 1200,
          fromHead: false,
        },
      ]);
    });
  });
});
