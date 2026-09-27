/**
 * ICS parser + RRULE expansion regressions:
 *  - VALARM sub-components must not overwrite the event's own SUMMARY /
 *    DESCRIPTION (Google writes "Alarm notification" / "This is an event
 *    reminder" inside every alarm, after the real properties).
 *  - A ':' inside a quoted parameter value (Outlook's display-name TZIDs) is
 *    not the property separator.
 *  - RECURRENCE-ID overrides exclude the slot they replace from the master.
 *  - MONTHLY / YEARLY step by calendar month and rebuild the day: no
 *    setMonth() overflow (Jan 31 → "Feb 31" → Mar 3), months without the
 *    day are skipped, BYMONTHDAY (incl. -1) and ordinal BYDAY (2MO, -1FR).
 *  - WEEKLY INTERVAL>1 cycles honour WKST (Monday by default).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'calfeeds.js'), 'utf8');

function loadFns() {
  const start = src.indexOf('function parseICS(');
  const end = src.indexOf('const CAL_FETCH_MAX_BYTES');
  assert.ok(start >= 0 && end > start, 'slice parser + expand');
  return new Function('window', `${src.slice(start, end)}
    return { parseICS, expandEventToDateRange, parseICSDate };`)({});
}

const ics = (lines) => ['BEGIN:VCALENDAR', ...lines, 'END:VCALENDAR'].join('\r\n');
const dates = (occ) => occ.map((o) => o.dateISO).sort();

// The expansion window is ±windowDays around the real clock; the fixtures
// below sit inside ±200 days of the date this suite was written and are
// checked for shape (which days of a month) rather than absolute window edges.
const WINDOW = 400;

test('VALARM properties do not overwrite the event title / description', () => {
  const fns = loadFns();
  const events = fns.parseICS(ics([
    'BEGIN:VEVENT', 'UID:alarm-1', 'SUMMARY:Dentist', 'DESCRIPTION:Bring insurance card',
    'DTSTART:20260505T090000', 'DTEND:20260505T100000',
    'BEGIN:VALARM', 'ACTION:EMAIL', 'DESCRIPTION:This is an event reminder', 'SUMMARY:Alarm notification',
    'TRIGGER:-P0DT0H30M0S', 'END:VALARM',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:This is an event reminder', 'TRIGGER:-P0DT0H10M0S', 'END:VALARM',
    'END:VEVENT',
  ]));
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Dentist');
  assert.equal(events[0].description, 'Bring insurance card');
});

test('a colon inside a quoted TZID parameter is not the value separator', () => {
  const fns = loadFns();
  const events = fns.parseICS(ics([
    'BEGIN:VEVENT', 'UID:tz-quoted', 'SUMMARY:Standup',
    'DTSTART;TZID="(UTC-05:00) Eastern Time (US & Canada)":20260501T090000',
    'END:VEVENT',
  ]));
  assert.equal(events.length, 1);
  assert.equal(events[0].dateISO, '2026-05-01');
  assert.equal(events[0].title, 'Standup');
});

test('RECURRENCE-ID override removes the original slot from the master', () => {
  const fns = loadFns();
  const events = fns.parseICS(ics([
    'BEGIN:VEVENT', 'UID:standup', 'SUMMARY:Standup', 'DTSTART:20260915T100000', 'DTEND:20260915T101500',
    'RRULE:FREQ=WEEKLY;COUNT=6', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:standup', 'RECURRENCE-ID:20260922T100000', 'SUMMARY:Standup (moved)',
    'DTSTART:20260923T110000', 'DTEND:20260923T111500', 'END:VEVENT',
  ]));
  const master = events.find((e) => e.rrule);
  const override = events.find((e) => e.recurrenceId);
  assert.ok(master && override, 'both VEVENTs parsed');
  assert.equal(override.recurrenceId, '2026-09-22');
  assert.ok(master.exdateList.includes('2026-09-22'), 'master excludes the overridden slot');
  const occ = dates(fns.expandEventToDateRange(master, WINDOW));
  assert.ok(!occ.includes('2026-09-22'), 'ghost original is not emitted');
  assert.ok(occ.includes('2026-09-15') && occ.includes('2026-09-29'));
});

test('MONTHLY from the 31st skips short months instead of drifting to the 3rd', () => {
  const fns = loadFns();
  const occ = dates(fns.expandEventToDateRange(
    { uid: 'm31', title: 'Rent', dateISO: '2026-01-31', allDay: true, rrule: 'FREQ=MONTHLY;COUNT=8', exdateList: [] }, WINDOW));
  assert.ok(occ.includes('2026-03-31') && occ.includes('2026-05-31') && occ.includes('2026-07-31'));
  assert.ok(!occ.some((d) => d.startsWith('2026-02-') || d.startsWith('2026-04-') || d.startsWith('2026-06-')), 'months without a 31st are skipped');
  assert.ok(!occ.includes('2026-03-03') && !occ.includes('2026-05-01'), 'no overflow drift');
  assert.equal(occ.filter((d) => d >= '2026-01-31').length, Math.min(8, occ.length));
});

test('BYMONTHDAY=-1 is the last day of every month', () => {
  const fns = loadFns();
  const occ = dates(fns.expandEventToDateRange(
    { uid: 'last', title: 'Close books', dateISO: '2026-01-31', allDay: true, rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=5', exdateList: [] }, WINDOW));
  assert.deepEqual(occ, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
});

test('ordinal BYDAY: second Monday and last Friday of the month', () => {
  const fns = loadFns();
  const mon = dates(fns.expandEventToDateRange(
    { uid: '2mo', title: 'Board', dateISO: '2026-01-12', allDay: true, rrule: 'FREQ=MONTHLY;BYDAY=2MO;COUNT=4', exdateList: [] }, WINDOW));
  assert.deepEqual(mon, ['2026-01-12', '2026-02-09', '2026-03-09', '2026-04-13']);
  const fri = dates(fns.expandEventToDateRange(
    { uid: '-1fr', title: 'Payday', dateISO: '2026-01-30', allDay: true, rrule: 'FREQ=MONTHLY;BYDAY=-1FR;COUNT=3', exdateList: [] }, WINDOW));
  assert.deepEqual(fri, ['2026-01-30', '2026-02-27', '2026-03-27']);
});

test('YEARLY from Feb 29 only fires in leap years (no Mar 1 substitute)', () => {
  const fns = loadFns();
  const occ = dates(fns.expandEventToDateRange(
    { uid: 'leap', title: 'Leap day', dateISO: '2024-02-29', allDay: true, rrule: 'FREQ=YEARLY', exdateList: [] }, WINDOW));
  assert.ok(!occ.some((d) => d.endsWith('-03-01')), 'never rolls into March');
  assert.ok(occ.every((d) => d.endsWith('-02-29')));
});

test('WEEKLY INTERVAL=2 cycles are Monday-based by default (WKST)', () => {
  const fns = loadFns();
  const occ = dates(fns.expandEventToDateRange(
    { uid: 'wk', title: 'Sync', dateISO: '2026-09-14', allDay: true, rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;WKST=MO;COUNT=4', exdateList: [] }, WINDOW));
  assert.deepEqual(occ, ['2026-09-14', '2026-09-20', '2026-09-28', '2026-10-04']);
  const sun = dates(fns.expandEventToDateRange(
    { uid: 'wk2', title: 'Sync', dateISO: '2026-09-14', allDay: true, rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;WKST=SU;COUNT=4', exdateList: [] }, WINDOW));
  assert.deepEqual(sun, ['2026-09-14', '2026-09-27', '2026-09-28', '2026-10-11'], 'explicit WKST=SU keeps Sunday-based cycles');
});

test('feed cache is never persisted as null and results are written to the live feed', () => {
  assert.match(src, /function _saveCalFeeds\(\)\{\s*\/\/[\s\S]*?if\(!_calFeeds \|\| typeof _calFeeds !== 'object'\) return;/);
  const s = src.indexOf('async function syncCalFeed(');
  const body = src.slice(s, src.indexOf('\nasync function syncAllCalFeeds', s));
  assert.match(body, /const live = _liveFeed\(\);/);
  assert.ok(!/feed\.events = expanded/.test(body), 'stale closure object is not written');
});
