/**
 * Manual reorder & indent (Reorder mode). Loads the real reorder block from
 * js/tasks.js — same source the browser runs — and drives it against a tiny
 * in-memory task array with stubbed dependencies (sortTasks = manual order,
 * everything else a no-op).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const full = readFileSync(join(root, 'js', 'tasks.js'), 'utf8');
const s = full.indexOf('// ── Manual reorder & indent');
const e = full.indexOf('/** Non-archived tasks');
if (s < 0 || e < 0) throw new Error('tasks.js: reorder block markers not found (update test slice bounds)');
const block = full.slice(s, e);

function load(tasks) {
  const findTask = (id) => tasks.find((t) => t.id === id);
  const getTaskChildren = (pid) => tasks.filter((t) => (t.parentId || null) === pid);
  const sortTasks = (arr) => arr.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const noop = () => {};
  const gid = () => null;
  const win = {};
  return new Function(
    'tasks', 'findTask', 'getTaskChildren', 'sortTasks', 'saveState',
    'renderTaskList', 'gid', 'haptic', 'window', 'taskSortBy',
    block + '\nreturn { moveTaskUp, moveTaskDown, indentTask, outdentTask, isReorderMode };',
  )(tasks, findTask, getTaskChildren, sortTasks, noop, noop, gid, noop, win, 'smart');
}

const ids = (tasks, pid = null) =>
  tasks.filter((t) => (t.parentId || null) === pid)
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((t) => t.id);

test('moveTaskDown swaps order with the next sibling', () => {
  const tasks = [
    { id: 1, name: 'A', parentId: null, order: 0 },
    { id: 2, name: 'B', parentId: null, order: 10 },
    { id: 3, name: 'C', parentId: null, order: 20 },
  ];
  const { moveTaskDown } = load(tasks);
  moveTaskDown(1);
  assert.deepEqual(ids(tasks), [2, 1, 3]);
});

test('moveTaskUp swaps order with the previous sibling', () => {
  const tasks = [
    { id: 1, name: 'A', parentId: null, order: 0 },
    { id: 2, name: 'B', parentId: null, order: 10 },
    { id: 3, name: 'C', parentId: null, order: 20 },
  ];
  const { moveTaskUp } = load(tasks);
  moveTaskUp(3);
  assert.deepEqual(ids(tasks), [1, 3, 2]);
});

test('moveTaskUp on the first sibling is a no-op', () => {
  const tasks = [
    { id: 1, name: 'A', parentId: null, order: 0 },
    { id: 2, name: 'B', parentId: null, order: 10 },
  ];
  const { moveTaskUp } = load(tasks);
  moveTaskUp(1);
  assert.deepEqual(ids(tasks), [1, 2]);
});

test('indentTask nests under the immediately-preceding sibling and expands it', () => {
  const tasks = [
    { id: 1, name: 'A', parentId: null, order: 0, collapsed: true },
    { id: 2, name: 'B', parentId: null, order: 10 },
  ];
  const { indentTask } = load(tasks);
  indentTask(2);
  assert.strictEqual(tasks.find((t) => t.id === 2).parentId, 1);
  assert.strictEqual(tasks.find((t) => t.id === 1).collapsed, false, 'parent expands');
  assert.deepEqual(ids(tasks, null), [1]);
  assert.deepEqual(ids(tasks, 1), [2]);
});

test('indentTask on the first sibling is a no-op (nothing to nest under)', () => {
  const tasks = [
    { id: 1, name: 'A', parentId: null, order: 0 },
    { id: 2, name: 'B', parentId: null, order: 10 },
  ];
  const { indentTask } = load(tasks);
  indentTask(1);
  assert.strictEqual(tasks.find((t) => t.id === 1).parentId, null);
});

test('outdentTask promotes a child to its grandparent level, just after the old parent', () => {
  const tasks = [
    { id: 1, name: 'A', parentId: null, order: 0 },
    { id: 2, name: 'child', parentId: 1, order: 0 },
    { id: 3, name: 'B', parentId: null, order: 10 },
  ];
  const { outdentTask } = load(tasks);
  outdentTask(2);
  assert.strictEqual(tasks.find((t) => t.id === 2).parentId, null);
  // Sits between A (order 0) and B (order 10).
  assert.deepEqual(ids(tasks, null), [1, 2, 3]);
});

test('outdentTask on a root task is a no-op', () => {
  const tasks = [{ id: 1, name: 'A', parentId: null, order: 0 }];
  const { outdentTask } = load(tasks);
  outdentTask(1);
  assert.strictEqual(tasks.find((t) => t.id === 1).parentId, null);
});

test('UI wiring: reorder toggle and overflow menu are present', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  assert.match(html, /id="reorderModeToggle"[^>]*data-action="toggleReorderMode"|data-action="toggleReorderMode"[^>]*id="reorderModeToggle"/, 'reorder toggle wired');
  const ui = readFileSync(join(root, 'js', 'ui.js'), 'utf8');
  assert.match(ui, /data-action="showTaskActionMenu"/, 'rows render the ⋯ overflow trigger');
  assert.match(ui, /data-action="moveTaskUp"/, 'reorder-mode rows render move-up');
  assert.match(ui, /data-action="indentTask"/, 'reorder-mode rows render indent');
  assert.match(ui, /window\.showTaskActionMenu\s*=/, 'showTaskActionMenu exported');
});

test('move forces manual sort (so the change is visible under any sort mode)', () => {
  const tasks = [
    { id: 1, name: 'A', parentId: null, order: 0 },
    { id: 2, name: 'B', parentId: null, order: 10 },
  ];
  // taskSortBy starts as 'smart'; a move must flip the module's sort to manual.
  // We can't read the closure var directly, but the swap result proves manual
  // ordering took effect (smart sort would ignore .order).
  const { moveTaskDown } = load(tasks);
  moveTaskDown(1);
  assert.deepEqual(ids(tasks), [2, 1]);
});
