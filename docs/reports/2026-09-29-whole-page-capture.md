# Storing a whole page: what the browsers actually give us

Date: 2026-09-29
Status: research note. No decision taken, nothing implemented.

Groundwork for a feature that does not exist yet: letting somebody store
the contents of a page, not just its address. It also answers a smaller
question asked at the same time — whether the popup can be resized —
because the two turn out to constrain each other.

Everything below was checked against the browsers' own documentation on
the date above, not recalled. The links are at the bottom, and the gaps
are named rather than smoothed over.

## The short version

Each browser's best whole-page tool belongs to that browser alone.
Firefox can screenshot a full page and save a PDF; Chrome can write the
page and its resources into one MHTML file; neither can do the other's
trick, and Safari does none of it. Anything that must work the same in
all three has to be built on what they share: a content script reading
the DOM.

The permissions story is better than the capability story. A first
version that stores the article text needs **no permission the extension
does not already hold**, and anything beyond it can be asked for at the
moment it is used, with our own explanation shown first.

## What each browser offers

| Capability                         | Chrome                                                             | Firefox                                     | Safari                                                |
| ---------------------------------- | ------------------------------------------------------------------ | ------------------------------------------- | ----------------------------------------------------- |
| Screenshot of the visible viewport | `tabs.captureVisibleTab`                                           | same                                        | supported, with a reported failure on extension pages |
| Full-page screenshot in one call   | no — scroll and stitch yourself                                    | **`tabs.captureTab(tabId, {rect, scale})`** | no                                                    |
| Whole page + resources in one file | **`pageCapture.saveAsMHTML`**                                      | no                                          | no                                                    |
| Save as PDF                        | no — only `window.print()`, where the person chooses "Save as PDF" | **`tabs.saveAsPDF()`**                      | no                                                    |
| Reader mode                        | no                                                                 | `tabs.toggleReaderMode()`                   | no                                                    |
| Reader-style extraction            | Readability.js in a content script                                 | same                                        | same                                                  |

Three details matter more than the table suggests.

**`tabs.captureTab`'s `rect` is relative to the page, not the viewport**,
and omitting it captures only what is visible. Passing the document's
full height is therefore a full-page screenshot in one call. It arrived
in Firefox 82 and exists nowhere else.

**`tabs.saveAsPDF()` opens the operating system's save dialog.** It does
not save silently, and it answers with `saved`, `replaced`, `canceled`,
`not_saved` or `not_replaced`. That makes it a fine thing to offer a
person and a poor thing to build a pipeline on.

**`pageCapture.saveAsMHTML` is the closest thing to "the whole page"** —
one file holding the document and its stylesheets and images. Chrome
notes that an MHTML file can only be _loaded_ from the file system and
only in the main frame. That restricts viewing it, not producing it: the
API hands back a Blob, which is what an upload needs.

`tabs.toggleReaderMode()` is worth naming only to rule it out. It toggles
the view; it does not hand over the extracted text. Reader content has to
be extracted by us either way.

## The one approach that works everywhere

Readability.js — Mozilla's own library, the engine behind Firefox's
reader view — run in a content script. It yields a title, a byline and
cleaned article HTML from the live DOM, identically in all three
browsers.

It is also the format most likely to be worth something later. Text can
be searched, excerpted and re-rendered; a screenshot cannot. Per-browser
extras (a full-page image on Firefox, an MHTML archive on Chrome) layer
on top for people who want the page as it looked, and degrade to nothing
where the browser lacks them.

## Permissions, and asking for them honestly

**A text-first version needs nothing new.** `activeTab` plus `scripting`
already covers injecting a script into the page when somebody clicks the
toolbar button — exactly what the picture harvesting does today. That is
a strong argument for shipping that version first: no new warning, no new
review question, no new reason for somebody to say no.

Beyond that, extras can be requested at the moment of use:

- Declare them under `optional_permissions` / `optional_host_permissions`.
  Optional permissions produce **no install-time warning**.
- `permissions.request()` may only be called, in MDN's words, "inside the
  handler for a user action". So the sequence is forced to be the honest
  one: our own UI explains what the capability is for, the person presses
  "Enable full-page capture", and _that press_ is the gesture that opens
  the browser's prompt. The explanation cannot come after the ask.
- The options page already works this way, requesting the configured
  server's origin when the address is saved.

### `activeTab` is narrower than it looks

It is granted by a direct gesture on the extension itself — the icon, a
context-menu item, a keyboard shortcut — and it lapses on navigation. It
is **not** granted by a button inside a side panel.

This is where the two questions meet. A side panel is the resizable,
stays-open surface that a "capture this page" feature might want. Choosing
it would mean giving up `activeTab` and asking for `tabs` plus host
permissions instead — a far larger ask, at install time, for every site.
The popup keeps the small permission story. That trade should be made
deliberately, not discovered later.

## The popup, since it was asked

The popup **cannot be resized** by the person using it, in any of the
three browsers. There is no handle and no API. It sizes itself to its
content, up to **800×600** in both Chrome and Firefox.

Ours is 360px wide because `src/entrypoints/popup/style.css` says so. That
is our decision, not a limit — there is more than double the room
available. The popup can also read the screen (`window.screen.availWidth`
and friends, no permission required) and size itself accordingly.

Two constraints on doing that:

- Firefox computes the size from the **`<body>`** element, not `:root`.
  The width must stay where it already is.
- If somebody moves the button into Firefox's overflow menu, the popup is
  given a **fixed** width and any adaptive sizing is ignored.

For a surface that really is resizable: a detached window
(`windows.create({type: 'popup'})`), an extension page in a tab, or the
side panel — with the `activeTab` cost noted above.

## What has not been checked

- Whether Chrome accepts `pageCapture` in `optional_permissions`, and
  what warning it shows if so. This decides whether MHTML can be an
  ask-when-used extra or has to be an install-time permission.
- Safari's optional-permission behaviour, and how much of any of this it
  supports in practice. Safari is already the weakest target.
- That Firefox has no `pageCapture` — believed, not verified against
  documentation.
- Nothing here has been tried in a running browser. These are
  documentation claims.

## Questions for the server side

The extension cannot settle these alone:

- What does Hrček store — extracted text, original HTML, an MHTML
  archive, an image, several of these?
- How large may an upload be? An MHTML archive of a media-heavy page runs
  to megabytes, far beyond the 10 MB picture ceiling in places.
- Does stored content need its own API route, or does it extend the entry?

## Sources

- [tabs.captureTab](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/captureTab)
- [extensionTypes.ImageDetails](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/extensionTypes/ImageDetails) — the `rect` semantics
- [tabs.saveAsPDF](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/saveAsPDF)
- [chrome.pageCapture](https://developer.chrome.com/docs/extensions/reference/api/pageCapture)
- [permissions.request](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/permissions/request)
- [Popups](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/user_interface/Popups)
- [Managing Safari web extension permissions](https://developer.apple.com/documentation/safariservices/safari_web_extensions/managing_safari_web_extension_permissions)
