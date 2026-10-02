import { defineConfig } from 'vitest/config';
import { lingui } from '@lingui/vite-plugin';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  // PROTOTYPE: WxtVitest does not carry over the plugins from
  // wxt.config.ts, so the .po compiler has to be named again here or every
  // test importing a catalogue fails parsing PO as JavaScript.
  plugins: [lingui(), WxtVitest()],
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
  },
});
