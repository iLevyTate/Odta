// Odta Service Worker — CACHE_NAME pulled from the single source in
// js/version.js so version bumps don't require editing three files.
let CACHE_NAME = 'odtaulai-v67';
try {
  importScripts('./js/version.js');
  if (self.ODTAULAI_RELEASE && self.ODTAULAI_RELEASE.swCache) {
    CACHE_NAME = self.ODTAULAI_RELEASE.swCache;
  }
} catch (e) {
  // version.js unavailable (e.g. offline install) — keep the inline default.
  // Surface the fallback so CI smoke logs and `chrome://serviceworker-internals`
  // show drift between the inline cache name and the canonical one in version.js.
  console.warn('[sw] version.js importScripts failed; using inline CACHE_NAME', CACHE_NAME, e && e.message);
}

// Static app shell + every vendored runtime dependency. The transformers
// WASM binary is large (~22 MB) and the model weights under
// `./assets/models/...` are larger still; individual fetch failures are
// tolerated by the install handler below so a missing model doesn't break
// the core app. To enable AI features fully offline, run
// `npm run fetch-models` once to populate `./assets/models/`.
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './favicon.ico',
  './css/main.css?v=v67',
  './js/version.js',
  './js/event-delegation.js',
  './js/pwa.js',
  './js/config.js',
  './js/icons.js',
  './js/utils.js',
  './js/ui-flip.js',
  './js/modal.js',
  './js/dropdown.js',
  './js/storage.js',
  './js/audio.js',
  './js/timer.js',
  './js/attachments.js',
  './js/timer-dock.js',
  './js/tasks.js',
  './js/spellcheck.js',
  './js/intel.js',
  './js/embed-store.js',
  './js/nlparse.js',
  './js/intel-features.js',
  './js/tool-schema.js',
  './js/gen.js',
  './js/gen-pipeline.js',
  './js/gen-worker.js',
  './js/ask.js',
  './js/ui.js',
  './js/ai.js',
  './js/sync.js',
  './js/calfeeds.js',
  './js/app.js',
  './js/vendor/peerjs.min.js',
  './js/vendor/Sortable.min.js',
  './js/vendor/chrono-node.min.mjs',
  './js/vendor/transformers/transformers.min.mjs',
  './js/vendor/transformers/ort-wasm-simd-threaded.jsep.mjs',
  './js/vendor/transformers/ort-wasm-simd-threaded.jsep.wasm',
  // Model weights for the WASM/WebGPU embedding pipeline. Precaching these
  // makes the AI features available offline on first run — if the files are
  // missing (i.e. `npm run fetch-models` hasn't been run yet) the individual
  // entries fail silently and the rest of the app still installs.
  './assets/models/Xenova/bge-small-en-v1.5/config.json',
  './assets/models/Xenova/bge-small-en-v1.5/tokenizer.json',
  './assets/models/Xenova/bge-small-en-v1.5/tokenizer_config.json',
  './assets/models/Xenova/bge-small-en-v1.5/special_tokens_map.json',
  './assets/models/Xenova/bge-small-en-v1.5/onnx/model_quantized.onnx',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/icon-small.svg',
  './widgets/quickadd-template.json',
  './widgets/quickadd-data.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(async c => {
      // Add assets one-by-one so a single missing file (e.g. a renamed icon)
      // doesn't fail the entire precache. Track which URLs failed so the
      // page can report them — silent install was the previous behavior and
      // it produced the "app suddenly broken offline" class of bug.
      const failed = [];
      await Promise.all(ASSETS.map(url =>
        fetch(url, { cache: 'reload' })
          .then(res => {
            if(!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
            return c.put(url, res);
          })
          .catch(err => { failed.push({ url, err: String(err && err.message || err) }); })
      ));
      if(failed.length){
        console.warn('[sw] precache incomplete:', failed);
        // Notify the page via BroadcastChannel; pwa.js subscribes and shows
        // a banner so the user knows offline mode may be partial. Wrapped
        // because not every browser context has BroadcastChannel.
        try{
          const ch = new BroadcastChannel('odtaulai-sw-status');
          ch.postMessage({ type: 'precache-incomplete', failed, total: ASSETS.length });
          ch.close();
        }catch(_){}
      }
    })
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Everything is same-origin now (libraries + model weights are vendored).
  // Cross-origin requests are left to the browser — the app never makes any
  // by default; user-enabled features (calendar feeds, P2P sync) handle
  // their own network. The previous Hugging Face / jsDelivr passthrough is
  // no longer needed.
  if(url.origin !== self.location.origin) return;

  const isNavigation = e.request.mode === 'navigate' || e.request.destination === 'document' ||
    url.pathname === '/' || url.pathname.endsWith('/index.html') || url.pathname.endsWith('index.html');
  if(isNavigation){
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if(res && res.status === 200 && res.type === 'basic'){
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, clone).catch(() => {}));
          }
          return res;
        })
        .catch(() => caches.match('./index.html').then(r => r || caches.match(e.request)))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      const net = fetch(e.request).then(res => {
        if(res && res.status === 200 && res.type === 'basic'){
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone).catch(() => {}));
        }
        return res;
      }).catch(() => cached || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } }));
      return cached || net;
    })
  );
});

self.addEventListener('message', e => {
  if(e.data?.type === 'SKIP_WAITING') self.skipWaiting();
  // ── Persistent notification from main thread ──
  // ServiceWorker.showNotification() fires even when the page tab is frozen
  // or backgrounded on mobile — unlike `new Notification()` from the main
  // thread which requires the page to be active.
  if(e.data?.type === 'SHOW_NOTIFICATION'){
    const d = e.data;
    e.waitUntil(
      self.registration.showNotification(d.title || 'Odta', {
        body:               d.body || '',
        tag:                d.tag || 'odtaulai',
        renotify:           d.renotify !== false,
        icon:               './icons/icon-192.png',
        badge:              './icons/icon-192.png',
        silent:             !!d.silent,
        requireInteraction: !!d.requireInteraction,
        data:               d.data || {},
      })
    );
  }
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  const target = data.url || './';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // If the app is already open, focus it and forward the notification data
      for(const c of clients){
        if('focus' in c){
          c.postMessage({ type: 'NOTIFICATION_CLICK', data });
          return c.focus();
        }
      }
      // App isn't open — launch it (with optional target path)
      if(self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
