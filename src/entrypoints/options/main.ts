import { browser } from 'wxt/browser';
import { HrcekApiError, HrcekNetworkError } from '../../lib/api/errors';
import { anonymousClient, clientFromSettings } from '../../lib/client-factory';
import { i18n } from '@lingui/core';
import { availableLocales, localeFor } from '../../lib/i18n';
import { LOCALE_NAMES } from '../../lib/i18n/catalogues';
import { loadSettings, normalizeServerUrl, saveSettings } from '../../lib/settings';
import { tokenName } from '../../lib/token-name';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app')!;

/** The stored choice: null is Automatic. */
let chosenLanguage: string | null = null;

/**
 * Lingui's non-macro form, aliased to keep call sites one short word. The
 * id is the English text, so a call site reads as what it says — and a
 * message with no translation falls back to its own id, which is already
 * the English.
 */
function t(id: string, values?: Record<string, unknown>): string {
  return i18n._(id, values);
}

/**
 * Catalogues are .po and compiled on import by @lingui/vite-plugin, so
 * loading one is a dynamic import. The extension holds two small
 * languages, but this is where a tenth would cost nothing at install.
 */
async function activate(locale: string): Promise<void> {
  const { messages } = await import(`../../locales/${locale}.po`);
  i18n.loadAndActivate({ locale, messages });
}

let serverUrlInput: HTMLInputElement;
let tokenInput: HTMLInputElement;
let identifierInput: HTMLInputElement;
let passwordInput: HTMLInputElement;
let accountLink: HTMLAnchorElement;
let showSavedInput: HTMLInputElement;

/**
 * Whether the account already held a token as of the last restore.
 * Minting is the first-run path; once a token is held, every render
 * folds the create-token panel away — not just the first one, or a
 * language switch would spring it back open.
 */
let tokenAlreadyHeld = false;

function escapeText(value: string): string {
  const node = document.createElement('span');
  node.textContent = value;
  return node.innerHTML;
}

function languageOptions(): string {
  // Automatic first, naming what it resolved to. Then every language in
  // its own words — the only naming that helps somebody who has landed
  // in a language they cannot read.
  const resolved = localeFor(null);
  const automatic = t('Automatic ({language})', {
    language: LOCALE_NAMES[resolved] ?? resolved,
  });
  const rows = [`<option value="">${escapeText(automatic)}</option>`];
  for (const locale of availableLocales()) {
    const selected = locale === chosenLanguage ? ' selected' : '';
    rows.push(
      `<option value="${locale}"${selected}>${escapeText(LOCALE_NAMES[locale] ?? locale)}</option>`,
    );
  }
  return rows.join('');
}

function render(): void {
  app.innerHTML = `
    <div class="hrcek-header">
      <img src="/icon/32.png" alt="" />
      <span class="name">Hrček</span>
    </div>
    <h1>${escapeText(t('Settings'))}</h1>
    <form id="settings-form">
      <div class="field">
        <label for="server-url">${escapeText(t('Server address'))}</label>
        <input id="server-url" type="url" placeholder="https://hrcek.example.com" required />
      </div>
      <div class="field">
        <label for="token">${escapeText(t('API token'))}</label>
        <input id="token" type="password" placeholder="hrcek_…" autocomplete="off" />
      </div>
      <div class="field">
        <label for="language">${escapeText(t('Language'))}</label>
        <select id="language">${languageOptions()}</select>
      </div>
      <div class="field">
        <label for="show-saved"><input type="checkbox" id="show-saved" /> ${escapeText(t('Show whether a page is already saved'))}</label>
        <p>${escapeText(t('The toolbar ticks the hamster on pages you have saved. Doing so asks your Hrček about every address you visit. Turn it off and the toolbar only says whether the extension is configured.'))}</p>
      </div>
      <p>${escapeText(t('Paste one from '))}<a id="account-link" href="#" target="_blank">${escapeText(t('your clients page'))}</a>${escapeText(t(', or let Hrček make one below.'))}</p>
      <button type="submit" id="save">${escapeText(t('Save'))}</button>
      <button type="button" class="quiet" id="test">${escapeText(t('Test connection'))}</button>
      <p id="status" data-kind="info"></p>
    </form>

    <details id="create-token" open>
      <summary>${escapeText(t('Create a token with your password'))}</summary>
      <p>${escapeText(t('Your password is used once to ask Hrček for a token, and is never stored. The token appears above and is what the extension uses from then on.'))}</p>
      <div class="field">
        <label for="identifier">${escapeText(t('Email or display name'))}</label>
        <input id="identifier" autocomplete="username" />
      </div>
      <div class="field">
        <label for="password">${escapeText(t('Password'))}</label>
        <input id="password" type="password" autocomplete="current-password" />
      </div>
      <button type="button" id="create">${escapeText(t('Create token'))}</button>
    </details>
  `;
  wire();
}

function refreshAccountLink(): void {
  accountLink.href = `${normalizeServerUrl(serverUrlInput.value)}/accounts/me/clients/`;
}

function wire(): void {
  serverUrlInput = document.querySelector<HTMLInputElement>('#server-url')!;
  tokenInput = document.querySelector<HTMLInputElement>('#token')!;
  identifierInput = document.querySelector<HTMLInputElement>('#identifier')!;
  passwordInput = document.querySelector<HTMLInputElement>('#password')!;
  accountLink = document.querySelector<HTMLAnchorElement>('#account-link')!;
  showSavedInput = document.querySelector<HTMLInputElement>('#show-saved')!;
  // A first visit has no stored settings, so restore() never runs; default on.
  showSavedInput.checked = true;
  // Runs after every render, not just the first, so a language switch
  // does not spring the panel back open on an account that already has
  // a token.
  document.querySelector<HTMLDetailsElement>('#create-token')!.open = !tokenAlreadyHeld;

  serverUrlInput.addEventListener('change', refreshAccountLink);

  document
    .querySelector<HTMLFormElement>('#settings-form')!
    .addEventListener('submit', (event) => {
      event.preventDefault();
      void save();
    });

  document.querySelector<HTMLButtonElement>('#create')!.addEventListener('click', () => {
    void createToken();
  });

  document.querySelector<HTMLButtonElement>('#test')!.addEventListener('click', () => {
    void testConnection();
  });

  document
    .querySelector<HTMLSelectElement>('#language')!
    .addEventListener('change', (event) => {
      const value = (event.target as HTMLSelectElement).value;
      chosenLanguage = value === '' ? null : value;
      // Keep what is typed but not yet saved: rebuilding the markup
      // would otherwise throw away a half-entered token. The password is
      // deliberately left out — it must never survive longer than the
      // click that used it, not even across a re-render.
      const kept = {
        serverUrl: serverUrlInput.value,
        token: tokenInput.value,
        identifier: identifierInput.value,
        showSaved: showSavedInput.checked,
      };
      // Activating a catalogue is async now — it is a dynamic import — so
      // the re-render has to wait for it. With the hand-rolled catalogue
      // this was a synchronous assignment.
      void activate(localeFor(chosenLanguage)).then(() => {
        render();
        serverUrlInput.value = kept.serverUrl;
        tokenInput.value = kept.token;
        identifierInput.value = kept.identifier;
        showSavedInput.checked = kept.showSaved;
        refreshAccountLink();
        void persistLanguage();
      });
    });
}

/**
 * The language is a preference, not a credential: it is stored the
 * moment it is chosen rather than waiting for Save. There is nothing to
 * store it in on a first visit — the Save that creates the settings
 * carries it.
 */
async function persistLanguage(): Promise<void> {
  const settings = await loadSettings();
  if (settings === null) return;
  await saveSettings({ ...settings, language: chosenLanguage });
}

function setStatus(kind: 'info' | 'success' | 'error', text: string): void {
  const status = document.querySelector<HTMLParagraphElement>('#status')!;
  status.dataset.kind = kind;
  status.textContent = text;
}

function messageFor(error: unknown): string {
  if (error instanceof HrcekApiError) {
    // Rate-limited, ten an hour by default. The throttle's reply is not
    // the Hrček error envelope, so the status is all there is to go on.
    if (error.status === 429)
      return t(
        'Too many attempts. Wait a while before trying again, or paste a token from your clients page.',
      );
    // An older Hrček has no exchange route; its 404 says nothing useful.
    if (error.status === 404)
      return t(
        'This Hrček cannot make tokens for an extension. Create one on your clients page and paste it above.',
      );
    return error.message;
  }
  // Written by the client, in English. Say it in the chosen language,
  // naming the address that was actually tried.
  if (error instanceof HrcekNetworkError) {
    return t('Could not reach {server}.', {
      server: normalizeServerUrl(serverUrlInput.value),
    });
  }
  return t('Something went wrong.');
}

/** The manifest holds no host permissions; ask for this server's origin. */
async function requestOriginPermission(serverUrl: string): Promise<boolean> {
  try {
    const origin = `${new URL(serverUrl).origin}/*`;
    return await browser.permissions.request({ origins: [origin] });
  } catch {
    // A malformed address, or no user gesture — the save itself reports it.
    return false;
  }
}

async function save(): Promise<void> {
  setStatus('info', t('Saving…'));
  try {
    const serverUrl = normalizeServerUrl(serverUrlInput.value);
    const granted = await requestOriginPermission(serverUrl);
    const token = tokenInput.value.trim();
    await saveSettings({
      serverUrl,
      token: token.length > 0 ? token : null,
      showSavedState: showSavedInput.checked,
      language: chosenLanguage,
    });
    setStatus(
      'success',
      granted
        ? t('Saved.')
        : t('Saved. Site access was declined — press Save again to grant it.'),
    );
  } catch (error) {
    setStatus('error', messageFor(error));
  }
}

/** Where this token will show up in the owner's clients list. */
async function nameForThisClient(): Promise<string> {
  try {
    const { os } = await browser.runtime.getPlatformInfo();
    return tokenName(import.meta.env.BROWSER, os);
  } catch {
    return tokenName(import.meta.env.BROWSER, null);
  }
}

async function createToken(): Promise<void> {
  setStatus('info', t('Asking Hrček for a token…'));
  try {
    const serverUrl = normalizeServerUrl(serverUrlInput.value);
    await requestOriginPermission(serverUrl);
    const name = await nameForThisClient();
    const created = await anonymousClient(
      serverUrl,
      localeFor(chosenLanguage),
    ).createToken(name, identifierInput.value.trim(), passwordInput.value);
    passwordInput.value = ''; // used once, never kept
    tokenInput.value = created.token;
    // There is a token now, so the panel that makes one folds away and
    // stays folded — a language switch re-renders, and without this it
    // would spring back open on a first visit.
    tokenAlreadyHeld = true;
    await saveSettings({
      serverUrl,
      token: created.token,
      showSavedState: showSavedInput.checked,
      language: chosenLanguage,
    });
    setStatus('success', t('Saved. Token created as "{name}".', { name: created.name }));
  } catch (error) {
    setStatus('error', messageFor(error));
  }
}

async function testConnection(): Promise<void> {
  const settings = await loadSettings();
  if (settings === null || settings.token === null) {
    setStatus('error', t('Save a server address and token first.'));
    return;
  }
  setStatus('info', t('Testing…'));
  try {
    const user = await clientFromSettings(settings, localeFor(chosenLanguage)).me();
    setStatus('success', t('Connected as {email}.', { email: user.email }));
  } catch (error) {
    setStatus('error', messageFor(error));
  }
}

async function restore(): Promise<void> {
  // Settings that cannot be read are still settings that must be
  // writable: the markup is built here now, so a rejected read would
  // otherwise leave a blank page with no way to configure anything —
  // including no way to fix whatever broke the read.
  const settings = await loadSettings().catch((error: unknown) => {
    console.warn('[hrcek] could not read the stored settings', error);
    return null;
  });
  if (settings !== null) {
    chosenLanguage = settings.language;
    tokenAlreadyHeld = settings.token !== null;
  }
  // Nothing can render before a catalogue is active — with the hand-rolled
  // catalogue the translator was ready at module scope, synchronously.
  await activate(localeFor(chosenLanguage));
  render();
  if (settings === null) return;
  serverUrlInput.value = settings.serverUrl;
  refreshAccountLink();
  tokenInput.value = settings.token ?? '';
  showSavedInput.checked = settings.showSavedState;
}

void restore();
