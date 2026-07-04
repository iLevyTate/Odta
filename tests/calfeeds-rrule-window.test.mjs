/**
 * Regression: RRULE COUNT accounting vs the ±windowDays expansion window, and
 * the iteration-budget fast-forward for deep-past DTSTARTs.
 *
 * Two bugs locked in here:
 *  1. COUNT used to be checked against `results.length` (the *emitted*,
 *     in-window occurrences), so positions before the `past` boundary never
 *     consumed COUNT slots — an exhausted COUNT=20 rule from years ago
 *     re-materialized up to 20 phantom occurrences inside every new window.
 *  2. Iteration started at DTSTART with maxIter=2000, so a still-active DAILY
 *     rule whose DTSTART is older than ~5.5 years burned the whole budget on
 *     pre-window dates and silently produced zero occurrences.
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
  // Pin "today" to 2026-01-01 (see calfeeds-byday-count.test.mjs).
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super('2026-01-01T00:00:00');
      else super(...args);
    }
  }
  const factory = new Function(
    'parseICSDate', 'Date',
    `${block}\n return expandEventToDateRange;`,
  );
  return factory(() => { throw new Error('parseICSDate should not be called'); }, FakeDate);
}

test('exhausted COUNT from years ago produces NO phantom occurrences in the window', () => {
  const expand = buildExpand();
  // Weekly standup that really ended after 20 weeks in mid-2023.
  const ev = { uid: 'p1', title: 'Old standup', dateISO: '2023-01-02', allDay: false,
    rrule: 'FREQ=WEEKLY;COUNT=20' };
  assert.deepEqual(expand(ev, 180), [], 'COUNT exhausted long before the window — nothing to emit');
});

test('COUNT straddling the window edge emits only the in-window remainder', () => {
  const expand = buildExpand();
  // windowDays=60 → past = 2025-11-02. Daily from 2025-10-29 with COUNT=10:
  // positions 1-4 (10-29 .. 11-01) are pre-window and consume COUNT;
  // positions 5-10 (11-02 .. 11-07) are emitted.
  const ev = { uid: 'p2', title: 'Straddle', dateISO: '2025-10-29', allDay: false,
    rrule: 'FREQ=DAILY;COUNT=10' };
  const out = expand(ev, 60).map(o => o.dateISO).sort();
  assert.deepEqual(out, ['2025-11-02', '2025-11-03', '2025-11-04', '2025-11-05', '2025-11-06', '2025-11-07']);
});

test('still-active DAILY rule from 7 years back survives the iteration budget', () => {
  const expand = buildExpand();
  const ev = { uid: 'p3', title: 'Ancient daily', dateISO: '2019-03-01', allDay: false,
    rrule: 'FREQ=DAILY' };
  const out = expand(ev, 180).map(o => o.dateISO).sort();
  assert.ok(out.length > 300, `expected the full window of dailies, got ${out.length}`);
  assert.ok(out.includes('2026-01-01'), 'today must be present');
  // First emitted date is the window boundary (today − 180d = 2025-07-05).
  assert.equal(out[0], '2025-07-05', 'first occurrence sits on the past window boundary');
  // Occurrences are anchored at T12:00 but `future` is midnight of today+180d,
  // so the future boundary day itself falls outside the window (pre-existing
  // windowing behavior, unchanged by the fast-forward fix).
  assert.equal(out[out.length - 1], '2026-06-29', 'last occurrence sits just inside the future window boundary');
});

test('fast-forward preserves the INTERVAL grid alignment', () => {
  const expand = buildExpand();
  const ev = { uid: 'p4', title: 'Every 3 days', dateISO: '2019-01-06', allDay: false,
    rrule: 'FREQ=DAILY;INTERVAL=3' };
  const out = expand(ev, 90).map(o => o.dateISO);
  assert.ok(out.length > 0, 'active recurrence must emit');
  const base = new Date('2019-01-06T12:00:00');
  for (const iso of out) {
    const d = new Date(iso + 'T12:00:00');
    const days = Math.round((d - base) / 86400000);
    assert.equal(days % 3, 0, `${iso} must sit on the every-3-days grid from DTSTART`);
  }
});

test('WEEKLY+BYDAY deep past with COUNT emits exactly the surviving tail positions', () => {
  const expand = buildExpand();
  // 2024-01-01 is a Monday. BYDAY=MO,WE → 2 occurrences per week, so COUNT=200
  // spans 100 weeks: last occurrence is the Wednesday of week 99 =
  // 2024-01-01 + 99*7 + 2 = 2025-11-26. windowDays=90 → past = 2025-10-03
  // (Friday). Surviving in-window positions: Mondays/Wednesdays from
  // 2025-10-06 through 2025-11-26.
  const ev = { uid: 'p5', title: 'Old cadence', dateISO: '2024-01-01', allDay: false,
    rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=200' };
  const out = expand(ev, 90).map(o => o.dateISO).sort();
  const expected = [];
  for (let w = 0; ; w++) {
    const mon = new Date('2024-01-01T12:00:00');
    mon.setDate(mon.getDate() + w * 7);
    const wed = new Date(mon); wed.setDate(mon.getDate() + 2);
    const fmt = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    if (expected.push(fmt(mon)) >= 0 && fmt(mon) === '2025-11-24') { expected.push(fmt(wed)); break; }
    expected.push(fmt(wed));
  }
  const tail = expected.slice(0, 200).filter(iso => iso >= '2025-10-03');
  assert.deepEqual(out, tail.sort(), 'in-window tail of the 200-occurrence sequence');
  assert.equal(out[out.length - 1], '2025-11-26', 'sequence ends exactly at occurrence #200');
});

test('pre-window EXDATEs do not consume COUNT slots (kept-occurrence semantics)', () => {
  const expand = buildExpand();
  // Daily COUNT=68 from 2025-10-27, windowDays=60 → past = 2025-11-02.
  // Without EXDATEs the sequence ends 2026-01-02 (position 68). Two pre-window
  // EXDATEs shift the 68th KEPT occurrence out to 2026-01-04.
  const ev = { uid: 'p6', title: 'Exdated', dateISO: '2025-10-27', allDay: false,
    rrule: 'FREQ=DAILY;COUNT=68',
    exdateList: ['2025-10-28', '2025-10-30'] };
  const out = expand(ev, 60).map(o => o.dateISO).sort();
  assert.equal(out[out.length - 1], '2026-01-04', 'pre-window EXDATEs must not consume COUNT');
  assert.ok(!out.includes('2025-10-28') && !out.includes('2025-10-30'), 'exdated dates never emit');
});
