/**
 * Regression tests for _subtaskAllowedUnderShownParent in js/tasks.js.
 *
 * The function decides whether a subtask should render when its parent
 * passed the smart-view filter. Before the Task-1 fix, a done subtask
 * under a visible parent (e.g. parent due today) kept rendering in every
 * smart view including 'today' / 'starred' / 'overdue'.
 *
 * Pattern: slice the function source out of js/tasks.js and evaluate it
 * in an isolated vm context with stubbed dependencies (smartView, gid,
 * todayISO). vm.runInNewContext gives us the same isolation as the
 * existing search-operators tests use, with native Node APIs.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const full = readFileSync(join(root, 'js', 'tasks.js'), 'utf8');

const startMarker = 'function _subtaskAllowedUnderShownParent';
const sIdx = full.indexOf(startMarker);
if (sIdx < 0) throw new Error('_subtaskAllowedUnderShownParent not found in js/tasks.js');
const eIdx = full.indexOf('\n}', sIdx);
if (eIdx < 0) throw new Error('end of _subtaskAllowedUnderShownParent not found');
const block = full.slice(sIdx, eIdx + 2);

/**
 * Run the sliced source inside an isolated vm context that defines the
 * scope vars the function reads (smartView, gid, todayISO). The returned
 * value is the function itself, ready to call with a task object.
 */
function loadFn(smartView, showCompletedAllChecked) {
  const sandbox = {
    smartView,
    todayISO: () => '2026-05-27',
    gid: (id) => id === 'showCompletedAll' ? { checked: showCompletedAllChecked } : null,
    _pinVisibleTaskIds: new Set(),
  };
  vm.createContext(sandbox);
  const script = block + '\n_subtaskAllowedUnderShownParent;';
  return vm.runInContext(script, sandbox);
}

test('done subtask is hidden in today view when showCompletedAll is off', () => {
  const fn = loadFn('today', false);
  assert.equal(fn({ status: 'done' }), false);
});

test('done subtask is hidden in starred view when showCompletedAll is off', () => {
  const fn = loadFn('starred', false);
  assert.equal(fn({ status: 'done' }), false);
});

test('done subtask is visible in completed view regardless of toggle', () => {
  const fn = loadFn('completed', false);
  assert.equal(fn({ status: 'done' }), true);
});

test('done subtask is visible in all view when showCompletedAll is on', () => {
  const fn = loadFn('all', true);
  assert.equal(fn({ status: 'done' }), true);
});

test('done subtask is hidden in all view when showCompletedAll is off', () => {
  const fn = loadFn('all', false);
  assert.equal(fn({ status: 'done' }), false);
});

test('open subtask is visible in any non-snooze view', () => {
  for (const view of ['today', 'all', 'starred', 'completed', 'overdue']) {
    const fn = loadFn(view, false);
    assert.equal(fn({ status: 'open' }), true, 'view=' + view);
  }
});

test('snoozed open subtask is hidden in non-snooze view', () => {
  const fn = loadFn('today', false);
  assert.equal(fn({ status: 'open', hiddenUntil: '2026-05-28' }), false);
});

test('snoozed open subtask is visible in snoozed view', () => {
  const fn = loadFn('snoozed', false);
  assert.equal(fn({ status: 'open', hiddenUntil: '2026-05-28' }), true);
});
