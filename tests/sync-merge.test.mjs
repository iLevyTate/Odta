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
  const iGen = src.indexOf('function _genCode(', iClamp);
  const iMergeDel = src.indexOf('function _mergeDelMapPair(');
  const iConn = src.indexOf('// ── Connection handling');
  assert.ok(iClamp >= 0 && iGen > iClamp, 'slice _clampSyncTs');
  assert.ok(iMergeDel > 0 && iConn > iMergeDel, 'slice merge block');

  const clamp = src.slice(iClamp, iGen);
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
        timeLog, cfg, theme, totalPomos, totalFocusSec, saveReason: _saveReason,
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
