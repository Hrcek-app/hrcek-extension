# Picture chooser — design

Date: 2026-10-07
Status: approved

Builds on [v3](2026-09-23-hrcek-extension-v3-design.md). Replaces the
popup's picture picker; nothing about how a picture is saved changes.

## Purpose

The current picker is cumbersome. Its tiles are 2.4rem squares, too
small to judge a picture by; the larger preview is capped at 7rem and
has to be expanded by hand; and the strip shows exactly four tiles
(`WINDOW = 4` in `popup/picker.ts`) whatever the popup's width, so it
did not grow when the popup did.

The new chooser makes the common case — the page's first picture is the
right one — need no action at all, and makes choosing a different one a
dedicated, full-popup task with a picture large enough to review.

## Behaviour

### The form row

The Picture row shows:

- an **Include picture** checkbox;
- when it is ticked, the selected picture (at about the current 7rem
  hero height) and a **Change** button.

Unticking hides the picture and Change; nothing is sent for the picture
(see "What is saved"). Ticking again brings both back with the same
selection as before — unticking does not forget the selection.

Change is shown only when there is something else to pick: two or more
pictures in total (candidates plus the held picture).

The row is absent, as now, when the page offers no candidates and the
entry holds no picture.

### Starting state

| Situation                                         | Checkbox   | Selected                      |
| ------------------------------------------------- | ---------- | ----------------------------- |
| New address, page has candidates                  | ticked     | first candidate               |
| Saved entry that holds a picture                  | ticked     | the held picture              |
| Saved entry that holds no picture, has candidates | unticked   | first candidate (once ticked) |
| No candidates, no held picture                    | row absent | —                             |

The unticked start for a saved, pictureless entry keeps the existing
rule: reopening an entry to fix a typo must not quietly add a picture.

A held picture whose bytes could not be fetched (`held.src === null`)
is shown as a placeholder reading "It has a picture that cannot be
shown here", in the row, the preview and its strip tile. It behaves
like any other held picture.

### The chooser overlay

Change opens an overlay that covers the whole popup:

- **Preview** — the selected picture, as large as the space allows
  (`object-fit: contain`), with a fixed caption **Selected** over it.
  Clicking the preview confirms and closes the overlay.
- **Strip** — below the preview, spanning the full width. Every
  picture: the held one first, tagged **current**, then the page's
  candidates in harvest order. Tiles are larger than today's (around
  4.5rem) and as many fit as the width allows; the strip scrolls
  horizontally. ‹ › buttons scroll by one strip width and are disabled
  at either end. The selected tile is highlighted.
- **Close** — closes the overlay, keeping the current selection.

Clicking a tile selects it, and the preview follows. Selecting in the
overlay is the selection: there is no cancel, and Close and clicking
the preview do the same thing. The overlay has no "no picture" tile —
the checkbox does that job.

Keyboard: the overlay opens with focus on the selected tile, scrolled
into view. ←/→ move the selection. Escape closes the overlay like Close
— unless the browser closes the whole popup on Escape before the page
sees it (to be checked in Chrome); then Escape is simply not promised.

### Popup size

A browser popup takes its size from its content, capped at 800×600,
and cannot be resized by the person. The overlay keeps the popup's
440px width and makes it about 600px tall while open; closing it
returns the popup to the form's own height. A landscape picture
(og:image is typically 1200×630) previews at about 416×220px, and a
portrait one uses the remaining height.

Widening the popup to 800px was considered and deferred: a bigger
preview, but a popup that jumps sideways from its toolbar button, and
Firefox has a history of resizing popups badly after they open. Try
this first and revisit.

## What is saved

`PictureChoice` (`lib/picture.ts`) is unchanged, as are
`fetchPictureBytes`, `attachPicture` and `submitSave`. The chooser maps
its state onto the existing choice:

| State                            | `PictureChoice`                         |
| -------------------------------- | --------------------------------------- |
| Unticked, entry holds a picture  | `none` — the picture is removed on save |
| Unticked, entry holds no picture | `unchanged`                             |
| Ticked, held picture selected    | `unchanged` — nothing is re-sent        |
| Ticked, a candidate selected     | `url` — that candidate                  |

## Structure

The picker is split into a state model and two views. `popup/picker.ts`
and its test are deleted.

- **`popup/picture-state.ts`** — pure, no DOM. Built from
  `{ candidates, held, existing }`; holds `included` and `selected`;
  exposes the list of pictures (held first), `select(key)`,
  `setIncluded(flag)`, `canChange()` and `choice(): PictureChoice`.
  Every rule in "Starting state" and "What is saved" lives here. It
  sits in `popup/` rather than `lib/` because it is this view's state,
  not save logic; it imports only types from `lib/`.
- **`popup/picture-row.ts`** — the form row: checkbox, picture,
  Change. Renders from the state, sends it events, asks to open the
  overlay.
- **`popup/picture-overlay.ts`** — the chooser: preview, caption,
  strip, Close. Mounted over `#app` on open and removed on close; it
  sets the popup's height while open and restores it after.

`popup/main.ts` keeps one handle for `choice()`. The `focusin`
listener and both `collapse()` calls go away — there is no inline
preview left to put away. `renderForm` re-mounts the row, as it
re-mounts the picker today.

Untrusted addresses keep today's rule: pictures are drawn with `src`
assigned as a property on created elements, never interpolated into
markup.

Messages are new Lingui literals (`Include picture`, `Change`,
`Selected`, `current`, `Close`, strip button labels) and both
catalogues are updated with `pnpm i18n:extract`. Messages the old
picker used and the new one does not are dropped from the catalogues.

## Testing

TDD, as usual.

- **`picture-state.test.ts`** — every row of both tables above;
  untick/retick keeps the selection; `canChange()` with one and with
  several pictures; held picture first in the list.
- **`picture-row.test.ts`** and **`picture-overlay.test.ts`** (DOM,
  replacing `picker.test.ts`) — checkbox hides and restores the picture
  and Change; Change absent with a single picture; row absent with
  nothing; tile click moves the selection and the preview; preview
  click and Close both close and keep the selection; ←/→ move the
  selection; the unshowable placeholder; an address containing `"`
  stays inert.
- **e2e** (`tests/e2e/save-flow.spec.ts`) — open the popup on a page
  with several pictures, Change, pick the second, Close, save; the fake
  Hrček receives that picture. And: untick, save; no picture is sent.
- **Manual** — `pnpm dev` in Firefox: the popup grows to ~600px on
  Change and shrinks back on close; the strip fills the width; Escape
  behaviour in both browsers.

## Out of scope

- Widening the popup while choosing (see "Popup size").
- Adding a picture from outside the page (upload, pasted address),
  cropping, or more than one picture per entry.
- Any change to how pictures are harvested from the page.
