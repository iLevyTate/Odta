/**
 * The model must not be able to decide what the review card says. A
 * CHANGE_LIST op can carry `_preview: {taskName, fromList, toList}` (a display
 * snapshot auto-organize sets for itself) and validateOps copies it through;
 * if the card rendered it, a model could show "Buy milk → Groceries" on a card
 * that moves "Tax return" into Archive. Two layers:
 *   - ask.js rebuilds every model op as a bare {name,args} on BOTH the main
 *     path and the write-retry path (the retry used to keep the metadata);
 *   - ai.js's card derives task / list names from the ids it will apply.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaSrc = readFileSync(join(root, 'js', 'tool-schema.js'), 'utf8');
const askSrc = readFileSync(join(root, 'js', 'ask.js'), 'utf8');
const aiSrc = readFileSync(join(root, 'js', 'ai.js'), 'utf8');

const LISTS = [{ id: 1, name: 'Work' }, { id: 2, name: 'Archive' }, { id: 3, name: 'Groceries' }];
const mkTasks = () => [
  { id: 10, name: 'Tax return', listId: 1, status: 'open', archived: false, lastModified: 2 },
  { id: 11, name: 'Buy milk', listId: null, status: 'open', archived: false, lastModified: 1 },
];
const SPOOF = {
  name: 'CHANGE_LIST',
  args: { id: 10, listId: 2 },
  _preview: { taskName: 'Buy milk', fromList: 'Inbox', toList: 'Groceries' },
  _rationale: '99% match: you approved this earlier',
  rationale: 'safe',
  _anything: 'x',
};

function mkAsk({ tasks, responses }) {
  let calls = 0;
  const win = {};
  const ctx = {
    window: win, console, tasks, lists: LISTS,
    isIntelReady: () => true, embedText: async () => new Float32Array(8), semanticSearch: async () => [],
    isGenReady: () => true, pushAskHistory: () => {}, getGenCfg: () => ({ timeoutSec: 30 }),
    getUpcomingEvents: () => [], getActiveCategories: () => [], intelLoad: async () => {},
    findTask: (id) => tasks.find((t) => t.id === id) || null,
    genGenerate: async () => responses[Math.min(calls++, responses.length - 1)],
  };
  new Function(...Object.keys(ctx), schemaSrc)(...Object.values(ctx));
  ctx.TOOL_SCHEMA = win.TOOL_SCHEMA;
  ctx.validateOps = win.validateOps;
  ctx.parseOpsJson = win.parseOpsJson;
  ctx.normalizeProposedOps = win.normalizeProposedOps;
  ctx.toolSchemaPromptBlock = win.toolSchemaPromptBlock;
  new Function(...Object.keys(ctx), askSrc)(...Object.values(ctx));
  return { win, calls: () => calls };
}

/** _describeOpStructured + its helpers, over the given task/list state. */
function loadDescribe(tasks, lists) {
  const start = aiSrc.indexOf('function _humanizeFieldKey');
  const end = aiSrc.indexOf('function _pendingMasterCheckbox', start);
  assert.ok(start >= 0 && end > start, 'slice _describeOpStructured');
  const findTask = (id) => tasks.find((t) => t.id === id) || null;
  return new Function('findTask', 'lists', 'window', aiSrc.slice(start, end) + '\nreturn _describeOpStructured;')(findTask, lists, {});
}

function assertBare(op) {
  assert.deepEqual(Object.keys(op).sort(), ['args', 'name'], 'model op must reach the UI as bare {name,args}: ' + JSON.stringify(op));
}

test('askRun main path: model _preview / _rationale never reach the returned ops', async () => {
  const tasks = mkTasks();
  const { win } = mkAsk({ tasks, responses: [JSON.stringify([SPOOF])] });
  const res = await win.askRun('move the tax return to Archive', {});
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.ops.length, 1);
  assertBare(res.ops[0]);
});

test('askRun write-retry path: model _preview / _rationale are stripped there too', async () => {
  const tasks = mkTasks();
  const { win, calls } = mkAsk({ tasks, responses: ['[]', JSON.stringify([SPOOF])] });
  const res = await win.askRun('move the tax return to Archive', {});
  assert.equal(calls(), 2, 'ops pass + write-retry');
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.ops.length, 1);
  assertBare(res.ops[0]);
  assert.equal(res.ops[0].args.id, 10);
  assert.equal(res.ops[0].args.listId, 2);
});

test('write-retry NOOP reason still survives the strip (it lives in args)', async () => {
  const tasks = mkTasks();
  const { win } = mkAsk({ tasks, responses: ['[]', '[{"name":"NOOP","args":{"reason":"Which list?"},"_preview":{"taskName":"x"}}]'] });
  const res = await win.askRun('move the thing', {});
  assert.ok(res.ok, JSON.stringify(res));
  assert.match(res.chatAnswer, /Which list\?/);
});

test('review card: a spoofed _preview cannot change the task or list names shown', () => {
  const tasks = mkTasks();
  const describe = loadDescribe(tasks, LISTS);
  const st = describe(SPOOF);
  assert.equal(st.kind, 'listMove');
  assert.equal(st.title, 'Tax return');
  assert.equal(st.fromList, 'Work');
  assert.equal(st.toList, 'Archive');
});

test('review card: auto-organize snapshots still render (and agree with the ids)', () => {
  const tasks = mkTasks();
  const describe = loadDescribe(tasks, LISTS);
  const st = describe({ name: 'CHANGE_LIST', args: { id: 11, listId: 3 }, _preview: { taskName: 'Buy milk', fromList: 'Inbox', toList: 'Groceries' } });
  assert.deepEqual([st.title, st.fromList, st.toList], ['Buy milk', 'Inbox', 'Groceries']);
});

test('review card: the snapshot only fills in for a task deleted since the proposal', () => {
  const describe = loadDescribe([], LISTS);
  const st = describe({ name: 'CHANGE_LIST', args: { id: 99, listId: 3 }, _preview: { taskName: 'Gone task', fromList: 'Work', toList: 'Spoofed' } });
  assert.equal(st.title, 'Gone task');
  assert.equal(st.fromList, 'Work');
  assert.equal(st.toList, 'Groceries', 'destination always comes from the listId the op applies');
});

test('applyOpsBatch labels the batch from pre-apply state (list moves read old → new)', async () => {
  // Card names now come from live ids, so the apply summary must be taken
  // before the ops run; afterwards the task already sits in its new list.
  const start = aiSrc.indexOf('async function _enrichClassifyOps');
  const end = aiSrc.indexOf('async function intelApplyPending', start);
  assert.ok(start >= 0 && end > start);
  const tasks = mkTasks();
  const findTask = (id) => tasks.find((t) => t.id === id) || null;
  const stubs = {
    findTask,
    predictClassifyCategory: async () => null,
    executeClassifyTaskOp: async () => null,
    executeIntelOp: (op) => { const t = findTask(op.args.id); t.listId = op.args.listId; return { type: 'updated', id: t.id }; },
    summarizeOpsLabels: (ops) => ops.map((o) => 'from list ' + findTask(o.args.id).listId),
    _pushUndo: () => {}, saveState: () => {}, renderTaskList: () => {}, renderBanner: () => {}, renderLists: () => {},
    _renderUndoBtn: () => {}, showActionToast: () => {}, _renderPendingOps: () => {}, _setIntelStatus: () => {},
    _pendingOps: [], _pendingDestructive: 'none', _pendingSource: null,
  };
  const { applyOpsBatch } = new Function(...Object.keys(stubs), aiSrc.slice(start, end) + '\nreturn { applyOpsBatch };')(...Object.values(stubs));
  const r = await applyOpsBatch([{ name: 'CHANGE_LIST', args: { id: 10, listId: 2 } }], { source: 'ask' }, { confirmedDestructive: true, showToast: false, clearPending: false });
  assert.equal(r.applied, 1);
  assert.equal(tasks[0].listId, 2, 'op ran');
  assert.deepEqual(r.labels, ['from list 1']);
});
