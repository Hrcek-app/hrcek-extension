import { browser } from 'wxt/browser';
import { HrcekApiError, HrcekNetworkError, isAuthFailure } from '../../lib/api/errors';
import { HrcekClient } from '../../lib/api/client';
import { clientFromSettings } from '../../lib/client-factory';
import { i18n } from '@lingui/core';
import { activateLocale } from '../../lib/i18n';
import { harvestCandidates } from '../../lib/page/harvest-client';
import { showToast } from '../../lib/page/toast-client';
import { attachPicture, fetchPictureBytes, type PictureTrouble } from '../../lib/picture';
import { loadExisting, submitSave } from '../../lib/save';
import { isConfigured, loadSettings } from '../../lib/settings';
import {
  emptyForm,
  entryToForm,
  formToSaveRequest,
  parseTags,
  type FormState,
} from './form';
import { createChipInput, type ChipInput } from './chips';
import { createPicker, type HeldPicture, type Picker } from './picker';
import type { Settings } from '../../lib/settings';
import type { FieldInput } from '../../lib/fields';
import type { FieldOut, ImageOut } from '../../lib/api/types';
import type { Candidate } from '../../lib/page/candidates';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app')!;

// A fresh install has no settings yet, and the popup still has to speak:
// Automatic resolves against the browser until main() knows better.
activateLocale(null);

let settings: Settings | null = null;
let client: HrcekClient | null = null;
/** True when the initial look-before-write failed for a reason other than "not held". */
let lookupFailed = false;
let pageUrl = '';
/** What the <details> actually showed. Only these are ever sent back. */
let renderedFields: FieldInput[] = [];
/** Loaded once in main(); null when GET /api/fields/ could not be read. */
let definitions: FieldOut[] | null = null;
/** True when that read failed, as opposed to answering no fields at all. */
let fieldsFailed = false;
/** The mounted tags chip input; remounted by every renderForm() call. */
let chips: ChipInput | null = null;
/** The mounted picture picker; remounted by every renderForm() call. */
let picker: Picker | null = null;
/** Harvested once in main(); what the page itself offers. */
let candidates: Candidate[] = [];
/** The picture the entry already holds, if any, ready to be shown. */
let held: HeldPicture | null = null;
/** The object URL behind `held.src`, kept so it can be revoked. */
let heldObjectUrl: string | null = null;

/**
 * What to show the held picture with. The entry only carries an address,
 * and that address answers to the owning account alone — an `<img>`
 * cannot present a bearer token, and this extension holds no cookies —
 * so the bytes are fetched here and handed over as an object URL.
 *
 * A fetch that fails is not worth an error: the tile falls back to saying
 * the entry has a picture without showing it, and the entry is otherwise
 * untouched.
 */
async function loadHeldPicture(image: ImageOut | null | undefined): Promise<void> {
  // Whatever was shown before is about to be replaced; let it go.
  if (heldObjectUrl !== null) URL.revokeObjectURL(heldObjectUrl);
  heldObjectUrl = null;
  if (image == null || client === null) {
    held = null;
    return;
  }
  try {
    heldObjectUrl = URL.createObjectURL(await client.fetchImage(image.url));
    held = { src: heldObjectUrl };
  } catch {
    held = { src: null };
  }
}

async function getPageInfo(): Promise<{ url: string; title: string }> {
  // e2e builds only: Playwright opens the popup as an ordinary tab, which
  // makes the popup itself the active tab, so ?url=&title= stand in for the
  // page under test. MODE is a build-time constant, so this branch is not in
  // production bundles.
  if (import.meta.env.MODE === 'e2e') {
    const params = new URLSearchParams(window.location.search);
    const urlOverride = params.get('url');
    if (urlOverride !== null) {
      return { url: urlOverride, title: params.get('title') ?? '' };
    }
  }
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return { url: tab?.url ?? '', title: tab?.title ?? '' };
}

/**
 * The tab the save was about. In production that is the active tab, the
 * one this popup hangs off. Under Playwright the popup IS the active
 * tab, so the e2e build looks the page up by the address it was handed
 * — the same seam as `?url=` above, and the same build-time constant,
 * so neither branch is in a production bundle.
 */
async function targetTabId(): Promise<number | undefined> {
  if (import.meta.env.MODE === 'e2e') {
    const [seeded] = await browser.tabs.query({ url: pageUrl });
    return seeded?.id;
  }
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

/**
 * e2e builds only, and null in every other build: the popup is its own
 * tab under Playwright, so there is no page to harvest and `?candidate=`
 * stands in for what one would have offered. Same seam, and the same
 * build-time constant, as the `?url=` above.
 */
function seededCandidates(): Candidate[] | null {
  if (import.meta.env.MODE === 'e2e') {
    const seeded = new URLSearchParams(window.location.search).get('candidate');
    // Shaped like a head declaration, which is what a page most often
    // offers: no dimensions to be had until something loads it.
    if (seeded !== null) return [{ url: seeded, width: 0, height: 0, fromHead: true }];
  }
  return null;
}

function setStatus(kind: 'info' | 'success' | 'error', text: string): void {
  const status = document.querySelector<HTMLParagraphElement>('#status')!;
  status.dataset.kind = kind;
  status.textContent = text;
}

/**
 * The save is done. Say so on the page — which outlives this popup —
 * and then go away. The status line is set first regardless: it is what
 * a page that cannot host a toast leaves behind, and what the e2e build
 * reads.
 */
async function finish(kind: 'success' | 'error', text: string): Promise<void> {
  setStatus(kind, text);
  const tabId = await targetTabId();
  if (tabId !== undefined) await showToast(tabId, text, kind);
  closeSelf();
}

function closeSelf(): void {
  if (import.meta.env.MODE === 'e2e') {
    // Playwright opens the popup as an ordinary tab, and window.close()
    // may not close a tab a script did not open. Mark the document so
    // the test can see that the popup asked.
    document.documentElement.dataset['hrcekClosed'] = 'true';
    return;
  }
  window.close();
}

/**
 * The reason a picture did not attach, in words. This lands inside an
 * already-translated sentence, so a message the client wrote in English
 * — "Could not reach …" — must be said again here rather than passed
 * through, or one half of that sentence comes out in the wrong language.
 */
function pictureTroubleText(trouble: PictureTrouble): string {
  switch (trouble.kind) {
    // The server's own words, already in the reader's language.
    case 'refused':
      return trouble.message;
    case 'unreachable':
      return i18n._('Could not reach {server}.', { server: settings?.serverUrl ?? '' });
    case 'unknown':
      return i18n._('The picture could not be attached.');
  }
}

function messageFor(error: unknown): string {
  // The server's message is translated and made for people — show it.
  if (error instanceof HrcekApiError) return error.message;
  // This one is written by the client, in English. Say it here instead,
  // in the language the rest of the popup is speaking.
  if (error instanceof HrcekNetworkError) {
    return i18n._('Could not reach {server}.', { server: settings?.serverUrl ?? '' });
  }
  return i18n._('Something went wrong.');
}

function fieldControl(input: FieldInput): string {
  const id = `field-${encodeURIComponent(input.name)}`;
  if (input.kind === 'choice') {
    // The stored value can outlive the option that produced it — the
    // account's options can change after an entry was saved. Hiding it
    // would mean Save silently clears it, so show it, clearly marked as no
    // longer offered, rather than pretending the field is empty.
    const isOrphan = input.value !== '' && !input.options.includes(input.value);
    const values = isOrphan ? [...input.options, input.value] : input.options;
    const options = ['', ...values]
      .map((option) => {
        const label =
          option === ''
            ? '—'
            : option === input.value && isOrphan
              ? escapeText(i18n._('{option} (no longer offered)', { option }))
              : escapeText(option);
        return `<option value="${escapeAttribute(option)}"${option === input.value ? ' selected' : ''}>${label}</option>`;
      })
      .join('');
    return `<select id="${id}" data-field="${escapeAttribute(input.name)}">${options}</select>`;
  }
  // A number field still takes a string: values come back as strings
  // always, and the server does the validating.
  const mode = input.kind === 'number' ? ' inputmode="decimal"' : '';
  return `<input id="${id}" data-field="${escapeAttribute(input.name)}"${mode} value="${escapeAttribute(input.value)}" />`;
}

function escapeText(value: string): string {
  const node = document.createElement('span');
  node.textContent = value;
  return node.innerHTML;
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;');
}

function fieldsMarkup(inputs: FieldInput[]): string {
  if (inputs.length === 0) return '';
  const rows = inputs
    .map(
      (input) =>
        `<div class="field"><label for="field-${encodeURIComponent(input.name)}">${escapeText(
          input.name,
        )}</label>${fieldControl(input)}</div>`,
    )
    .join('');
  // Closed by default: these are optional, and most saves never touch them.
  return `<details id="fields"><summary>${escapeText(i18n._('Your fields'))}</summary><div class="field-body">${rows}</div></details>`;
}

function renderUnconfigured(): void {
  app.innerHTML = `
    <div class="hrcek-header">
      <img src="/icon/32.png" alt="" />
      <span class="name">Hrček</span>
    </div>
    <p>${escapeText(i18n._('Hrček is not configured yet.'))}</p>
    <button id="open-options">${escapeText(i18n._('Open settings'))}</button>
  `;
  document
    .querySelector<HTMLButtonElement>('#open-options')!
    .addEventListener('click', () => browser.runtime.openOptionsPage());
}

function renderUnauthorized(): void {
  app.innerHTML = `
    <div class="hrcek-header">
      <img src="/icon/32.png" alt="" />
      <span class="name">Hrček</span>
    </div>
    <p>${escapeText(i18n._('Your Hrček no longer accepts this token. Make a new one in settings.'))}</p>
    <button id="open-options">${escapeText(i18n._('Open settings'))}</button>
  `;
  document
    .querySelector<HTMLButtonElement>('#open-options')!
    .addEventListener('click', () => browser.runtime.openOptionsPage());
}

function renderForm(form: FormState, existing: boolean): void {
  renderedFields = form.fields;
  app.innerHTML = `
    <div class="hrcek-header">
      <img src="/icon/32.png" alt="" />
      <span class="name">Hrček</span>
      ${existing ? `<span class="aside">${escapeText(i18n._('Already saved'))}</span>` : ''}
    </div>
    <span class="address" id="address" title=""></span>
    <form id="entry-form">
      <div class="field"><label for="title">${escapeText(i18n._('Title'))}</label><input id="title" /></div>
      <div class="field"><label for="notes">${escapeText(i18n._('Notes'))}</label><textarea id="notes" rows="3"></textarea></div>
      <div class="field" id="picture-field"><label>${escapeText(i18n._('Picture'))}</label><div id="picture"></div></div>
      <div class="field"><label>${escapeText(i18n._('Tags'))}</label><div id="tags"></div></div>
      ${fieldsFailed ? `<p id="fields-trouble" class="trouble">${escapeText(i18n._('Your fields could not be loaded — saving will not change them.'))}</p>` : ''}
      ${fieldsMarkup(form.fields)}
      <button type="submit" id="save">${escapeText(existing ? i18n._('Update') : i18n._('Save'))}</button>
      <p id="status" data-kind="info"></p>
    </form>
  `;
  const address = document.querySelector<HTMLSpanElement>('#address')!;
  address.textContent = form.url;
  address.title = form.url;
  document.querySelector<HTMLInputElement>('#title')!.value = form.title;
  document.querySelector<HTMLTextAreaElement>('#notes')!.value = form.notes;
  const pictureHost = document.querySelector<HTMLDivElement>('#picture')!;
  picker = createPicker(pictureHost, { candidates, held, existing });
  // The row is absent, not empty, when the page offered nothing.
  if (pictureHost.innerHTML === '') {
    document.querySelector<HTMLDivElement>('#picture-field')!.hidden = true;
  }
  chips = createChipInput(document.querySelector<HTMLDivElement>('#tags')!, {
    tags: parseTags(form.tags),
    suggest: (prefix) =>
      client === null
        ? Promise.resolve([])
        : client
            .listLabels({ startsWith: prefix })
            .then((labels) => labels.map((label) => label.name)),
    onSubmit: () => void save(),
  });

  const entryForm = document.querySelector<HTMLFormElement>('#entry-form')!;
  // Attached here, once per rendered form, rather than inside the picker:
  // the picker redraws itself on every tile click, and a listener added
  // per redraw would pile up. The form is rebuilt wholesale by each
  // renderForm, so this one is discarded with it.
  //
  // focusin reaches this listener only when the focus landed inside the
  // form, so it says precisely "attention moved to another field".
  entryForm.addEventListener('focusin', (event) => {
    const target = event.target;
    if (target instanceof Node && pictureHost.contains(target)) return;
    picker?.collapse();
  });
  entryForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void save();
  });
}

function collectForm(): FormState {
  return {
    // Not editable, so it is carried rather than read back from an input.
    url: pageUrl,
    title: document.querySelector<HTMLInputElement>('#title')!.value,
    notes: document.querySelector<HTMLTextAreaElement>('#notes')!.value,
    tags: (chips?.tags() ?? []).join(', '),
    // The `!` here relies on fieldsMarkup and this query iterating the same
    // rendered set — every [data-field] control on the page came from
    // renderedFields, so the name is always found.
    fields: [
      ...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-field]'),
    ].map((control) => {
      const rendered = renderedFields.find(
        (field) => field.name === control.dataset['field'],
      )!;
      return { ...rendered, value: control.value };
    }),
  };
}

async function save(): Promise<void> {
  // Said here rather than on the form's submit event so that both ways in
  // — the button and Enter in the tag field — put the preview away. Not
  // every browser focuses a button that was clicked, so focusin alone
  // would miss it.
  picker?.collapse();
  if (!settings || !client) {
    setStatus('error', i18n._('Settings not available.'));
    return;
  }
  setStatus('info', i18n._('Saving…'));

  // The initial look-before-write failed (network blip, 5xx — not a
  // confirmed "not held"). Posting now could blind-replace a held entry's
  // notes/tags, so re-check before writing anything.
  if (lookupFailed) {
    try {
      const existing = pageUrl.length > 0 ? await loadExisting(client, pageUrl) : null;
      if (existing !== null) {
        lookupFailed = false;
        await loadHeldPicture(existing.image);
        renderForm(entryToForm(existing, definitions), true);
        setStatus(
          'error',
          i18n._(
            'This address is already saved. Review the existing entry, then save again.',
          ),
        );
        return;
      }
      lookupFailed = false;
    } catch (error) {
      setStatus('error', messageFor(error));
      return;
    }
  }

  try {
    const choice = picker?.choice() ?? { kind: 'unchanged' as const };
    // Bytes first: the server refuses to fetch from private hosts, and a
    // signed or referer-checked address will not come back for it.
    const bytes = choice.kind === 'url' ? await fetchPictureBytes(choice.url) : null;
    const request = formToSaveRequest(collectForm());
    const outcome = await submitSave(client, {
      ...request,
      // image_url only when the bytes could not be had. Omitted entirely
      // otherwise, which is the documented way to leave a picture alone.
      ...(choice.kind === 'url' && bytes === null ? { imageUrl: choice.url } : {}),
    });
    // The entry exists on the server now, regardless of what the picture
    // does below — the tick reports the entry, not the picture. Caught,
    // not merely voided: on Chrome a message with no live listener
    // rejects, and an unhandled rejection is noise at best. This runs
    // before the picture work precisely so that both of the exits below
    // mark it held.
    void browser.runtime
      .sendMessage({ type: 'hrcek:saved', url: outcome.entry.url, held: true })
      .catch(() => undefined);

    // The picture's bytes live only in this popup — Chrome serialises
    // messages as JSON, so they cannot be handed to the background to
    // finish with. The popup waits the second or two instead.
    if (choice.kind !== 'unchanged') setStatus('info', i18n._('Saving the picture…'));
    // image_url is fetched inside the save's own transaction, so an
    // address the server will not go to takes the save with it. submitSave
    // posts again without the picture when that happens and reports the
    // reason here — the entry stands either way.
    const trouble =
      outcome.pictureTrouble ??
      (await attachPicture(client, outcome.entry, choice, bytes));
    if (trouble !== null) {
      // The entry stands; only the picture did not. Still a close: the
      // entry saved, which is what was asked for.
      await finish(
        'error',
        i18n._('Saved, but the picture could not be attached: {reason}', {
          reason: pictureTroubleText(trouble),
        }),
      );
      return;
    }
    await finish(
      'success',
      outcome.status === 'created' ? i18n._('Saved.') : i18n._('Updated.'),
    );
  } catch (error) {
    // The entry did not save. Stay open: this is the case where somebody
    // must do something about it.
    setStatus('error', messageFor(error));
  }
}

async function main(): Promise<void> {
  settings = await loadSettings();
  // A fresh install has no settings and still has to say so: Automatic
  // resolves against the browser.
  const locale = activateLocale(settings?.language ?? null);
  // A server address saved before a token is minted — the documented
  // first-run order, since the mint panel sits below the Save button —
  // is not configured yet. Falling through would send an unauthenticated
  // request, get a 401, and tell somebody who never had a token that
  // theirs was refused.
  if (!isConfigured(settings)) {
    renderUnconfigured();
    return;
  }
  client = clientFromSettings(settings, locale);
  const { url, title } = await getPageInfo();
  pageUrl = url;
  const seeded = seededCandidates();
  if (seeded !== null) {
    candidates = seeded;
  } else {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    candidates = tab?.id === undefined ? [] : await harvestCandidates(tab.id);
  }
  // Not fatal: without them the form falls back to the entry's own keys,
  // which is enough to show and re-send what the entry already holds.
  // Worth saying, though — an account with fields that silently shows
  // none looks exactly like an account without any.
  definitions = await client.listFields().then(
    (fields) => fields,
    (error: unknown) => {
      console.warn('[hrcek] could not read the account’s fields', error);
      fieldsFailed = true;
      return null;
    },
  );
  try {
    const existing = url.length > 0 ? await loadExisting(client, url) : null;
    if (existing !== null) {
      await loadHeldPicture(existing.image);
      renderForm(entryToForm(existing, definitions), true);
    } else {
      renderForm(emptyForm(url, title, definitions), false);
    }
  } catch (error) {
    if (isAuthFailure(error)) {
      // Nothing on this form can succeed until there is a new token.
      renderUnauthorized();
      return;
    }
    lookupFailed = true;
    renderForm(emptyForm(url, title, definitions), false);
    setStatus('error', messageFor(error));
  }
}

void main();
