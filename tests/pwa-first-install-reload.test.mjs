/**
 * pwa.js controllerchange reload — first-install guard.
 *
 * sw.js's activate handler calls clients.claim(), which fires
 * controllerchange on a page that had NO previous controller (every first
 * visit). Reloading there yanks new visitors through a pointless full-page
 * reload right after first paint. The reload must only happen when an old
 * service worker is actually being replaced, i.e. when
 * navigator.serviceWorker.controller was non-null before the change.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'pwa.js'), 'utf8');

test('controllerchange reload is gated on a pre-existing controller', () => {
  const idx = src.indexOf("addEventListener('controllerchange'");
  assert.ok(idx >= 0, 'controllerchange listener exists');
  // The prior-controller snapshot must be taken before the listener…
  const before = src.slice(Math.max(0, idx - 800), idx);
  assert.match(before, /navigator\.serviceWorker\.controller/,
    'captures navigator.serviceWorker.controller before listening');
  // …and the handler must bail when there was no prior controller.
  const handler = src.slice(idx, idx + 500);
  assert.match(handler, /if\(!_hadController\) return;/,
    'handler skips the reload on first install');
  assert.match(handler, /window\.location\.reload\(\)/, 'update path still reloads');
});
