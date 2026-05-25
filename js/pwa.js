(function(){
  const isFileProtocol = location.protocol === 'file:';

  // Inline fallback icon (for file:// where external PNGs can't be fetched by manifest)
  const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none">
    <rect width="512" height="512" rx="112" fill="#0a1320"/>
    <circle cx="256" cy="256" r="160" stroke="#1a2d44" stroke-width="18"/>
    <path d="M 256 96 A 160 160 0 1 1 96 256" stroke="#3d8bcc" stroke-width="22" stroke-linecap="round"/>
    <circle cx="256" cy="96" r="14" fill="#48b5e0"/>
    <text x="256" y="292" text-anchor="middle" font-family="monospace" font-weight="800" font-size="90" fill="#e2e8f0">28</text>
  </svg>`;
  const iconUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(iconSvg);

  // On file://, override to inline manifest + icons so install still works.
  // The full canonical manifest lives in manifest.json (served via the static
  // <link rel="manifest"> on http(s)); this minimal stub covers only what
  // file:// install actually needs. Fields like display_override, categories,
  // description, and orientation are intentionally absent here — duplicating
  // them was the M-2 drift surface that bit us during the v48 cleanup.
  if (isFileProtocol) {
    document.getElementById('pwa-apple-icon').href = iconUrl;
    document.getElementById('pwa-favicon').href = iconUrl;
    const path = location.pathname.split('/');
    const scope = path.slice(0, -1).join('/') + '/';
    const manifest = {
      name: 'Odta — On device task app using local ambient intelligence',
      short_name: 'Odta',
      start_url: scope + (path[path.length - 1] || ''),
      scope: scope,
      display: 'standalone',
      background_color: '#0a1320',
      theme_color: '#0a1320',
      icons: [
        {src: iconUrl, sizes: '192x192', type: 'image/svg+xml', purpose: 'any'},
        {src: iconUrl, sizes: '512x512', type: 'image/svg+xml', purpose: 'any'},
        {src: iconUrl, sizes: 'any', type: 'image/svg+xml', purpose: 'maskable'}
      ]
    };
    try {
      const manifestBlob = new Blob([JSON.stringify(manifest)], {type: 'application/manifest+json'});
      document.getElementById('pwa-manifest').href = URL.createObjectURL(manifestBlob);
    } catch(e) {}
  }

  // Listen for SW precache-incomplete reports. The previous behavior was
  // silent: a missing asset meant offline mode broke later with no clue.
  // Now we surface a small dismissable banner above the install affordance.
  try{
    const swStatusCh = new BroadcastChannel('odtaulai-sw-status');
    swStatusCh.addEventListener('message', (ev) => {
      if(!ev.data || ev.data.type !== 'precache-incomplete') return;
      const failed = Array.isArray(ev.data.failed) ? ev.data.failed : [];
      if(!failed.length) return;
      // Best-effort UI surface — the system info section is the natural home.
      const host = document.getElementById('systemInfo') || document.body;
      let banner = document.getElementById('swPrecacheBanner');
      if(!banner){
        banner = document.createElement('div');
        banner.id = 'swPrecacheBanner';
        banner.className = 'sw-precache-banner';
        banner.setAttribute('role', 'status');
        host.parentNode ? host.parentNode.insertBefore(banner, host) : document.body.appendChild(banner);
      }
      banner.replaceChildren();
      const msg = document.createElement('span');
      msg.textContent = '⚠ Offline cache incomplete — ' + failed.length + ' of ' + (ev.data.total || '?') + ' assets failed to load. App will work online; offline mode may be partial.';
      banner.appendChild(msg);
      // Disclose which assets failed so users (and us debugging) can see what
      // broke. Keep it collapsed by default to not dominate the banner.
      const details = document.createElement('details');
      details.className = 'sw-precache-banner-details';
      const summary = document.createElement('summary');
      summary.textContent = 'Show failed assets (' + failed.length + ')';
      details.appendChild(summary);
      const list = document.createElement('ul');
      list.className = 'sw-precache-banner-list';
      failed.slice(0, 50).forEach(item => {
        const li = document.createElement('li');
        li.textContent = typeof item === 'string' ? item : (item && item.url) || String(item);
        list.appendChild(li);
      });
      if(failed.length > 50){
        const li = document.createElement('li');
        li.textContent = '…and ' + (failed.length - 50) + ' more';
        list.appendChild(li);
      }
      details.appendChild(list);
      banner.appendChild(details);
      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.className = 'sw-precache-banner-btn';
      refresh.textContent = 'Reload';
      refresh.onclick = () => location.reload();
      banner.appendChild(refresh);
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'sw-precache-banner-btn sw-precache-banner-btn--ghost';
      close.textContent = 'Dismiss';
      close.onclick = () => banner.remove();
      banner.appendChild(close);
    });
  }catch(_){ /* BroadcastChannel unavailable — fail silent */ }

  // SW self-heal: reload once when a new worker takes control. The reload
  // path is intentionally passive here — app.js owns the "Reload to update /
  // Later" banner and posts SKIP_WAITING when the user clicks Reload. This
  // listener just guarantees the reload happens on controllerchange exactly
  // once. We do NOT auto-postMessage SKIP_WAITING from pwa.js, because doing
  // so races the banner and effectively defeats the user-facing "Later"
  // button (#23 in the UX audit).
  let _swReloading = false;
  if ('serviceWorker' in navigator && !isFileProtocol) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if(_swReloading) return;
      _swReloading = true;
      window.location.reload();
    });
  }

  // Register external service worker when served via http(s) — preferred path.
  // Falls back to inline blob SW only if sw.js isn't reachable.
  if ('serviceWorker' in navigator && !isFileProtocol) {
    navigator.serviceWorker.register('sw.js', {scope: './'}).then((reg)=>{
      window._swRegistered = true;
    }).catch((err)=>{
      console.warn('External sw.js failed, falling back to inline SW:', err);
      // Fallback: inline SW via blob URL (cache name tracks js/version.js via ODTAULAI_RELEASE)
      const swBase = (typeof window !== 'undefined' && window.ODTAULAI_RELEASE && window.ODTAULAI_RELEASE.swCache)
        ? window.ODTAULAI_RELEASE.swCache
        : 'odtaulai-v54';
      const swCode = `
        const CACHE = '${swBase}-inline';
        self.addEventListener('install', e => self.skipWaiting());
        self.addEventListener('activate', e => e.waitUntil(clients.claim()));
        self.addEventListener('fetch', e => {
          if (e.request.method !== 'GET') return;
          const u = new URL(e.request.url);
          if (u.origin !== self.location.origin) return;
          e.respondWith(
            caches.match(e.request).then(cached => {
              if (cached) return cached;
              return fetch(e.request).then(resp => {
                if (resp.ok && resp.type === 'basic') {
                  const clone = resp.clone();
                  caches.open(CACHE).then(c => c.put(e.request, clone)).catch(()=>{});
                }
                return resp;
              }).catch(() => cached || new Response('Offline', {status: 503}));
            })
          );
        });
      `;
      try {
        const swBlob = new Blob([swCode], {type: 'application/javascript'});
        // Keep blob URL alive for the session — revoking can break the registered SW.
        const swUrl = URL.createObjectURL(swBlob);
        navigator.serviceWorker.register(swUrl).then((reg)=>{
          window._swRegistered = true;
        }).catch(()=>{ window._swRegistered = false; });
      } catch(e) { window._swRegistered = false; }
    });
  }

  // Install prompt — capture beforeinstallprompt, show install button when available
  window._deferredInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window._deferredInstallPrompt = e;
    document.addEventListener('DOMContentLoaded', () => {
      const btn = document.getElementById('installBtn');
      if (btn) btn.hidden = false;
    });
    const btn = document.getElementById('installBtn');
    if (btn) btn.hidden = false;
    if (typeof window.refreshPWAInstallUI === 'function') window.refreshPWAInstallUI();
  });
  window.addEventListener('appinstalled', () => {
    window._deferredInstallPrompt = null;
    const btn = document.getElementById('installBtn');
    if (btn) btn.hidden = true;
    const status = document.getElementById('pwaStatus');
    if (status) status.textContent = '✓ Installed as app';
  });

  function _isIOS(){
    const ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function _isStandalonePWA(){
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  /** iOS never fires beforeinstallprompt — show the same button with manual steps. */
  function _syncInstallButtonForPlatform(){
    if (location.protocol === 'file:') return;
    if (_isStandalonePWA()) return;
    const btn = document.getElementById('installBtn');
    const status = document.getElementById('pwaStatus');
    if (!btn) return;
    if (window._deferredInstallPrompt) {
      btn.hidden = false;
      btn.textContent = '＋ Install';
      if (status) status.textContent = 'Ready to install';
      return;
    }
    if (_isIOS()) {
      btn.hidden = false;
      btn.textContent = '＋ Add to Home Screen';
      if (status) status.textContent = 'iOS: tap for steps — Share → Add to Home Screen';
      return;
    }
    if (/Android/i.test(navigator.userAgent)) {
      btn.hidden = false;
      btn.textContent = '＋ Install app';
      if (status) status.textContent = 'Android: tap for tips, or Chrome ⋮ → Install app';
    }
  }

  // Render an inline help panel (instead of alert) below the install button
  // when no native prompt is available. Platform-detected steps; tappable
  // close button. Reusable across iOS / Android / desktop fallback paths.
  function _renderInstallHelpPanel(steps, title){
    const btn = document.getElementById('installBtn');
    if(!btn) return;
    let panel = document.getElementById('installHelpPanel');
    if(!panel){
      panel = document.createElement('div');
      panel.id = 'installHelpPanel';
      panel.className = 'install-help-panel';
      panel.setAttribute('role', 'region');
      panel.setAttribute('aria-label', 'How to install');
      btn.parentNode.insertBefore(panel, btn.nextSibling);
    }
    if(!panel.hidden && panel.dataset.title === title){
      // Toggle off when re-clicked.
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    panel.dataset.title = title;
    panel.replaceChildren();
    const h = document.createElement('div');
    h.className = 'install-help-title';
    h.textContent = title;
    panel.appendChild(h);
    const ol = document.createElement('ol');
    ol.className = 'install-help-steps';
    steps.forEach(s => { const li = document.createElement('li'); li.textContent = s; ol.appendChild(li); });
    panel.appendChild(ol);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'install-help-close';
    close.textContent = 'Got it';
    close.onclick = () => { panel.hidden = true; };
    panel.appendChild(close);
  }

  window.installPWA = function(){
    if (window._deferredInstallPrompt) {
      window._deferredInstallPrompt.prompt();
      window._deferredInstallPrompt.userChoice.then((choice) => {
        // The prompt is consumed either way and can't be re-triggered until
        // the browser re-fires beforeinstallprompt. If the user accepted,
        // the install is happening — hide the button. If they dismissed,
        // keep the button visible so they can find install help (it falls
        // through to the platform help panel branch below). #22 in UX audit.
        window._deferredInstallPrompt = null;
        const btn = document.getElementById('installBtn');
        const help = document.getElementById('installHelpPanel');
        if (choice && choice.outcome === 'accepted') {
          if (btn) btn.hidden = true;
          if (help) help.hidden = true;
        } else {
          // Reveal the help panel so the user has a fallback path; the
          // button itself remains visible for re-discovery.
          if (typeof _syncInstallButtonForPlatform === 'function') _syncInstallButtonForPlatform();
        }
      });
      return;
    }
    if (_isIOS()) {
      _renderInstallHelpPanel(
        [
          'Tap the Share button (square with up-arrow) at the bottom of Safari.',
          'Scroll and tap “Add to Home Screen”.',
          'Tap Add — Odta opens fullscreen like a native app.',
          'Note: iOS doesn’t provide a one-tap install API. Chrome on iOS uses the same WebKit; if “Add to Home Screen” is missing, switch to Safari.',
        ],
        'Install on iPhone / iPad'
      );
      return;
    }
    if (/Android/i.test(navigator.userAgent || '')) {
      _renderInstallHelpPanel(
        [
          'Open Chrome’s menu (⋮ in the top-right).',
          'Tap “Install app” or “Add to Home screen”.',
          'If you don’t see it: the site must be on HTTPS or localhost, and Chrome shows install only after a bit of engagement.',
        ],
        'Install on Android'
      );
      return;
    }
    _renderInstallHelpPanel(
      [
        'In Chrome / Edge, click the ⊕ Install icon in the address bar, or use the menu → Save and share → Install page as app.',
        'The site must be served over HTTPS or localhost (file:// won’t work).',
        'On iOS Safari: Share → Add to Home Screen.',
      ],
      'Install Odta'
    );
  };

  window.refreshPWAInstallUI = _syncInstallButtonForPlatform;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { _syncInstallButtonForPlatform(); });
  } else {
    _syncInstallButtonForPlatform();
  }
  // beforeinstallprompt fires asynchronously after engagement criteria are
  // met; one delayed re-sync covers the common case without the previous
  // double-timeout. The event listeners above also call refresh on demand.
  setTimeout(_syncInstallButtonForPlatform, 1500);
})();
