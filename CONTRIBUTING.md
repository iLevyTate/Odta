# Contributing

Thanks for helping improve Odta.

## Principles

- Keep it **vanilla**: no framework, no bundler, no build step for the main app.
- Keep it **local-first**: no new outbound network calls without a clear opt-in.
- Run **`node --check js/*.js`** before committing.
- Run **`node --test tests/`** when you touch release metadata or shared constants.

## Pull requests

- Small, focused diffs are easier to review than large refactors.
- If you change the release identity, update [`js/version.js`](js/version.js) and keep [`sw.js`](sw.js) `CACHE_NAME` in sync (see tests).
