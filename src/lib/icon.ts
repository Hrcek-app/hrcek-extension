import { toolbarAction } from './platform/action';

/** What the toolbar button is saying right now. */
export type IconState = 'unconfigured' | 'configured' | 'saved';

const SIZES = [16, 32, 48, 128] as const;

const PREFIX: Record<IconState, string> = {
  unconfigured: 'grey-',
  configured: '',
  saved: 'saved-',
};

export function iconPaths(state: IconState): Record<number, string> {
  const paths: Record<number, string> = {};
  for (const size of SIZES) paths[size] = `icon/${PREFIX[state]}${size}.png`;
  return paths;
}

/**
 * Setting an icon can fail for reasons nothing can be done about — the
 * tab closed between the lookup and the answer, most often. A toolbar
 * that did not repaint is not worth an unhandled rejection.
 */
export async function setIcon(state: IconState, tabId?: number): Promise<void> {
  try {
    await toolbarAction().setIcon({
      path: iconPaths(state),
      ...(tabId === undefined ? {} : { tabId }),
    });
  } catch {
    // The tab is gone. Nothing to repaint.
  }
}

/**
 * The button's tooltip — the only text a toolbar button has, and so the
 * only place a refused token can say so without a notification.
 */
export async function setTitle(title: string, tabId?: number): Promise<void> {
  try {
    await toolbarAction().setTitle({
      title,
      ...(tabId === undefined ? {} : { tabId }),
    });
  } catch {
    // The tab is gone. Nothing to name.
  }
}

/** The theme's accent, so the count reads as the extension's own. */
const BADGE_COLOUR = '#234e9c';

/**
 * The waiting count, on every tab at once. Global on purpose: the queue
 * belongs to no page. Like the icon, a refusal is not worth a rejection.
 */
export async function setBadge(text: string): Promise<void> {
  try {
    await toolbarAction().setBadgeBackgroundColor({ color: BADGE_COLOUR });
    await toolbarAction().setBadgeText({ text });
  } catch {
    // Nothing to do about it.
  }
}
