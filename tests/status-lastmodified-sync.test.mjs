/**
 * Regression: status/completion changes must bump `lastModified` so P2P sync's
 * last-writer-wins merge resolves completion/reopen deterministically.
 *
 * Before the fix, _cascadeOnDone / _maybeAutoCompleteParent (and the quick-toggle
 * paths) set status + completedAt but left lastModified untouched. Reopening a
 * task cleared completedAt while keeping a stale lastModified, so a peer still
 * holding the "done" record (recent completedAt) won the merge and the task
 * flipped back to done — the "stays reopened" / cross-device communication bug.
 *
 * Part A slices the real cascade helpers out of js/tasks.js (same approach as
 * cascade-completion.test.mjs) and asserts they stamp lastModified.
 * Part B reuses the _mergeState harness (same approach as sync-merge.test.mjs)
 * to prove a freshly-reopened local task survives a merge against a stale remote
 * "done" copy.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── Part A: cascade producers bump lastModified ──────────────────────────────
const full = readFileSync(join(root, 'js', 'tasks.js'), 'utf8');
const sIdx = full.indexOf('// ── Parent/subtask completion cascade');
const eIdx = full.indexOf('// Status/Priority quick-change');
if (sIdx < 0 || eIdx < 0) throw new Error('cascade markers not found in tasks.js (update test bounds)');
const cascadeSrc = full.slice(sIdx, eIdx);

function makeCascadeScope(tasks, cfg) {
  const findTask = (id) => tasks.find(t => t.id === id) || null;
  const getTaskChildren = (parentId) => tasks.filter(t => (t.parentId || null) === parentId);
  const stampCompletion = () => '2026-05-11T12:00:00';
  const factory = new Function(
    'tasks', 'cfg', 'findTask', 'getTaskChildren', 'stampCompletion',
    cascadeSrc + '\nreturn { _cascadeOnDone, _maybeAutoCompleteParent };'
  );
  return factory(tasks, cfg, findTask, getTaskChildren, stampCompletion);
}

test('cascade down: completed children get a fresh lastModified', () => {
  const before = Date.now();
  const tasks = [
    { id: 1, name: 'P',  status: 'done', parentId: null, archived: false },
    { id: 2, name: 'C1', status: 'open', parentId: 1,    archived: false, lastModified: 1 },
    { id: 3, name: 'C2', status: 'open', parentId: 1,    archived: false, lastModified: 1 },
  ];
  const { _cascadeOnDone } = makeCascadeScope(tasks, { cascadeCompletion: true });
  _cascadeOnDone(1);
  for (const id of [2, 3]) {
    const t = tasks.find(x => x.id === id);
    assert.equal(t.status, 'done');
    assert.ok(t.lastModified >= before, `child ${id} lastModified bumped to now`);
  }
});

test('cascade up: auto-completed parent gets a fresh lastModified', () => {
  const before = Date.now();
  const tasks = [
    { id: 1, name: 'P',  status: 'open', parentId: null, archived: false, lastModified: 1 },
    { id: 2, name: 'C1', status: 'done', parentId: 1,    archived: false },
    { id: 3, name: 'C2', status: 'done', parentId: 1,    archived: false },
  ];
  const { _maybeAutoCompleteParent } = makeCascadeScope(tasks, { cascadeCompletion: true });
  _maybeAutoCompleteParent(3);
  const p = tasks.find(x => x.id === 1);
  assert.equal(p.status, 'done');
  assert.ok(p.lastModified >= before, 'parent lastModified bumped to now');
});

// ── Part B: reopen wins the sync merge over a stale remote "done" ────────────
function makeMergeRun() {
  const src = readFileSync(join(root, 'js', 'sync.js'), 'utf8');
  const iClamp = src.indexOf('function _clampSyncTs(');
  const iGen = src.indexOf('function _genCode(', iClamp);
  const iMergeDel = src.indexOf('function _mergeDelMapPair(');
  const iConn = src.indexOf('// ── Connection handling');
  assert.ok(iClamp >= 0 && iGen > iClamp, 'slice _clampSyncTs');
  assert.ok(iMergeDel > 0 && iConn > iMergeDel, 'slice merge block');
  const clamp = src.slice(iClamp, iGen);
  const mergeBlock = src.slice(iMergeDel, iConn);

  return new Function(`
    var SYNC_VERSION = 1;
    var _syncApplying = false, _syncAckTimer = null, _conn = null, _saveReason = null;
    var tasks, lists, goals, taskIdCtr, listIdCtr, goalIdCtr, activeListId;
    var timeLog, sessionHistory, intervals, intIdCtr, totalPomos, totalBreaks, totalFocusSec;
    var syncTaskDels, syncListDels, syncGoalDels, stateEpoch, stateNonce;
    var cfg, theme, logIdCtr, pomosInCycle, phase;
    function persistAfterSyncMerge(remoteEpoch, remoteNonce){
      const le = stateEpoch || 0, re = remoteEpoch || 0, ln = stateNonce || 0, rn = remoteNonce || 0;
      if(re > 0) stateEpoch = Math.max(le, re);
      if(re > le || (re === le && re > 0 && rn > ln)) stateNonce = rn;
    }
    function saveState(reason){ _saveReason = reason; }
    function renderAll(){}
    function rebuildTaskIdIndex(){}
    function repairOrphanedTaskParents(){}
    function _repairTask(t){ return t; }
    ${clamp}
    ${mergeBlock}
    return function run(init, remote){
      tasks = init.tasks || []; lists = []; goals = [];
      taskIdCtr = init.taskIdCtr || 0; listIdCtr = 0; goalIdCtr = 0; activeListId = 1;
      timeLog = []; sessionHistory = []; intervals = []; intIdCtr = 0;
      totalPomos = 0; totalBreaks = 0; totalFocusSec = 0;
      syncTaskDels = { ...(init.syncTaskDels || {}) }; syncListDels = {}; syncGoalDels = {};
      stateEpoch = init.stateEpoch || 0; stateNonce = init.stateNonce || 0;
      cfg = {}; theme = 'dark'; logIdCtr = 0; pomosInCycle = 0; phase = 'work';
      _mergeState(remote, {});
      return { tasks };
    };
  `)();
}

test('sync: a freshly-reopened task wins over a stale remote "done" copy', () => {
  const run = makeMergeRun();
  // Local reopened the task most recently: status open, completedAt cleared, and
  // (post-fix) lastModified bumped to a time newer than the remote completion.
  const local = {
    tasks: [{ id: 1, name: 'task', status: 'open', completedAt: null, lastModified: 2000 }],
    taskIdCtr: 1,
    stateEpoch: 2,
  };
  // Remote still has the older "done" record. Its sync timestamp falls back to
  // completedAt (1500), which is older than the local reopen (2000).
  const remote = {
    tasks: [{ id: 1, name: 'task', status: 'done', completedAt: 1500, lastModified: 0 }],
    taskIdCtr: 1,
    stateEpoch: 1,
  };
  const out = run(local, remote);
  assert.equal(out.tasks.length, 1);
  assert.equal(out.tasks[0].status, 'open', 'reopen survives the merge');
  assert.equal(out.tasks[0].completedAt, null);
});

test('sync: WITHOUT the lastModified bump the stale done would win (guards the fix)', () => {
  const run = makeMergeRun();
  // Simulates the pre-fix bug: reopen left lastModified at the old creation time
  // (1) while completedAt was cleared, so the merge timestamp collapsed to 1 and
  // the remote done (completedAt 1500) overwrote it. This documents why the bump
  // matters — if this assertion ever flips, the merge contract changed.
  const local = {
    tasks: [{ id: 1, name: 'task', status: 'open', completedAt: null, lastModified: 1 }],
    taskIdCtr: 1,
    stateEpoch: 1,
  };
  const remote = {
    tasks: [{ id: 1, name: 'task', status: 'done', completedAt: 1500, lastModified: 0 }],
    taskIdCtr: 1,
    stateEpoch: 1,
  };
  const out = run(local, remote);
  assert.equal(out.tasks[0].status, 'done', 'stale reopen loses — exactly the bug we fixed');
});
