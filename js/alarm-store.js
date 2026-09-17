/**
 * Alarm store — the one piece of state the page and the service worker both
 * read.
 *
 * Why IndexedDB and not the localStorage everything else in this app uses:
 * a service worker has no access to localStorage. The whole point of the
 * alarm system is that the SW can fire a notification when the page is
 * frozen, discarded, or was never opened this session, so the pending
 * deadlines have to live somewhere the SW can actually reach.
 *
 * This file is loaded BOTH as a <script> on the page and via importScripts()
 * from sw.js, so it must stay a classic script with no imports and no DOM
 * access — `self` is the only global it may assume.
 *
 * Record shape (see js/alarms.js for who writes them):
 *   {
 *     id:      string   stable per source, e.g. 'pomo' | 'qt:3' | 'task:abc'
 *     at:      number   epoch ms the alarm is due
 *     title:   string
 *     body:    string
 *     tag:     string   notification tag — same value the page's notify() uses
 *     data:    object   forwarded to notificationclick (carries `url`)
 *     requireInteraction: boolean
 *     firedAt: number|0 set by whichever side actually showed it
 *     trigger: boolean  true once handed to a TimestampTrigger
 *   }
 */
(function (global) {
  'use strict';

  var DB_NAME = 'odta-alarms';
  var STORE = 'alarms';
  var DB_VERSION = 1;
  var _dbPromise = null;

  function openDb() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      if (!global.indexedDB) { reject(new Error('indexedDB unavailable')); return; }
      var req;
      try { req = global.indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = function () {
        var db = req.result;
        // A version change from another context (or a wiped profile) leaves
        // this handle dead; drop the cache so the next call reopens.
        db.onclose = db.onversionchange = function () {
          try { db.close(); } catch (_) {}
          if (_dbPromise) _dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = function () { _dbPromise = null; reject(req.error || new Error('open failed')); };
      req.onblocked = function () { /* another tab is mid-upgrade; onsuccess still follows */ };
    });
    return _dbPromise;
  }

  /**
   * Run `fn(store)` inside one transaction and resolve with its result once
   * the transaction commits.
   *
   * `fn` may return a value or a promise (readers resolve theirs from an
   * IDBRequest's onsuccess). Both the transaction's commit and that promise
   * are awaited explicitly — relying on microtask ordering to have assigned
   * the result before `oncomplete` ran would work today and break the first
   * time a caller awaits anything.
   */
  function tx(mode, fn) {
    return openDb().then(function (db) {
      var work;
      var done = new Promise(function (resolve, reject) {
        var t, store;
        try {
          t = db.transaction(STORE, mode);
          store = t.objectStore(STORE);
        } catch (e) { reject(e); return; }
        t.oncomplete = function () { resolve(); };
        t.onerror = function () { reject(t.error || new Error('tx failed')); };
        t.onabort = function () { reject(t.error || new Error('tx aborted')); };
        try { work = fn(store); }
        catch (e) { try { t.abort(); } catch (_) {} reject(e); }
      });
      return done.then(function () { return work; });
    });
  }

  /** All alarms, unfired and fired alike, oldest deadline first. */
  function all() {
    return tx('readonly', function (store) {
      return new Promise(function (resolve) {
        var req = store.getAll();
        req.onsuccess = function () {
          var rows = req.result || [];
          rows.sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
          resolve(rows);
        };
        req.onerror = function () { resolve([]); };
      });
    }).catch(function () { return []; });
  }

  /** Alarms still waiting to fire. */
  function pending() {
    return all().then(function (rows) {
      return rows.filter(function (r) { return r && !r.firedAt; });
    });
  }

  /**
   * Replace the whole set. The page recomputes every pending deadline from
   * live app state rather than patching individual records, so a wholesale
   * swap is both simpler and self-healing — a crash mid-session can't leave
   * an orphaned alarm ringing for a timer the user already cancelled.
   *
   * `firedAt` already set on a surviving record is preserved: that flag is
   * what stops the page re-announcing a notification the SW delivered.
   */
  function replaceAll(list) {
    var next = Array.isArray(list) ? list : [];
    return tx('readwrite', function (store) {
      return new Promise(function (resolve) {
        var req = store.getAll();
        req.onsuccess = function () {
          var prevById = Object.create(null);
          (req.result || []).forEach(function (r) { if (r && r.id) prevById[r.id] = r; });
          var keep = Object.create(null);
          next.forEach(function (a) {
            if (!a || !a.id) return;
            keep[a.id] = true;
            var prev = prevById[a.id];
            // Same id AND same deadline → carry the fired/trigger flags over.
            // A changed deadline is a different alarm: it must ring again.
            var carry = (prev && prev.at === a.at);
            var rec = {
              id: a.id,
              at: a.at,
              title: a.title || 'Odta',
              body: a.body || '',
              tag: a.tag || a.id,
              data: a.data || {},
              requireInteraction: !!a.requireInteraction,
              firedAt: carry ? (prev.firedAt || 0) : 0,
              trigger: carry ? !!prev.trigger : false,
            };
            store.put(rec);
          });
          Object.keys(prevById).forEach(function (id) {
            if (!keep[id]) store.delete(id);
          });
          resolve(true);
        };
        req.onerror = function () { resolve(false); };
      });
    }).catch(function () { return false; });
  }

  /** Stamp records as delivered so the other context doesn't repeat them. */
  function markFired(ids, when) {
    var list = Array.isArray(ids) ? ids : [ids];
    var ts = when || Date.now();
    return tx('readwrite', function (store) {
      list.forEach(function (id) {
        var req = store.get(id);
        req.onsuccess = function () {
          var rec = req.result;
          if (!rec || rec.firedAt) return;
          rec.firedAt = ts;
          store.put(rec);
        };
      });
      return true;
    }).catch(function () { return false; });
  }

  /** Record that a record's notification is parked in a TimestampTrigger. */
  function markTriggered(ids) {
    var list = Array.isArray(ids) ? ids : [ids];
    return tx('readwrite', function (store) {
      list.forEach(function (id) {
        var req = store.get(id);
        req.onsuccess = function () {
          var rec = req.result;
          if (!rec) return;
          rec.trigger = true;
          store.put(rec);
        };
      });
      return true;
    }).catch(function () { return false; });
  }

  function remove(ids) {
    var list = Array.isArray(ids) ? ids : [ids];
    return tx('readwrite', function (store) {
      list.forEach(function (id) { store.delete(id); });
      return true;
    }).catch(function () { return false; });
  }

  function clear() {
    return tx('readwrite', function (store) { store.clear(); return true; })
      .catch(function () { return false; });
  }

  global.OdtaAlarmStore = {
    all: all,
    pending: pending,
    replaceAll: replaceAll,
    markFired: markFired,
    markTriggered: markTriggered,
    remove: remove,
    clear: clear,
    DB_NAME: DB_NAME,
    STORE: STORE,
  };
})(self);
