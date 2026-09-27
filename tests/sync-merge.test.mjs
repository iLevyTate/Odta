/**
 * P2P _mergeState: tombstones, LWW, malformed payload (js/sync.js).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function makeMergeRun() {
  const src = readFileSync(join(root, 'js', 'sync.js'), 'utf8');
  const iClamp = src.indexOf('function _clampSyncTs(');
  const iGen = src.indexOf('function _randChars(', iClamp);
  const iMergeDel = src.indexOf('function _mergeDelMapPair(');
  const iConn = src.indexOf('// ── Connection handling');
  assert.ok(iClamp >= 0 && iGen > iClamp, 'slice _clampSyncTs');
  assert.ok(iMergeDel > 0 && iConn > iMergeDel, 'slice merge block');

  const clamp = src.slice(iClamp, iGen);
  // The merge now routes ids and lists through storage.js's ingress repair
  // helpers; load the real ones (plus the _str they use) rather than stubs.
  const storageSrc = readFileSync(join(root, 'js', 'storage.js'), 'utf8');
  const iR = storageSrc.indexOf('// ── Ingress repair: id counters, lists ──');
  const jR = storageSrc.indexOf('// ── end ingress repair ──', iR);
  assert.ok(iR >= 0 && jR > iR, 'slice ingress repair helpers');
  const strLine = storageSrc.match(/^const _str\s*=.*$/m)[0];
  const ingressRepair = strLine + '\n' + storageSrc.slice(iR, jR);
  const mergeBlock = src.slice(iMergeDel, iConn);

  return new Function(`
    var SYNC_VERSION = 1;
    var _lastSyncAt = 0;
    var _syncApplying = false;
    var _syncAckTimer = null;
    var _conn = null;
    var tasks, lists, goals, taskIdCtr, listIdCtr, goalIdCtr, activeListId;
    var timeLog, sessionHistory, intervals, intIdCtr, totalPomos, totalBreaks, totalFocusSec;
    var syncTaskDels, syncListDels, syncGoalDels, stateEpoch, stateNonce;
    var cfg, theme, logIdCtr, pomosInCycle, phase;
    var _saveReason = null;
    function persistAfterSyncMerge(remoteEpoch, remoteNonce){
      const _localEpoch = stateEpoch || 0;
      const _remoteEpoch = remoteEpoch || 0;
      const _localNonce = stateNonce || 0;
      const _remoteNonce = remoteNonce || 0;
      if(_remoteEpoch > 0) stateEpoch = Math.max(_localEpoch, _remoteEpoch);
      if(_remoteEpoch > _localEpoch || (_remoteEpoch === _localEpoch && _remoteEpoch > 0 && _remoteNonce > _localNonce)){
        stateNonce = _remoteNonce;
      }
    }
    function saveState(reason) { _saveReason = reason; }
    function renderAll() { }
    function rebuildTaskIdIndex() { }
    function repairOrphanedTaskParents() { }
    function _repairTask(t) { return t; }
    ${ingressRepair}
    ${clamp}
    ${mergeBlock}
    return function run(init, remote, opts) {
      tasks = init.tasks || [];
      lists = init.lists || [];
      goals = init.goals || [];
      taskIdCtr = init.taskIdCtr || 0;
      listIdCtr = init.listIdCtr || 0;
      goalIdCtr = init.goalIdCtr || 0;
      activeListId = init.activeListId != null ? init.activeListId : 1;
      timeLog = init.timeLog || [];
      sessionHistory = init.sessionHistory || [];
      intervals = init.intervals || [];
      intIdCtr = init.intIdCtr || 0;
      totalPomos = init.totalPomos || 0;
      totalBreaks = init.totalBreaks || 0;
      totalFocusSec = init.totalFocusSec || 0;
      syncTaskDels = { ...(init.syncTaskDels || {}) };
      syncListDels = { ...(init.syncListDels || {}) };
      syncGoalDels = { ...(init.syncGoalDels || {}) };
      stateEpoch = init.stateEpoch || 0;
      stateNonce = init.stateNonce || 0;
      cfg = init.cfg && typeof init.cfg === 'object' ? { ...init.cfg } : {};
      theme = init.theme || 'dark';
      logIdCtr = init.logIdCtr || 0;
      pomosInCycle = init.pomosInCycle || 0;
      phase = init.phase || 'work';
      _saveReason = null;
      _mergeState(remote, opts || {});
      return {
        tasks, lists, goals, taskIdCtr, listIdCtr, goalIdCtr, syncTaskDels, syncListDels, syncGoalDels, stateEpoch, stateNonce,
        timeLog, cfg, theme, totalPomos, totalFocusSec, pomosInCycle, saveReason: _saveReason,
      };
    };
  `)();
}

test('merge: null/undefined remote is a no-op', () => {
  const run = makeMergeRun();
  const t0 = [{ id: 1, name: 'a', lastModified: 1 }];
  let r = run({ tasks: t0 }, null);
  assert.equal(r.tasks.length, 1);
  r = run({ tasks: t0 }, undefined);
  assert.equal(r.tasks.length, 1);
});

test('merge: task tombstone newer than task removes it', () => {
  const run = makeMergeRun();
  const o = run(
    { tasks: [{ id: 1, name: 'a', lastModified: 100 }], taskIdCtr: 1, syncTaskDels: {} },
    { tasks: [], syncTaskDels: { 1: 200 }, taskIdCtr: 1, stateEpoch: 0 },
  );
  assert.equal(o.tasks.length, 0);
});

test('merge: remote task wins on higher lastModified (LWW)', () => {
  const run = makeMergeRun();
  const o = run(
    { tasks: [{ id: 1, name: 'old', lastModified: 5 }], taskIdCtr: 1 },
    { tasks: [{ id: 1, name: 'new', lastModified: 10 }], taskIdCtr: 1 },
  );
  assert.equal(o.tasks.length, 1);
  assert.equal(o.tasks[0].name, 'new');
});

test('merge: list LWW and delete via syncListDels', () => {
  const run = makeMergeRun();
  const o = run(
    {
      lists: [{ id: 1, name: 'A', lastModified: 1 }],
      listIdCtr: 1,
      syncListDels: {},
    },
    {
      lists: [{ id: 1, name: 'B', lastModified: 100 }],
      listIdCtr: 1,
      stateEpoch: 0,
    },
  );
  assert.equal(o.lists.length, 1);
  assert.equal(o.lists[0].name, 'B');

  const o2 = run(
    { lists: [{ id: 1, name: 'B', lastModified: 100 }], listIdCtr: 1, syncListDels: {} },
    { lists: [], syncListDels: { 1: 200 }, listIdCtr: 1 },
  );
  assert.equal(o2.lists.length, 0);
});

test('merge: same-ms tie unions cumulative counters but keeps local pomosInCycle', () => {
  const run = makeMergeRun();
  // Exact epoch+nonce collision → the tie branch. Cumulative totals union via
  // Math.max, but pomosInCycle is a cadence POSITION and must NOT be inflated
  // (Math.max-ing it could push it past cfg.cycle and wedge the long break).
  const o = run(
    { stateEpoch: 1000, stateNonce: 5, totalPomos: 2, totalFocusSec: 60, pomosInCycle: 1 },
    { stateEpoch: 1000, stateNonce: 5, totalPomos: 5, totalFocusSec: 120, pomosInCycle: 3 },
  );
  assert.equal(o.totalPomos, 5, 'cumulative pomos still union to the max');
  assert.equal(o.totalFocusSec, 120, 'cumulative focus still unions to the max');
  assert.equal(o.pomosInCycle, 1, 'cadence position keeps the local value, not Math.max');
});

test('merge: newer remote epoch still overwrites pomosInCycle', () => {
  const run = makeMergeRun();
  // When remote genuinely wins (higher epoch), taking its cadence position is
  // correct — only the same-ms tie keeps local.
  const o = run(
    { stateEpoch: 1000, stateNonce: 1, pomosInCycle: 1 },
    { stateEpoch: 2000, stateNonce: 1, pomosInCycle: 3 },
  );
  assert.equal(o.pomosInCycle, 3, 'a newer epoch overwrites the cadence position');
});

test('merge: stateEpoch remote newer applies timeLog and cfg', () => {
  const run = makeMergeRun();
  const o = run(
    { timeLog: [], stateEpoch: 0, cfg: { x: 1 } },
    { stateEpoch: 10_000, timeLog: [{ t: 1 }], cfg: { x: 2, y: 3 }, totalPomos: 2 },
  );
  assert.equal(o.timeLog.length, 1);
  assert.equal(o.cfg.x, 2);
  assert.equal(o.totalPomos, 2);
});

test('merge: equal stateEpoch unions timeLog by id and maxes pomo count', () => {
  const run = makeMergeRun();
  const o = run(
    { timeLog: [{ id: 1, name: 'a', durSec: 1, time: 't' }], stateEpoch: 5000, totalPomos: 1 },
    {
      stateEpoch: 5000,
      timeLog: [{ id: 2, name: 'b', durSec: 2, time: 't' }],
      totalPomos: 3,
    },
  );
  assert.equal(o.timeLog.length, 2);
  assert.equal(o.totalPomos, 3);
});

test('merge: invalid syncV is rejected without mutating tasks', () => {
  const run = makeMergeRun();
  const bad = { syncV: 999, tasks: [{ id: 2, name: 'x', lastModified: 9 }], stateEpoch: 1 };
  const t0 = [{ id: 1, name: 'keep', lastModified: 1 }];
  const o = run({ tasks: t0, taskIdCtr: 1, stateEpoch: 0 }, bad);
  assert.equal(o.tasks.length, 1);
  assert.equal(o.tasks[0].name, 'keep');
});

test('merge: bidirectional offline edits union tasks from both devices', () => {
  const run = makeMergeRun();
  let local = {
    tasks: [{ id: 1, name: 'A edited', lastModified: 100 }],
    taskIdCtr: 2,
    stateEpoch: 1000,
  };
  local = run(local, {
    tasks: [{ id: 2, name: 'B created', lastModified: 200 }],
    taskIdCtr: 2,
    stateEpoch: 2000,
  });
  assert.equal(local.tasks.length, 2);
  assert.ok(local.tasks.some(t => t.id === 1 && t.name === 'A edited'));
  assert.ok(local.tasks.some(t => t.id === 2 && t.name === 'B created'));

  local = run(local, {
    tasks: [{ id: 1, name: 'A edited', lastModified: 100 }],
    taskIdCtr: 2,
    stateEpoch: 1000,
  });
  assert.equal(local.tasks.length, 2);
});

test('merge: persistAfterSyncMerge advances stateEpoch to max of local and remote', () => {
  const run = makeMergeRun();
  const o = run(
    { tasks: [], taskIdCtr: 0, stateEpoch: 100, stateNonce: 1 },
    { tasks: [], taskIdCtr: 0, stateEpoch: 500, stateNonce: 3 },
  );
  assert.equal(o.stateEpoch, 500);
  assert.equal(o.stateNonce, 3);
});

test('merge: uses persistAfterSyncMerge (not auto save) after merge', () => {
  const run = makeMergeRun();
  const o = run(
    { tasks: [{ id: 1, name: 'local', lastModified: 5 }], taskIdCtr: 1, stateEpoch: 0 },
    { tasks: [{ id: 1, name: 'remote', lastModified: 10 }], taskIdCtr: 1, stateEpoch: 1 },
  );
  assert.equal(o.saveReason, null, 'persistAfterSyncMerge handles persist without saveState auto');
  assert.equal(o.stateEpoch, 1);
});

test('merge: remote task lastModified is not re-stamped on receive', () => {
  const run = makeMergeRun();
  const remoteLm = 424242;
  const o = run(
    { tasks: [], taskIdCtr: 1, stateEpoch: 0 },
    { tasks: [{ id: 1, name: 'from peer', lastModified: remoteLm }], taskIdCtr: 1, stateEpoch: 1 },
  );
  assert.equal(o.tasks[0].lastModified, remoteLm);
});

// ── Id collisions between devices that created tasks while apart ────────────
// Both devices number their first task 1. The id-keyed LWW used to keep one
// task of each pair and drop the other on both devices.
function pairUp(localA, localB) {
  const run = makeMergeRun();
  const clone = (x) => structuredClone(x);
  const stateA = { tasks: clone(localA.tasks), taskIdCtr: localA.taskIdCtr, stateEpoch: 0 };
  const stateB = { tasks: clone(localB.tasks), taskIdCtr: localB.taskIdCtr, stateEpoch: 0 };
  const a = run({ tasks: clone(localA.tasks), taskIdCtr: localA.taskIdCtr }, stateB, { isInitialState: true });
  const b = run({ tasks: clone(localB.tasks), taskIdCtr: localB.taskIdCtr }, stateA, { isInitialState: true });
  const view = (o) => o.tasks.map((t) => [t.id, t.name, t.parentId ?? null, (t.blockedBy || []).join('+')]).sort((x, y) => x[0] - y[0]);
  return { a, b, view };
}

test('initial merge: same id, different created keeps both tasks, and both devices agree on the ids', () => {
  const A = { taskIdCtr: 2, tasks: [
    { id: 1, name: 'A one', created: '2026-09-20 09:00', lastModified: 10 },
    { id: 2, name: 'A two', created: '2026-09-20 09:05', lastModified: 11, parentId: 1, blockedBy: [1] },
  ] };
  const B = { taskIdCtr: 1, tasks: [
    { id: 1, name: 'B one', created: '2026-09-22 18:00', lastModified: 99 },
  ] };
  const { a, b, view } = pairUp(A, B);
  assert.deepEqual(view(a), view(b), 'both devices converge on the same id → task map');
  const names = a.tasks.map((t) => t.name).sort();
  assert.deepEqual(names, ['A one', 'A two', 'B one'], 'nothing is lost');
  const byName = Object.fromEntries(a.tasks.map((t) => [t.name, t]));
  assert.equal(byName['A one'].id, 1, 'the older task keeps the id');
  assert.equal(byName['B one'].id, 3, 'the newer one moves past every id either side holds');
  assert.equal(byName['A two'].parentId, 1, 'references on the side that kept its id are untouched');
  assert.ok(a.taskIdCtr >= 3 && b.taskIdCtr >= 3, 'counters move past the new id');
});

test('initial merge: a moved task takes its own subtasks and blockers with it', () => {
  const A = { taskIdCtr: 1, tasks: [{ id: 1, name: 'A one', created: '2026-09-20 09:00', lastModified: 1 }] };
  const B = { taskIdCtr: 3, tasks: [
    { id: 1, name: 'B parent', created: '2026-09-25 10:00', lastModified: 5 },
    { id: 2, name: 'B child', created: '2026-09-25 10:01', lastModified: 5, parentId: 1 },
    { id: 3, name: 'B blocked', created: '2026-09-25 10:02', lastModified: 5, blockedBy: [1] },
  ] };
  const { a, b, view } = pairUp(A, B);
  assert.deepEqual(view(a), view(b));
  const byName = Object.fromEntries(a.tasks.map((t) => [t.name, t]));
  // A holds ids up to 1 and B up to 3, so B's parent moves to 4, and its child
  // (id 2) collides with nothing on A.
  assert.equal(byName['B parent'].id, 4);
  assert.equal(byName['B child'].parentId, 4);
  assert.deepEqual(byName['B blocked'].blockedBy, [4]);
  assert.equal(byName['A one'].id, 1);
});

test('initial merge: the same task on both devices is not a collision', () => {
  const t = { id: 5, name: 'Shared', created: '2026-09-01 08:00', lastModified: 3 };
  const { a, b } = pairUp({ taskIdCtr: 5, tasks: [t] }, { taskIdCtr: 5, tasks: [{ ...t, name: 'Shared (renamed)', lastModified: 9 }] });
  assert.equal(a.tasks.length, 1);
  assert.equal(b.tasks.length, 1);
  assert.equal(a.tasks[0].name, 'Shared (renamed)', 'normal LWW still applies');
});

test('initial merge: a task without created is never treated as a collision', () => {
  const { a } = pairUp(
    { taskIdCtr: 1, tasks: [{ id: 1, name: 'legacy', created: '', lastModified: 1 }] },
    { taskIdCtr: 1, tasks: [{ id: 1, name: 'other', created: '2026-09-01 08:00', lastModified: 2 }] },
  );
  assert.equal(a.tasks.length, 1, 'unknown created: fall back to plain LWW');
});

test('a live patch (not the initial state) does not re-id anything', () => {
  const run = makeMergeRun();
  const o = run(
    { tasks: [{ id: 1, name: 'mine', created: '2026-09-20 09:00', lastModified: 1 }], taskIdCtr: 1 },
    { tasks: [{ id: 1, name: 'theirs', created: '2026-09-22 09:00', lastModified: 2 }], taskIdCtr: 1, stateEpoch: 0 },
  );
  assert.equal(o.tasks.length, 1);
});
