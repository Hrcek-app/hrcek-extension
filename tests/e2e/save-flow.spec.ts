import type { BrowserContext, Page } from '@playwright/test';
import { expect, SERVER, test } from './fixtures';

const FAKE_TOKEN = 'hrcek_test_token';
const FAKE_IDENTIFIER = 'nina@example.com';
const FAKE_PASSWORD = 'correct horse';
/** The address the fake refuses to fetch — tests/fake-hrcek/server.ts. */
const UNFETCHABLE_IMAGE_URL = 'https://unfetchable.example.com/picture.jpg';

test.beforeEach(async () => {
  await fetch(`${SERVER}/__reset`, { method: 'POST' });
});

async function openOptions(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  return page;
}

async function configureToken(
  context: BrowserContext,
  extensionId: string,
): Promise<void> {
  const page = await openOptions(context, extensionId);
  await page.fill('#server-url', SERVER);
  await page.fill('#token', FAKE_TOKEN);
  await page.click('#save');
  await expect(page.locator('#status')).toHaveAttribute('data-kind', 'success');
  await page.close();
}

/** What the server holds at an address, asked the way a client must ask. */
async function heldEntry(address: string) {
  const response = await fetch(`${SERVER}/api/entries/lookup`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${FAKE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url: address }),
  });
  return response.json();
}

/**
 * The JSON body of the next entry POST the popup sends. The fake stores
 * every picture at the same serving address, so this is where the
 * address actually chosen can be seen.
 */
function nextEntryPost(popup: Page): Promise<Record<string, unknown>> {
  return popup
    .waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/api/entries/'),
    )
    .then((request) => request.postDataJSON() as Record<string, unknown>);
}

/**
 * Opens the popup seeded with several page pictures. `<img>` loads get a
 * real picture; the popup's own fetch of the bytes is refused, as it is
 * for any picture on a host the extension cannot read — so the save
 * carries `image_url` and the choice is visible on the wire.
 */
async function openPopupWithPictures(
  context: BrowserContext,
  extensionId: string,
  url: string,
  pictures: string[],
  /** What every `<img>` gets; a square icon unless a test needs a shape. */
  picture: { body: string; contentType: string } | null = null,
): Promise<Page> {
  const popup = await context.newPage();
  await popup.route('https://pictures.example.com/**', (route) =>
    route.request().resourceType() === 'image'
      ? route.fulfill(
          picture ?? { path: 'src/public/icon/128.png', contentType: 'image/png' },
        )
      : route.abort('failed'),
  );
  const query = new URLSearchParams({ url, title: 'Pictures' });
  for (const picture of pictures) query.append('candidate', picture);
  await popup.goto(`chrome-extension://${extensionId}/popup.html?${query}`);
  return popup;
}

const PICTURES = [
  'https://pictures.example.com/one.jpg',
  'https://pictures.example.com/two.jpg',
  'https://pictures.example.com/three.jpg',
];

async function openPopup(
  context: BrowserContext,
  extensionId: string,
  url: string,
  title: string,
): Promise<Page> {
  const page = await context.newPage();
  const query = new URLSearchParams({ url, title });
  await page.goto(`chrome-extension://${extensionId}/popup.html?${query}`);
  return page;
}

test('shows a pointer to settings when unconfigured', async ({
  context,
  extensionId,
}) => {
  const popup = await openPopup(context, extensionId, 'https://example.com/a', 'A');
  await expect(popup.locator('#open-options')).toBeVisible();
});

test('says "not configured" — not "token refused" — before a token is minted', async ({
  context,
  extensionId,
}) => {
  // Saving the server address before minting is the documented first-run
  // order: the mint panel sits below the Save button. The popup used to
  // send an unauthenticated request, take the 401 at face value and say
  // the token was no longer accepted. There was never a token.
  const options = await openOptions(context, extensionId);
  await options.fill('#server-url', SERVER);
  await options.click('#save');
  await expect(options.locator('#status')).toHaveAttribute('data-kind', 'success');
  await options.close();

  const popup = await openPopup(context, extensionId, 'https://example.com/a', 'A');
  await expect(popup.locator('#app')).toContainText('not configured');
  await expect(popup.locator('#app')).not.toContainText('no longer accepts');
});

test('options page saves settings and tests the connection', async ({
  context,
  extensionId,
}) => {
  await configureToken(context, extensionId);
  const page = await openOptions(context, extensionId);
  await page.click('#test');
  await expect(page.locator('#status')).toContainText('nina@example.com');
});

test('saves a new entry from the popup', async ({ context, extensionId }) => {
  await configureToken(context, extensionId);
  const popup = await openPopup(
    context,
    extensionId,
    'https://example.com/watch',
    'A watch',
  );

  await expect(popup.locator('#address')).toHaveText('https://example.com/watch');
  await expect(popup.locator('#title')).toHaveValue('A watch');
  await popup.fill('#notes', '38mm, sapphire');
  await popup.locator('.chip-input').fill('watches');
  await popup.locator('.chip-input').press(',');
  await popup.locator('.chip-input').fill('diving');
  await popup.locator('.chip-input').press(',');
  await expect(popup.locator('.chip')).toHaveCount(2);
  await popup.click('#save');

  await expect(popup.locator('#status')).toContainText('Saved.');
});

test('reopening a saved address prefills the existing entry and updates it', async ({
  context,
  extensionId,
}) => {
  await configureToken(context, extensionId);
  const first = await openPopup(
    context,
    extensionId,
    'https://example.com/watch',
    'A watch',
  );
  await first.fill('#notes', 'original notes');
  await first.click('#save');
  await expect(first.locator('#status')).toContainText('Saved.');
  await first.close();

  const second = await openPopup(
    context,
    extensionId,
    'https://example.com/watch',
    'ignored',
  );
  await expect(second.locator('.hrcek-header .aside')).toBeVisible();
  await expect(second.locator('#notes')).toHaveValue('original notes');
  await second.fill('#title', 'A watch, revisited');
  await second.click('#save');
  await expect(second.locator('#status')).toContainText('Updated.');
});

test('offers the account’s own fields and saves a choice', async ({
  context,
  extensionId,
}) => {
  await configureToken(context, extensionId);
  const popup = await openPopup(context, extensionId, 'https://example.com/x', 'X');

  // Built from GET /api/fields/, never hard-coded on the client side.
  await popup.locator('#fields').click();
  await expect(popup.locator('[data-field="Price"]')).toBeVisible();
  await popup.locator('[data-field="Price"]').fill('129');
  await popup.locator('[data-field="Priority"]').selectOption('high');
  await popup.click('#save');
  await expect(popup.locator('#status')).toContainText('Saved.');

  const reopened = await openPopup(context, extensionId, 'https://example.com/x', 'X');
  await reopened.locator('#fields').click();
  await expect(reopened.locator('[data-field="Price"]')).toHaveValue('129');
  await expect(reopened.locator('[data-field="Priority"]')).toHaveValue('high');
});

test('preserves a choice value the account no longer offers', async ({
  context,
  extensionId,
}) => {
  await configureToken(context, extensionId);
  const url = 'https://example.com/orphan';

  // Save an entry with Priority set to a value that is still offered here.
  const setup = await openPopup(context, extensionId, url, 'Orphan');
  await setup.locator('#fields').click();
  await setup.locator('[data-field="Priority"]').selectOption('high');
  await setup.click('#save');
  await expect(setup.locator('#status')).toContainText('Saved.');
  await setup.close();

  // The account's options changed since: 'high' is no longer offered.
  const popup = await context.newPage();
  await popup.route('**/api/fields/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          { name: 'Price', kind: 'number', options: [] },
          { name: 'Priority', kind: 'choice', options: ['medium', 'low'] },
        ],
        count: 2,
      }),
    });
  });
  const query = new URLSearchParams({ url, title: 'ignored' });
  await popup.goto(`chrome-extension://${extensionId}/popup.html?${query}`);

  await popup.locator('#fields').click();
  const priority = popup.locator('[data-field="Priority"]');
  await expect(priority).toHaveValue('high');
  await expect(priority.locator('option[value="high"]')).toHaveText(/no longer offered/);

  // Saving without touching Priority must not clear it.
  await popup.fill('#title', 'Orphan, revisited');
  await popup.click('#save');
  await expect(popup.locator('#status')).toContainText('Updated.');

  // Reopen normally — the account's real options are back, and the value
  // the popup never touched came through the save untouched.
  const reopened = await openPopup(context, extensionId, url, 'ignored');
  await reopened.locator('#fields').click();
  await expect(reopened.locator('[data-field="Priority"]')).toHaveValue('high');
});

test('a failed initial lookup does not let Save blind-replace an existing entry', async ({
  context,
  extensionId,
}) => {
  await configureToken(context, extensionId);

  // Save an entry with notes/tags so a blind replace would be observable.
  const url = 'https://example.com/blip';
  const setup = await openPopup(context, extensionId, url, 'Blip');
  await setup.fill('#notes', 'precious notes');
  await setup.locator('.chip-input').fill('keep');
  await setup.locator('.chip-input').press(',');
  await setup.click('#save');
  await expect(setup.locator('#status')).toContainText('Saved.');
  await setup.close();

  // Simulate a network blip on the popup's initial look-before-write only;
  // let any later lookup (the save-time retry) through normally.
  const popup = await context.newPage();
  let lookupCalls = 0;
  await popup.route('**/api/entries/lookup', async (route) => {
    lookupCalls += 1;
    if (lookupCalls === 1) {
      await route.abort('failed');
      return;
    }
    await route.continue();
  });

  const query = new URLSearchParams({ url, title: 'ignored' });
  await popup.goto(`chrome-extension://${extensionId}/popup.html?${query}`);

  // Initial lookup failed: an empty form is shown, with an error note —
  // but Save is still armed.
  await expect(popup.locator('.hrcek-header .aside')).toHaveCount(0);
  await expect(popup.locator('#notes')).toHaveValue('');
  await expect(popup.locator('#status')).toHaveAttribute('data-kind', 'error');

  // Saving now must re-check before writing, not blind-replace the held entry.
  await popup.click('#save');
  await expect(popup.locator('.hrcek-header .aside')).toBeVisible();
  await expect(popup.locator('#notes')).toHaveValue('precious notes');
  await expect(popup.locator('#status')).not.toContainText('Saved.');
  await expect(popup.locator('#status')).not.toContainText('Updated.');

  // A second, conscious Save now proceeds normally.
  await popup.fill('#title', 'Blip, revisited');
  await popup.click('#save');
  await expect(popup.locator('#status')).toContainText('Updated.');
  await expect(popup.locator('#notes')).toHaveValue('precious notes');
});

test('mints a token from credentials, then saves with it', async ({
  context,
  extensionId,
}) => {
  const options = await openOptions(context, extensionId);
  await options.fill('#server-url', SERVER);
  await options.fill('#identifier', FAKE_IDENTIFIER);
  await options.fill('#password', FAKE_PASSWORD);
  await options.click('#create');

  await expect(options.locator('#status')).toContainText('Token created as');
  await expect(options.locator('#status')).toContainText('Hrček extension');
  await expect(options.locator('#password')).toHaveValue(''); // never kept
  // The minted token is what the extension will use from now on.
  await expect(options.locator('#token')).toHaveValue(/^hrcek_/);
  await options.close();

  const popup = await openPopup(context, extensionId, 'https://example.com/s', 'S');
  await popup.click('#save');
  await expect(popup.locator('#status')).toContainText('Saved.');
});

test('hides the picture field when the page offered nothing, and still saves', async ({
  context,
  extensionId,
}) => {
  await configureToken(context, extensionId);
  const address = 'https://example.com/article';
  const popup = await openPopup(context, extensionId, address, 'Article');

  // The picker only appears when the page offered something. Here the
  // popup IS the active tab, so nothing is harvested and the row is
  // absent — which is itself the behaviour worth pinning down.
  await expect(popup.locator('#picture-field')).toBeHidden();
  await popup.click('#save');
  await expect(popup.locator('#status')).toContainText('Saved.');
});

test('saves the entry even when the server refuses the picture, and says so', async ({
  context,
  extensionId,
}) => {
  await configureToken(context, extensionId);
  const address = 'https://example.com/cdn-hosted';

  const popup = await context.newPage();
  // The bytes are tried first and must fail, as they do for any picture
  // not served from the page's own host. Aborted rather than left to DNS,
  // so the test neither waits on the network nor depends on it.
  await popup.route(`${UNFETCHABLE_IMAGE_URL}*`, (route) => route.abort('failed'));
  const query = new URLSearchParams({
    url: address,
    title: 'CDN hosted',
    // The popup is its own tab here, so nothing is harvested; this seeds
    // the picker with what an og:image would have offered.
    candidate: UNFETCHABLE_IMAGE_URL,
  });
  await popup.goto(`chrome-extension://${extensionId}/popup.html?${query}`);

  // Preselected, so Save is the only gesture — as it is for any page that
  // declares a picture.
  await expect(popup.locator('#picture-field')).toBeVisible();
  await popup.click('#save');

  // The server fetches image_url inside the save's transaction and fails
  // the whole call. A picture never fails the entry: it is saved without
  // the picture, and the person is told which half went wrong.
  const status = popup.locator('#status');
  await expect(status).toContainText('Saved');
  await expect(status).toContainText('could not be attached');
  await expect(status).toContainText('That image could not be fetched.');

  const entry = await heldEntry(address);
  expect(entry.title).toBe('CDN hosted');
  expect(entry.image).toBeNull();
});

test('shows the picture an entry already holds, fetched with the token', async ({
  context,
  extensionId,
}) => {
  await configureToken(context, extensionId);
  const address = 'https://example.com/illustrated';
  await fetch(`${SERVER}/api/entries/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${FAKE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: address,
      title: 'Illustrated',
      image_url: 'https://cdn.example.com/cover.jpg',
    }),
  });

  const popup = await openPopup(context, extensionId, address, 'ignored');

  // The entry's image address answers only to the owning account, so the
  // popup fetches the bytes with the token and shows those. A plain
  // <img src> on that address would render broken here.
  await expect(popup.locator('#picture-field')).toBeVisible();
  const held = popup.locator('img.picture-preview');
  await expect(held).toHaveAttribute('src', /^blob:/);
  // It decoded, so those really are the picture's bytes.
  await expect
    .poll(() => held.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);

  // And leaving it alone leaves it alone.
  await popup.fill('#title', 'Illustrated, revisited');
  await popup.click('#save');
  await expect(popup.locator('#status')).toContainText('Updated.');
  const entry = await heldEntry(address);
  expect(entry.image).not.toBeNull();
});

test('removes the picture an entry holds when Include picture is unticked', async ({
  context,
  extensionId,
}) => {
  await configureToken(context, extensionId);
  const address = 'https://example.com/browsable';
  await fetch(`${SERVER}/api/entries/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${FAKE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: address,
      title: 'Browsable',
      image_url: 'https://cdn.example.com/cover.jpg',
    }),
  });

  const popup = await openPopup(context, extensionId, address, 'ignored');

  // A held picture is a choice already made: ticked, shown, and no Change
  // when the page offers nothing else.
  await expect(popup.locator('#include-picture')).toBeChecked();
  await expect(popup.locator('img.picture-preview')).toHaveAttribute('src', /^blob:/);
  await expect(popup.locator('#change-picture')).toHaveCount(0);

  // A change of mind and back keeps it…
  await popup.uncheck('#include-picture');
  await popup.check('#include-picture');
  await expect(popup.locator('img.picture-preview')).toHaveAttribute('src', /^blob:/);

  // …and unticking for good removes it.
  await popup.uncheck('#include-picture');
  await popup.click('#save');
  await expect(popup.locator('#status')).toContainText('Updated.');
  expect((await heldEntry(address)).image).toBeNull();
});

test('chooses another picture in the chooser and saves that one', async ({
  context,
  extensionId,
}) => {
  await configureToken(context, extensionId);
  const popup = await openPopupWithPictures(
    context,
    extensionId,
    'https://example.com/gallery',
    PICTURES,
  );

  // Proposed without being asked: the page's first picture, ticked.
  await expect(popup.locator('#include-picture')).toBeChecked();
  await expect(popup.locator('img.picture-preview')).toHaveAttribute('src', PICTURES[0]!);

  await popup.click('#change-picture');
  await expect(popup.locator('.chooser')).toBeVisible();
  await expect(popup.locator('.chooser-caption')).toHaveText('Selected');
  await popup.locator('.chooser-tile').nth(1).click();
  await expect(popup.locator('img.chooser-image')).toHaveAttribute('src', PICTURES[1]!);
  await popup.click('.chooser-close');
  await expect(popup.locator('.chooser')).toHaveCount(0);
  await expect(popup.locator('img.picture-preview')).toHaveAttribute('src', PICTURES[1]!);

  const posted = nextEntryPost(popup);
  await popup.click('#save');
  expect((await posted)['image_url']).toBe(PICTURES[1]);
  await expect(popup.locator('#status')).toContainText('Saved.');
});

test('a click on the large picture confirms it', async ({ context, extensionId }) => {
  await configureToken(context, extensionId);
  const popup = await openPopupWithPictures(
    context,
    extensionId,
    'https://example.com/gallery-click',
    PICTURES,
  );

  await popup.click('#change-picture');
  await popup.locator('.chooser-tile').nth(2).click();
  await popup.click('.chooser-preview');
  await expect(popup.locator('.chooser')).toHaveCount(0);

  const posted = nextEntryPost(popup);
  await popup.click('#save');
  expect((await posted)['image_url']).toBe(PICTURES[2]);
});

test('keeps Change to the right of even a very wide picture, inside the popup', async ({
  context,
  extensionId,
}) => {
  await configureToken(context, extensionId);
  // A 20:1 panorama: the one shape that would push Change off the row if
  // the picture were allowed the full width.
  const panorama = {
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="100"><rect width="2000" height="100" fill="#888"/></svg>',
    contentType: 'image/svg+xml',
  };
  const popup = await openPopupWithPictures(
    context,
    extensionId,
    'https://example.com/panorama',
    PICTURES,
    panorama,
  );

  const image = popup.locator('img.picture-preview');
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0);
  const picture = (await image.boundingBox())!;
  const change = (await popup.locator('#change-picture').boundingBox())!;
  const form = (await popup.locator('#entry-form').boundingBox())!;

  // No longer a fixed box: the picture takes its own proportions.
  expect(picture.height).toBeLessThan(112);
  // Change sits to its right, bottom-aligned, and inside the form.
  expect(change.x).toBeGreaterThanOrEqual(picture.x + picture.width);
  expect(change.x + change.width).toBeLessThanOrEqual(form.x + form.width + 0.5);
  expect(Math.abs(change.y + change.height - (picture.y + picture.height))).toBeLessThan(
    1,
  );
});

test('shows a picture at its own shape, with no box around it', async ({
  context,
  extensionId,
}) => {
  await configureToken(context, extensionId);
  const popup = await openPopupWithPictures(
    context,
    extensionId,
    'https://example.com/square',
    PICTURES,
  );

  const image = popup.locator('img.picture-preview');
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0);
  const picture = (await image.boundingBox())!;
  // The square icon stays square, at the 7rem (112px) cap — not
  // stretched across the form inside a box.
  expect(Math.round(picture.height)).toBe(112);
  expect(Math.round(picture.width)).toBe(112);
  expect(await image.evaluate((element) => getComputedStyle(element).borderStyle)).toBe(
    'none',
  );
});

test('unticking Include picture saves without one', async ({ context, extensionId }) => {
  await configureToken(context, extensionId);
  const address = 'https://example.com/plain';
  const popup = await openPopupWithPictures(context, extensionId, address, PICTURES);

  await popup.uncheck('#include-picture');
  await expect(popup.locator('.picture-preview')).toHaveCount(0);
  await expect(popup.locator('#change-picture')).toHaveCount(0);

  const posted = nextEntryPost(popup);
  await popup.click('#save');
  expect(await posted).not.toHaveProperty('image_url');
  await expect(popup.locator('#status')).toContainText('Saved.');
  expect((await heldEntry(address)).image).toBeNull();
});

test('keeps the tags and fields an entry holds when only the title changes', async ({
  context,
  extensionId,
}) => {
  await configureToken(context, extensionId);
  const address = 'https://example.com/held';
  await fetch(`${SERVER}/api/entries/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${FAKE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: address,
      title: 'Before',
      tags: ['diving'],
      fields: { Price: '129' },
    }),
  });

  const popup = await openPopup(context, extensionId, address, 'ignored');
  await expect(popup.locator('.chip')).toHaveCount(1);
  await popup.fill('#title', 'After');
  await popup.locator('#fields').click();
  await popup.locator('[data-field="Price"]').fill('99');
  await popup.click('#save');
  await expect(popup.locator('#status')).toContainText('Updated.');

  const entry = await heldEntry(address);
  expect(entry.title).toBe('After');
  // POST replaces entry attributes, so the tag only survives because the
  // form resent it. fields is PATCHED, not replaced, so a stale Price would
  // pass even with no field wiring at all — proving that path instead
  // requires actually changing the value and checking the new one landed.
  expect(entry.tags).toEqual(['diving']);
  expect(entry.fields).toEqual({ Price: '99' });
});

test('says what to do when the server cannot mint tokens', async ({
  context,
  extensionId,
}) => {
  const options = await openOptions(context, extensionId);
  // An older Hrček, without the exchange route, answers 404 here.
  await options.route(`${SERVER}/api/auth/tokens/exchange`, (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'HRC-CORE-0003', message: 'Not found.', details: {} },
      }),
    }),
  );

  await options.fill('#server-url', SERVER);
  await options.fill('#identifier', FAKE_IDENTIFIER);
  await options.fill('#password', FAKE_PASSWORD);
  await options.click('#create');

  await expect(options.locator('#status')).toHaveAttribute('data-kind', 'error');
  await expect(options.locator('#status')).toContainText('clients page');
});

test('closes itself after saving and says so on the page', async ({
  context,
  extensionId,
}) => {
  await configureToken(context, extensionId);

  // A real page, in its own tab, for the toast to land on.
  const page = await context.newPage();
  await page.goto(`${SERVER}/`);

  const popup = await openPopup(context, extensionId, `${SERVER}/`, 'Fake Hrček');
  await popup.click('#save');

  // The popup asked to close. Playwright opened it as an ordinary tab,
  // which window.close() cannot touch, so the e2e build marks the
  // document instead of vanishing.
  await expect(popup.locator('html')).toHaveAttribute('data-hrcek-closed', 'true');

  // And the confirmation is on the page, inside a shadow root.
  const toast = page.locator('#__hrcek-toast');
  await expect(toast).toBeAttached();
  await expect
    .poll(() => toast.evaluate((host: HTMLElement) => host.shadowRoot?.textContent ?? ''))
    .toContain('Saved.');
});

test('stays open when the entry itself could not be saved', async ({
  context,
  extensionId,
}) => {
  await configureToken(context, extensionId);
  const popup = await context.newPage();
  // The save was refused: this is the case where somebody must act, so
  // the popup must not disappear with the reason.
  await popup.route('**/api/entries/', (route) =>
    route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'HRC-CORE-0002',
          message: 'The submitted data is not valid.',
          details: {},
        },
      }),
    }),
  );
  const query = new URLSearchParams({ url: 'https://example.com/refused', title: 'R' });
  await popup.goto(`chrome-extension://${extensionId}/popup.html?${query}`);

  await popup.click('#save');
  await expect(popup.locator('#status')).toHaveAttribute('data-kind', 'error');
  await expect(popup.locator('html')).not.toHaveAttribute('data-hrcek-closed', 'true');
});

test('speaks the language the settings page chose', async ({ context, extensionId }) => {
  const page = await openOptions(context, extensionId);

  // Automatic names the language it resolved to, so "automatic" is
  // never a mystery.
  await expect(page.locator('#language option[value=""]')).toContainText('Automatic');
  await expect(page.locator('h1')).toHaveText('Settings');

  await page.selectOption('#language', 'sl');
  // Re-rendered immediately, not on the next open — this is a page
  // somebody may never return to.
  await expect(page.locator('h1')).toHaveText('Nastavitve');
  await expect(page.locator('#save')).toHaveText('Shrani');
});

test('keeps the chosen language once there are settings to keep it in', async ({
  context,
  extensionId,
}) => {
  await configureToken(context, extensionId);
  const page = await openOptions(context, extensionId);

  await page.selectOption('#language', 'sl');
  await expect(page.locator('h1')).toHaveText('Nastavitve');

  await page.reload();
  await expect(page.locator('h1')).toHaveText('Nastavitve');
  await expect(page.locator('#language')).toHaveValue('sl');
});

test('keeps the account link live and the create-token panel folded across a language switch', async ({
  context,
  extensionId,
}) => {
  await configureToken(context, extensionId);
  const page = await openOptions(context, extensionId);

  // A held token already folded the panel away, and the link already
  // points at this server — both are restored state, not a fresh render.
  await expect(page.locator('#create-token')).toHaveJSProperty('open', false);
  await expect(page.locator('#account-link')).toHaveAttribute(
    'href',
    `${SERVER}/accounts/me/clients/`,
  );

  await page.selectOption('#language', 'sl');

  // The re-render must not lose either: restoring the server address by
  // property assignment fires no `change` event, and the fold-away check
  // must not silently reset to the template's default `open`.
  await expect(page.locator('#account-link')).toHaveAttribute(
    'href',
    `${SERVER}/accounts/me/clients/`,
  );
  await expect(page.locator('#create-token')).toHaveJSProperty('open', false);
});

test('says when your fields could not be read, instead of hiding them', async ({
  context,
  extensionId,
}) => {
  await configureToken(context, extensionId);
  const popup = await context.newPage();
  await popup.route('**/api/fields/**', (route) => route.abort('failed'));
  const query = new URLSearchParams({ url: 'https://example.com/fieldless', title: 'F' });
  await popup.goto(`chrome-extension://${extensionId}/popup.html?${query}`);

  // Silence here reads as "this account has no fields", which is a
  // different and wrong thing.
  await expect(popup.locator('#fields-trouble')).toContainText(
    'fields could not be loaded',
  );
  // Saving is still allowed: omitted fields are patched, not cleared.
  await popup.click('#save');
  await expect(popup.locator('#status')).toContainText('Saved.');
});
