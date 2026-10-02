# Hrček extension — working agreement

Browser extension clients for the Hrček link-saving service. Firefox
ships first; Chrome is a verified build target too, and Safari builds
from the same code. The popup and options page follow the browser's
language automatically; a person can also pick one by hand in settings.
The server lives in `../hrcek` — its API guide is
`../hrcek/docs/dev/api.md`, its error codes
`../hrcek/docs/dev/error-codes.md`, and its OpenAPI schema is vendored
here at `docs/api/openapi.json`.

Design spec: `docs/superpowers/specs/2026-09-16-hrcek-extension-design.md`.

## Commands

- `pnpm dev` — run in real Firefox with auto-reload (primary target)
- `pnpm test` / `pnpm test:watch` — unit + contract tests (Vitest)
- `pnpm test:e2e` — builds the e2e Chrome target, runs Playwright
  against the in-repo fake Hrček (`tests/fake-hrcek/`)
- `HRCEK_URL=… HRCEK_TOKEN=… pnpm vitest run tests/contract/real.test.ts`
  — contract tests against a real, locally running Hrček (opt-in)
- `pnpm typecheck && pnpm lint` — must pass before any commit; the
  `.githooks/pre-commit` hook runs these plus `pnpm test` and refuses
  the commit if any fails. `pnpm install` installs the hook (the
  `prepare` script points `core.hooksPath` at `.githooks`). The
  end-to-end suite is too slow for the hook and runs in CI instead.
- `pnpm build` / `pnpm zip` — Firefox production build / AMO zip
- `pnpm build:chrome` / `pnpm zip:chrome` — Chrome production build /
  Chrome Web Store zip
- `pnpm refresh-schema` — re-vendor `openapi.json` from `../hrcek` and
  regenerate `src/lib/api/types.gen.ts`. Run when the server API changes.
- `pnpm i18n:extract` — rebuild `src/locales/*.po` from the code. Run
  after adding or changing any message.

## Messages

Messages go through Lingui, keyed by their English text: write
`i18n._('Save')`, never an invented key. `pnpm i18n:extract` then finds
it and adds it to both catalogues, reporting what is still untranslated.

- **The extractor reads literals.** A message held in a variable never
  reaches the catalogue, which is why `lib/badge.ts` returns a name the
  entrypoint turns into a message rather than the message itself.
- **Catalogues are `src/locales/*.po`** — English and translation on
  adjacent lines. Nothing compiled is committed; `@lingui/vite-plugin`
  compiles on import, and it must be registered in `vitest.config.ts` as
  well as `wxt.config.ts`.
- **Both catalogues load statically**, because the background is a
  classic script on both targets and a service worker cannot
  dynamic-import. Rendering stays synchronous as a result.
- A test fails the build on any untranslated message. Deliberate while
  the catalogue is small.

## Architecture rules

- **`src/lib/` never imports from `src/entrypoints/`.** All reusable
  logic (API client, auth, settings, save flow) lives in `lib/`;
  entrypoints are thin DOM wiring.
- **Browser-specific code climbs a ladder — always use the lowest rung
  that works:** (1) per-browser manifest config in `wxt.config.ts`;
  (2) `import.meta.env.FIREFOX`-style build-time switches;
  (3) a platform module in `src/lib/platform/` behind a shared
  interface; (4) per-browser entrypoints. Adding a browser must be a
  build target, not a port.
- `src/lib/api/types.gen.ts` is generated — never edit it by hand.

## API gotchas (they bite)

- `POST /api/entries/` is an upsert: 201 created, 200 updated. It
  REPLACES the entry — omitted attributes are cleared — EXCEPT
  `fields`, which is PATCHED (send `""` to clear one field; omitting
  `fields` changes none of them).
- Always look before writing: `POST /api/entries/lookup` with the address
  in the body (404 + `HRC-CORE-0003` means not held). The popup does this
  on open. It is a POST for a read on purpose — an address is the private
  half of an entry, and a query string lands in every access log the
  request passes through, so it never goes in one.
- Branch on error `code`, never on `message` — messages are translated
  and may be reworded. Show `message` to people, though.
- Never hard-code field names. `Price`/`Priority` are only the defaults
  of a fresh account; fields are per-account, renameable, deletable.
- Addresses match on trimmed whitespace + lowercased scheme/host and
  nothing else: a trailing slash or `www.` is a different address.

## Security rules

- The API token lives in `browser.storage.local` only — never
  `storage.sync` (unencrypted, replicated).
- The password is NEVER persisted anywhere. It is used once for
  `POST /api/auth/tokens`, which returns a token; only the token is kept.
- **Bearer tokens are the only credential.** Session authentication is
  not an option for an extension: Django checks the `Origin` header
  before the CSRF token, and `moz-extension://<uuid>` can never be a
  trusted origin (the uuid differs per install). The client therefore
  sends `credentials: 'omit'` everywhere and holds no `cookies`
  permission. Do not reintroduce session auth.
- Minting a token is deliberately anonymous — the server refuses to mint
  one for a request that presents a token, so a leaked token cannot
  issue its own replacement.
- The manifest requires no host permissions; the configured server's
  origin is requested at runtime from the options page. Only the
  `--mode e2e` build adds localhost host permissions, for Playwright.

## Testing expectations

- TDD: behavior changes start with a failing test. Unit tests are
  colocated (`*.test.ts` next to the source).
- The fake Hrček (`tests/fake-hrcek/server.ts`) is typed against the
  generated schema and mirrors documented behavior including error
  codes; when the server API changes, update fake + tests together
  with `pnpm refresh-schema`.
- Production zips must contain no test code — WXT only bundles
  entrypoints; keep test files out of `src/entrypoints/` imports.
- e2e runs in Chromium (Playwright cannot load Firefox extensions);
  Firefox is covered by unit tests plus `pnpm dev` smoke checks.
- Tests gate twice: the pre-commit hook locally, and CI on every pull
  request and push to `main`. Never commit with `--no-verify` to dodge
  a failing test — fix the test or the code.

## Store paperwork

`docs/store/permissions.md` and `docs/store/privacy.md` are the
permission justifications and privacy statement written for store
reviewers. Update them alongside any change that adds a permission,
adds a host the extension talks to, or changes what is stored or sent.
