import { describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { iconPaths, setBadge, setTitle } from './icon';

describe('iconPaths', () => {
  it('serves the plain hamster when configured but the page is not held', () => {
    expect(iconPaths('configured')).toEqual({
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    });
  });

  it('greys the hamster out when there is nothing configured', () => {
    expect(iconPaths('unconfigured')[16]).toBe('icon/grey-16.png');
  });

  it('ticks the hamster when the page is already held', () => {
    expect(iconPaths('saved')[128]).toBe('icon/saved-128.png');
  });
});

describe('setTitle', () => {
  it('names the button, so a refused token has somewhere to say so', async () => {
    // A tooltip is the only text a toolbar button has. Read back through
    // the fake's own getTitle rather than spying on setTitle — the fake
    // browser's action.setTitle is a real, stateful implementation here,
    // not a stub — which proves the title AND the tabId actually arrived.
    await setTitle('Hrček: sign in again', 7);
    expect(await fakeBrowser.action.getTitle({ tabId: 7 })).toBe('Hrček: sign in again');
    // Untouched: the call was scoped to tab 7, not the whole browser.
    expect(await fakeBrowser.action.getTitle({})).toBe('');
  });

  it('swallows a failure — a tab can close between the lookup and the answer', async () => {
    vi.spyOn(fakeBrowser.action, 'setTitle').mockRejectedValueOnce(new Error('gone'));
    await expect(setTitle('Hrček: sign in again', 7)).resolves.toBeUndefined();
  });
});

describe('setBadge', () => {
  it('sets the count for every tab at once', async () => {
    await setBadge('3');
    expect(await fakeBrowser.action.getBadgeText({})).toBe('3');
  });

  it('clears it with an empty string', async () => {
    await setBadge('3');
    await setBadge('');
    expect(await fakeBrowser.action.getBadgeText({})).toBe('');
  });

  it('swallows a failure', async () => {
    vi.spyOn(fakeBrowser.action, 'setBadgeText').mockRejectedValueOnce(new Error('gone'));
    await expect(setBadge('1')).resolves.toBeUndefined();
  });
});
