# Security

Odta is a static, local-first PWA. Report sensitive issues privately to the repository maintainers (use GitHub Security Advisories if enabled for this repo).

## Threat model (short)

- **Your device**: Task data lives in `localStorage` and IndexedDB. Anyone with access to the unlocked browser profile can read or modify it.
- **Optional P2P sync**: Pair only with devices you trust. Incoming connections must be explicitly accepted; treat unexpected prompts as suspicious.
- **Calendar URLs**: Only subscribe to HTTPS feeds you trust. The app fetches ICS content in your browser; malicious feeds could try large responses or confusing text (mitigated with size and timeout limits).
- **Content Security Policy**: See `index.html`. The policy is intentionally **practical, not maximalist**: it allows normal patterns people actually use (HTTP or HTTPS calendar URLs when the app itself is served over HTTP — e.g. local `python -m http.server`; any HTTPS feed or proxy; Hugging Face / jsDelivr / unpkg; WASM for on-device embeddings; PeerJS signalling). When you host the app on **HTTPS**, the browser still blocks mixed `http://` subresources — that’s separate from CSP. Tightening further is a trade-off against “subscribe to this random `.ics` URL and it just works.”

## Coordinated disclosure

Please allow a reasonable time to fix before public disclosure. For non-sensitive bugs, open a normal issue.
