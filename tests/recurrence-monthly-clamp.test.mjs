/**
 * advanceRecurringDate 'monthly' — short-month clamping.
 *
 * Calling d.setMonth(m+1) while the day-of-month is still 29–31 overflows
 * past a shorter target month (Jan 31 → "Feb 31" → Mar 3), so the subsequent
 * clamp landed on Mar 31 and February was skipped entirely. The fix moves to
 * the 1st before setMonth, then clamps to the target month's last day.
 *
 * The function is sliced from js/tasks.js and evaluated in an isolated vm
 * context (same pattern as tests/search-operators-duration.test.mjs).
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const full = readFileSync(join(root, 'js', 'tasks.js'), 'utf8');

const sIdx = full.indexOf('function advanceRecurringDate(');
assert.ok(sIdx >= 0, 'advanceRecurringDate found in js/tasks.js');
const eIdx = full.indexOf('\nfunction ', sIdx + 1);
const block = full.slice(sIdx, eIdx > sIdx ? eIdx : undefined);

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(block + '\nthis.advanceRecurringDate = advanceRecurringDate;', sandbox);
const advance = sandbox.advanceRecurringDate;

test('monthly: due-day 31 clamps to short months instead of skipping them', () => {
  assert.strictEqual(advance('2026-01-31', 'monthly'), '2026-02-28');
  assert.strictEqual(advance('2026-03-31', 'monthly'), '2026-04-30');
  assert.strictEqual(advance('2026-08-31', 'monthly'), '2026-09-30');
});

test('monthly: leap February keeps the 29th', () => {
  assert.strictEqual(advance('2024-01-31', 'monthly'), '2024-02-29');
  assert.strictEqual(advance('2024-01-29', 'monthly'), '2024-02-29');
});

test('monthly: plain mid-month dates advance one month unchanged', () => {
  assert.strictEqual(advance('2026-01-15', 'monthly'), '2026-02-15');
  assert.strictEqual(advance('2026-12-05', 'monthly'), '2027-01-05');
});

test('monthly: December 31 rolls into January 31 of the next year', () => {
  assert.strictEqual(advance('2026-12-31', 'monthly'), '2027-01-31');
});
