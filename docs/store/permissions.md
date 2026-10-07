# Permissions, and why each one is asked for

Written for a store reviewer. Each entry says what the extension does
with the permission, and what stops working without it.

## `activeTab`

Reads the address and title of the tab you are on, at the moment you
click the extension's button, so the popup can offer to save that page.
It also allows the two on-demand scripts — the one that reads which
pictures the page offers, and the one that shows the confirmation after
a save — and the one plain request that fetches a chosen picture's
bytes directly from the page, before they are uploaded to Hrček. None
of this runs on page load: nothing runs on a page until you press the
button.

## `storage`

Keeps the server address, the API token and the preferences in
`storage.local`. Never `storage.sync`, which is replicated and
unencrypted. A short-lived cache of recent saved/not-saved answers also
lives in `storage.session` (memory-only, cleared when the browser
closes) so the toolbar badge survives Chrome's service worker going
idle; see `docs/store/privacy.md` for what it holds. Entries kept
while Hrček cannot be reached live in the extension's own IndexedDB
storage until they are sent or deleted; see `docs/store/privacy.md`.

## `contextMenus`

Adds two items to the menu of the extension's own toolbar button: one
opens the list of entries waiting to be saved to Hrček, the other tries
to save them now. Nothing is added to the menu of web pages.

## `tabs`

The toolbar button ticks the hamster on a page you have already saved.
Deciding that needs each tab's address as you browse, which `activeTab`
does not provide — it reveals a tab's URL only after a click on that
tab. It grants no access to page content. With "Show whether a page is
already saved" turned off in settings, the extension still receives
those addresses but asks nothing about them: no request leaves the
browser, and the address is used for nothing else.

## `scripting` (Chrome only)

Runs the two on-demand scripts above. Firefox reaches the same thing
through `tabs.executeScript`, which `activeTab` already covers.

## `<all_urls>`, optional and requested at runtime

Not held at install. The Hrček server's address is configured by the
person using the extension and can be any host, so its origin is asked
for from the settings page the moment it is saved. This permission is
requested for the configured Hrček server only.
