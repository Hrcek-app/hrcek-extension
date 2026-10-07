import { browser } from 'wxt/browser';

/**
 * The toolbar button, whatever this manifest version calls it. MV3 has
 * `action`, MV2 has `browserAction`; the two carry the same `setIcon`,
 * so one interface covers both. Rung three of the browser ladder — a
 * build-time switch cannot help, because the object itself differs.
 */
interface ToolbarAction {
  setIcon(details: { path: Record<number, string>; tabId?: number }): Promise<void>;
  setTitle(details: { title: string; tabId?: number }): Promise<void>;
  setBadgeText(details: { text: string; tabId?: number }): Promise<void>;
  setBadgeBackgroundColor(details: { color: string; tabId?: number }): Promise<void>;
}

export function toolbarAction(): ToolbarAction {
  const api = browser as unknown as Record<string, ToolbarAction | undefined>;
  const action = api['action'] ?? api['browserAction'];
  if (action === undefined) throw new Error('No toolbar action API on this browser.');
  return action;
}
