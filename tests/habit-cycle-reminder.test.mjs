/**
 * completeHabitCycle must re-arm the reminder for the next cycle.
 *
 * checkReminders skips any task with reminderFired set and never clears it.
 * Cycling a habit advances dueDate (implicit due-date reminder) but used to
 * leave reminderFired=true, making every recurring reminder one-shot: it
 * fired once on the first cycle and never again.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'tasks.js'), 'utf8');

function fnBlock(name) {
  const s = src.indexOf(`function ${name}(`);
  assert.ok(s >= 0, `${name} found`);
  const e = src.indexOf('\nfunction ', s + 1);
  return src.slice(s, e > s ? e : undefined);
}

test('completeHabitCycle resets reminderFired', () => {
  const body = fnBlock('completeHabitCycle');
  assert.match(body, /t\.reminderFired\s*=\s*false/, 'habit cycle re-arms the reminder');
  assert.match(body, /advanceRecurringDate/, 'habit cycle advances the due date');
});

// Functional: checkReminders prefers remindAt over dueDate, so a cycle must
// roll an explicit remindAt forward too. Left stale, the past timestamp
// re-fires as "Missed:" ~30s after logging the cycle, and the dueDate branch
// stays unreachable for every future cycle.
test('completeHabitCycle advances an explicit remindAt with the cycle', () => {
  const sandbox = {
    todayISO: () => '2026-07-20',
    getTaskElapsed: () => 0,
    _pinTaskVisibleBriefly: () => {},
    Date,
    JSON,
    Math,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    fnBlock('advanceRecurringDate') + '\n' + fnBlock('completeHabitCycle') +
    '\nthis.completeHabitCycle = completeHabitCycle;',
    sandbox
  );
  const t = {
    recur: 'daily', dueDate: '2026-07-20', remindAt: '2026-07-20T21:00',
    reminderFired: true, completions: [], status: 'done', checklist: [],
  };
  sandbox.completeHabitCycle(t);
  assert.strictEqual(t.dueDate, '2026-07-21');
  assert.strictEqual(t.remindAt, '2026-07-21T21:00', 'remindAt rolls with the recurrence, keeping the time');
  assert.strictEqual(t.reminderFired, false);

  // Tasks without an explicit remindAt keep it null.
  const t2 = { recur: 'weekly', dueDate: '2026-07-20', remindAt: null,
    reminderFired: true, completions: [], status: 'done', checklist: [] };
  sandbox.completeHabitCycle(t2);
  assert.strictEqual(t2.remindAt, null);
  assert.strictEqual(t2.dueDate, '2026-07-27');
});
