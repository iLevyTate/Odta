/**
 * Auto-apply mode — askDestructiveConfirmNeeded, _allSelectedOpsFromList,
 * applyOpsBatch headless path, and GEN_CFG askApplyMode default.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const aiSrc = readFileSync(join(root, 'js', 'ai.js'), 'utf8');
const genSrc = readFileSync(join(root, 'js', 'gen.js'), 'utf8');
const uiSrc = readFileSync(join(root, 'js', 'ui.js'), 'utf8');

function loadDestructiveHelpers(){
  const start = aiSrc.indexOf('function askDestructiveConfirmNeeded');
  const end = aiSrc.indexOf('function _formatOpSummaryLabel', start);
  assert.ok(start >= 0 && end > start);
  const win = {};
  const mod = new Function(`
    ${aiSrc.slice(aiSrc.indexOf('function intelHardBulkConfirmNeeded'), end)}
    return { intelHardBulkConfirmNeeded, askDestructiveConfirmNeeded };
  `);
  return mod();
}

function loadAllSelectedOpsHelper(){
  const start = aiSrc.indexOf('function _allSelectedOpsFromList');
  const end = aiSrc.indexOf('function _selectedOpsFromPendingDom', start);
  const mod = new Function(`
    ${aiSrc.slice(start, end)}
    return { _allSelectedOpsFromList };
  `);
  return mod();
}

function loadApplyOpsBatch(tasks, hooks = {}){
  const start = aiSrc.indexOf('async function _enrichClassifyOps');
  const end = aiSrc.indexOf('async function intelApplyPending', start);
  assert.ok(start >= 0 && end > start);
  const snaps = [];
  const ctx = {
    tasks,
    lists: [],
    findTask: (id) => tasks.find(t => t.id === id) || null,
    predictClassifyCategory: async () => null,
    executeClassifyTaskOp: async () => null,
    executeIntelOp: hooks.executeIntelOp || ((op) => ({ type: 'update', id: op.args && op.args.id })),
    _pushUndo: (label, s) => { snaps.push({ label, s }); },
    saveState: () => {},
    renderTaskList: () => {},
    renderBanner: () => {},
    renderLists: () => {},
    _renderUndoBtn: () => {},
    showActionToast: () => {},
    _pendingOps: [],
    _pendingDestructive: 'none',
    _pendingSource: null,
    _renderPendingOps: () => {},
    _setIntelStatus: () => {},
    _describeOpStructured: () => ({ kind: 'simple', title: op.name, taskName: 'T', detail: '' }),
    _intelPreviewShortNameFromTaskArgs: () => 'Task',
    summarizeOpsLabels: () => ['Update Task'],
    console,
  };
  const body = aiSrc.slice(start, end);
  const mod = new Function(...Object.keys(ctx), `
    let op;
    ${body.replace('function _formatOpSummaryLabel', 'function _formatOpSummaryLabel').replace('function summarizeOpsLabels', 'function summarizeOpsLabels')}
    return { applyOpsBatch, _allSelectedOpsFromList };
  `);
  // Include _allSelectedOpsFromList in slice - it's before _enrichClassifyOps
  const selStart = aiSrc.indexOf('function _allSelectedOpsFromList');
  const fullBody = aiSrc.slice(selStart, end);
  const mod2 = new Function(...Object.keys(ctx), `
    ${fullBody}
    return { applyOpsBatch, _allSelectedOpsFromList };
  `);
  return { ...mod2(...Object.values(ctx)), _snaps: snaps };
}

function loadGen(storage = {}){
  const fakeLocalStorage = {
    getItem: (k) => (k in storage) ? storage[k] : null,
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
  };
  const win = { addEventListener: () => {}, removeEventListener: () => {} };
  const ctx = { window: win, localStorage: fakeLocalStorage, console, caches: undefined };
  new Function(...Object.keys(ctx), genSrc)(...Object.values(ctx));
  return win;
}

test('askDestructiveConfirmNeeded: DELETE_TASK always confirms', () => {
  const { askDestructiveConfirmNeeded } = loadDestructiveHelpers();
  assert.equal(askDestructiveConfirmNeeded([{ name: 'DELETE_TASK', args: { id: 1 } }], 'none'), true);
});

test('askDestructiveConfirmNeeded: warn/hard bulk confirms without delete', () => {
  const { askDestructiveConfirmNeeded } = loadDestructiveHelpers();
  assert.equal(askDestructiveConfirmNeeded([{ name: 'CHANGE_LIST', args: { id: 1, listId: 2 } }], 'warn'), true);
  assert.equal(askDestructiveConfirmNeeded([{ name: 'UPDATE_TASK', args: { id: 1, priority: 'high' } }], 'none'), false);
});

test('_allSelectedOpsFromList selects all UPDATE fields', () => {
  const { _allSelectedOpsFromList } = loadAllSelectedOpsHelper();
  const ops = [{ name: 'UPDATE_TASK', args: { id: 3, priority: 'urgent', dueDate: '2026-06-01' } }];
  const sel = _allSelectedOpsFromList(ops);
  assert.equal(sel.length, 1);
  assert.equal(sel[0].args.priority, 'urgent');
  assert.equal(sel[0].args.dueDate, '2026-06-01');
});

test('applyOpsBatch applies ops without DOM checkboxes', async () => {
  const tasks = [{ id: 1, name: 'Pay rent', status: 'open', archived: false }];
  const { applyOpsBatch, _snaps } = loadApplyOpsBatch(tasks);
  const ops = [{ name: 'UPDATE_TASK', args: { id: 1, priority: 'urgent' } }];
  const result = await applyOpsBatch(ops, { source: 'ask', destructiveLevel: 'none' }, {
    confirmedDestructive: true,
    clearPending: false,
    showToast: false,
  });
  assert.equal(result.applied, 1);
  assert.equal(result.failures.length, 0);
  assert.equal(_snaps.length, 1);
});

test('applyOpsBatch: DELETE without confirmedDestructive returns DELETE_ACK', async () => {
  const tasks = [{ id: 1, name: 'X', status: 'open', archived: false }];
  const { applyOpsBatch } = loadApplyOpsBatch(tasks);
  const result = await applyOpsBatch(
    [{ name: 'DELETE_TASK', args: { id: 1 } }],
    { source: 'ask', destructiveLevel: 'hard' },
    { confirmedDestructive: false, showToast: false, clearPending: false },
  );
  assert.equal(result.cancelled, true);
  assert.equal(result.reason, 'DELETE_ACK');
  assert.equal(result.applied, 0);
});

test('gen cfg: askApplyMode defaults to review', () => {
  const win = loadGen();
  const cfg = win.getGenCfg();
  assert.equal(cfg.askApplyMode, 'review');
});

test('gen cfg: askApplyMode auto persists', () => {
  const storage = { stupind_gen_cfg: JSON.stringify({ enabled: true, modelId: 'HuggingFaceTB/SmolLM2-360M-Instruct', dtype: 'q4', cfgVersion: 2, askApplyMode: 'auto' }) };
  const win = loadGen(storage);
  assert.equal(win.getGenCfg().askApplyMode, 'auto');
});

test('ui.js exports session apply mode helpers', () => {
  assert.match(uiSrc, /function cmdkSetApplyMode\(/);
  assert.match(uiSrc, /function _cmdkInitApplyModeFromCfg\(/);
  assert.match(uiSrc, /function cmdkAskApplyTurn\(/);
  assert.match(uiSrc, /_cmdkAskApplyMode === 'auto'/);
});

test('ai.js exports applyOpsBatch and askDestructiveConfirmNeeded', () => {
  assert.match(aiSrc, /window\.applyOpsBatch = applyOpsBatch/);
  assert.match(aiSrc, /window\.askDestructiveConfirmNeeded = askDestructiveConfirmNeeded/);
});
