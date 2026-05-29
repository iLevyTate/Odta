/**
 * Regression: _embedAllCache is a per-tab in-memory mirror of the shared
 * IndexedDB embeddings store. IDB writes emit no `storage` events, so when one
 * tab re-embeds/purges/clears, other tabs kept serving stale vectors to KNN
 * search. embed-store now broadcasts a coalesced localStorage ping on every
 * mutation; other tabs drop their mirror and lazily rebuild on the next all().
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'embed-store.js'), 'utf8');

function buildHarness() {
  // Slice the cross-tab cache-coherence block (cache var + ping + listener).
  const start = src.indexOf('let _embedAllCache = null;');
  const end = src.indexOf('function _openDb(', start);
  assert.ok(start >= 0 && end > start, 'slice cache-coherence block');
  const block = src.slice(start, end);

  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
  };
  let storageHandler = null;
  const timers = [];
  const window = {
    addEventListener: (type, fn) => { if (type === 'storage') storageHandler = fn; },
  };
  const setTimeout = (fn) => { timers.push(fn); return timers.length; };

  const factory = new Function('_EC', 'window', 'localStorage', 'setTimeout', `
    ${block}
    return {
      ping: _pingEmbedCacheChange,
      seedCache: (m) => { _embedAllCache = m; },
      getCache: () => _embedAllCache,
      PING_KEY: EMBED_CACHE_PING_KEY,
    };
  `);
  const api = factory({}, window, localStorage, setTimeout);
  return {
    api, store, timers,
    fireStorage: (key) => { if (storageHandler) storageHandler({ key }); },
    hasHandler: () => storageHandler != null,
    flushTimers: () => { const t = timers.splice(0); t.forEach(fn => fn()); },
  };
}

test('a storage listener is registered and clears the mirror on the ping key', () => {
  const h = buildHarness();
  assert.ok(h.hasHandler(), 'embed-store must register a storage listener');
  h.api.seedCache(new Map([[1, {}]]));
  h.fireStorage(h.api.PING_KEY);
  assert.equal(h.api.getCache(), null, 'a ping must drop the stale mirror');
});

test('an unrelated storage key does not clear the mirror', () => {
  const h = buildHarness();
  h.api.seedCache(new Map([[1, {}]]));
  h.fireStorage('something_else');
  assert.notEqual(h.api.getCache(), null, 'unrelated keys must not invalidate the mirror');
});

test('a burst of mutations coalesces into a single ping write', () => {
  const h = buildHarness();
  // Many puts in one tick should schedule only one debounced ping.
  for (let i = 0; i < 50; i++) h.api.ping();
  assert.equal(h.timers.length, 1, 'burst must coalesce into one scheduled ping');
  h.flushTimers();
  assert.ok(h.store.has(h.api.PING_KEY), 'the coalesced ping writes the key once flushed');
});

test('the ping value changes each flush so the storage event always fires', () => {
  const h = buildHarness();
  h.api.ping(); h.flushTimers();
  const first = h.store.get(h.api.PING_KEY);
  h.api.ping(); h.flushTimers();
  const second = h.store.get(h.api.PING_KEY);
  assert.notEqual(first, second, 'consecutive pings must write distinct values (storage event only fires on change)');
});

test('every mirror mutation site pings (put / purge / clearAll)', () => {
  // Static guard: the three IDB-mutating methods must broadcast.
  const putNow = src.slice(src.indexOf('async _putNow('), src.indexOf('async get('));
  const purge = src.slice(src.indexOf('async purge('), src.indexOf('async cleanOrphans('));
  const clear = src.slice(src.indexOf('async clearAllEmbeddings('), src.indexOf('getCatCentroidsKey('));
  assert.match(putNow, /_pingEmbedCacheChange\(\)/, '_putNow must ping');
  assert.match(purge, /_pingEmbedCacheChange\(\)/, 'purge must ping');
  assert.match(clear, /_pingEmbedCacheChange\(\)/, 'clearAllEmbeddings must ping');
});
