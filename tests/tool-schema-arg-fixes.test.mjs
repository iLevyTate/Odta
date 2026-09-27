/**
 * validateOps / normalizeProposedOp / parseOpsJson regressions:
 *  - SET_RECUR with recur:null (or "none") is the way to CLEAR a recurrence;
 *    the validator used to drop the null so the op reached the executor
 *    without `recur` and was refused as "unknown".
 *  - UPDATE_TASK with an empty name must not blank the title.
 *  - MOVE_TASK cannot make a task its own parent (infinite render recursion).
 *  - `type` is a task argument unless it actually carried the op name.
 *  - JSON repair never rewrites True/False/None inside string values.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaSrc = readFileSync(join(root, 'js', 'tool-schema.js'), 'utf8');

function load() {
  const win = {};
  new Function('window', schemaSrc)(win);
  return win;
}
const ctx = () => ({
  tasksById: new Map([[1, { id: 1, name: 'A', parentId: null }], [2, { id: 2, name: 'B', parentId: 1 }]]),
  lists: [{ id: 1, name: 'Personal' }],
});

test('SET_RECUR: explicit null / "none" clears; unknown strings are still dropped', () => {
  const { validateOps } = load();
  const r1 = validateOps([{ name: 'SET_RECUR', args: { id: 1, recur: null } }], ctx());
  assert.equal(r1.valid.length, 1);
  assert.ok('recur' in r1.valid[0].args && r1.valid[0].args.recur === null, 'null passes through');
  const r2 = validateOps([{ name: 'SET_RECUR', args: { id: 1, recur: 'none' } }], ctx());
  assert.strictEqual(r2.valid[0].args.recur, null);
  const r3 = validateOps([{ name: 'SET_RECUR', args: { id: 1, recur: 'daily' } }], ctx());
  assert.strictEqual(r3.valid[0].args.recur, 'daily');
  const r4 = validateOps([{ name: 'SET_RECUR', args: { id: 1, recur: 'yearly' } }], ctx());
  assert.ok(!('recur' in r4.valid[0].args), 'unrecognised value is dropped, not turned into a clear');
});

test('UPDATE_TASK: an empty name is ignored rather than applied', () => {
  const { validateOps } = load();
  const r = validateOps([{ name: 'UPDATE_TASK', args: { id: 1, name: '', priority: 'high' } }], ctx());
  assert.equal(r.valid.length, 1);
  assert.ok(!('name' in r.valid[0].args));
  assert.strictEqual(r.valid[0].args.priority, 'high');
  const r2 = validateOps([{ name: 'UPDATE_TASK', args: { id: 1, name: '   ' } }], ctx());
  assert.ok(!('name' in r2.valid[0].args));
});

test('MOVE_TASK: self-parenting is rejected as a cycle', () => {
  const { validateOps } = load();
  const r = validateOps([{ name: 'MOVE_TASK', args: { id: 1, newParentId: 1 } }], ctx());
  assert.equal(r.valid.length, 0);
  assert.equal(r.rejected[0].reason, 'MOVE_WOULD_CYCLE');
  const ok = validateOps([{ name: 'MOVE_TASK', args: { id: 2, newParentId: null } }], ctx());
  assert.equal(ok.valid.length, 1);
});

test('normalizeProposedOp keeps a task `type` argument in the flattened form', () => {
  const { normalizeProposedOp } = load();
  const a = normalizeProposedOp({ name: 'UPDATE_TASK', id: 3, type: 'bug' });
  assert.deepEqual(a, { name: 'UPDATE_TASK', args: { id: 3, type: 'bug' } });
  const b = normalizeProposedOp({ type: 'function', function: { name: 'MARK_DONE', arguments: '{"id":3}' } });
  assert.deepEqual(b, { name: 'MARK_DONE', args: { id: 3 } });
  const c = normalizeProposedOp({ type: 'MARK_DONE', id: 4 });
  assert.deepEqual(c, { name: 'MARK_DONE', args: { id: 4 } });
});

test('parseOpsJson repairs near-JSON without corrupting task text', () => {
  const { parseOpsJson } = load();
  const ops = parseOpsJson('[{"name":"CREATE_TASK","args":{"name":"Read None of This Is True",}}]');
  assert.equal(ops.length, 1);
  assert.strictEqual(ops[0].args.name, 'Read None of This Is True');
  const ops2 = parseOpsJson('[{"name":"UPDATE_TASK","args":{"id":3,"starred":True,"description":"Watch True Detective, then: call mom"}},]');
  assert.strictEqual(ops2[0].args.starred, true, 'bare Python literal outside strings is converted');
  assert.strictEqual(ops2[0].args.description, 'Watch True Detective, then: call mom');
});
