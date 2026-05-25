/**
 * removeTask now deletes permanently (the old "archive" step is gone) and
 * surfaces an Undo toast whose callback restores the deleted objects — and
 * their original order. Slices the real removeTask out of js/tasks.js and runs
 * it in a Function scope with minimal stubs so production code is exercised.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const full = readFileSync(join(root, 'js', 'tasks.js'), 'utf8');

const sIdx = full.indexOf('async function removeTask(');
const eIdx = full.indexOf('function snoozeTask(', sIdx);
if(sIdx < 0 || eIdx < 0) throw new Error('removeTask markers not found in tasks.js (update test bounds)');
const removeSrc = full.slice(sIdx, eIdx);

function makeScope(initial){
  let tasks = initial;
  const syncTaskDels = {};
  const capture = { undo: null };
  const findTask = (id) => tasks.find(t => t.id === id) || null;
  const getTaskDescendantIds = (id) => {
    const out = [];
    const walk = (pid) => tasks.filter(t => (t.parentId ?? null) === pid)
      .forEach(c => { out.push(c.id); walk(c.id); });
    walk(id);
    return out;
  };
  const factory = new Function(
    'getCtx', 'findTask', 'getTaskDescendantIds', '_stopEvt', 'showAppConfirm',
    '_taskIndexRemove', 'rebuildTaskIdIndex', 'showActionToast',
    'renderTaskList', 'renderBanner', 'saveState', 'announce',
    `let { tasks, syncTaskDels } = getCtx();
     let activeTaskId = null, taskStartedAt = null;
     ${removeSrc}
     return {
       removeTask,
       getTasks: () => tasks,
       getDels: () => syncTaskDels,
     };`
  );
  // tasks/syncTaskDels live inside the factory; expose via getCtx + closures.
  const api = factory(
    () => ({ tasks, syncTaskDels }),
    findTask, getTaskDescendantIds,
    () => {},                                   // _stopEvt
    async () => true,                           // showAppConfirm → always confirm
    () => {},                                   // _taskIndexRemove
    () => {},                                   // rebuildTaskIdIndex
    (label, actLabel, fn) => { capture.undo = fn; }, // showActionToast captures undo
    () => {}, () => {}, () => {}, () => {},     // renderTaskList/renderBanner/saveState/announce
  );
  return { api, capture, getDels: () => api.getDels() };
}

test('removeTask: deletes a task + subtree, undo restores them in original order', async () => {
  const initial = [
    { id: 1, name: 'A', parentId: null },
    { id: 2, name: 'B', parentId: null },   // ← deleted (with child 4)
    { id: 3, name: 'C', parentId: null },
    { id: 4, name: 'B-child', parentId: 2 },
  ];
  const { api, capture } = makeScope(initial);

  await api.removeTask(2);
  let after = api.getTasks();
  assert.deepEqual(after.map(t => t.id), [1, 3], 'task 2 and its child 4 are gone');
  assert.ok(api.getDels()[2] > 0 && api.getDels()[4] > 0, 'deletions are tombstoned for sync');
  assert.equal(typeof capture.undo, 'function', 'an Undo callback was offered');

  capture.undo();
  let restored = api.getTasks();
  assert.deepEqual(restored.map(t => t.id), [1, 2, 3, 4], 'undo restores both, in original positions');
  assert.equal(api.getDels()[2], undefined, 'undo clears the sync tombstones');
  assert.equal(api.getDels()[4], undefined);
});

test('removeTask: single delete needs no confirm and is fully undoable', async () => {
  const initial = [
    { id: 1, name: 'A', parentId: null },
    { id: 2, name: 'B', parentId: null },
  ];
  const { api, capture } = makeScope(initial);

  await api.removeTask(1);
  assert.deepEqual(api.getTasks().map(t => t.id), [2]);

  capture.undo();
  assert.deepEqual(api.getTasks().map(t => t.id), [1, 2], 'restored at its original index');
});
