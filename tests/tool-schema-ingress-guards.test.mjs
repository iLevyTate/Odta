/**
 * validateOps ingress guards added after the v81 audit:
 *  - ISO dates/datetimes must be real calendar values (2026-02-31 and
 *    25:99 used to pass the shape-only regex, string-compared as "overdue"
 *    in Ask and became Invalid Date everywhere else; a bad remindAt never fired).
 *  - checkId must be non-empty and must exist on the target task's checklist
 *    ('' coerced to 0 and REMOVE_CHECK "applied" as a no-op with an undo entry).
 *  - url is limited to http(s).
 *  - category goes through isAssignableCategory when the classification
 *    module is loaded (a hidden or invented category used to be assignable
 *    through UPDATE/CREATE and then silently nulled on the next config run).
 *  - ctx.nextId seeds the in-batch CREATE_TASK simulation so it matches the
 *    runtime counter, which _reseedIdCtr keeps above max(id) after deletes.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaSrc = readFileSync(join(root, 'js', 'tool-schema.js'), 'utf8');

function load(extraGlobals = {}) {
  const win = {};
  const names = Object.keys(extraGlobals);
  new Function('window', ...names, schemaSrc)(win, ...names.map(n => extraGlobals[n]));
  return win;
}
const ctx = (extra = {}) => ({
  tasksById: new Map([
    [1, { id: 1, name: 'A', parentId: null, checklist: [{ id: 7, text: 'x', done: false }] }],
    [2, { id: 2, name: 'B', parentId: 1 }],
  ]),
  lists: [{ id: 1, name: 'Personal' }],
  ...extra,
});

test('dueDate / remindAt reject impossible calendar values', () => {
  const { validateOps } = load();
  const bad = validateOps([
    { name: 'UPDATE_TASK', args: { id: 1, dueDate: '2026-02-31' } },
    { name: 'UPDATE_TASK', args: { id: 1, dueDate: '2026-13-01' } },
    { name: 'SET_REMINDER', args: { id: 1, remindAt: '2026-01-01T25:99' } },
  ], ctx());
  assert.equal(bad.valid.length, 2, 'UPDATE_TASK survives with the field dropped');
  for (const op of bad.valid) assert.ok(!('dueDate' in op.args), 'impossible dueDate dropped');
  assert.equal(bad.rejected.length, 1);
  assert.match(bad.rejected[0].reason, /MISSING_REQUIRED:remindAt/, 'impossible remindAt is a missing required arg');
  const good = validateOps([
    { name: 'UPDATE_TASK', args: { id: 1, dueDate: '2028-02-29' } },
    { name: 'SET_REMINDER', args: { id: 1, remindAt: '2026-12-31T23:59' } },
  ], ctx());
  assert.equal(good.valid[0].args.dueDate, '2028-02-29');
  assert.equal(good.valid[1].args.remindAt, '2026-12-31T23:59');
});

test('checkId must be non-empty and exist on the task', () => {
  const { validateOps } = load();
  const r = validateOps([
    { name: 'REMOVE_CHECK', args: { id: 1, checkId: '' } },
    { name: 'TOGGLE_CHECK', args: { id: 1, checkId: 999 } },
    { name: 'TOGGLE_CHECK', args: { id: 1, checkId: 7 } },
    { name: 'TOGGLE_CHECK', args: { id: 1, checkId: '7' } },
  ], ctx());
  assert.equal(r.valid.length, 2);
  assert.match(r.rejected[0].reason, /MISSING_REQUIRED:checkId/);
  assert.match(r.rejected[1].reason, /UNKNOWN_CHECK_ID:999/);
});

test('url is limited to http(s)', () => {
  const { validateOps } = load();
  const r = validateOps([
    { name: 'UPDATE_TASK', args: { id: 1, url: 'javascript:alert(1)' } },
    { name: 'UPDATE_TASK', args: { id: 1, url: 'https://example.com/x' } },
  ], ctx());
  assert.ok(!('url' in r.valid[0].args));
  assert.equal(r.valid[1].args.url, 'https://example.com/x');
});

test('category honours isAssignableCategory when the gate is loaded', () => {
  const { validateOps } = load({ isAssignableCategory: (c) => c === 'work' });
  const r = validateOps([
    { name: 'UPDATE_TASK', args: { id: 1, category: 'finance' } },
    { name: 'UPDATE_TASK', args: { id: 1, category: 'work' } },
  ], ctx());
  assert.ok(!('category' in r.valid[0].args), 'unknown / hidden category dropped');
  assert.equal(r.valid[1].args.category, 'work');
  const standalone = load().validateOps([{ name: 'UPDATE_TASK', args: { id: 1, category: 'finance' } }], ctx());
  assert.equal(standalone.valid[0].args.category, 'finance', 'no gate loaded → free text as before');
});

test('ctx.nextId seeds the synthetic id for in-batch CREATE_TASK', () => {
  const { validateOps } = load();
  const r = validateOps([
    { name: 'CREATE_TASK', args: { name: 'New' } },
    { name: 'UPDATE_TASK', args: { id: 16, priority: 'high' } },
    { name: 'UPDATE_TASK', args: { id: 3, priority: 'high' } },
  ], ctx({ nextId: 16 }));
  assert.equal(r.valid.length, 2, 'the runtime id validates, max+1 does not');
  assert.equal(r.valid[1].args.id, 16);
  assert.match(r.rejected[0].reason, /UNKNOWN_TASK_ID:3/);
});
