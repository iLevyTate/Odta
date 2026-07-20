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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'tasks.js'), 'utf8');

test('completeHabitCycle resets reminderFired', () => {
  const s = src.indexOf('function completeHabitCycle(');
  assert.ok(s >= 0, 'completeHabitCycle found');
  const e = src.indexOf('\nfunction ', s + 1);
  const body = src.slice(s, e > s ? e : undefined);
  assert.match(body, /t\.reminderFired\s*=\s*false/, 'habit cycle re-arms the reminder');
  assert.match(body, /advanceRecurringDate/, 'habit cycle advances the due date');
});
