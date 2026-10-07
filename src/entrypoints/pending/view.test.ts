// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HrcekNetworkError } from '../../lib/api/errors';
import type { EntryOut } from '../../lib/api/types';
import { activateLocale } from '../../lib/i18n';
import type { QueuedEntry, QueuedState } from '../../lib/offline/queue';
import { createPendingView, type PendingDeps } from './view';

beforeEach(() => activateLocale('en'));

const SERVER = 'https://hrcek.example.org';

function queued(
  url: string,
  state: QueuedState = { kind: 'waiting' },
  server = SERVER,
): QueuedEntry {
  return {
    request: { url, title: `Mine ${url}`, notes: 'my notes', tags: ['mine'], fields: {} },
    picture: null,
    savedAt: 1,
    server,
    state,
  };
}

function theirs(url: string): EntryOut {
  return {
    id: 1,
    url,
    title: 'Theirs',
    notes: 'their notes',
    tags: ['theirs'],
    fields: {},
    image: null,
    created_at: '',
    updated_at: '',
  } as EntryOut;
}

function mount(entries: QueuedEntry[], overrides: Partial<PendingDeps> = {}) {
  let list = [...entries];
  const deps: PendingDeps = {
    list: async () => list,
    server: () => SERVER,
    lookup: async (url) => theirs(url),
    remove: vi.fn(async (entry: QueuedEntry) => {
      list = list.filter((e) => e !== entry);
    }),
    replace: vi.fn(async (url: string) => {
      list = list.filter((e) => e.request.url !== url);
      return { ok: true as const };
    }),
    sync: vi.fn(async () => null),
    open: vi.fn(),
    pictureSrc: () => null,
    ...overrides,
  };
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const view = createPendingView(host, deps);
  return { host, deps, view };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createPendingView', () => {
  it('says nothing is waiting when nothing is', async () => {
    const { host, view } = mount([]);
    await view.refresh();
    expect(host.querySelector('.empty')!.textContent).toBe('Nothing is waiting.');
    expect(host.querySelector('#count')!.textContent).toBe('0');
  });

  it('lists a waiting entry with its title and address, inert', async () => {
    const hostile = queued('https://e.test/<img src=x onerror=alert(1)>');
    const { host, view } = mount([hostile]);
    await view.refresh();
    const article = host.querySelector('.pending-entry[data-state="waiting"]')!;
    expect(article.textContent).toContain('https://e.test/<img src=x onerror=alert(1)>');
    expect(host.querySelectorAll('[onerror]')).toHaveLength(0);
  });

  it('deletes only after a second, explicit confirmation', async () => {
    const entry = queued('https://e.test/a');
    const { host, deps, view } = mount([entry]);
    await view.refresh();
    host.querySelector<HTMLButtonElement>('.delete')!.click();
    expect(deps.remove).not.toHaveBeenCalled();
    host.querySelector<HTMLButtonElement>('.confirm-delete')!.click();
    await flush();
    expect(deps.remove).toHaveBeenCalledWith(entry);
    expect(host.querySelector('.empty')).not.toBeNull();
  });

  it('compares a held entry with what Hrček has, and keeps Hrček’s', async () => {
    const entry = queued('https://e.test/a', { kind: 'held' });
    const { host, deps, view } = mount([entry]);
    await view.refresh();
    await flush();
    expect(host.querySelector('.compare .theirs')!.textContent).toContain('Theirs');
    expect(host.querySelector('.compare .mine')!.textContent).toContain(
      'Mine https://e.test/a',
    );
    host.querySelector<HTMLButtonElement>('.keep')!.click();
    await flush();
    expect(deps.remove).toHaveBeenCalledWith(entry);
  });

  it('replaces Hrček’s entry with the queued copy on request', async () => {
    const { host, deps, view } = mount([queued('https://e.test/a', { kind: 'held' })]);
    await view.refresh();
    await flush();
    host.querySelector<HTMLButtonElement>('.replace')!.click();
    await flush();
    expect(deps.replace).toHaveBeenCalledWith('https://e.test/a');
  });

  it('disables keep and replace when Hrček cannot be reached to compare', async () => {
    const { host, view } = mount([queued('https://e.test/a', { kind: 'held' })], {
      lookup: async () => {
        throw new HrcekNetworkError('down');
      },
    });
    await view.refresh();
    await flush();
    expect(host.querySelector('.compare')!.textContent).toContain(
      "Hrček can't be reached",
    );
    expect(host.querySelector<HTMLButtonElement>('.keep')!.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('.replace')!.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('.open')!.disabled).toBe(false);
  });

  it('shows a refusal in the server’s words, with Open page', async () => {
    const { host, deps, view } = mount([
      queued('https://e.test/a', { kind: 'refused', message: 'Not valid, says Hrček.' }),
    ]);
    await view.refresh();
    expect(
      host.querySelector('.pending-entry[data-state="refused"]')!.textContent,
    ).toContain('Not valid, says Hrček.');
    host.querySelector<HTMLButtonElement>('.open')!.click();
    expect(deps.open).toHaveBeenCalledWith('https://e.test/a');
  });

  it('offers only Delete for an entry meant for another server', async () => {
    const { host, view } = mount([
      queued('https://e.test/a', { kind: 'waiting' }, 'https://old.example.org'),
    ]);
    await view.refresh();
    const article = host.querySelector('.pending-entry[data-state="elsewhere"]')!;
    expect(article.textContent).toContain('https://old.example.org');
    expect(article.querySelector('.delete')).not.toBeNull();
    expect(article.querySelector('.open')).toBeNull();
  });

  it('syncs on request and reports the result', async () => {
    const { host, deps, view } = mount([], {
      sync: vi.fn(async () => ({
        saved: 2,
        held: 1,
        refused: 0,
        withoutPicture: ['Pictured'],
        stopped: null,
      })),
    });
    await view.refresh();
    host.querySelector<HTMLButtonElement>('#sync')!.click();
    await flush();
    expect(deps.sync).toHaveBeenCalled();
    const result = host.querySelector('#result')!.textContent!;
    expect(result).toContain('2 entries saved.');
    expect(result).toContain('Saved without its picture: Pictured');
    expect(result).toContain('1 is already on Hrček and waits for your review.');
  });

  it('says when Hrček could not be reached', () => {
    const { host, view } = mount([]);
    view.showResult({
      saved: 0,
      held: 0,
      refused: 0,
      withoutPicture: [],
      stopped: 'unavailable',
    });
    expect(host.querySelector('#result')!.textContent).toBe("Hrček can't be reached.");
  });
});
