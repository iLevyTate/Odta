/**
 * Regression: expandEventToDateRange emitted each occurrence as { ...event,
 * dateISO } — keeping the original rrule AND the first instance's endDateISO.
 * So recurring multi-day all-day events only rendered on their start day
 * (_alldayRangeCovers bails when rrule is set), and timed occurrences inherited
 * a stale end date pointing at the first instance. Each concrete occurrence must
 * clear rrule and shift endDateISO by the original start->end span.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'calfeeds.js'), 'utf8');

function loadExpand() {
  const start = src.indexOf('function parseICSDate(');
  const end = src.indexOf('const CAL_FETCH_MAX_BYTES');
  assert.ok(start >= 0 && end > start, 'slice date+expand helpers');
  const block = src.slice(start, end);
  return new Function('window', `${block}\n return expandEventToDateRange;`)({});
}

test('recurring multi-day all-day occurrences shift endDateISO and drop rrule', () => {
  const expand = loadExpand();
  const ev = {
    uid: 'r', title: 'Conf', allDay: true,
    dateISO: '2026-06-01', endDateISO: '2026-06-04', // 3-day span (DTEND exclusive)
    rrule: 'FREQ=WEEKLY;COUNT=3', exdateList: [],
  };
  const occ = expand(ev, 180).sort((a, b) => a.dateISO.localeCompare(b.dateISO));
  assert.deepEqual(occ.map(o => o.dateISO), ['2026-06-01', '2026-06-08', '2026-06-15']);
  // Each occurrence keeps the 3-day span relative to its own start.
  assert.deepEqual(occ.map(o => o.endDateISO), ['2026-06-04', '2026-06-11', '2026-06-18']);
  // Concrete instances must not carry the rrule anymore.
  assert.ok(occ.every(o => o.rrule === null), 'occurrences must clear rrule');
});

test('timed recurring occurrences get a per-instance end date (not the first instance)', () => {
  const expand = loadExpand();
  const ev = {
    uid: 't', title: 'Standup', allDay: false, time: '09:00', endTime: '09:30',
    dateISO: '2026-06-01', endDateISO: '2026-06-01',
    rrule: 'FREQ=DAILY;COUNT=3', exdateList: [],
  };
  const occ = expand(ev, 180).sort((a, b) => a.dateISO.localeCompare(b.dateISO));
  assert.deepEqual(occ.map(o => o.dateISO), ['2026-06-01', '2026-06-02', '2026-06-03']);
  assert.deepEqual(occ.map(o => o.endDateISO), ['2026-06-01', '2026-06-02', '2026-06-03'],
    'single-day timed occurrence ends on its own date, not the first instance');
});

test('a non-recurring event is returned unchanged', () => {
  const expand = loadExpand();
  const ev = { uid: 'x', dateISO: '2026-06-01', endDateISO: '2026-06-03', allDay: true, rrule: null };
  const occ = expand(ev, 180);
  assert.equal(occ.length, 1);
  assert.equal(occ[0].dateISO, '2026-06-01');
  assert.equal(occ[0].endDateISO, '2026-06-03');
});

test('the rendered range covers continuation days once rrule is cleared', () => {
  // Cross-check with _alldayRangeCovers: an expanded occurrence must now be
  // recognised across its full span (the bug was the rrule guard returning false).
  const cov = (() => {
    const s = src.indexOf('function _alldayRangeCovers(');
    const e = src.indexOf('// Return all feeds whose last sync', s);
    return new Function(`${src.slice(s, e)}\n return _alldayRangeCovers;`)();
  })();
  const expand = loadExpand();
  const ev = {
    uid: 'r', allDay: true, dateISO: '2026-06-01', endDateISO: '2026-06-04',
    rrule: 'FREQ=WEEKLY;COUNT=2', exdateList: [],
  };
  const second = expand(ev, 180).find(o => o.dateISO === '2026-06-08');
  assert.ok(second, 'second occurrence exists');
  assert.equal(cov(second, '2026-06-09'), true, 'continuation day of the 2nd occurrence is covered');
  assert.equal(cov(second, '2026-06-11'), false, 'exclusive end is not covered');
});
