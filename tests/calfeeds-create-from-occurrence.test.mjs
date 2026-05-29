/**
 * Regression: createTaskFromCalEventCore matched a feed event by UID only.
 * Recurring events expand into many rows sharing one UID, so it always picked
 * the FIRST (often long-past) occurrence — the new task got the wrong due date,
 * and per-event dedup made it impossible to create a task for a second instance.
 * It must honour the clicked occurrence's date and dedup per occurrence.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'calfeeds.js'), 'utf8');

function buildCore(feed, tasks) {
  const start = src.indexOf('function createTaskFromCalEventCore(');
  const end = src.indexOf('function createTaskFromCalEvent(', start);
  assert.ok(start >= 0 && end > start, 'slice createTaskFromCalEventCore');
  const block = src.slice(start, end);
  const _calFeeds = { feeds: [feed] };
  const factory = new Function(
    '_loadCalFeeds', '_calFeeds', 'tasks', 'taskIdCtr', 'defaultTaskProps', 'timeNowFull', '_taskIndexRegister',
    `${block}\n return createTaskFromCalEventCore;`,
  );
  return factory(
    () => {}, _calFeeds, tasks, 0,
    () => ({ priority: 'none', tags: [], _ext: {} }),
    () => '2026-01-01 00:00',
    () => {},
  );
}

const RECUR_EVENTS = [
  { uid: 'r1', title: 'Standup', dateISO: '2026-01-05', allDay: false, description: '', location: '' },
  { uid: 'r1', title: 'Standup', dateISO: '2026-01-12', allDay: false, description: '', location: '' },
  { uid: 'r1', title: 'Standup', dateISO: '2026-01-19', allDay: false, description: '', location: '' },
];

test('creating from a specific occurrence uses THAT date, not the first instance', () => {
  const tasks = [];
  const core = buildCore({ id: 'f1', label: 'Work', events: RECUR_EVENTS.map(e => ({ ...e })) }, tasks);
  const id = core('f1', 'r1', '2026-01-12');
  assert.ok(id != null, 'task created');
  const t = tasks.find(x => x.id === id);
  assert.equal(t.dueDate, '2026-01-12', 'due date must be the clicked occurrence, not 2026-01-05');
  assert.equal(t._ext.calEventDate, '2026-01-12', 'occurrence date is recorded for per-instance dedup');
});

test('a second occurrence of the same recurring event creates a distinct task', () => {
  const tasks = [];
  const core = buildCore({ id: 'f1', label: 'Work', events: RECUR_EVENTS.map(e => ({ ...e })) }, tasks);
  const a = core('f1', 'r1', '2026-01-12');
  const b = core('f1', 'r1', '2026-01-19');
  assert.notEqual(a, b, 'different occurrences must be different tasks');
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks.map(t => t.dueDate).sort(), ['2026-01-12', '2026-01-19']);
});

test('the same occurrence dedups to the existing task', () => {
  const tasks = [];
  const core = buildCore({ id: 'f1', label: 'Work', events: RECUR_EVENTS.map(e => ({ ...e })) }, tasks);
  const a = core('f1', 'r1', '2026-01-12');
  const again = core('f1', 'r1', '2026-01-12');
  assert.equal(a, again, 'same occurrence must dedup, not duplicate');
  assert.equal(tasks.length, 1);
});

test('a legacy task without calEventDate still dedups (no surprise duplicate)', () => {
  const tasks = [{ id: 99, _ext: { calFeedId: 'f1', calEventUid: 'r1' } }];
  const core = buildCore({ id: 'f1', label: 'Work', events: RECUR_EVENTS.map(e => ({ ...e })) }, tasks);
  const id = core('f1', 'r1', '2026-01-12');
  assert.equal(id, 99, 'a legacy uid-only task matches any date to avoid duplicating');
  assert.equal(tasks.length, 1);
});

test('with no date passed it falls back to the first occurrence (non-recurring callers)', () => {
  const tasks = [];
  const core = buildCore({ id: 'f1', label: 'Work', events: RECUR_EVENTS.map(e => ({ ...e })) }, tasks);
  const id = core('f1', 'r1');
  const t = tasks.find(x => x.id === id);
  assert.equal(t.dueDate, '2026-01-05', 'uid-only fallback keeps prior behaviour');
});
