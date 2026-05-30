/**
 * Regression: WEEKLY + BYDAY + COUNT truncation order.
 * `byDays` was kept in the BYDAY *string* order, and occurrences were emitted
 * in that order within each week. When BYDAY is listed out of weekday order AND
 * COUNT is set, the `results.length >= count` truncation kept the wrong
 * instances (e.g. BYDAY=FR,MO;COUNT=3 from a Monday kept week-2 Friday instead
 * of week-2 Monday). byDays must be sorted ascending so truncation is
 * chronological.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'calfeeds.js'), 'utf8');

function buildExpand() {
  const start = src.indexOf('function expandEventToDateRange(');
  const end = src.indexOf('const CAL_FETCH_MAX_BYTES', start);
  assert.ok(start >= 0 && end > start, 'slice expandEventToDateRange');
  const block = src.slice(start, end);
  // Pin "today" so the ±windowDays clamp is deterministic regardless of the
  // wall clock. Passing Date as a param shadows the global for the sliced
  // closure; no-arg `new Date()` returns the fixed day, every other form
  // delegates to the real Date.
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super('2026-01-01T00:00:00');
      else super(...args);
    }
  }
  // parseICSDate is only referenced when UNTIL is present; tests below omit it,
  // but pass a throwing stub so an accidental call is loud rather than silent.
  const factory = new Function(
    'parseICSDate', 'Date',
    `${block}\n return expandEventToDateRange;`,
  );
  return factory(() => { throw new Error('parseICSDate should not be called'); }, FakeDate);
}

test('BYDAY=FR,MO;COUNT=3 from a Monday keeps the first three chronological occurrences', () => {
  const expand = buildExpand();
  // 2026-01-05 is a Monday. COUNT=3 should yield Mon 01-05, Fri 01-09, Mon 01-12.
  const ev = { uid: 'r1', title: 'Standup', dateISO: '2026-01-05', allDay: false,
    rrule: 'FREQ=WEEKLY;BYDAY=FR,MO;COUNT=3' };
  const out = expand(ev, 60).map(o => o.dateISO).sort();
  assert.deepEqual(out, ['2026-01-05', '2026-01-09', '2026-01-12'],
    'must keep Mon, Fri, Mon — not Mon, Fri, Fri');
});

test('BYDAY listing order does not change the emitted set (COUNT held equal)', () => {
  const mk = (byday) => buildExpand()({ uid: 'x', dateISO: '2026-01-05', allDay: false,
    rrule: `FREQ=WEEKLY;BYDAY=${byday};COUNT=4` }, 60).map(o => o.dateISO).sort();
  assert.deepEqual(mk('MO,FR'), mk('FR,MO'),
    'BYDAY listing order must not change which dates are produced');
  assert.deepEqual(mk('FR,MO'), ['2026-01-05', '2026-01-09', '2026-01-12', '2026-01-16']);
});
