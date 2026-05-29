/**
 * Regression: _calFeeds is a per-tab in-memory cache populated once on first
 * read. When another tab adds/removes/re-syncs a feed (rewriting CALFEEDS_KEY),
 * this tab kept serving the stale cache — and worse, its next _saveCalFeeds()
 * would clobber the other tab's write. A `storage` listener must drop the cache
 * so the next access re-reads the authoritative localStorage value.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'calfeeds.js'), 'utf8');

function buildHarness() {
  const start = src.indexOf('let _calFeeds = null;');
  const end = src.indexOf('// ── Parser', start);
  assert.ok(start >= 0 && end > start, 'slice calfeeds cache block');
  const body = src.slice(start, end);

  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
  };
  let storageHandler = null;
  const window = {
    addEventListener: (type, fn) => { if (type === 'storage') storageHandler = fn; },
  };

  const factory = new Function('window', 'localStorage', `
    const CALFEEDS_KEY = 'cal_feeds_test';
    ${body}
    return { _loadCalFeeds, _saveCalFeeds, getCache: () => _calFeeds, KEY: CALFEEDS_KEY };
  `);
  const api = factory(window, localStorage);
  return {
    api, store,
    fireStorage: (key) => { if (storageHandler) storageHandler({ key }); },
    hasHandler: () => storageHandler != null,
  };
}

test('a storage listener for the feeds key is registered', () => {
  const h = buildHarness();
  assert.ok(h.hasHandler(), 'calfeeds.js must register a storage listener');
});

test('a cross-tab CALFEEDS_KEY write invalidates the stale cache', () => {
  const h = buildHarness();
  h.store.set('cal_feeds_test', JSON.stringify({ feeds: [{ id: 'a', label: 'A' }] }));

  const first = h.api._loadCalFeeds();
  assert.deepEqual(first.feeds.map(f => f.id), ['a'], 'initial read');

  // Another tab rewrites the feeds.
  h.store.set('cal_feeds_test', JSON.stringify({ feeds: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }));

  // Without invalidation the cache still returns the stale single feed.
  assert.deepEqual(h.api._loadCalFeeds().feeds.map(f => f.id), ['a'], 'cache is still stale before the event');

  // The cross-tab storage event drops the cache.
  h.fireStorage('cal_feeds_test');
  assert.equal(h.api.getCache(), null, 'cache must be cleared by the storage event');
  assert.deepEqual(h.api._loadCalFeeds().feeds.map(f => f.id), ['a', 'b'], 're-read picks up the other tab\'s write');
});

test('an unrelated storage key does not clear the cache', () => {
  const h = buildHarness();
  h.store.set('cal_feeds_test', JSON.stringify({ feeds: [{ id: 'a' }] }));
  h.api._loadCalFeeds();
  h.fireStorage('some_other_key');
  assert.notEqual(h.api.getCache(), null, 'unrelated keys must not invalidate the feeds cache');
});
