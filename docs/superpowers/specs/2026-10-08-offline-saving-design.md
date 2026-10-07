# Offline saving — design

Date: 2026-10-08
Status: approved

Builds on [v3](2026-09-23-hrcek-extension-v3-design.md) and the
[picture chooser](2026-10-07-picture-chooser-design.md). Adds a local
queue for saves made while Hrček cannot be reached, and a way to send
them later.

## Purpose

Many Hrček servers are run by a family member, not an operator, and are
sometimes down. Today a save made then is simply lost: the popup says
the server cannot be reached and nothing is kept. The extension should
keep working through an outage: keep the entry, say plainly that it is
not on Hrček yet, and send it once the server is back. It must never
guess when the server already holds something at that address.

## Behaviour

### What counts as unavailable

A request that never got an answer (`HrcekNetworkError`), or one
answered 502, 503 or 504. Nothing else queues: a refused token, a
validation error or any other answer is shown as it is today, because
waiting will not fix it.

### Saving while Hrček is unavailable

- **On open,** the popup asks the background to sync (see "Syncing"),
  without waiting for it, and does its usual lookup.
- **Lookup finds Hrček unavailable:** the form opens as for a new page.
  In place of today's error, an info note reads "Hrček can't be
  reached. Saving keeps this entry here until it can." The button reads
  **Save for later**. The account's fields cannot be loaded, so none are
  shown, which is safe: an omitted field is never changed.
- **Save:** the picture's bytes are fetched as today. The entry, the
  bytes (or, failing those, the picture's address) and the server
  address are stored in the queue. The page confirms with a toast:
  "Kept for later — it will be saved to Hrček once it can be reached."
  Then the popup closes.
- **The lookup succeeded but the save itself finds Hrček unavailable:**
  the entry is queued the same way, with the same confirmation.
- **The queue already holds 100 entries:** the save is refused with
  "100 entries are already waiting to be saved. Sync or delete some
  first." The form stays open, so nothing typed is lost.

### The popup on an address that is already waiting

- **State waiting or refused:** the popup opens on the queued copy and
  says "Waiting to be saved to Hrček." Saving replaces the queued copy,
  online or not. One address has one queued copy at most.
- **State held for review:** the popup works normally against the
  server's entry. A note says "You also have an unsynced copy of this
  page — saving here replaces it." A successful save removes the
  queued copy.

### Syncing

Only the background script syncs, one sync at a time. It is asked to by
the popup opening, by **Sync now** in the toolbar context menu, and by
**Sync now** on the waiting page. There is no timer. Doing it in the
background means a popup closing mid-sync cannot leave an entry sent
but still queued, which the next sync would then mistake for one
already held.

Queued entries meant for the server in the current settings are
processed oldest first:

1. Look the address up (`POST /api/entries/lookup`).
   - **Unavailable:** stop. Everything stays queued.
   - **Token refused:** stop. The toolbar shows the existing "sign in
     again" state.
2. **Held** (200): mark the entry _held for review_. Nothing is sent.
3. **Not held** (404 `HRC-CORE-0003`): send it through the existing
   save path: `submitSave`, then `attachPicture` with the stored bytes,
   and `image_url` when there are none. Then remove it from the queue.
   - **Unavailable during the send:** stop. The entry stays queued as
     it was.
   - **Refused** (any other error answer): mark it _refused_ and keep
     the server's `message` to show.
   - **The picture was refused but the entry saved:** the entry counts
     as synced and is removed. The sync's result records it, so the
     waiting page can say "Saved without its picture: <title>".

Held and refused entries are not retried automatically. A held entry is
sent only when somebody presses **Replace with mine**. A refused entry
is sent again only when somebody saves it again from the popup.

After every sync, and after every change to the queue, the badge, the
context menu label and any open waiting page are brought up to date.

### Toolbar badge and context menu

- The badge shows how many entries are queued, in any state. It is
  global (no `tabId`), and empty at zero. It shares nothing with the
  saved-state indicator, which swaps the icon and never sets badge
  text.
- The toolbar button's context menu (`contexts: ['action']` on MV3,
  `['browser_action']` on MV2) has two items:
  - **Waiting to sync (N)…** opens the waiting page in a tab. N follows
    the queue.
  - **Sync now.**
- The page's own context menu is untouched.

### The waiting page

A new extension page, `entrypoints/pending/`.

- **Header:** "Waiting to sync", the count, a **Sync now** button, and
  the result of the last sync in one line ("Hrček can't be reached.",
  "3 entries saved.", "Saved without its picture: <title>").
- **Each entry:** its title, address, when it was saved, its tags, and
  the picture drawn from the stored bytes. Then, by state:
  - _Waiting:_ **Delete**, with a two-step confirmation on the page
    itself and no browser dialog.
  - _Held for review:_ the server's current entry is fetched and shown
    next to the queued copy (title, notes, tags, fields, picture), with
    **Keep what's on Hrček** (deletes the queued copy), **Replace with
    mine** (sends it now through the same save path, then removes it),
    and **Open page** (opens the address in a tab, where the popup takes
    over as described above). If Hrček is unavailable, the comparison
    says so and the first two buttons are disabled.
  - _Refused:_ the server's message, **Open page** and **Delete**.
  - _For another server:_ "Saved for <server>, which is not the one in
    your settings." and **Delete**.
- **Empty:** "Nothing is waiting."
- The page updates when a sync finishes or the queue changes.

## Structure

- **`lib/offline/queue.ts`:** the queue, in IndexedDB (database
  `hrcek`, store `pending`, keyed by the normalised address, i.e.
  trimmed, with the scheme and host lowercased, as the server matches).
  - Operations: `put`, `get`, `list` (oldest first), `count`, `remove`,
    `mark`.
  - `put` replaces any entry at the same address and refuses a new one
    beyond 100.
  - An entry holds the `SaveRequest` minus `imageUrl`, the picture as
    `{ kind: 'bytes', blob, filename } | { kind: 'url', url } | null`,
    `savedAt`, `server` (the settings' server URL at save time), and
    `state` (`waiting`, `held` or `refused`, plus `message` for
    refused).
  - IndexedDB stores Blobs natively and is shared by the popup, the
    waiting page and the background in both Firefox and Chrome. That is
    also how the picture's bytes reach the background, which Chrome's
    JSON-only messages cannot do.
- **`lib/offline/sync.ts`:** `syncQueue(client, queue, server)` runs
  the steps under "Syncing" and returns a result: counts saved, held,
  refused, the titles saved without a picture, and why it stopped, if
  it did. No browser APIs; the client and queue are passed in.
- **`lib/offline/unavailable.ts`:** `isUnavailable(error)` (network
  error, or a 502, 503 or 504 answer). `HrcekApiError` already
  carries the HTTP `status`.
- **`entrypoints/background.ts`:** runs `syncQueue` when asked by a
  `hrcek:sync` message or the menu, never two at once. Keeps the badge
  and the menu label current. Answers `hrcek:queue-changed` by
  repainting. Broadcasts `hrcek:synced` with the result.
- **`lib/platform/action.ts`:** the toolbar interface gains
  `setBadgeText` and `setBadgeBackgroundColor`. A small
  `lib/platform/menus.ts` hides `menus` and `contextMenus`, and
  `action` and `browser_action`.
- **`entrypoints/popup/main.ts`:** the decisions under "Saving while
  Hrček is unavailable" and "The popup on an address that is already
  waiting". The pure parts (which note, which button label, queue or
  send) live in a tested helper next to it, not in `main.ts`.
- **`entrypoints/pending/`:** the waiting page.

## Permissions and paperwork

- New permission: `menus` on Firefox and `contextMenus` on Chrome,
  declared in `wxt.config.ts` per browser.
- No new host and no `alarms`, `notifications` or `unlimitedStorage`
  permission.
- `docs/store/permissions.md`: why the menu permission is needed (two
  items on the toolbar button only).
- `docs/store/privacy.md`, "Kept in the browser": while Hrček cannot be
  reached, a save is kept in the extension's own IndexedDB storage
  (what the entry would have sent, its picture, and the server it was
  meant for) until it is synced or deleted, at most 100 entries. It
  never leaves the browser except to that server. Removing the
  extension deletes it.

## Messages

Every new message goes through Lingui with a Slovenian translation, as
usual. Sentences built around a server's message keep the server's
words verbatim, as `pictureTroubleText` does.

## Testing

TDD, as usual.

- **`queue.test.ts`**, against `fake-indexeddb` (new dev dependency):
  replace by address, the 100 limit, ordering, marking, Blobs surviving
  a round trip.
- **`sync.test.ts`**, against a fake client:
  - every step and branch above;
  - stopping leaves the rest untouched;
  - entries for another server are skipped;
  - held and refused entries are not retried;
  - the picture refusal is still counted as synced.
- **`unavailable.test.ts`**: which errors count.
- **The popup helper**: note, label and queue-or-send for each case
  above.
- **Waiting page (DOM)**: each state's actions; Delete's two-step
  confirmation; disabled buttons when Hrček is unavailable; addresses
  and titles inert (no markup injection).
- **Fake Hrček**: `POST /__outage` and `POST /__restore` make it answer
  503 to everything, or behave normally again.
- **e2e**:
  - Outage, save. The popup reports "Kept for later". The badge reads 1
    (`action.getBadgeText` through the service worker).
  - Restore, open the popup on another page. The entry reaches the
    server and the badge clears.
  - Outage, save an address. Restore, and save the same address
    directly to the server. Sync: it is held. On the waiting page, Keep
    leaves the server's entry; in a second run, Replace sends the
    queued copy.
- **Manual (Firefox):** the toolbar context menu and the badge, which
  Playwright cannot reach in Firefox.

## Delivery

One `gh stack`, roughly:

1. queue, sync and unavailability logic;
2. the background: runner, badge, menu and permission;
3. the popup's offline saving;
4. the waiting page, the e2e flows and the store paperwork.

## Out of scope

- Syncing on a timer or when connectivity returns.
- Editing a queued entry on the waiting page. The popup does that via
  **Open page**.
- Moving queued entries to a different server.
- Notifications outside the extension's own pages.
