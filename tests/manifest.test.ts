import { describe, expect, it } from 'vitest';
import config from '../wxt.config';

type ManifestFn = (env: {
  browser: string;
  manifestVersion: 2 | 3;
  mode: string;
  command: 'build' | 'serve';
}) => Record<string, unknown>;

function manifestFor(browser: string, manifestVersion: 2 | 3): Record<string, unknown> {
  return (config.manifest as ManifestFn)({
    browser,
    manifestVersion,
    mode: 'production',
    command: 'build',
  });
}

describe('Firefox manifest', () => {
  const settings = manifestFor('firefox', 2).browser_specific_settings as Record<
    string,
    Record<string, unknown>
  >;
  const gecko = settings.gecko!;

  // AMO refuses a new listing without it, and Firefox shows it at install.
  // Every category here must match what docs/store/privacy.md says leaves
  // the browser.
  it('declares what leaves the browser', () => {
    expect(gecko.data_collection_permissions).toEqual({
      required: ['browsingActivity', 'websiteContent', 'authenticationInfo'],
    });
  });

  // Firefox only shows the consent prompt from 140 on; an older one would
  // install without asking.
  it('requires a Firefox that asks for that consent', () => {
    expect(gecko.strict_min_version).toBe('140.0');
  });

  it('requires a Firefox for Android that asks for it too', () => {
    expect(settings.gecko_android).toEqual({ strict_min_version: '142.0' });
  });
});

describe('Chrome manifest', () => {
  it('carries no Gecko settings', () => {
    expect(manifestFor('chrome', 3).browser_specific_settings).toBeUndefined();
  });
});
