/**
 * getCalFeedEventsForDate: EXDATE filter + multi-day all-day (js/calfeeds.js).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function makeApi(_calFeeds) {
  const src = readFileSync(join(root, 'js', 'calfeeds.js'), 'utf8');
  const s = src.indexOf('function _alldayRangeCovers(');
  const e = src.indexOf('// Get all visible feed events', s);
  assert.ok(s >= 0 && e > s, 'slice query helpers');
  const block = src.slice(s, e);
  return new Function(
    '_loadCalFeeds',
    '_calFeeds',
    `${block}
    return { _alldayRangeCovers, getCalFeedEventsForDate };
  `,
  )(() => {}, _calFeeds);
}

test('_alldayRangeCovers: multi-day all-day (DTEND exclusive)', () => {
  const f = makeApi({ feeds: [] });
  const ev = { allDay: true, dateISO: '2026-01-10', endDateISO: '2026-01-13', rrule: null };
  assert.equal(f._alldayRangeCovers(ev, '2026-01-09'), false);
  assert.equal(f._alldayRangeCovers(ev, '2026-01-10'), true);
  assert.equal(f._alldayRangeCovers(ev, '2026-01-11'), true);
  assert.equal(f._alldayRangeCovers(ev, '2026-01-12'), true);
  assert.equal(f._alldayRangeCovers(ev, '2026-01-13'), false);
});

test('getCalFeedEventsForDate: excludes EXDATE instance on multi-day all-day', () => {
  const _calFeeds = {
    feeds: [
      {
        id: 'f1',
        label: 'T',
        color: '#000',
        visible: true,
        events: [
          {
            title: 'R',
            dateISO: '2026-06-01',
            exdateList: ['2026-06-02'],
            allDay: true,
            endDateISO: '2026-06-04',
            rrule: null,
            uid: 'u1',
          },
        ],
      },
    ],
  };
  const f = makeApi(_calFeeds);
  assert.equal(f.getCalFeedEventsForDate('2026-06-01').length, 1);
  assert.equal(f.getCalFeedEventsForDate('2026-06-02').length, 0, 'excluded day');
  assert.equal(f.getCalFeedEventsForDate('2026-06-03').length, 1, 'range continues after exdate');
});

test('getCalFeedEventsForDate: collapses identical occurrence from two feeds (same UID)', () => {
  const ev = { uid: 'u-meet', title: 'Tuesday Evening Meeting', dateISO: '2026-06-09', time: '19:00', rrule: null };
  const _calFeeds = {
    feeds: [
      { id: 'a', label: 'A', color: '#111', visible: true, events: [{ ...ev }] },
      { id: 'b', label: 'B', color: '#222', visible: true, events: [{ ...ev }] },
    ],
  };
  const f = makeApi(_calFeeds);
  assert.equal(f.getCalFeedEventsForDate('2026-06-09').length, 1, 'duplicate collapsed');
});

test('getCalFeedEventsForDate: keeps distinct events at same slot (different UID)', () => {
  const _calFeeds = {
    feeds: [{
      id: 'a', label: 'A', color: '#111', visible: true,
      events: [
        { uid: 'u1', title: 'Standup', dateISO: '2026-06-09', time: '19:00', rrule: null },
        { uid: 'u2', title: 'Sync',    dateISO: '2026-06-09', time: '19:00', rrule: null },
      ],
    }],
  };
  const f = makeApi(_calFeeds);
  assert.equal(f.getCalFeedEventsForDate('2026-06-09').length, 2, 'distinct events preserved');
});

test('getCalFeedEventsForDate: dedupes by title when UID absent', () => {
  const ev = { title: 'No-UID event', dateISO: '2026-06-09', time: '08:00', rrule: null };
  const _calFeeds = {
    feeds: [
      { id: 'a', label: 'A', color: '#111', visible: true, events: [{ ...ev }] },
      { id: 'b', label: 'B', color: '#222', visible: true, events: [{ ...ev }] },
    ],
  };
  const f = makeApi(_calFeeds);
  assert.equal(f.getCalFeedEventsForDate('2026-06-09').length, 1, 'title-based dedupe');
});
