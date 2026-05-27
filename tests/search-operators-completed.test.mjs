/**
 * Tests for the completed: operator added to parseTaskSearchQuery.
 *
 * Accepts:
 *   completed:today           single-day range, today only
 *   completed:yesterday       single-day range, yesterday
 *   completed:this-week       [today-6 .. today] inclusive
 *   completed:last-week       [today-7 .. today-1] inclusive
 *   completed:this-month      [first-of-month .. today]
 *   completed:last-month      previous calendar month
 *   completed:2026-05-20      single ISO date
 *   completed:2026-05-20..2026-05-27   inclusive ISO range
 *
 * Pattern: slice parser source from js/tasks.js, evaluate in a vm
 * context that stubs todayISO so keyword tests are deterministic.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const full = readFileSync(join(root, 'js', 'tasks.js'), 'utf8');

const sIdx = full.indexOf('// ── Search operator parser');
const eMark = "if(typeof window !== 'undefined') window.parseTaskSearchQuery = parseTaskSearchQuery;";
const eIdx = full.indexOf(eMark);
if (sIdx < 0 || eIdx < 0) throw new Error('parser markers not found in js/tasks.js');
const block = full.slice(sIdx, eIdx + eMark.length);

function loadParser() {
  // Pin "today" to a deterministic date so keyword tests are stable.
  const sandbox = { todayISO: () => '2026-05-27' };
  vm.createContext(sandbox);
  vm.runInContext(block, sandbox);
  return sandbox.parseTaskSearchQuery;
}

test('completed: today resolves to a single-day range', () => {
  const r = loadParser()('completed:today');
  assert.deepEqual(r.ops.completed, [{ start: '2026-05-27', end: '2026-05-27' }]);
});

test('completed: yesterday', () => {
  const r = loadParser()('completed:yesterday');
  assert.deepEqual(r.ops.completed, [{ start: '2026-05-26', end: '2026-05-26' }]);
});

test('completed: this-week is the 7-day window ending today', () => {
  const r = loadParser()('completed:this-week');
  assert.deepEqual(r.ops.completed, [{ start: '2026-05-21', end: '2026-05-27' }]);
});

test('completed: last-week is the 7-day window ending yesterday', () => {
  const r = loadParser()('completed:last-week');
  assert.deepEqual(r.ops.completed, [{ start: '2026-05-20', end: '2026-05-26' }]);
});

test('completed: this-month from 1st to today', () => {
  const r = loadParser()('completed:this-month');
  assert.deepEqual(r.ops.completed, [{ start: '2026-05-01', end: '2026-05-27' }]);
});

test('completed: last-month covers the whole previous calendar month', () => {
  const r = loadParser()('completed:last-month');
  assert.deepEqual(r.ops.completed, [{ start: '2026-04-01', end: '2026-04-30' }]);
});

test('completed: exact ISO date', () => {
  const r = loadParser()('completed:2026-05-20');
  assert.deepEqual(r.ops.completed, [{ start: '2026-05-20', end: '2026-05-20' }]);
});

test('completed: ISO range', () => {
  const r = loadParser()('completed:2026-05-20..2026-05-27');
  assert.deepEqual(r.ops.completed, [{ start: '2026-05-20', end: '2026-05-27' }]);
});

test('completed: invalid value drops, text survives', () => {
  const r = loadParser()('completed:banana keep');
  assert.equal((r.ops.completed || []).length, 0);
  assert.equal(r.text, 'keep');
});

test('completed: AND-stacks with duration and other ops', () => {
  const r = loadParser()('is:done completed:last-week duration:>2h');
  assert.deepEqual(r.ops.completed, [{ start: '2026-05-20', end: '2026-05-26' }]);
  assert.deepEqual(r.ops.is, ['done']);
  assert.deepEqual(r.ops.duration, [{ op: '>', seconds: 7200 }]);
});
