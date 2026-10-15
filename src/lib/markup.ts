/**
 * Building the popup and settings page from templates.
 *
 * Every value interpolated into a template goes through escapeText or
 * escapeAttribute first; the templates themselves are literals in the
 * entrypoints. setMarkup is the one place a template becomes nodes. It
 * parses into a separate, inert document rather than assigning
 * `innerHTML`, so nothing in the markup runs while it is parsed, and the
 * AMO linter's unsafe-assignment warning has a single, documented answer
 * instead of one per template.
 */

/** `value` as HTML text: it can only ever read as itself. */
export function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** `value` safe inside a double-quoted attribute. */
export function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;');
}

/** Replaces everything `host` holds with the nodes `markup` describes. */
export function setMarkup(host: Element, markup: string): void {
  const parsed = new DOMParser().parseFromString(markup, 'text/html');
  host.replaceChildren(...parsed.body.childNodes);
}
