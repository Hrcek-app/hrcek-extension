import { describe, expect, it } from 'vitest';
import { badgeForAnswer, isSaveable, planBadge } from './badge';
import type { Settings } from './settings';

function settings(over: Partial<Settings> = {}): Settings {
  return {
    serverUrl: 'https://hrcek.test',
    token: 'hrcek_t',
    showSavedState: true,
    language: null,
    ...over,
  };
}

describe('isSaveable', () => {
  it('takes http and https and nothing else', () => {
    expect(isSaveable('https://example.com/a')).toBe(true);
    expect(isSaveable('http://example.com/a')).toBe(true);
    expect(isSaveable('chrome://extensions')).toBe(false);
    expect(isSaveable('about:blank')).toBe(false);
    expect(isSaveable(undefined)).toBe(false);
  });
});

describe('planBadge', () => {
  it('greys out when there is no settings at all', () => {
    expect(planBadge({ settings: null, url: 'https://example.com/a' })).toEqual({
      icon: 'unconfigured',
      title: 'name',
      ask: false,
    });
  });

  it('greys out when a server address was saved before a token', () => {
    // The documented first-run order. Not a refused token, and the
    // tooltip must not claim one.
    const plan = planBadge({
      settings: settings({ token: null }),
      url: 'https://example.com/a',
    });
    expect(plan).toEqual({ icon: 'unconfigured', title: 'name', ask: false });
  });

  it('asks about an ordinary page when the indicator is on', () => {
    expect(planBadge({ settings: settings(), url: 'https://example.com/a' })).toEqual({
      icon: 'configured',
      title: 'name',
      ask: true,
    });
  });

  it('asks nothing about a page there is nothing to save on', () => {
    const plan = planBadge({ settings: settings(), url: 'chrome://extensions' });
    expect(plan.ask).toBe(false);
    expect(plan.icon).toBe('configured');
  });

  it('asks nothing at all when the indicator is off', () => {
    // The privacy choice: no request about a page merely visited.
    const plan = planBadge({
      settings: settings({ showSavedState: false }),
      url: 'https://example.com/a',
    });
    expect(plan.ask).toBe(false);
    expect(plan.icon).toBe('configured');
  });

  it('ticks for a save it was handed, even with the indicator off', () => {
    // On a page that cannot host a toast — a PDF, the Web Store — this
    // tick is the only confirmation the save has. It needs no request:
    // the answer came with the message that asked for the repaint.
    const plan = planBadge({
      settings: settings({ showSavedState: false }),
      url: 'https://example.com/a.pdf',
      known: 'held',
    });
    expect(plan).toEqual({ icon: 'saved', title: 'name', ask: false });
  });

  it('names the button on every branch, so no tooltip goes stale', () => {
    // A tab badged "sign in again" that moves to a PDF, or whose owner
    // switches the indicator off, must stop saying so.
    for (const plan of [
      planBadge({ settings: null, url: 'https://example.com/a' }),
      planBadge({ settings: settings(), url: 'about:blank' }),
      planBadge({ settings: settings({ showSavedState: false }), url: 'https://e.test' }),
      planBadge({ settings: settings(), url: 'https://e.test' }),
    ]) {
      expect(plan.title).toBe('name');
    }
  });
});

describe('badgeForAnswer', () => {
  it('ticks a held address', () => {
    expect(badgeForAnswer('held')).toEqual({ icon: 'saved', title: 'name' });
  });

  it('leaves the plain hamster for one that is not held', () => {
    expect(badgeForAnswer('not-held')).toEqual({
      icon: 'configured',
      title: 'name',
    });
  });

  it('abstains rather than guessing when the question could not be asked', () => {
    expect(badgeForAnswer('unknown')).toEqual({
      icon: 'configured',
      title: 'name',
    });
  });

  it('greys out and says so when the token was refused', () => {
    expect(badgeForAnswer('unauthorized')).toEqual({
      icon: 'unconfigured',
      title: 'signInAgain',
    });
  });
});
