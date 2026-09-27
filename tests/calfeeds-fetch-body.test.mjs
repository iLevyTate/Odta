/**
 * Regression: fetchICSContent's timeout / abort / size cap must cover the
 * response BODY (js/calfeeds.js).
 *
 * The 25 s abort timer was cleared, and the feed's AbortController dropped
 * from _calFeedControllers, as soon as fetch() resolved (headers only). The
 * following `await res.text()` had no timeout, could not be aborted by
 * removeCalFeed, and CAL_FETCH_MAX_BYTES was only checked after the whole
 * body had been buffered. A server that sends headers then stalls (or streams
 * forever) hung the sync or exhausted memory.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(root, 'js', 'calfeeds.js'), 'utf8');
const ICS = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:a\nSUMMARY:Café ☕\nDTSTART;VALUE=DATE:20260105\nEND:VEVENT\nEND:VCALENDAR\n';
const URL_OK = 'https://calendar.example.com/feed.ics';

function load({ fetch, subs = {} }) {
  let code = SRC;
  for (const [k, v] of Object.entries(subs)) {
    const re = new RegExp(`const ${k} = [^;]+;`);
    assert.ok(re.test(code), `constant ${k} must exist`);
    code = code.replace(re, `const ${k} = ${v};`);
  }
  const store = new Map();
  const ctx = {
    console, URL, TextDecoder, TextEncoder, ReadableStream, AbortController, setTimeout, clearTimeout, fetch,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
    },
    location: { protocol: 'https:', href: 'https://example.com/' },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return { ctx, get: (expr) => vm.runInContext(expr, ctx) };
}

const headers = (h = {}) => ({ get: (k) => (k.toLowerCase() in h ? String(h[k.toLowerCase()]) : null) });

// A streamed Response whose chunks come from `next()`; returning undefined
// ends the stream, returning a never-settling promise stalls it. The stream
// deliberately ignores the fetch signal unless `honorSignal` is set, so the
// abort must work even for a body that never errors on its own.
function streamed(next, { hdrs = {}, honorSignal = false } = {}) {
  const stats = { pulls: 0, cancelled: false };
  return {
    stats,
    fetch: async (_url, init) => {
      const body = new ReadableStream({
        start(ctrl) {
          if (honorSignal && init && init.signal) init.signal.addEventListener('abort', () => ctrl.error(init.signal.reason));
        },
        async pull(ctrl) {
          stats.pulls++;
          const v = await next(stats.pulls);
          if (v === undefined) ctrl.close(); else ctrl.enqueue(v);
        },
        cancel() { stats.cancelled = true; },
      }, { highWaterMark: 0 });
      return { ok: true, status: 200, headers: headers(hdrs), body, text: async () => { throw new Error('text() must not be used when a stream exists'); } };
    },
  };
}

test('streamed body decodes UTF-8 split across chunk boundaries', async () => {
  const bytes = new TextEncoder().encode(ICS);
  const cut = ICS.indexOf('é') + 1; // mid-codepoint (é is 2 bytes; the byte index is past the ASCII prefix)
  const parts = [bytes.slice(0, cut), bytes.slice(cut, cut + 3), bytes.slice(cut + 3)];
  const s = streamed((n) => parts[n - 1]);
  const h = load({ fetch: s.fetch });
  const text = await h.ctx.fetchICSContent({ id: 'f', url: URL_OK });
  assert.equal(text, ICS);
  assert.equal(h.get('_calFeedControllers.size'), 0, 'controller released after the body is read');
});

test('Content-Length over the cap is refused before the body is read', async () => {
  let readerCalls = 0;
  let signal;
  const h = load({
    fetch: async (_u, init) => {
      signal = init.signal;
      return { ok: true, status: 200, headers: headers({ 'content-length': 50_000_000 }),
        body: { getReader() { readerCalls++; throw new Error('must not read'); } },
        text: async () => { throw new Error('must not read'); } };
    },
  });
  await assert.rejects(h.ctx.fetchICSContent({ id: 'f', url: URL_OK }), /too large/);
  assert.equal(readerCalls, 0);
  assert.equal(signal.aborted, true, 'connection aborted');
});

test('endless stream is aborted once it passes the cap, without buffering the rest', async () => {
  const chunk = new Uint8Array(64 * 1024).fill(0x41);
  const s = streamed(() => chunk);
  const h = load({ fetch: s.fetch });
  const cap = h.get('CAL_FETCH_MAX_BYTES');
  const t0 = performance.now();
  await assert.rejects(h.ctx.fetchICSContent({ id: 'f', url: URL_OK }), /too large/);
  assert.ok(performance.now() - t0 < 2000);
  assert.ok(s.stats.pulls <= Math.ceil(cap / chunk.length) + 2, `read ${s.stats.pulls} chunks`);
  assert.equal(s.stats.cancelled, true, 'stream cancelled');
});

for (const honorSignal of [false, true]) {
  test(`stalled body hits the fetch timeout (stream ${honorSignal ? 'honours' : 'ignores'} the signal)`, { timeout: 5000 }, async () => {
    const first = new TextEncoder().encode('BEGIN:VCALENDAR\n');
    const s = streamed((n) => (n === 1 ? first : new Promise(() => {})), { honorSignal });
    const h = load({ fetch: s.fetch, subs: { CAL_FETCH_TIMEOUT_MS: 60 } });
    const t0 = performance.now();
    await assert.rejects(h.ctx.fetchICSContent({ id: 'f', url: URL_OK }), (e) => /abort/i.test(String(e && (e.name + e.message))));
    assert.ok(performance.now() - t0 < 1500, 'rejected promptly after the timeout');
    assert.equal(h.get('_calFeedControllers.size'), 0);
  });
}

test('removeCalFeed aborts a sync whose body is still streaming', { timeout: 5000 }, async () => {
  let bodyStarted;
  const started = new Promise((r) => { bodyStarted = r; });
  const s = streamed((n) => {
    if (n === 1) { bodyStarted(); return new TextEncoder().encode('BEGIN:VCALENDAR\n'); }
    return new Promise(() => {});
  });
  const h = load({ fetch: s.fetch });
  const feed = h.ctx.addCalFeed({ label: 'U', url: URL_OK });
  const sync = h.ctx.syncCalFeed(feed.id);
  await started;
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.get(`_calFeedControllers.has(${JSON.stringify(feed.id)})`), true,
    'controller stays registered while the body is read');
  h.ctx.removeCalFeed(feed.id);
  await assert.rejects(sync, (e) => /abort/i.test(String(e && (e.name + e.message))));
  assert.equal(h.ctx._loadCalFeeds().feeds.length, 0);
});

test('no-stream fallback: res.text() still works and is still size-checked', async () => {
  const mk = (body) => async () => ({ ok: true, status: 200, headers: headers(), text: async () => body });
  const ok = load({ fetch: mk(ICS) });
  assert.equal(await ok.ctx.fetchICSContent({ id: 'f', url: URL_OK }), ICS);
  const big = load({ fetch: mk('BEGIN:VCALENDAR\n' + 'x'.repeat(2_000_001)) });
  await assert.rejects(big.ctx.fetchICSContent({ id: 'f', url: URL_OK }), /too large/);
});

test('HTTP error status still rejects and releases the controller', async () => {
  const h = load({ fetch: async () => ({ ok: false, status: 404, headers: headers(), text: async () => '' }) });
  await assert.rejects(h.ctx.fetchICSContent({ id: 'f', url: URL_OK }), /HTTP 404/);
  assert.equal(h.get('_calFeedControllers.size'), 0);
});
