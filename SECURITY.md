# Security

Odta is a static, local-first PWA. Report sensitive issues privately to the repository maintainers (use GitHub Security Advisories if enabled for this repo).

## Threat model (short)

- **Your device**: Task data lives in `localStorage` and IndexedDB. Anyone with access to the unlocked browser profile can read or modify it.
- **Optional P2P sync**: Pair only with devices you trust. The first connection between two devices must be accepted on the receiving device; that Accept mints a 256-bit pairing key both devices keep in `localStorage` (never in backups or the synced state). Every later connection proves the key in both directions (HMAC over a fresh nonce) before any data moves, so someone who registers a paired device's code while it is offline gets nothing. A "Re-pair request" banner means a device with a known code could not prove it: accept only if you reset that device. Sync requires a secure (https or localhost) page.
- **Calendar URLs**: Only subscribe to HTTPS feeds you trust. The app fetches ICS content in your browser; malicious feeds could try large responses or confusing text (mitigated with size and timeout limits).
- **Content Security Policy**: See `index.html` and `DEPLOY.md`. Scripts, styles and workers are same-origin only (every library is vendored), with `'wasm-unsafe-eval'` for on-device embeddings and no `'unsafe-inline'`. `connect-src` stays broad (`http:` / `https:`) on purpose so any calendar feed or CORS proxy you add just works, plus PeerJS signalling. When you host the app on **HTTPS**, the browser still blocks mixed `http://` subresources, which is separate from CSP.
- **Handler allowlist**: markup can only trigger functions named in `js/event-delegation.js`'s `HANDLERS` set, so an injected element can't call arbitrary globals.

## Coordinated disclosure

Please allow a reasonable time to fix before public disclosure. For non-sensitive bugs, open a normal issue.
