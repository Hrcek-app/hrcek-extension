# What leaves your browser

The extension talks to two kinds of host: the Hrček server you
configured, and — only when the page you are saving has a picture —
that page's own host, to fetch the picture's bytes before handing them
to Hrček. Nothing else is contacted, and there is no analytics,
telemetry or error reporting of any kind.

**Sent to your Hrček, when you save a page:** its address, the title,
your notes, tags, the values of your own fields, and a picture if you
chose one. When the toolbar's saved-state indicator is on, the address
of a page you visit is also sent, to ask whether you already hold it.
That indicator can be switched off in settings, and then nothing is
sent until you press Save. Every request to Hrček also carries a
standard `Accept-Language` header naming the interface language you've
chosen, or your browser's own — the same header ordinary web requests
send by default.

**Fetched from the page itself, when you save a picture:** the
picture's bytes, from wherever the page says they live — usually the
page's own host, not Hrček. No cookies are sent with that request. The
bytes are then uploaded to Hrček along with the rest of the entry.

**Kept in the browser:** the server address, the API token and your
preferences, in `storage.local` — local to the machine, never synced.
A short-lived cache of up to 500 recently-looked-up addresses, and
whether each is already held, lives in `storage.session` — memory-only,
never written to disk, each entry forgotten after five minutes.
Saving a page always records an entry in this cache, even with the
saved-state indicator switched off — the setting only stops the cache
being read, not written. Signing in with a new token, or switching the
indicator off, clears everything already recorded; closing the browser
clears it outright.

While your Hrček cannot be reached, a save is kept in the extension's
own IndexedDB storage instead: what it would have sent (address,
title, notes, tags, field values), the picture you chose, when it was
saved, and the server address it was meant for. At most 100 are kept.
Each one stays until it is saved to that server or you delete it from
the "Waiting to sync" page, and it is never sent anywhere else.
Removing the extension deletes them all.

**Never kept:** your password. It is used once, to ask Hrček for a
token, and is written nowhere.

**Never collected:** page contents, form data, or anything beyond what
is described above. The browser does hand the extension each tab's
address as you browse — that is what the `tabs` permission is for — but
that address leaves your browser only when you press Save, or when the
saved-state indicator asks your Hrček about it. With the indicator off,
nothing is sent at all until you press Save.
