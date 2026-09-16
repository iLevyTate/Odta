/**
 * End-to-end quick-add time parsing through parseQuickAddAsync + chrono.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Point nlparse at the vendored chrono bundle by file URL so the async path
 *  (not just the sync quick-add parser) is actually exercised in Node. */
function useVendoredChrono() {
  globalThis.ODTAULAI_CONFIG = {
    CHRONO_URL: pathToFileURL(join(root, 'js', 'vendor', 'chrono-node.min.mjs')).href,
  };
}

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

test('quick add consumes the qualifier in front of a weekday ("next monday", "on friday") with the date', async () => {
  const parseQuickAddAsync = loadAsyncParser('2026-09-10');
  // Seen in the wild as the task "Call dentist next": the sync parser stripped only the
  // weekday and the qualifier survived in the title.
  const r1 = await parseQuickAddAsync('call dentist next monday');
  assert.equal(r1.name, 'call dentist');
  assert.ok(r1.props.dueDate && r1.props.dueDate > '2026-09-10', 'a date was still extracted: ' + r1.props.dueDate);
  const r2 = await parseQuickAddAsync('renew the passport next friday @high');
  assert.equal(r2.name, 'renew the passport');
  assert.equal(r2.props.priority, 'high');
  const r3 = await parseQuickAddAsync('submit expenses on friday');
  assert.equal(r3.name, 'submit expenses');
});

test('a leading day-part word belongs to the title, not to the date phrase', async () => {
  useVendoredChrono();
  const parseQuickAddAsync = loadAsyncParser('2026-09-16');
  // Seen in the wild: "Morning run daily" saved the task as "run", and
  // "Night shift prep friday" saved it as "shift prep".
  const r1 = await parseQuickAddAsync('Morning run daily #health');
  assert.equal(r1.name, 'Morning run');
  assert.equal(r1.props.recur, 'daily');
  assert.deepEqual(r1.props.tags, ['health']);

  const r2 = await parseQuickAddAsync('Evening walk with dog');
  assert.equal(r2.name, 'Evening walk with dog');

  const r3 = await parseQuickAddAsync('Night shift prep friday');
  assert.equal(r3.name, 'Night shift prep');
  assert.ok(r3.props.dueDate, 'the weekday is still parsed: ' + r3.props.dueDate);
});

test('the preposition pointing at a consumed date phrase is consumed with it', async () => {
  useVendoredChrono();
  const parseQuickAddAsync = loadAsyncParser('2026-09-16');
  // "Take meds every night" used to save as "Take meds every".
  assert.equal((await parseQuickAddAsync('Take meds every night')).name, 'Take meds');
  assert.equal((await parseQuickAddAsync('Water the plants every evening')).name, 'Water the plants');
  assert.equal((await parseQuickAddAsync('Gym every morning')).name, 'Gym');
  assert.equal((await parseQuickAddAsync('Review PR by 5pm today')).name, 'Review PR');
});

test('phrasal-verb particles survive the date strip', async () => {
  useVendoredChrono();
  const parseQuickAddAsync = loadAsyncParser('2026-09-16');
  // The trim must never turn "Check in" into "Check" or "Follow up" into "Follow".
  assert.equal((await parseQuickAddAsync('Check in tomorrow')).name, 'Check in');
  assert.equal((await parseQuickAddAsync('Follow up on friday')).name, 'Follow up');
  assert.equal((await parseQuickAddAsync('Turn on heating tomorrow')).name, 'Turn on heating');
  // No date consumed at all → nothing is trimmed.
  assert.equal((await parseQuickAddAsync('Read before bed')).name, 'Read before bed');
});
