/**
 * Regression: the action-toast "Undo" button ran its callback but left the
 * mirrored entry in the Cmd+Z ring buffer (_undoRing in js/ui.js). After the
 * toast faded, a follow-up Cmd+Z popped that stale entry and replayed the same
 * undo — re-inserting a just-restored task and duplicating state. The toast
 * undo must now consume its ring entry (removeUndoEntry) and guard against a
 * double-fire.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const uiSrc = readFileSync(join(root, 'js', 'ui.js'), 'utf8');
const utilsSrc = readFileSync(join(root, 'js', 'utils.js'), 'utf8');

function loadUndoRing() {
  const s = uiSrc.indexOf('const _UNDO_RING_MAX');
  const e = uiSrc.indexOf('window.pushUndo = pushUndo;');
  assert.ok(s >= 0 && e > s, 'slice undo-ring block');
  const block = uiSrc.slice(s, e); // stop just before the window.* exports
  return new Function(`
    ${block}
    return { pushUndo, popUndo, removeUndoEntry, ring: _undoRing };
  `)();
}

test('toast Undo consumes its ring entry so Cmd+Z cannot replay it', () => {
  const { pushUndo, popUndo, removeUndoEntry } = loadUndoRing();
  let runs = 0;
  const undoFn = () => { runs += 1; };

  // showActionToast pushes the undo and keeps the returned handle.
  const handle = pushUndo('Deleted task', undoFn);
  assert.ok(handle, 'pushUndo returns a handle');

  // User clicks the toast "Undo" button: run the action, then consume the entry.
  undoFn();
  removeUndoEntry(handle);
  assert.equal(runs, 1);

  // Later, the toast is gone and the user presses Cmd+Z → ring fallback.
  const entry = popUndo();
  assert.equal(entry, null, 'no stale entry remains, so the undo is not replayed');
  assert.equal(runs, 1, 'undo ran exactly once');
});

test('removeUndoEntry only removes the matching entry', () => {
  const { pushUndo, popUndo, removeUndoEntry } = loadUndoRing();
  const a = pushUndo('A', () => {});
  const b = pushUndo('B', () => {});
  removeUndoEntry(a);
  const top = popUndo();
  assert.equal(top, b, 'unrelated entries are preserved');
});

test('utils.js action-toast wiring consumes the undo entry and guards double-fire', () => {
  const s = utilsSrc.indexOf('function showActionToast');
  assert.ok(s >= 0, 'showActionToast not found');
  const body = utilsSrc.slice(s, s + 3000);
  assert.match(body, /_undoHandle\s*=\s*pushUndo\(/, 'must capture the pushUndo handle');
  assert.match(body, /removeUndoEntry\(_undoHandle\)/, 'toast undo must consume the ring entry');
  assert.match(body, /if\(_undone\)\s*return/, 'toast undo must guard against a double-fire');
});
