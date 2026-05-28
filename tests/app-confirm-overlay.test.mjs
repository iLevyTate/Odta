/**
 * App confirm / prompt overlay stacking and markup guards.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'css', 'main.css'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const ui = readFileSync(join(root, 'js', 'ui.js'), 'utf8');

test('app confirm message host is a div (import delta uses block children)', () => {
  assert.match(html, /id="appConfirmMessage"[^>]*class="[^"]*app-dlg-msg--body/);
  assert.doesNotMatch(html, /<p id="appConfirmMessage"/);
});

test('app confirm overlay stacks above sync-incoming bar and export toasts', () => {
  const dialogZ = css.match(/--z-dialog:\s*(\d+)/);
  assert.ok(dialogZ, 'missing --z-dialog token');
  const zDialog = Number(dialogZ[1]);
  const syncZ = css.match(/\.sync-incoming-bar\s*\{[^}]*z-index:\s*(\d+)/);
  assert.ok(syncZ, 'missing .sync-incoming-bar z-index');
  const exportZ = css.match(/\.export-toast\s*\{[^}]*z-index:\s*(\d+)/);
  assert.ok(exportZ, 'missing .export-toast z-index');
  assert.ok(zDialog > Number(syncZ[1]), 'dialog must sit above sync-incoming bar');
  assert.ok(zDialog > Number(exportZ[1]), 'dialog must sit above export toast');
});

test('destructive confirms style the OK button and reset on close', () => {
  assert.match(ui, /function _resetAppConfirmChrome\(/);
  assert.match(ui, /mfoot-del/);
  assert.match(ui, /closeAppConfirm[\s\S]*?_resetAppConfirmChrome\(\)/);
  assert.match(ui, /showImportConfirm[\s\S]*?_applyAppConfirmChrome\(\{ destructive: true, okLabel: 'Restore' \}\)/);
});
