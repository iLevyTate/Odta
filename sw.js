// Odta Service Worker — CACHE_NAME pulled from the single source in
// js/version.js so version bumps don't require editing three files.
let CACHE_NAME = 'odtaulai-v81';
try {
  importScripts('./js/version.js');
  // The alarm store is the one piece of state the page and this worker share.
  // It has to load here, not just on the page, because the whole point is that
  // this worker can fire a notification when no page is alive to ask it to.
  importScripts('./js/alarm-store.js');
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
  './css/main.css?v=v81',
  './js/version.js',
  './js/event-delegation.js',
  './js/alarm-store.js',
  './js/alarms.js',
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
        // Optional model weights may be absent; the app shell may not. A
        // shell file that failed to fetch (transient 5xx, flaky network)
        // used to install anyway, and activate then deleted the previous —
        // complete — cache, so the next offline start 503'd on a core
        // script. Failing the install keeps the working old worker; the
        // browser retries on the next update check.
        const coreFailed = failed.filter(f => !/assets\/models\//.test(f.url));
        if(coreFailed.length){
          throw new Error('[sw] precache failed for core assets: ' + coreFailed.map(f => f.url).join(', '));
        }
      }
    })
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      // An update that activates while the app was away is a wake like any
      // other: anything overdue goes out now rather than waiting for the user
      // to reopen the app.
      .then(() => serviceAlarms())
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

  // Any fetch means this worker is awake. Use the opportunity to deliver
  // anything overdue — throttled so a burst of asset requests doesn't hammer
  // IndexedDB. This is the path that saves a phone which froze the page: the
  // next time anything touches the scope, the notification goes out.
  const nowTs = Date.now();
  if(nowTs - _lastFetchFlush > ALARM_FETCH_THROTTLE_MS){
    _lastFetchFlush = nowTs;
    e.waitUntil(serviceAlarms());
  }

  const isNavigation = e.request.mode === 'navigate' || e.request.destination === 'document' ||
    url.pathname === '/' || url.pathname.endsWith('/index.html') || url.pathname.endsWith('index.html');
  if(isNavigation){
    // Shell-first, like every other precached asset: serve the cached
    // index.html and refresh the copy in the background. Navigation used to
    // be network-first while js/*.js stayed cache-first, so the first load
    // after a deploy ran the NEW index.html against the OLD scripts (a
    // mixed-version page until the next reload). It also meant a flaky
    // connection showed a blank page until the fetch finally failed.
    e.respondWith(
      (() => {
        const scopePath = new URL(self.registration.scope).pathname;
        const isShell = url.pathname === scopePath || url.pathname === scopePath + 'index.html';
        // Another page in scope (README.md, docs/…) is not the shell: fetch it,
        // and never let its body land under the shell's cache key, or the
        // next launch would serve that page as the app.
        if(!isShell) return fetch(e.request).catch(() => caches.match('./index.html'));
        return caches.match('./index.html').then(cached => {
          const net = fetch(e.request).then(res => {
            if(res && res.status === 200 && res.type === 'basic'){
              const clone = res.clone();
              // One key for every shell navigation. Keyed by e.request, each
              // launch URL (?tab=…&task=…, ?share=1&share_text=…) kept its own
              // copy of the shell until the next version bump, and a
              // share-target launch left the shared text in Cache Storage
              // after app.js had scrubbed it from the address bar.
              caches.open(CACHE_NAME).then(c => c.put('./index.html', clone).catch(() => {}));
            }
            return res;
          }).catch(() => null);
          if(cached) return cached;
          return net.then(r => r || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } }));
        });
      })()
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

// ══════════════════════════════════════════════════════════════════════════
// ALARM ENGINE — the worker decides WHEN, not just what to draw
// ══════════════════════════════════════════════════════════════════════════
// Before this, every notification was emitted by the page at the moment the
// page noticed a deadline had passed, and this worker only ever rendered what
// it was told (a SHOW_NOTIFICATION message, since removed). That made delivery conditional on
// the page still running — which a backgrounded PWA is not: the browser
// throttles its timers, then freezes it (suspending its Web Workers too),
// then discards it. The result was a timer that only reliably rang while the
// app was on screen.
//
// Now js/alarms.js writes every pending deadline into the shared IndexedDB
// store, and this worker flushes whatever is overdue on ANY wake it gets —
// a navigation, a fetch, a message, a periodicsync, a notification click.
// Combined with the Notification Triggers the page arms where supported,
// delivery no longer depends on a live page.
//
// Note on lifetime: a service worker is killed after a few seconds idle, so
// the setTimeout below is an optimisation for the case where we happen to
// still be alive at the deadline — never the mechanism we rely on. The flush
// on wake is what actually makes this work.

const ALARM_TIMER_HORIZON_MS = 60 * 1000; // only bother arming within a minute
const ALARM_FETCH_THROTTLE_MS = 20 * 1000;
let _alarmTimer = null;
let _lastFetchFlush = 0;

function _alarmStore(){
  return self.OdtaAlarmStore || null;
}

/**
 * Show every alarm whose deadline has passed and that nobody has delivered
 * yet, then stamp them so the page doesn't announce them a second time when
 * it comes back.
 */
async function flushDueAlarms(){
  const store = _alarmStore();
  if(!store) return 0;
  let rows;
  try { rows = await store.pending(); } catch(_) { return 0; }
  const now = Date.now();
  const due = rows.filter(r => r && r.at <= now);
  if(!due.length) return 0;

  for(const a of due){
    try {
      await self.registration.showNotification(a.title || 'Odta', {
        body:               a.body || '',
        tag:                a.tag || a.id,
        renotify:           true,
        icon:               './icons/icon-192.png',
        badge:              './icons/icon-192.png',
        requireInteraction: !!a.requireInteraction,
        data:               Object.assign({}, a.data || {}, { odtaAlarmId: a.id, odtaAt: a.at }),
      });
    } catch(err) {
      console.warn('[sw] alarm show failed', a.id, err && err.message);
      continue; // leave it pending so a later wake retries
    }
    try { await store.markFired(a.id, now); } catch(_) {}
    // Tell any live page so it drops its own duplicate of this one.
    try {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      clients.forEach(c => { try { c.postMessage({ type: 'ALARM_FIRED', id: a.id, firedAt: now }); } catch(_){} });
    } catch(_) {}
  }
  return due.length;
}

/** Re-arm the in-worker timer for the soonest deadline, if it is close. */
async function armNextAlarm(){
  const store = _alarmStore();
  if(!store) return;
  if(_alarmTimer){ clearTimeout(_alarmTimer); _alarmTimer = null; }
  let rows;
  try { rows = await store.pending(); } catch(_) { return; }
  if(!rows.length) return;
  const now = Date.now();
  const next = rows.reduce((min, r) => (r.at < min ? r.at : min), Infinity);
  if(!Number.isFinite(next)) return;
  const delay = next - now;
  if(delay <= 0){ await flushDueAlarms(); return; }
  if(delay > ALARM_TIMER_HORIZON_MS) return; // too far out to outlive; the wake-flush covers it
  _alarmTimer = setTimeout(() => {
    _alarmTimer = null;
    flushDueAlarms().then(armNextAlarm).catch(() => {});
  }, delay);
}

/** One call for every wake path: deliver what is overdue, then re-arm. */
function serviceAlarms(){
  return flushDueAlarms().then(armNextAlarm).catch(err => {
    console.warn('[sw] serviceAlarms failed', err && err.message);
  });
}

// Periodic Background Sync: granted sparingly and with an hours-long minimum
// interval, so it is no use for a 25-minute phase — but it is a free extra
// wake for day-scale reminders, and it costs nothing to honour.
self.addEventListener('periodicsync', e => {
  if(e.tag === 'odta-alarms') e.waitUntil(serviceAlarms());
});

// One-off background sync, if the page ever registers it.
self.addEventListener('sync', e => {
  if(e.tag === 'odta-alarms') e.waitUntil(serviceAlarms());
});

self.addEventListener('message', e => {
  if(e.data?.type === 'SKIP_WAITING') self.skipWaiting();
  // The page rewrote the alarm set (a phase started, a timer was cancelled,
  // a reminder moved). Re-read it and re-arm.
  if(e.data?.type === 'ALARMS_UPDATED') e.waitUntil(serviceAlarms());
  // (SHOW_NOTIFICATION was removed: nothing posted it, since audio.js calls
  // reg.showNotification() itself, and it rendered whatever it was sent.)
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  // Only ever launch into this app. Every url the app sets is a relative
  // ./?… path; anything resolving off-origin is dropped for the scope root.
  let target = './';
  try{
    const u = new URL(data.url || './', self.registration.scope);
    if(u.origin === self.location.origin) target = u.href;
  }catch(_){}
  // A tapped alarm is delivered; stamp it so the page doesn't re-announce it,
  // and take the wake as a chance to flush any sibling that is also overdue.
  if(data.odtaAlarmId && self.OdtaAlarmStore){
    e.waitUntil(
      self.OdtaAlarmStore.markFired(data.odtaAlarmId).then(() => flushDueAlarms()).catch(() => {})
    );
  }
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // If the app is already open, focus it and forward the notification
      // data. Prefer a client that is actually the app shell — the update
      // banner opens CHANGELOG.md in a same-origin tab, and focusing that
      // one meant the tapped reminder never opened its task.
      const isShell = (c) => {
        try{
          const p = new URL(c.url).pathname;
          return p === '/' || p.endsWith('/') || p.endsWith('/index.html') || p.endsWith('index.html');
        }catch(_){ return false; }
      };
      const focusable = clients.filter(c => 'focus' in c);
      const pick = focusable.find(isShell) || null;
      if(pick){
        pick.postMessage({ type: 'NOTIFICATION_CLICK', data });
        return pick.focus();
      }
      // App isn't open — launch it (with optional target path)
      if(self.clients.openWindow) return self.clients.openWindow(target);
      if(focusable[0]){
        focusable[0].postMessage({ type: 'NOTIFICATION_CLICK', data });
        return focusable[0].focus();
      }
    })
  );
});

self.addEventListener('notificationclose', e => {
  // A triggered notification the user swiped away has still been delivered —
  // record that so the page doesn't replay it as a "missed" alert on return.
  const data = (e.notification && e.notification.data) || {};
  if(data.odtaAlarmId && self.OdtaAlarmStore){
    e.waitUntil(self.OdtaAlarmStore.markFired(data.odtaAlarmId).catch(() => {}));
  }
});
