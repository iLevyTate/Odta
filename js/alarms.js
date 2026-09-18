/**
 * Alarm scheduler — hands every known deadline to the browser AHEAD of time
 * instead of waiting for the page to notice it has passed.
 *
 * ── The bug this exists to fix ─────────────────────────────────────────────
 * Every notification used to be emitted from the main thread at the instant
 * the main thread noticed a deadline had elapsed: onPhaseComplete() and
 * checkReminders() both call notify(), and notify() then asks the service
 * worker to *display* something. The SW was a passive renderer — it never
 * decided *when*. So the whole chain depended on the page being alive and
 * ticking at the deadline.
 *
 * An installed PWA that is backgrounded does not stay alive. Browsers
 * escalate: intensive setInterval throttling, then a `freeze` that suspends
 * dedicated workers too (so audio.js's 1s Worker tick stops), then outright
 * discard. The silent-oscillator keepalive holds this off on desktop Chrome
 * and sometimes Android, and not at all on iOS, where WebKit suspends the
 * AudioContext on background and refuses resume() outside user activation.
 * Hence the reported behaviour: the chime works "periodically", and the timer
 * only reliably rings when the app is on screen.
 *
 * ── The fix ───────────────────────────────────────────────────────────────
 * Three independent layers, best available wins, all of them safe to run at
 * once because they share one dedupe key (the alarm id + its `firedAt` stamp
 * in the shared IndexedDB store):
 *
 *   1. Notification Triggers (`TimestampTrigger`). Where supported, the
 *      deadline is handed to the browser, which fires it at the OS level with
 *      the page closed, discarded, or the browser not running. This is the
 *      only zero-server mechanism that is genuinely reliable.
 *   2. A service-worker alarm registry (sw.js). The SW re-arms a timer and
 *      flushes every overdue alarm on ANY wake — a fetch, a message, a
 *      periodicsync, a notification click. A locked phone that gets woken for
 *      any reason delivers the notification then, instead of never.
 *   3. The existing main-thread catch-up (_reconcileTimerAfterWake), which
 *      stays as the last resort for browsers with neither of the above.
 *
 * Nothing here replaces the in-app chime; it makes the *notification* arrive
 * without the page's cooperation.
 */
(function () {
  'use strict';

  var SW_CHANNEL = 'odta-alarms';
  /** Sources are functions returning arrays of alarm records. */
  var _sources = [];
  var _rebuildTimer = 0;
  var _lastSerialized = '';

  function _store() {
    return (typeof self !== 'undefined' && self.OdtaAlarmStore) ? self.OdtaAlarmStore : null;
  }

  function notifGranted() {
    try {
      if (!('Notification' in window)) return false;
      if (Notification.permission !== 'granted') return false;
      if (typeof cfg !== 'undefined' && cfg && cfg.notif === false) return false;
      return true;
    } catch (_) { return false; }
  }

  /**
   * True when this browser can park a notification on a future timestamp.
   * Chromium-only today; the feature detect is the whole contract.
   */
  function supportsTriggers() {
    try {
      return ('Notification' in window) &&
        ('showTrigger' in Notification.prototype) &&
        (typeof self.TimestampTrigger === 'function');
    } catch (_) { return false; }
  }

  function swReady() {
    try {
      if (!('serviceWorker' in navigator)) return Promise.resolve(null);
      if (!navigator.serviceWorker.controller) return Promise.resolve(null);
      return navigator.serviceWorker.ready.catch(function () { return null; });
    } catch (_) { return Promise.resolve(null); }
  }

  /**
   * Register a contributor. Each returns the alarms it currently wants
   * pending — the full set, not a delta. Recomputing wholesale is what keeps
   * a cancelled timer from leaving a stale alarm behind.
   */
  function addSource(fn) {
    if (typeof fn === 'function' && _sources.indexOf(fn) === -1) _sources.push(fn);
  }

  function collect() {
    var out = [];
    var now = Date.now();
    _sources.forEach(function (fn) {
      var list;
      try { list = fn(); } catch (e) { console.warn('[alarms] source failed', e); return; }
      if (!Array.isArray(list)) return;
      list.forEach(function (a) {
        if (!a || !a.id || !Number.isFinite(a.at)) return;
        // Deadlines already in the past are the catch-up path's business, not
        // something to park in a trigger.
        if (a.at <= now) return;
        out.push(a);
      });
    });
    return out;
  }

  /**
   * Park every pending alarm on a TimestampTrigger and retire the triggers
   * that no longer correspond to anything pending.
   */
  function syncTriggers(reg, pendingList) {
    if (!reg || !reg.showNotification || !supportsTriggers() || !notifGranted()) {
      return Promise.resolve(false);
    }
    var wantByTag = Object.create(null);
    pendingList.forEach(function (a) { wantByTag[a.tag || a.id] = a; });

    var existing = reg.getNotifications
      ? reg.getNotifications({ includeTriggered: true }).catch(function () { return []; })
      : Promise.resolve([]);

    return existing.then(function (notes) {
      var haveByTag = Object.create(null);
      (notes || []).forEach(function (n) {
        if (!n || !n.tag) return;
        // Only ever touch notifications this scheduler owns.
        if (!(n.data && n.data.odtaAlarmId)) return;
        var want = wantByTag[n.tag];
        if (want && n.data.odtaAt === want.at) { haveByTag[n.tag] = true; return; }
        // Obsolete (cancelled timer, or the deadline moved) — retire it.
        try { n.close(); } catch (_) {}
      });

      var armed = [];
      var work = pendingList.filter(function (a) { return !haveByTag[a.tag || a.id]; })
        .map(function (a) {
          var data = Object.assign({}, a.data || {});
          data.odtaAlarmId = a.id;
          data.odtaAt = a.at;
          return reg.showNotification(a.title, {
            body: a.body || '',
            tag: a.tag || a.id,
            icon: './icons/icon-192.png',
            badge: './icons/icon-192.png',
            requireInteraction: !!a.requireInteraction,
            data: data,
            showTrigger: new self.TimestampTrigger(a.at),
          }).then(function () { armed.push(a.id); })
            .catch(function (e) {
              // A trigger can be rejected (quota, unsupported option shape).
              // Layer 2 still covers this alarm, so log and carry on.
              console.warn('[alarms] trigger rejected for', a.id, e && e.message);
            });
        });

      return Promise.all(work).then(function () {
        var st = _store();
        if (st && armed.length) return st.markTriggered(armed).then(function () { return true; });
        return armed.length > 0;
      });
    }).catch(function (e) {
      console.warn('[alarms] syncTriggers failed', e);
      return false;
    });
  }

  /** Hand the SW the current set so it can re-arm its own timer. */
  function postToSw(reg, pendingList) {
    try {
      var target = (reg && reg.active) || (navigator.serviceWorker && navigator.serviceWorker.controller);
      if (!target || !target.postMessage) return;
      target.postMessage({ type: 'ALARMS_UPDATED', count: pendingList.length, channel: SW_CHANNEL });
    } catch (_) {}
  }

  /**
   * Recompute every pending deadline and push it down to all three layers.
   * Safe to call as often as you like: identical sets short-circuit.
   */
  function rebuild(opts) {
    var force = !!(opts && opts.force);
    var list = collect();
    var serialized = JSON.stringify(list.map(function (a) { return a.id + '@' + a.at; }));
    if (!force && serialized === _lastSerialized) return Promise.resolve(false);
    _lastSerialized = serialized;

    var st = _store();
    if (!st) return Promise.resolve(false);

    return st.replaceAll(list)
      .then(function () { return st.pending(); })
      .then(function (pendingList) {
        return swReady().then(function (reg) {
          postToSw(reg, pendingList);
          return syncTriggers(reg, pendingList);
        });
      })
      .then(function () { return true; })
      .catch(function (e) { console.warn('[alarms] rebuild failed', e); return false; });
  }

  /** Coalesce bursts (a phase start touches several bits of state at once). */
  function schedule(opts) {
    if (_rebuildTimer) clearTimeout(_rebuildTimer);
    _rebuildTimer = setTimeout(function () {
      _rebuildTimer = 0;
      rebuild(opts);
    }, 120);
  }

  /**
   * Which alarms were already delivered by the SW or a trigger while we were
   * away. The completion paths consult this so a phase that ended in the
   * background doesn't announce itself a second time when the user returns.
   */
  var _firedIds = Object.create(null);
  function refreshFired() {
    var st = _store();
    if (!st) return Promise.resolve([]);
    return st.all().then(function (rows) {
      var fired = [];
      rows.forEach(function (r) {
        if (r && r.firedAt) { _firedIds[r.id] = r.firedAt; fired.push(r.id); }
      });
      return fired;
    }).catch(function () { return []; });
  }
  function wasFired(id) { return !!_firedIds[id]; }
  /** Called by the completion paths once they've handled an alarm themselves. */
  function consume(id) { delete _firedIds[id]; }
  function markFiredLocally(id) {
    var st = _store();
    if (st) st.markFired(id);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────
  // The moment before we lose the main thread is the most important time to
  // have the alarm set current, so push on every path out of the foreground.
  // `freeze` and `pagehide` are the ones that actually fire on mobile when
  // the OS takes the app away; visibilitychange is the desktop-tab case.
  function _onHide() { rebuild({ force: true }); }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) _onHide();
      else refreshFired().then(function () { schedule(); });
    });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', _onHide);
    window.addEventListener('freeze', _onHide);
    window.addEventListener('beforeunload', _onHide);
  }

  // The SW tells us when it delivered something so an open page can drop the
  // corresponding in-app duplicate.
  try {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', function (ev) {
        var d = ev && ev.data;
        if (!d || d.type !== 'ALARM_FIRED') return;
        if (d.id) _firedIds[d.id] = d.firedAt || Date.now();
      });
    }
  } catch (_) {}

  /**
   * Ask for Periodic Background Sync. Chromium grants it only to installed
   * apps with enough site engagement and the minimum interval is measured in
   * hours, so it is useless for a 25-minute phase — but it is a free extra
   * wake for day-scale things like a task that came due, so we take it when
   * it's offered and never depend on it.
   */
  function registerPeriodicSync() {
    try {
      if (!('serviceWorker' in navigator)) return;
      navigator.serviceWorker.ready.then(function (reg) {
        if (!reg || !reg.periodicSync) return;
        if (!navigator.permissions || !navigator.permissions.query) return;
        navigator.permissions.query({ name: 'periodic-background-sync' }).then(function (status) {
          if (status.state !== 'granted') return;
          reg.periodicSync.register('odta-alarms', { minInterval: 60 * 60 * 1000 })
            .catch(function () { /* not available — layers 1-3 stand */ });
        }).catch(function () {});
      }).catch(function () {});
    } catch (_) {}
  }

  window.OdtaAlarms = {
    addSource: addSource,
    rebuild: rebuild,
    schedule: schedule,
    refreshFired: refreshFired,
    wasFired: wasFired,
    consume: consume,
    markFiredLocally: markFiredLocally,
    supportsTriggers: supportsTriggers,
    registerPeriodicSync: registerPeriodicSync,
    _collect: collect,
  };
})();
