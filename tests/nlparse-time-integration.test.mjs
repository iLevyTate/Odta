/**
 * End-to-end quick-add time parsing through parseQuickAddAsync + chrono.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadAsyncParser(fixedTodayISO) {
  const tasksSrc = readFileSync(join(root, 'js', 'tasks.js'), 'utf8');
  const h = tasksSrc.indexOf('function _qaPad2(n)');
  const s = tasksSrc.indexOf('function parseQuickAdd(raw)');
  const e = tasksSrc.indexOf('async function addTask()', s);
  const parseQuickAdd = new Function('todayISO', tasksSrc.slice(h, e) + '\nreturn parseQuickAdd;')(() => fixedTodayISO);

  const nlparseSrc = readFileSync(join(root, 'js', 'nlparse.js'), 'utf8');
  globalThis.parseQuickAdd = parseQuickAdd;
  globalThis.gid = () => null;
  eval(nlparseSrc.replace(/window\./g, 'globalThis.'));
  return globalThis.parseQuickAddAsync;
}

test('parseQuickAddAsync keeps tomorrow when chrono only enriches the clock', async () => {
  const parseQuickAddAsync = loadAsyncParser('2026-05-28');
  const r = await parseQuickAddAsync('meeting tomorrow at 2pm @urgent');
  assert.equal(r.name, 'meeting');
  assert.equal(r.props.priority, 'urgent');
  assert.equal(r.props.dueDate, '2026-05-29');
  assert.equal(r.props.remindAt, '2026-05-29T14:00');
});

test('parseQuickAddAsync parses standalone clock phrases through chrono', async () => {
  const parseQuickAddAsync = loadAsyncParser('2026-05-28');
  const r = await parseQuickAddAsync('call mom at 3pm');
  assert.equal(r.name, 'call mom');
  assert.equal(r.props.dueDate, '2026-05-28');
  assert.equal(r.props.remindAt, '2026-05-28T15:00');
});
