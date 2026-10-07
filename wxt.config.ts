import { defineConfig } from 'wxt';
import { lingui } from '@lingui/vite-plugin';

// The colour icon set for the toolbar button, keyed by the manifest field
// the hook below writes it into (`action` on MV3, `browser_action` on
// MV2).
const defaultIcon = {
  16: 'icon/16.png',
  32: 'icon/32.png',
  48: 'icon/48.png',
  128: 'icon/128.png',
};

export default defineConfig({
  srcDir: 'src',
  // PROTOTYPE: compiles src/locales/*.po on import, so the .po files are
  // the only catalogue in the tree and nothing compiled is committed.
  // This is the whole build-side cost of Lingui without macros — one
  // plugin, no Babel, no change to how anything else is bundled.
  vite: () => ({ plugins: [lingui()] }),
  // WXT's publicDir default is `<root>/public`, unaffected by srcDir — it
  // must be set explicitly so `src/public` (icons, static assets) is
  // copied into the build.
  publicDir: 'src/public',
  manifest: ({ browser, manifestVersion, mode }) => ({
    name: 'Hrček',
    description: 'Save links to your Hrček',
    permissions: [
      'activeTab',
      'storage',
      // Two items on the toolbar button's own menu — the waiting list and
      // Sync now. Firefox takes `contextMenus` as an alias of `menus`.
      'contextMenus',
      // The saved-state badge needs each tab's address to decide whether
      // that page is already held. `activeTab` only reveals a tab's URL
      // after a user gesture toward the extension on that specific tab;
      // `tabs` grants `url`/`title`/`favIconUrl` for every tab, with no
      // additional host access, which is exactly what tabs.onActivated
      // and tabs.onUpdated need to paint the icon while browsing normally.
      'tabs',
      // e2e builds talk to the fake server without the optional-permission
      // dance (Playwright cannot click native permission prompts). MV2 has
      // no separate host_permissions key, so the origins go here.
      ...(mode === 'e2e' && manifestVersion === 2
        ? ['http://localhost/*', 'http://127.0.0.1/*']
        : []),
      // MV3 needs this to inject at all. MV2 reaches the same thing
      // through tabs.executeScript, which activeTab already covers.
      ...(manifestVersion === 3 ? ['scripting'] : []),
    ],
    ...(mode === 'e2e' && manifestVersion === 3
      ? { host_permissions: ['http://localhost/*', 'http://127.0.0.1/*'] }
      : {}),
    // The server URL is user-configured, so its origin is requested at
    // runtime (options page). The manifest only declares it requestable.
    ...(manifestVersion === 2
      ? { optional_permissions: ['<all_urls>'] }
      : { optional_host_permissions: ['<all_urls>'] }),
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            // Final AMO id: valid and unique, and fine to ship as-is.
            // Can still change right up to the first AMO upload — after
            // that, never.
            gecko: { id: 'hrcek@markos.gaivo.net' },
          },
        }
      : {}),
  }),
  hooks: {
    // A plain `manifest: { action: { default_icon } }` (rung one of the
    // browser ladder) is not enough: on MV2, WXT's popup-entrypoint
    // handling writes straight to `browser_action` while building the
    // manifest, and WXT's own action->browser_action fallback then no-ops
    // because `browser_action` already exists — so a static config value
    // would be silently dropped on Firefox specifically. This hook is
    // still rung one (pure `wxt.config.ts` config, no per-browser code):
    // it re-applies default_icon after entrypoints are added but before
    // WXT finalizes the manifest, onto whichever key (`action` for MV3,
    // `browser_action` for MV2) this build actually uses.
    'build:manifestGenerated': (wxt, manifest) => {
      const target =
        wxt.config.manifestVersion === 2
          ? (manifest.browser_action ??= {})
          : (manifest.action ??= {});
      target.default_icon = defaultIcon;
    },
  },
});
