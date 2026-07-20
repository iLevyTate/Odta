/**
 * Keyboard-shortcut integrity in js/ui.js.
 *
 * 1. Digits 1–5 switch top-level tabs — the shortcuts cheat-sheet and the
 *    command-palette kbd labels advertise this, so a real keydown handler
 *    must exist (previously the labels were cosmetic and pressing 1–5 did
 *    nothing).
 * 2. Cmd/Ctrl+N must not fire while typing in ANY field. The guard used to
 *    check only tag === 'input', so Cmd+N inside the description textarea,
 *    a <select>, or contenteditable stole the browser's new-window shortcut
 *    and yanked focus to the new-task input.
 * 3. showTab carries the data-panel-entered marker itself — the old
 *    window.showTab monkey-patch was bypassed by every internal bare
 *    showTab(...) call (they bind the hoisted declaration, not the wrapper).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'ui.js'), 'utf8');

test('digit 1-5 tab-switch handler exists and maps all five tabs', () => {
  const m = src.match(/TAB_KEYS\s*=\s*\{([^}]*)\}/);
  assert.ok(m, 'TAB_KEYS digit → tab map exists');
  for (const tab of ['tasks', 'focus', 'tools', 'data', 'settings']) {
    assert.ok(m[1].includes(`'${tab}'`), `digit shortcut covers '${tab}'`);
  }
  // The handler must respect fields and modifier keys like the other
  // global shortcuts do.
  const idx = src.indexOf('TAB_KEYS');
  const block = src.slice(Math.max(0, idx - 600), idx + 900);
  assert.match(block, /isContentEditable/, 'digit shortcut ignores fields');
  assert.match(block, /ctrlKey|metaKey/, 'digit shortcut ignores modifier combos');
});

test('Cmd/Ctrl+N bails out of every field type, not just <input>', () => {
  const idx = src.indexOf("(e.key==='n' || e.key==='N')");
  assert.ok(idx >= 0, 'Cmd+N handler exists');
  const block = src.slice(Math.max(0, idx - 800), idx + 800);
  assert.match(block, /if\(isMeta && inField\) return;/,
    'meta guard uses inField (textarea/select/contenteditable included)');
  assert.ok(!/if\(isMeta && tag === 'input'\) return;/.test(block),
    'old input-only guard is gone');
});

test('showTab sets data-panel-entered itself (no bypassed monkey-patch)', () => {
  assert.ok(!src.includes('_origShowTab'), 'window.showTab wrapper removed');
  const s = src.indexOf('function showTab(');
  assert.ok(s >= 0, 'showTab found');
  const e = src.indexOf('\nfunction ', s + 1);
  const body = src.slice(s, e > s ? e : undefined);
  assert.match(body, /data-panel-entered/, 'enter-animation marker lives inside showTab');
});
