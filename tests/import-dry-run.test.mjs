/**
 * Import-flow guards: the previous importData wholesale-replaced live state
 * with a single trailing alert(). Now we summarize incoming vs current
 * counts and show a confirm dialog *before* the destructive _applyState.
 * Static checks that the wiring stays intact.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const storageSrc = readFileSync(join(root, 'js', 'storage.js'), 'utf8');
const uiSrc      = readFileSync(join(root, 'js', 'ui.js'),      'utf8');

test('importData calls showImportConfirm before _applyState', () => {
  const idx = storageSrc.indexOf('function importData(');
  assert.ok(idx > 0, 'importData not found');
  const body = storageSrc.slice(idx, idx + 2000);
  const confirmAt = body.indexOf('showImportConfirm');
  const applyAt   = body.indexOf('_applyState(s)');
  assert.ok(confirmAt > 0, 'showImportConfirm must be called');
  assert.ok(applyAt   > 0, '_applyState must be called');
  assert.ok(confirmAt < applyAt, 'showImportConfirm must run BEFORE _applyState (destructive)');
});

test('_summarizeImport returns current/incoming/archive-day counts', () => {
  const idx = storageSrc.indexOf('function _summarizeImport');
  assert.ok(idx > 0, '_summarizeImport not found');
  const body = storageSrc.slice(idx, idx + 800);
  // Must surface both current and incoming counts so the user sees a delta,
  // not just "import 142 tasks?" with no point of comparison.
  assert.match(body, /current/, 'must return current counts');
  assert.match(body, /incoming/, 'must return incoming counts');
  assert.match(body, /archiveDays/, 'must surface daily Past-Days archive count');
});

test('showImportConfirm renders with textContent only', () => {
  const idx = uiSrc.indexOf('function showImportConfirm');
  assert.ok(idx > 0, 'showImportConfirm not found');
  const body = uiSrc.slice(idx, idx + 2000);
  // Defense-in-depth: even though the input is just our own count summary,
  // the dialog must not assemble HTML strings for any user-influenced field.
  assert.ok(!/innerHTML\s*=/.test(body), 'showImportConfirm must not use innerHTML');
  assert.match(body, /textContent/, 'must use textContent for cell rendering');
  assert.match(body, /replaceChildren\(\)/, 'must reset modal body before injecting new content');
});
