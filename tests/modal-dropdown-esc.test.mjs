/**
 * Escape-key ownership between Modal and Dropdown (cross-module).
 *
 * Both install document-level CAPTURE-phase keydown listeners, and
 * stopPropagation() cannot suppress another listener on the same node in the
 * same phase (that's stopImmediatePropagation, and registration order defeats
 * even that here: Modal's boot-time listener fires before Dropdown's
 * open-time one). So Modal's ESC handler must explicitly yield while a
 * Dropdown is open — otherwise pressing Escape to dismiss a Status/Priority/
 * Due pill picker inside the task-detail modal also tore down the modal.
 *
 * notify() (audio.js) rides along here: its ServiceWorker branch must gate on
 * an ACTIVE controller, because on file:// the API object exists but pwa.js
 * never registers a worker — .ready never resolves and the early return
 * stranded the main-thread fallback, silencing all timer/reminder
 * notifications in portable mode.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('Modal ESC handler yields to an open Dropdown', () => {
  const src = readFileSync(join(root, 'js', 'modal.js'), 'utf8');
  const idx = src.indexOf("e.key !== 'Escape'");
  assert.ok(idx >= 0, 'modal ESC handler exists');
  const handler = src.slice(idx, idx + 600);
  const guardIdx = handler.indexOf('Dropdown.isOpen');
  const topIdx = handler.indexOf('topmost()');
  assert.ok(guardIdx >= 0, 'handler checks Dropdown.isOpen()');
  assert.ok(topIdx >= 0, 'handler resolves the topmost modal');
  assert.ok(guardIdx < topIdx, 'dropdown check runs BEFORE the modal close path');
});

test('notify() SW branch gates on an active controller (file:// fallback reachable)', () => {
  const src = readFileSync(join(root, 'js', 'audio.js'), 'utf8');
  const idx = src.indexOf('function notify(');
  assert.ok(idx >= 0, 'notify found');
  const body = src.slice(idx, idx + 2000);
  assert.match(body, /'serviceWorker' in navigator && navigator\.serviceWorker\.controller/,
    'SW path requires a live controller, not just the API object');
  assert.match(body, /new Notification\(/, 'main-thread fallback still present');
});
