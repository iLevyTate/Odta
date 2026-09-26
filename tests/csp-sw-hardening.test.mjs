/**
 * Content-Security-Policy, service worker and generation-worker boundaries.
 *
 *  - The meta CSP had no media-src, so media fell back to default-src 'self'
 *    and every blob: URL was refused: the background-audio keepalive
 *    (audio.js) and voice-note playback never played. Chromium logged
 *    "Refused to load media from 'blob:…'".
 *  - The SW cached each navigation under its full URL, so share-target text
 *    the page had scrubbed from the address bar stayed in Cache Storage.
 *  - notificationclick passed data.url straight to clients.openWindow().
 *  - gen-worker.js import()ed whatever runtime URL its load message named;
 *    a worker's CSP comes from response headers, which static hosting omits.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const sw = readFileSync(join(root, 'sw.js'), 'utf8');
const worker = readFileSync(join(root, 'js', 'gen-worker.js'), 'utf8');

const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
const directives = Object.fromEntries(
  csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const [name, ...vals] = d.split(/\s+/);
    return [name, vals];
  }),
);

test('CSP: media-src allows blob: (keepalive WAV, voice notes)', () => {
  assert.ok(directives['media-src'], 'media-src must be explicit');
  assert.ok(directives['media-src'].includes("'self'"));
  assert.ok(directives['media-src'].includes('blob:'));
});

test('CSP: script-src stays same-origin, no inline, no eval', () => {
  const s = directives['script-src'];
  assert.deepStrictEqual([...s].sort(), ["'self'", "'wasm-unsafe-eval'"].sort());
  assert.ok(!csp.includes("'unsafe-inline'"));
  assert.ok(!csp.includes("'unsafe-eval'"));
  assert.deepStrictEqual(directives['object-src'], ["'none'"]);
  assert.deepStrictEqual(directives['form-action'], ["'none'"]);
});

test('SW: shell navigations share one cache key; off-shell navigations are not cached as the shell', () => {
  const nav = sw.slice(sw.indexOf('if(isNavigation){'), sw.indexOf('e.respondWith(\n    caches.match(e.request)'));
  assert.match(nav, /c\.put\('\.\/index\.html', clone\)/);
  assert.doesNotMatch(nav, /c\.put\(e\.request/);
  assert.match(nav, /isShell && res/);
});

test('SW: notificationclick only opens same-origin targets', () => {
  const nc = sw.slice(sw.indexOf("addEventListener('notificationclick'"), sw.indexOf("addEventListener('notificationclose'"));
  assert.match(nc, /u\.origin === self\.location\.origin/);
  assert.doesNotMatch(nc, /const target = data\.url \|\| '\.\/'/);
});

test('SW: the unused SHOW_NOTIFICATION message path is gone', () => {
  assert.doesNotMatch(sw, /e\.data\?\.type === 'SHOW_NOTIFICATION'/);
});

test('gen worker refuses runtime URLs off this origin', async () => {
  const fn = worker.match(/function sameOriginUrl\(u\)\{[\s\S]*?\n\}/);
  assert.ok(fn, 'sameOriginUrl not found');
  const sameOriginUrl = new Function('self', fn[0] + '; return sameOriginUrl;')({ location: { href: 'https://odta.app/js/gen-worker.js', origin: 'https://odta.app' } });
  assert.equal(sameOriginUrl('https://odta.app/js/vendor/transformers/transformers.min.mjs'), 'https://odta.app/js/vendor/transformers/transformers.min.mjs');
  assert.equal(sameOriginUrl('./vendor/transformers/'), 'https://odta.app/js/vendor/transformers/');
  assert.equal(sameOriginUrl('https://cdn.jsdelivr.net/npm/evil/x.mjs'), null);
  assert.equal(sameOriginUrl('data:text/javascript,alert(1)'), null);
  assert.match(worker, /if\(!transformersUrl \|\| !wasmDir\)\{ post\(\{ type: 'load-error'/);
});
