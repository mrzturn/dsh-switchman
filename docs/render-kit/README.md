# Screenshot render kit

Regenerates the eleven `conf-interface*.png` screenshots in `docs/assets/`
from the current `client.js` — offline, no DSH app, no host build. Use it
whenever the settings UI changes (new card, new locale, copy edits) and the
README screenshots need to follow.

## How it works

- `render.cjs` copies the repo root `client.js` here (gitignored), then
  drives headless Chrome via `playwright-core`.
- `page.html` boots the real client bundle with a faithful environment mock:
  a `window.fetch` serving canned `config` / `models` / `authorized` replies,
  a `__ModuleLoader__` sink, and a Host locale contract
  (`register` / `bind` / `getLocale` / `subscribe`) so `?locale=` walks the
  exact production startup path (`applyUiLocale` → `EXTRA_UI_DICTS`).
- Each locale renders at 1000×900 @2x; the `[data-dsh-switchman="settings"]`
  element is screenshotted to `docs/assets/`, one filename per locale.

The unsuffixed `conf-interface.png` is the `auto` capture resolved against a
demo app locale of `zh` (matches the zh README).

## Usage

```sh
cd docs/render-kit
npm install        # playwright-core + react/react-dom UMD, one-time
node render.cjs
```

Prerequisite: a local Chrome. The driver first tries Playwright's
`channel: 'chrome'`; if that fails, the macOS executable path
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. On other
systems, adjust the fallback in `render.cjs`.

Exit code is non-zero when any locale fails; details land in
`failures.json` (gitignored).

## When you touch things

- **New UI locale** — add `['<tag>', 'conf-interface-<tag>.png']` to
  `TARGETS` in `render.cjs`, add the path to the root `screenshots.json`,
  and link it from the matching README.
- **Different demo values** (watermark numbers, pool routes, catalog) — edit
  the mocks at the top of `page.html`; keep them plausible but generic.
- This directory never ships: the package `files` allowlist in the root
  `package.json` excludes `docs/` from the npm tarball.
