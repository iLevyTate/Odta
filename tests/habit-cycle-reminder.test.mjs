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
//
// The clock is pinned so the assertions don't depend on the real date: a
// habit logged on its due day rolls exactly one cycle.
function makeSandbox(today, nowMs) {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(nowMs); }
    static now() { return nowMs; }
  }
  const sandbox = {
    todayISO: () => today,
    getTaskElapsed: () => 0,
    _pinTaskVisibleBriefly: () => {},
    Date: FakeDate,
    JSON,
    Math,
    Number,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    fnBlock('advanceRecurringDate') + '\n' + fnBlock('completeHabitCycle') +
    '\nthis.completeHabitCycle = completeHabitCycle;',
    sandbox
  );
  return sandbox;
}

test('completeHabitCycle advances an explicit remindAt with the cycle', () => {
  const sandbox = makeSandbox('2026-07-20', new Date('2026-07-20T12:00:00').getTime());
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

// Logging a habit N days late must land the next due date AFTER today (and
// the reminder in the future). Advancing exactly one cycle from the stale due
// date left the habit overdue and — with reminderFired re-armed — re-fired
// "Missed: <habit>" within 30 s of logging it.
test('completeHabitCycle catches an overdue habit up past today', () => {
  const sandbox = makeSandbox('2026-09-26', new Date('2026-09-26T12:00:00').getTime());
  const daily = {
    recur: 'daily', dueDate: '2026-09-20', remindAt: '2026-09-20T21:00',
    reminderFired: true, completions: [], status: 'done', checklist: [],
  };
  sandbox.completeHabitCycle(daily);
  assert.strictEqual(daily.dueDate, '2026-09-27', 'daily habit 6 days late is next due tomorrow');
  assert.strictEqual(daily.remindAt, '2026-09-27T21:00', 'reminder keeps its time and lands in the future');
  assert.strictEqual(daily.reminderFired, false);

  // The reminder rolls the same number of cycles as the due date, so it keeps
  // its offset from the due date (here: same day) instead of nagging again
  // tonight for a cycle that is due tomorrow.
  const later = {
    recur: 'daily', dueDate: '2026-09-25', remindAt: '2026-09-25T21:00',
    reminderFired: true, completions: [], status: 'done', checklist: [],
  };
  sandbox.completeHabitCycle(later);
  assert.strictEqual(later.dueDate, '2026-09-27');
  assert.strictEqual(later.remindAt, '2026-09-27T21:00', 'reminder stays aligned with the new due date');

  // Weekly keeps its weekday anchor: Mon Sep 14 → Mon Sep 28 (Sep 21 is past).
  const weekly = { recur: 'weekly', dueDate: '2026-09-14', remindAt: null,
    reminderFired: true, completions: [], status: 'done', checklist: [] };
  sandbox.completeHabitCycle(weekly);
  assert.strictEqual(weekly.dueDate, '2026-09-28');

  // Monthly steps month by month: Jul 31 → Aug 31 → Sep 30, the first
  // occurrence after Sep 26 (advanceRecurringDate clamps to the shorter
  // month's last day).
  const monthly = { recur: 'monthly', dueDate: '2026-07-31', remindAt: null,
    reminderFired: true, completions: [], status: 'done', checklist: [] };
  sandbox.completeHabitCycle(monthly);
  assert.strictEqual(monthly.dueDate, '2026-09-30');

  // Unknown recurrence strings make no progress and must not spin forever.
  const odd = { recur: 'yearly', dueDate: '2020-01-01', remindAt: null,
    reminderFired: true, completions: [], status: 'done', checklist: [] };
  sandbox.completeHabitCycle(odd);
  assert.strictEqual(odd.dueDate, '2020-01-01');
});
