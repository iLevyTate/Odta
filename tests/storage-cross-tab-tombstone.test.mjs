/**
 * Regression: the cross-tab LWW merge (_mergeRemoteStateLww in js/storage.js)
 * merged deletion tombstone maps but never actually removed the tombstoned
 * entities. A task/list/goal deleted in tab A would resurrect in tab B whenever
 * B had unsaved edits — and could then propagate the zombie back out. The P2P
 * path (sync.js _mergeState) already honoured tombstones; this brings the
 * cross-tab path in line.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function makeMergeRun() {
  const src = readFileSync(join(root, 'js', 'storage.js'), 'utf8');
  const i = src.indexOf('function _mergeRemoteStateLww(');
  assert.ok(i >= 0, 'find _mergeRemoteStateLww');
  const j = src.indexOf('\nfunction _onStorageFromOtherTab(', i);
  assert.ok(j > i, 'slice _mergeRemoteStateLww');
  const mergeFn = src.slice(i, j);

  return new Function(`
    var tasks, lists, goals, taskIdCtr, listIdCtr, goalIdCtr;
    var timeLog, sessionHistory, intervals, intIdCtr, logIdCtr;
    var totalPomos, totalBreaks, totalFocusSec, pomosInCycle, phase;
    var syncTaskDels, syncListDels, syncGoalDels, stateEpoch, stateNonce, activeTaskId;
    function migrateState(s){ return s; }
    function _validateState(){ return true; }
    function _int(v, d){ const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
    function _taskLwwMs(t){ return (t && t.lastModified) || 0; }
    function _mergeDelPair(loc, rem){
      const o = { ...loc };
      if(!rem || typeof rem !== 'object' || Array.isArray(rem)) return o;
      for(const [k, v] of Object.entries(rem)){
        const id = parseInt(k, 10);
        if(!Number.isFinite(id)) continue;
        const rv = typeof v === 'number' && v > 0 ? v : 0;
        o[id] = o[id] == null ? rv : Math.max(o[id], rv);
      }
      return o;
    }
    function _mergeTimeLogById(a){ return a || []; }
    function _mergeSessionHistTail(a){ return a || []; }
    function _mergeIntervalsById(a){ return a || []; }
    function rebuildTaskIdIndex(){}
    function repairOrphanedTaskParents(){}
    function findTask(id){ return tasks.find(t => t.id === id) || null; }
    ${mergeFn}
    return function run(init, remote){
      tasks = init.tasks || [];
      lists = init.lists || [];
      goals = init.goals || [];
      taskIdCtr = init.taskIdCtr || 0;
      listIdCtr = init.listIdCtr || 0;
      goalIdCtr = init.goalIdCtr || 0;
      timeLog = []; sessionHistory = []; intervals = [];
      intIdCtr = 0; logIdCtr = 0;
      totalPomos = 0; totalBreaks = 0; totalFocusSec = 0; pomosInCycle = 0; phase = 'work';
      syncTaskDels = { ...(init.syncTaskDels || {}) };
      syncListDels = { ...(init.syncListDels || {}) };
      syncGoalDels = { ...(init.syncGoalDels || {}) };
      stateEpoch = init.stateEpoch || 0;
      stateNonce = init.stateNonce || 0;
      activeTaskId = init.activeTaskId != null ? init.activeTaskId : null;
      const ok = _mergeRemoteStateLww(remote);
      return { ok, tasks, lists, goals, syncTaskDels, syncListDels, syncGoalDels };
    };
  `)();
}

test('cross-tab: a remote task tombstone removes the local (dirty) task', () => {
  const run = makeMergeRun();
  // Local dirty tab still has task 1; remote tab deleted it (tombstone newer
  // than the task's lastModified).
  const res = run(
    { tasks: [{ id: 1, name: 'pay bill', lastModified: 100 }], taskIdCtr: 1 },
    { tasks: [], taskIdCtr: 1, syncTaskDels: { 1: 200 }, stateEpoch: 1 },
  );
  assert.equal(res.ok, true);
  assert.equal(res.tasks.find(t => t.id === 1), undefined, 'tombstoned task must be removed, not resurrected');
  assert.equal(res.syncTaskDels[1], 200, 'tombstone is retained for further propagation');
});

test('cross-tab: an incoming task older than a tombstone is not re-added', () => {
  const run = makeMergeRun();
  // Local already deleted task 1 (tombstone). Remote still ships a stale copy.
  const res = run(
    { tasks: [], syncTaskDels: { 1: 200 }, taskIdCtr: 1 },
    { tasks: [{ id: 1, name: 'zombie', lastModified: 150 }], taskIdCtr: 1, stateEpoch: 1 },
  );
  assert.equal(res.tasks.find(t => t.id === 1), undefined, 'stale incoming task beaten by tombstone must be dropped');
});

test('cross-tab: a task edited AFTER the tombstone survives (edit wins)', () => {
  const run = makeMergeRun();
  // Tombstone at 200, but the local task was re-edited at 300 → keep it.
  const res = run(
    { tasks: [{ id: 1, name: 're-created', lastModified: 300 }], taskIdCtr: 1 },
    { tasks: [], taskIdCtr: 1, syncTaskDels: { 1: 200 }, stateEpoch: 1 },
  );
  assert.ok(res.tasks.find(t => t.id === 1), 'a newer edit must outlive an older tombstone');
});

test('cross-tab: list and goal tombstones are honoured too', () => {
  const run = makeMergeRun();
  const res = run(
    {
      lists: [{ id: 2, name: 'Work', lastModified: 100 }],
      goals: [{ id: 3, name: 'Ship', lastModified: 100 }],
    },
    {
      lists: [], goals: [],
      syncListDels: { 2: 200 }, syncGoalDels: { 3: 200 },
      stateEpoch: 1,
    },
  );
  assert.equal(res.lists.find(l => l.id === 2), undefined, 'tombstoned list removed');
  assert.equal(res.goals.find(g => g.id === 3), undefined, 'tombstoned goal removed');
});
