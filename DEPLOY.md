# Deployment Guide

Odta is a static PWA — no build step, no server-side code, no API. You just need to host the files.

## Web app manifest `id`

[`manifest.json`](manifest.json) uses `"id": "./"`. The browser resolves it relative to the manifest URL, so the installed app identity matches **whatever directory hosts** `index.html` and `manifest.json` — site root (`https://example.com/`) or a subpath (`https://<user>.github.io/odtaulai/`) without editing the file.

Changing `id` later can make existing installs look like a separate app until old entries are removed.

## Option 1: Netlify (easiest, free, 30 seconds)

1. Go to https://app.netlify.com/drop
2. Drag the repository root (all project files) onto the page
3. Netlify gives you a URL like `https://random-name.netlify.app`
4. Visit the URL on your phone → install as PWA

**Custom domain:** Site settings → Domain management → Add custom domain.

---

## Option 2: GitHub Pages (free, permanent URL)

1. Create a new GitHub repo (e.g., `odtaulai`)
2. Upload all project files to the repo root
3. Repo Settings → Pages → Source: `main` branch, `/` (root)
4. Wait ~2 minutes, then visit `https://<username>.github.io/odtaulai/`

---

## Option 3: Vercel (free, fast)

```bash
cd /path/to/OdTauLai
npx vercel
```

Follow the prompts — it'll give you a URL.

---

## Option 4: Cloudflare Pages (free, great for custom domains)

1. Push files to GitHub
2. Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git
3. Select the repo; build command: `(none)`; output directory: `/`
4. Deploy

---

## Option 5: Your own server (Nginx example)

Copy the project folder to your server. Nginx config:

```nginx
server {
    listen 443 ssl http2;
    server_name odtaulai.example.com;

    root /var/www/odtaulai;
    index index.html;

    # Cache static assets for 1 year
    location ~* \.(png|jpg|jpeg|gif|ico|svg)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Service worker: never cache
    location = /sw.js {
        expires -1;
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }

    # Manifest: short cache
    location = /manifest.json {
        expires 1h;
        add_header Cache-Control "public";
    }

    # SPA fallback (not strictly needed here since we only have index.html)
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

---

## Option 6: Python one-liner (LAN / local test)

```bash
cd /path/to/OdTauLai
python3 -m http.server 8080
# Open http://YOUR-LAN-IP:8080 from your phone (same Wi-Fi)
```

**Note:** Without HTTPS, service workers only work on `localhost`. For LAN testing on mobile, use one of the cloud options above.

---

## Option 7: Caddy (auto-HTTPS, one command)

```bash
caddy file-server --domain odtaulai.example.com --root .
```

---

## Verifying the PWA installed correctly

After deploying, visit the site and open DevTools (desktop) or Safari Web Inspector (iOS):

- **Chrome DevTools:** Application tab → Manifest → should show "Odta" with icons
- **Application tab → Service Workers:** should show `sw.js` registered and running
- **Lighthouse:** Run PWA audit — should score 100%

### Expected behavior

1. Visit site → browser shows install icon in address bar (desktop) or "Add to Home Screen" is suggested (mobile)
2. Install → app opens in its own window with the Odta icon
3. Turn off Wi-Fi → app still loads (service worker serves from cache)
4. Tasks, timers, settings all persist across sessions and reloads

---

## Troubleshooting

**"Install button doesn't appear"**
- Chrome requires: HTTPS + valid manifest + registered service worker + served from non-file URL. Check all three in DevTools.
- iOS Safari never shows an install button — users must tap Share → Add to Home Screen.

**"Service worker not registering"**
- Check the file is at exactly `./sw.js` relative to index.html
- Check DevTools Console for errors
- On file://, service workers don't work at all — must be served via http(s) or localhost

**"Offline doesn't work"**
- First visit caches everything; reload once while online before testing offline
- Check Application → Cache Storage in DevTools — should see an `odtaulai-v*` cache (version matches [sw.js](sw.js)) with precached assets

**"Audio doesn't fire in background"**
- User must interact with the page first (browser autoplay policy)
- Install as PWA for best background behavior
- Fully closing the browser stops all JavaScript — no workaround for this

---

## Custom icon

Want a different icon? Replace these files under `icons/` with your own PNGs (keep the same names and sizes):
- `icons/icon-192.png` (192×192)
- `icons/icon-512.png` (512×512)
- `icons/icon-maskable-512.png` (512×512, safe zone in center 80%)
- `icons/apple-touch-icon.png` (180×180)
- `icons/favicon-32.png` (32×32)

Root `favicon.ico` is separate; update if you replace the browser tab icon.

Then update `manifest.json` colors to match your brand:
- `background_color` — splash screen background
- `theme_color` — address bar / status bar tint

---

## Content-Security-Policy (CSP)

Odta ships a permissive meta CSP in `index.html` — practical, not maximalist. The shipped policy allows `'unsafe-inline'` (the app uses inline `onclick` handlers throughout), `'wasm-unsafe-eval'` (Transformers.js needs it), and broad `connect-src http: https:` (calendar feeds in `js/calfeeds.js` accept user-configured CORS proxy URLs). On most static hosts (Netlify, GitHub Pages, Vercel, Cloudflare Pages) this is what gets served and everything works.

If your host wants to enforce a stricter CSP via HTTP headers (overriding the meta tag), the embedding model needs at least these allow-list entries:

```
default-src 'self';
script-src  'self' https://cdn.jsdelivr.net;
style-src   'self' 'unsafe-inline';
img-src     'self' data: blob:;
worker-src  'self' blob: https://cdn.jsdelivr.net;
connect-src 'self' https://cdn.jsdelivr.net https://huggingface.co https://cdn-lfs.huggingface.co https://*.huggingface.co;
```

Note: this stricter alternative drops `'unsafe-inline'` from `script-src`, which will break the inline `onclick` handlers in `index.html`. Migrate them to `addEventListener` first if you need this. It also tightens `connect-src` to the inference endpoints only — calendar feeds via user proxies will be blocked.

Why each entry:
- `cdn.jsdelivr.net` — Transformers.js ESM module + its WASM/worker assets.
- `huggingface.co` + `cdn-lfs.huggingface.co` — embedding model weights (`Xenova/bge-small-en-v1.5`).
- `worker-src blob:` — Transformers.js spawns a Web Worker from a blob URL for background inference.

If you enable P2P sync (PeerJS), also add your signalling server (default `wss://*.peerjs.com`) to `connect-src`.
