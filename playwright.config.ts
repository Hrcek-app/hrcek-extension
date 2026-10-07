import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  // One fake Hrček serves every spec, and its outage and reset switches are
  // global, so specs must not run at the same time.
  workers: 1,
  // e2e specs must not be picked up by vitest (vitest.config.ts excludes tests/e2e).
  webServer: {
    // node directly, not `pnpm tsx`: the wrapper chain (pnpm -> sh -> node)
    // swallows the termination signal, leaving the real server orphaned on
    // the port and `playwright test` waiting on a process that never dies.
    command: 'node --import tsx tests/fake-hrcek/main.ts',
    port: 8787,
    reuseExistingServer: !process.env.CI,
  },
});
