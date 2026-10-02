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
  const automatic = i18n._('Automatic ({language})', {
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
    <h1>${escapeText(i18n._('Settings'))}</h1>
    <form id="settings-form">
      <div class="field">
        <label for="server-url">${escapeText(i18n._('Server address'))}</label>
        <input id="server-url" type="url" placeholder="https://hrcek.example.com" required />
      </div>
      <div class="field">
        <label for="token">${escapeText(i18n._('API token'))}</label>
        <input id="token" type="password" placeholder="hrcek_…" autocomplete="off" />
      </div>
      <div class="field">
        <label for="language">${escapeText(i18n._('Language'))}</label>
        <select id="language">${languageOptions()}</select>
      </div>
      <div class="field">
        <label for="show-saved"><input type="checkbox" id="show-saved" /> ${escapeText(i18n._('Show whether a page is already saved'))}</label>
        <p>${escapeText(i18n._('The toolbar ticks the hamster on pages you have saved. Doing so asks your Hrček about every address you visit. Turn it off and the toolbar only says whether the extension is configured.'))}</p>
      </div>
      <p>${escapeText(i18n._('Paste one from '))}<a id="account-link" href="#" target="_blank">${escapeText(i18n._('your clients page'))}</a>${escapeText(i18n._(', or let Hrček make one below.'))}</p>
      <button type="submit" id="save">${escapeText(i18n._('Save'))}</button>
      <button type="button" class="quiet" id="test">${escapeText(i18n._('Test connection'))}</button>
      <p id="status" data-kind="info"></p>
    </form>

    <details id="create-token" open>
      <summary>${escapeText(i18n._('Create a token with your password'))}</summary>
      <p>${escapeText(i18n._('Your password is used once to ask Hrček for a token, and is never stored. The token appears above and is what the extension uses from then on.'))}</p>
      <div class="field">
        <label for="identifier">${escapeText(i18n._('Email or display name'))}</label>
        <input id="identifier" autocomplete="username" />
      </div>
      <div class="field">
        <label for="password">${escapeText(i18n._('Password'))}</label>
        <input id="password" type="password" autocomplete="current-password" />
      </div>
      <button type="button" id="create">${escapeText(i18n._('Create token'))}</button>
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
      return i18n._(
        'Too many attempts. Wait a while before trying again, or paste a token from your clients page.',
      );
    // An older Hrček has no exchange route; its 404 says nothing useful.
    if (error.status === 404)
      return i18n._(
        'This Hrček cannot make tokens for an extension. Create one on your clients page and paste it above.',
      );
    return error.message;
  }
  // Written by the client, in English. Say it in the chosen language,
  // naming the address that was actually tried.
  if (error instanceof HrcekNetworkError) {
    return i18n._('Could not reach {server}.', {
      server: normalizeServerUrl(serverUrlInput.value),
    });
  }
  return i18n._('Something went wrong.');
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
  setStatus('info', i18n._('Saving…'));
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
        ? i18n._('Saved.')
        : i18n._('Saved. Site access was declined — press Save again to grant it.'),
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
  setStatus('info', i18n._('Asking Hrček for a token…'));
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
    setStatus(
      'success',
      i18n._('Saved. Token created as "{name}".', { name: created.name }),
    );
  } catch (error) {
    setStatus('error', messageFor(error));
  }
}

async function testConnection(): Promise<void> {
  const settings = await loadSettings();
  if (settings === null || settings.token === null) {
    setStatus('error', i18n._('Save a server address and token first.'));
    return;
  }
  setStatus('info', i18n._('Testing…'));
  try {
    const user = await clientFromSettings(settings, localeFor(chosenLanguage)).me();
    setStatus('success', i18n._('Connected as {email}.', { email: user.email }));
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
