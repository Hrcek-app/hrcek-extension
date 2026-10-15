# Hrček extension

Browser extension for saving the page you are on to
[Hrček](https://github.com/Hrcek-app/hrcek), a simple self-hosted
bookmark manager with wish lists.
Firefox first; Chrome is a verified build target too, and Safari
builds from the same codebase. The popup and options page follow the
browser's language automatically; a language can also be chosen by
hand in settings.

## Develop

Requires [pnpm](https://pnpm.io) and Node 22+.

```bash
pnpm install
pnpm dev          # runs in real Firefox with auto-reload
pnpm test         # unit + contract tests
pnpm test:e2e     # Playwright e2e (Chromium + in-repo fake server)
pnpm build        # production Firefox build
pnpm build:chrome # production Chrome build
pnpm zip          # AMO-ready zip
pnpm zip:chrome   # Chrome Web Store-ready zip
```

See `CLAUDE.md` for architecture rules, `docs/superpowers/specs/` for
the design, and `docs/store/` for the permission justifications and
privacy statement written for store reviewers.
