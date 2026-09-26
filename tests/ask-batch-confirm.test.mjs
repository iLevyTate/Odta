/**
 * Mass / quiet-rewrite batches must go through confirmation even though no op
 * in them is "destructive" on its own. In auto mode an Ask turn applies
 * whatever validateOps rates 'none' without a prompt (ui.js →
 * askDestructiveConfirmNeeded), and saveState syncs it to every peer, so 50
 * MARK_DONEs, a snooze (hiddenUntil) or a rename must rate at least 'warn',
 * while 1 to 4 plain edits keep auto-applying.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaSrc = readFileSync(join(root, 'js', 'tool-schema.js'), 'utf8');
const aiSrc = readFileSync(join(root, 'js', 'ai.js'), 'utf8');
const askSrc = readFileSync(join(root, 'js', 'ask.js'), 'utf8');

function loadSchema() {
  const win = {};
  new Function('window', schemaSrc)(win);
  return win;
}

function loadConfirm() {
  const start = aiSrc.indexOf('function intelHardBulkConfirmNeeded');
  const end = aiSrc.indexOf('function _formatOpSummaryLabel', start);
  assert.ok(start >= 0 && end > start);
  return new Function(aiSrc.slice(start, end) + '\nreturn askDestructiveConfirmNeeded;')();
}

const mkTasks = (n) => Array.from({ length: n }, (_, i) => ({
  id: i + 1, name: 'Task ' + (i + 1), description: 'notes ' + (i + 1), status: 'open', archived: false,
}));
const ctxFrom = (tasks, lists = []) => ({
  tasksById: new Map(tasks.map((t) => [t.id, t])),
  listsById: new Map(lists.map((l) => [l.id, l])),
});

function level(ops, tasks = mkTasks(60)) {
  const { validateOps } = loadSchema();
  const v = validateOps(ops, ctxFrom(tasks));
  assert.equal(v.rejected.length, 0, JSON.stringify(v.rejected));
  return { level: v.destructiveLevel, confirm: loadConfirm()(v.valid, v.destructiveLevel) };
}

test('1 to 4 plain updates stay level none and auto-apply', () => {
  for (let n = 1; n <= 4; n++) {
    const ops = Array.from({ length: n }, (_, i) => ({ name: 'UPDATE_TASK', args: { id: i + 1, priority: 'high' } }));
    const r = level(ops);
    assert.equal(r.level, 'none', n + ' updates');
    assert.equal(r.confirm, false, n + ' updates must not prompt');
  }
  assert.equal(level([{ name: 'MARK_DONE', args: { id: 1 } }, { name: 'DUPLICATE_TASK', args: { id: 2 } }]).level, 'none');
});

test('≥5 write ops of any kind rate warn and need confirmation', () => {
  for (const name of ['MARK_DONE', 'UPDATE_TASK', 'DUPLICATE_TASK', 'RESCHEDULE']) {
    const ops = Array.from({ length: 5 }, (_, i) => ({
      name, args: name === 'UPDATE_TASK' ? { id: i + 1, priority: 'low' } : name === 'RESCHEDULE' ? { id: i + 1, dueDate: '2026-10-01' } : { id: i + 1 },
    }));
    const r = level(ops);
    assert.equal(r.level, 'warn', '5× ' + name);
    assert.equal(r.confirm, true, '5× ' + name);
  }
  const creates = Array.from({ length: 5 }, (_, i) => ({ name: 'CREATE_TASK', args: { name: 'New ' + i } }));
  assert.equal(level(creates).level, 'warn', 'mass creation syncs to peers too');
});

test('the ASK_MAX_OPS worst case (50 MARK_DONE) needs confirmation', () => {
  const ops = Array.from({ length: 50 }, (_, i) => ({ name: 'MARK_DONE', args: { id: i + 1 } }));
  const r = level(ops);
  assert.equal(r.level, 'warn');
  assert.equal(r.confirm, true);
});

test('a single op that hides a task rates warn (hiddenUntil / SNOOZE_TASK)', () => {
  assert.equal(level([{ name: 'UPDATE_TASK', args: { id: 1, hiddenUntil: '2026-12-01' } }]).level, 'warn');
  assert.equal(level([{ name: 'SNOOZE_TASK', args: { id: 1, untilDate: '2026-12-01' } }]).level, 'warn');
  assert.equal(level([{ name: 'SNOOZE_TASK', args: { id: 1, untilDate: '2026-12-01' } }]).confirm, true);
});

test('a single op that overwrites name / description / checklist text rates warn', () => {
  assert.equal(level([{ name: 'UPDATE_TASK', args: { id: 1, name: 'Something else' } }]).level, 'warn');
  assert.equal(level([{ name: 'UPDATE_TASK', args: { id: 1, description: 'replaced' } }]).level, 'warn');
  assert.equal(level([{ name: 'SPLIT_TASK', args: { id: 1, parts: [{ name: 'A' }, { name: 'B' }] } }]).level, 'warn');
  assert.equal(level([{ name: 'REMOVE_CHECK', args: { id: 1, checkId: 3 } }]).level, 'warn');
});

test('echoing the current name/description back is not a rewrite (small models do this constantly)', () => {
  const r = level([{ name: 'UPDATE_TASK', args: { id: 1, name: 'Task 1 ', description: 'notes 1', priority: 'urgent' } }]);
  assert.equal(r.level, 'none');
  assert.equal(r.confirm, false);
});

test('renaming a task created earlier in the same batch is not a rewrite of user text', () => {
  const tasks = mkTasks(1);
  const { validateOps } = loadSchema();
  const v = validateOps([
    { name: 'CREATE_TASK', args: { name: 'Draft' } },
    { name: 'UPDATE_TASK', args: { id: 2, name: 'Final' } },
  ], ctxFrom(tasks));
  assert.equal(v.valid.length, 2);
  assert.equal(v.destructiveLevel, 'none');
});

test('existing levels are unchanged: any DELETE → hard, 5 CHANGE_LIST → hard, 1 CHANGE_LIST → warn', () => {
  const lists = [{ id: 9, name: 'L' }];
  const { validateOps } = loadSchema();
  const tasks = mkTasks(6);
  assert.equal(validateOps([{ name: 'DELETE_TASK', args: { id: 1 } }], ctxFrom(tasks, lists)).destructiveLevel, 'hard');
  assert.equal(validateOps(tasks.slice(0, 5).map((t) => ({ name: 'CHANGE_LIST', args: { id: t.id, listId: 9 } })), ctxFrom(tasks, lists)).destructiveLevel, 'hard');
  assert.equal(validateOps([{ name: 'CHANGE_LIST', args: { id: 1, listId: 9 } }], ctxFrom(tasks, lists)).destructiveLevel, 'warn');
});

test('askRun: a model batch of 6 MARK_DONE comes back warn (the UI then confirms before auto-apply)', async () => {
  const tasks = mkTasks(6).map((t, i) => ({ ...t, lastModified: i }));
  const win = {};
  const response = JSON.stringify(tasks.map((t) => ({ name: 'MARK_DONE', args: { id: t.id } })));
  const ctx = {
    window: win, console, tasks, lists: [],
    isIntelReady: () => true, embedText: async () => new Float32Array(8), semanticSearch: async () => [],
    isGenReady: () => true, pushAskHistory: () => {}, getGenCfg: () => ({ timeoutSec: 30 }),
    getUpcomingEvents: () => [], getActiveCategories: () => [], intelLoad: async () => {},
    findTask: (id) => tasks.find((t) => t.id === id) || null,
    genGenerate: async () => response,
  };
  new Function(...Object.keys(ctx), schemaSrc)(...Object.values(ctx));
  ctx.TOOL_SCHEMA = win.TOOL_SCHEMA;
  ctx.validateOps = win.validateOps;
  ctx.parseOpsJson = win.parseOpsJson;
  ctx.toolSchemaPromptBlock = win.toolSchemaPromptBlock;
  new Function(...Object.keys(ctx), askSrc)(...Object.values(ctx));
  const res = await win.askRun('mark all my tasks as done', {});
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.ops.length, 6);
  assert.equal(res.destructiveLevel, 'warn');
  assert.equal(loadConfirm()(res.ops, res.destructiveLevel), true);
});
