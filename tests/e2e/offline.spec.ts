import type { BrowserContext, Page } from '@playwright/test';
import { expect, SERVER, test } from './fixtures';

const TOKEN = 'hrcek_test_token';

test.beforeEach(async () => {
  await fetch(`${SERVER}/__reset`, { method: 'POST' });
});

async function configure(context: BrowserContext, extensionId: string): Promise<void> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.fill('#server-url', SERVER);
  await page.fill('#token', TOKEN);
  await page.click('#save');
  await expect(page.locator('#status')).toHaveAttribute('data-kind', 'success');
  await page.close();
}

async function keepOffline(
  context: BrowserContext,
  extensionId: string,
  url: string,
  title: string,
): Promise<void> {
  const popup = await context.newPage();
  await popup.goto(
    `chrome-extension://${extensionId}/popup.html?${new URLSearchParams({ url, title })}`,
  );
  await expect(popup.locator('#save')).toHaveText('Save for later');
  await popup.click('#save');
  await expect(popup.locator('#status')).toContainText('Kept for later');
  await popup.close();
}

async function saveDirectly(url: string, title: string): Promise<void> {
  await fetch(`${SERVER}/api/entries/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, title }),
  });
}

async function titleOnServer(url: string): Promise<string | undefined> {
  const response = await fetch(`${SERVER}/api/entries/lookup`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return ((await response.json()) as { title?: string }).title;
}

async function openPending(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/pending.html`);
  return page;
}

test('holds queued saves Hrček already has, and keeps or replaces them on request', async ({
  context,
  extensionId,
}) => {
  await configure(context, extensionId);
  await fetch(`${SERVER}/__outage`, { method: 'POST' });
  await keepOffline(context, extensionId, 'https://example.com/keep', 'Mine (keep)');
  await keepOffline(
    context,
    extensionId,
    'https://example.com/replace',
    'Mine (replace)',
  );
  await fetch(`${SERVER}/__restore`, { method: 'POST' });
  // Saved elsewhere meanwhile — another device, say.
  await saveDirectly('https://example.com/keep', 'Theirs (keep)');
  await saveDirectly('https://example.com/replace', 'Theirs (replace)');

  const page = await openPending(context, extensionId);
  await expect(page.locator('.pending-entry[data-state="waiting"]')).toHaveCount(2);
  await page.click('#sync');
  await expect(page.locator('.pending-entry[data-state="held"]')).toHaveCount(2);
  await expect(page.locator('#result')).toContainText('already on Hrček');

  const keepEntry = page.locator('.pending-entry', {
    hasText: 'https://example.com/keep',
  });
  await expect(keepEntry.locator('.compare .theirs')).toContainText('Theirs (keep)');
  await keepEntry.locator('.keep').click();

  const replaceEntry = page.locator('.pending-entry', {
    hasText: 'https://example.com/replace',
  });
  await expect(replaceEntry.locator('.compare .theirs')).toContainText(
    'Theirs (replace)',
  );
  await replaceEntry.locator('.replace').click();

  await expect(page.locator('.empty')).toBeVisible();
  expect(await titleOnServer('https://example.com/keep')).toBe('Theirs (keep)');
  expect(await titleOnServer('https://example.com/replace')).toBe('Mine (replace)');
});

test('says so when syncing finds Hrček still down', async ({ context, extensionId }) => {
  await configure(context, extensionId);
  await fetch(`${SERVER}/__outage`, { method: 'POST' });
  await keepOffline(context, extensionId, 'https://example.com/still-down', 'Down');
  const page = await openPending(context, extensionId);
  await page.click('#sync');
  await expect(page.locator('#result')).toHaveText("Hrček can't be reached.");
  await expect(page.locator('.pending-entry[data-state="waiting"]')).toHaveCount(1);
});
