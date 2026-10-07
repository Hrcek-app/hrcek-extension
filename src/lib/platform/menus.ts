/**
 * The context naming the toolbar button. Rung two of the browser ladder:
 * the manifest version is a build-time constant, passed in so this stays
 * testable.
 */
export function toolbarMenuContext(manifestVersion: number): 'action' | 'browser_action' {
  return manifestVersion === 3 ? 'action' : 'browser_action';
}
