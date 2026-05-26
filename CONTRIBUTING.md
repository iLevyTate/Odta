# Contributing

Thanks for helping improve Odta.

## Principles

- Keep it **vanilla**: no framework, no bundler, no build step for the main app.
- Keep it **local-first**: no new outbound network calls without a clear opt-in.
- Run **`node --check`** using the CI file list in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) before committing.
- Run **`npm test`** (`scripts/run-tests.mjs`; Windows-safe) for the full regression suite — use **`npm ci`** so smoke/Puppeteer versions match CI.
- After UI wiring changes, **`npm run serve:smoke`** plus **`npm run smoke`** catches broken `data-action` delegation (same as CI).

## Pull requests

- Small, focused diffs are easier to review than large refactors.
- If you change the release identity, update [`js/version.js`](js/version.js) and keep [`sw.js`](sw.js) `CACHE_NAME` in sync (see tests).
