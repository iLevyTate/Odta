/**
 * Regression: the ICS parser concatenated EXDATE values and dropped their
 * TZID/VALUE params, and normaliseEvent took the literal date digits. A timed
 * or UTC EXDATE therefore matched the wrong local date (or none), so the
 * cancelled occurrence still showed. EXDATE must resolve through parseICSDate —
 * the same conversion used for occurrence dates — so the exclusion lines up.
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
    return { parseICS, expandEventToDateRange, parseICSDate, _exdateSetFromSpecs };`)({});
}

test('_exdateSetFromSpecs resolves a UTC EXDATE through the same conversion as occurrences', () => {
  const fns = loadFns();
  const set = fns._exdateSetFromSpecs([{ v: '20260421T233000Z', tzid: null, valueType: null }]);
  const expected = fns.parseICSDate('20260421T233000Z', false).iso;
  assert.ok(set.has(expected), 'UTC EXDATE resolves to its local date, matching the occurrence');
  assert.equal(set.size, 1);
});

test('_exdateSetFromSpecs handles a DATE-valued (all-day) EXDATE literally', () => {
  const fns = loadFns();
  const set = fns._exdateSetFromSpecs([{ v: '20260421', tzid: null, valueType: 'DATE' }]);
  assert.ok(set.has('2026-04-21'));
});

test('a UTC EXDATE excludes the occurrence with the matching local date', () => {
  const fns = loadFns();
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:tz-ex',
    'SUMMARY:Nightly',
    'DTSTART:20260420T233000Z',
    'RRULE:FREQ=DAILY;COUNT=4',
    'EXDATE:20260421T233000Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const events = fns.parseICS(ics);
  assert.equal(events.length, 1, 'one VEVENT parsed');
  const occ = fns.expandEventToDateRange(events[0], 400);
  const excludedLocal = fns.parseICSDate('20260421T233000Z', false).iso;
  const dtstartLocal = fns.parseICSDate('20260420T233000Z', false).iso;
  const dates = occ.map(o => o.dateISO);
  // COUNT counts KEPT occurrences, so the excluded day is replaced by a later
  // one — the meaningful check is that the zone-resolved EXDATE date is gone
  // while its non-excluded neighbour (the DTSTART day) remains.
  assert.ok(dates.includes(dtstartLocal), 'the non-excluded DTSTART occurrence remains');
  assert.ok(!dates.includes(excludedLocal), 'the zone-resolved EXDATE local date is excluded');
});

test('a TZID EXDATE is captured (not dropped) by the parser', () => {
  const fns = loadFns();
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:tz-ex2',
    'SUMMARY:Standup',
    'DTSTART;TZID=America/New_York:20260420T120000',
    'RRULE:FREQ=DAILY;COUNT=3',
    'EXDATE;TZID=America/New_York:20260421T120000',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const events = fns.parseICS(ics);
  // The excluded local date equals the DTSTART-style conversion of the EXDATE.
  const excluded = fns.parseICSDate('20260421T120000', false, 'America/New_York').iso;
  assert.ok(events[0].exdateList.includes(excluded), 'TZID EXDATE resolved to a local date');
  const occ = fns.expandEventToDateRange(events[0], 400);
  assert.ok(!occ.map(o => o.dateISO).includes(excluded), 'matching occurrence excluded');
});
