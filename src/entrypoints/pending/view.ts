import { i18n } from '@lingui/core';
import { isUnavailable } from '../../lib/offline/unavailable';
import type { EntryOut } from '../../lib/api/types';
import type { QueuedEntry } from '../../lib/offline/queue';
import type { SyncResult } from '../../lib/offline/sync';

export interface PendingDeps {
  list(): Promise<QueuedEntry[]>;
  server(): string | null;
  lookup(url: string): Promise<EntryOut | null>;
  remove(entry: QueuedEntry): Promise<void>;
  replace(
    url: string,
  ): Promise<{ ok: true } | { ok: false; unavailable: boolean; message: string | null }>;
  sync(): Promise<SyncResult | null>;
  open(url: string): void;
  pictureSrc(picture: QueuedEntry['picture']): string | null;
  /** Hrček's own picture as something an <img> can show, or null. */
  serverPicture(image: EntryOut['image']): Promise<string | null>;
}

export interface PendingView {
  refresh(): Promise<void>;
  showResult(result: SyncResult | null): void;
}

/** Elements only, text by textContent: every string here is untrusted. */
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

/** Title, notes, tags, fields and picture of one version of an entry. */
function summary(
  className: string,
  heading: string,
  version: {
    title: string;
    notes: string;
    tags: string[];
    fields: Record<string, string>;
  },
  pictureSrc: string | null,
): HTMLElement {
  const box = element('div', className);
  box.append(element('h3', undefined, heading), element('p', 'title', version.title));
  if (version.notes !== '') box.append(element('p', 'notes', version.notes));
  if (version.tags.length > 0) box.append(element('p', 'tags', version.tags.join(', ')));
  for (const [name, value] of Object.entries(version.fields)) {
    if (value !== '') box.append(element('p', 'field', `${name}: ${value}`));
  }
  if (pictureSrc !== null) {
    const image = element('img', 'picture');
    image.src = pictureSrc;
    image.alt = '';
    box.append(image);
  }
  return box;
}

export function createPendingView(host: HTMLElement, deps: PendingDeps): PendingView {
  host.replaceChildren();
  const header = element('header');
  const count = element('span', undefined, '0');
  count.id = 'count';
  const heading = element('h1', undefined, i18n._('Waiting to sync'));
  heading.append(' ', count);
  const sync = button('', i18n._('Sync now'), () => {
    sync.disabled = true;
    void deps
      .sync()
      .then((result) => {
        showResult(result);
        return refresh();
      })
      .finally(() => {
        sync.disabled = false;
      });
  });
  sync.id = 'sync';
  const result = element('p', 'result');
  result.id = 'result';
  header.append(heading, sync, result);
  const list = element('div', 'entries');
  host.append(header, list);

  function showResult(outcome: SyncResult | null): void {
    const lines: string[] = [];
    if (outcome === null) {
      lines.push(i18n._('Hrček is not configured yet.'));
    } else if (outcome.stopped === 'unavailable') {
      lines.push(i18n._("Hrček can't be reached."));
    } else if (outcome.stopped === 'unauthorized') {
      lines.push(
        i18n._('Your Hrček no longer accepts this token. Make a new one in settings.'),
      );
    } else {
      if (outcome.saved > 0) {
        lines.push(
          i18n._('{count, plural, one {# entry saved.} other {# entries saved.}}', {
            count: outcome.saved,
          }),
        );
      }
      for (const title of outcome.withoutPicture) {
        lines.push(i18n._('Saved without its picture: {title}', { title }));
      }
      if (outcome.held > 0) {
        lines.push(
          i18n._(
            '{count, plural, one {# is already on Hrček and waits for your review.} other {# are already on Hrček and wait for your review.}}',
            { count: outcome.held },
          ),
        );
      }
    }
    result.textContent = lines.join(' ');
  }

  function deleteControls(entry: QueuedEntry): HTMLElement {
    const box = element('span', 'delete-controls');
    const ask = button('delete quiet', i18n._('Delete'), () => {
      const confirm = button('confirm-delete', i18n._('Delete for good'), () => {
        void deps.remove(entry).then(refresh);
      });
      const cancel = button('quiet', i18n._('Cancel'), () => box.replaceChildren(ask));
      box.replaceChildren(confirm, cancel);
    });
    box.append(ask);
    return box;
  }

  function openButton(entry: QueuedEntry): HTMLButtonElement {
    return button('open quiet', i18n._('Open page'), () => deps.open(entry.request.url));
  }

  function held(entry: QueuedEntry, article: HTMLElement): void {
    const compare = element('div', 'compare', i18n._('Loading what Hrček has…'));
    const keep = button('keep', i18n._("Keep what's on Hrček"), () => {
      void deps.remove(entry).then(refresh);
    });
    const replace = button('replace', i18n._('Replace with mine'), () => {
      keep.disabled = true;
      replace.disabled = true;
      void deps.replace(entry.request.url).then(async (answer) => {
        if (!answer.ok) {
          compare.append(
            element(
              'p',
              'trouble',
              answer.unavailable
                ? i18n._("Hrček can't be reached.")
                : (answer.message ?? i18n._('Something went wrong.')),
            ),
          );
          keep.disabled = false;
          replace.disabled = false;
          return;
        }
        await refresh();
      });
    });
    const actions = element('div', 'actions');
    actions.append(keep, replace, openButton(entry));
    article.append(compare, actions);

    void deps
      .lookup(entry.request.url)
      .then(async (server) => ({
        server,
        picture: server === null ? null : await deps.serverPicture(server.image),
      }))
      .then(
        ({ server, picture }) => {
          compare.replaceChildren();
          if (server === null) {
            compare.append(
              element('p', undefined, i18n._('Hrček no longer has this address.')),
            );
          } else {
            compare.append(summary('theirs', i18n._('On Hrček'), server, picture));
          }
          compare.append(
            summary(
              'mine',
              i18n._('Yours'),
              entry.request,
              deps.pictureSrc(entry.picture),
            ),
          );
        },
        (error: unknown) => {
          compare.replaceChildren(
            element(
              'p',
              'trouble',
              isUnavailable(error)
                ? i18n._("Hrček can't be reached, so what it has can't be shown.")
                : i18n._('Something went wrong.'),
            ),
          );
          keep.disabled = true;
          replace.disabled = true;
        },
      );
  }

  function render(entry: QueuedEntry): HTMLElement {
    const current = deps.server();
    const state = entry.server !== current ? 'elsewhere' : entry.state.kind;
    const article = element('article', 'pending-entry');
    article.dataset['state'] = state;
    article.append(
      element('h2', undefined, entry.request.title || entry.request.url),
      element('p', 'address', entry.request.url),
      element(
        'p',
        'saved-at',
        i18n._('Saved {when}', {
          when: new Date(entry.savedAt).toLocaleString(i18n.locale),
        }),
      ),
    );
    if (entry.request.tags.length > 0) {
      article.append(element('p', 'tags', entry.request.tags.join(', ')));
    }
    const src = deps.pictureSrc(entry.picture);
    if (src !== null && state !== 'held') {
      const image = element('img', 'picture');
      image.src = src;
      image.alt = '';
      article.append(image);
    }

    if (state === 'elsewhere') {
      article.append(
        element(
          'p',
          'trouble',
          i18n._('Saved for {server}, which is not the one in your settings.', {
            server: entry.server,
          }),
        ),
        deleteControls(entry),
      );
    } else if (state === 'held') {
      held(entry, article);
    } else if (entry.state.kind === 'refused') {
      article.append(
        element(
          'p',
          'trouble',
          i18n._('Hrček refused it: {reason}', { reason: entry.state.message }),
        ),
      );
      const actions = element('div', 'actions');
      actions.append(openButton(entry), deleteControls(entry));
      article.append(actions);
    } else {
      article.append(deleteControls(entry));
    }
    return article;
  }

  async function refresh(): Promise<void> {
    const entries = await deps.list();
    count.textContent = String(entries.length);
    list.replaceChildren(
      ...(entries.length === 0
        ? [element('p', 'empty', i18n._('Nothing is waiting.'))]
        : entries.map(render)),
    );
  }

  return { refresh, showResult };
}
