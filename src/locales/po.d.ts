/** `@lingui/vite-plugin` compiles a .po import into a messages object. */
declare module '*.po' {
  import type { Messages } from '@lingui/core';
  export const messages: Messages;
}
