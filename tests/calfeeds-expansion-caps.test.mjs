/**
 * Regression: bounded work per calendar feed (js/calfeeds.js).
 *
 * Measured against the real parser before the fix:
 *  - RRULE INTERVAL=0 was taken literally, re-emitting one date for every
 *    maxIter iteration.
 *  - BYDAY=MO,MO,…×100k (300 KB) was walked in full for every week of the
 *    window: 5.8 s and 1.4 GB heap for a single event.
 *  - maxIter capped per event only: 10k one-line FREQ=DAILY VEVENTs (580 KB)
 *    became 3.6M occurrence rows (563 MB heap, 4.4 s), after which
 *    _saveCalFeeds' JSON.stringify threw "Invalid string length".
 *  - Every occurrence copied the event's full EXDATE list and DESCRIPTION, so
 *    a 200k-EXDATE or 1.9 MB-DESCRIPTION daily rule could not be persisted.
 * Caps must truncate deterministically (earliest rows kept) and say so via
 * the feed's status line (feed.warning; feed.error is reserved for failures).
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(root, 'js', 'calfeeds.js'), 'utf8');
const FEEDS_KEY = 'stupind_calfeeds';

// Run the whole file in a sandbox; `subs` rewrites top-level constants so the
// merge logic can be exercised with small caps.
function load(subs = {}) {
  let code = SRC;
  for (const [k, v] of Object.entries(subs)) {
    const re = new RegExp(`const ${k} = [^;]+;`);
    assert.ok(re.test(code), `constant ${k} must exist`);
    code = code.replace(re, `const ${k} = ${v};`);
  }
  const store = new Map();
  const ctx = {
    console, Intl, URL, TextDecoder, TextEncoder, AbortController, setTimeout, clearTimeout,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
    },
    location: { protocol: 'https:', href: 'https://example.com/' },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return { ctx, store, get: (expr) => vm.runInContext(expr, ctx) };
}

const plain = (x) => JSON.parse(JSON.stringify(x)); // strip sandbox prototypes
const ymd = (d) => d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
const isoOf = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const dayOffset = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
const ics = (body) => 'BEGIN:VCALENDAR\n' + body + 'END:VCALENDAR\n';
const vevent = (lines) => 'BEGIN:VEVENT\n' + lines.join('\n') + '\nEND:VEVENT\n';

async function syncContent(h, content) {
  const feed = h.ctx.addCalFeed({ label: 'T', content });
  const t0 = performance.now();
  const r = await h.ctx.syncCalFeed(feed.id);
  const ms = performance.now() - t0;
  const stored = h.ctx._loadCalFeeds().feeds.find((f) => f.id === feed.id);
  return { r: plain(r), ms, feed: stored };
}

test('INTERVAL=0 / junk INTERVAL is treated as 1 instead of re-emitting one date', () => {
  const h = load();
  const start = dayOffset(1);
  const want = [0, 1, 2, 3, 4].map((n) => isoOf(dayOffset(1 + n)));
  for (const iv of ['0', '-3', 'abc']) {
    const ev = { uid: 'i', title: 'I', dateISO: isoOf(start), allDay: true, exdateList: [],
      rrule: `FREQ=DAILY;INTERVAL=${iv};COUNT=5` };
    const out = plain(h.ctx.expandEventToDateRange(ev, 180)).map((o) => o.dateISO);
    assert.deepEqual(out, want, `INTERVAL=${iv} must step one day at a time`);
  }
});

test('BYDAY with 100k duplicate tokens completes fast and equals the deduped rule', () => {
  const h = load();
  const base = { uid: 'b', title: 'B', dateISO: isoOf(dayOffset(-170)), allDay: true, exdateList: [] };
  const t0 = performance.now();
  const huge = plain(h.ctx.expandEventToDateRange(
    { ...base, rrule: 'FREQ=WEEKLY;BYDAY=' + Array(100000).fill('MO').join(',') }, 180));
  const ms = performance.now() - t0;
  const single = plain(h.ctx.expandEventToDateRange({ ...base, rrule: 'FREQ=WEEKLY;BYDAY=MO' }, 180));
  assert.ok(ms < 1000, `100k-token BYDAY took ${ms.toFixed(0)} ms`);
  assert.deepEqual(huge.map((o) => o.dateISO), single.map((o) => o.dateISO));
  assert.ok(single.length > 40 && single.length < 60, 'about one Monday per week of the window');
});

test('BYDAY dedupe keeps a distinct day listed after many duplicates', () => {
  const h = load();
  const ev = { uid: 'b2', title: 'B2', dateISO: isoOf(dayOffset(-60)), allDay: true, exdateList: [],
    rrule: 'FREQ=WEEKLY;BYDAY=' + Array(1000).fill('MO').join(',') + ',TU' };
  const dows = new Set(plain(h.ctx.expandEventToDateRange(ev, 180))
    .map((o) => new Date(o.dateISO + 'T12:00:00').getDay()));
  assert.deepEqual([...dows].sort(), [1, 2], 'both Monday and Tuesday survive');
});

test('10k one-line FREQ=DAILY VEVENTs: fast, capped, persisted, flagged', async () => {
  const h = load();
  const caps = plain(h.get('({ ev: CAL_FEED_MAX_EVENTS, occ: CAL_FEED_MAX_OCCURRENCES })'));
  const line = vevent([`DTSTART;VALUE=DATE:${ymd(dayOffset(-179))}`, 'RRULE:FREQ=DAILY']);
  const { r, ms, feed } = await syncContent(h, ics(line.repeat(10000)));
  assert.ok(ms < 2000, `sync took ${ms.toFixed(0)} ms`);
  assert.equal(r.count, caps.occ);
  assert.equal(r.truncated, true);
  assert.equal(feed.events.length, caps.occ);
  assert.match(feed.warning, /too large/i, 'truncation surfaces on the feed status line');
  assert.equal(feed.error, null, 'a capped feed still synced: warning, not the stale-sync error');
  // Earliest kept: rows are date-sorted and the cutoff is the 5th day (5000
  // events × 4 days = 20000 rows), so nothing later than that survives.
  const dates = feed.events.map((e) => e.dateISO);
  assert.deepEqual(dates, [...dates].sort(), 'kept rows are in date order');
  assert.equal(dates[0], isoOf(dayOffset(-179)));
  assert.equal(dates[dates.length - 1], isoOf(dayOffset(-176)));
  // The save no longer throws: the rows really reached localStorage.
  const saved = JSON.parse(h.store.get(FEEDS_KEY));
  assert.equal(saved.feeds[0].events.length, caps.occ);
});

test('VEVENT cap keeps the first N in file order and flags the feed', async () => {
  const h = load();
  const cap = h.get('CAL_FEED_MAX_EVENTS');
  const body = Array.from({ length: cap + 25 }, (_, i) =>
    vevent([`UID:u${i}`, `DTSTART;VALUE=DATE:${ymd(dayOffset(-(i % 100)))}`])).join('');
  const { r, feed } = await syncContent(h, ics(body));
  assert.equal(r.count, cap);
  assert.equal(r.truncated, true);
  assert.match(feed.warning, new RegExp(`first ${cap} events`));
  const uids = new Set(feed.events.map((e) => e.uid));
  assert.ok(uids.has('u0') && uids.has(`u${cap - 1}`) && !uids.has(`u${cap}`), 'first N in file order');
});

test('under the caps: feed order is untouched and no error is recorded', async () => {
  const h = load();
  const body = vevent(['UID:late', `DTSTART;VALUE=DATE:${ymd(dayOffset(30))}`])
    + vevent(['UID:early', `DTSTART;VALUE=DATE:${ymd(dayOffset(-30))}`]);
  const { r, feed } = await syncContent(h, ics(body));
  assert.equal(r.truncated, false);
  assert.equal(feed.error, null);
  assert.equal(feed.warning, null);
  assert.deepEqual(feed.events.map((e) => e.uid), ['late', 'early']);
});

test('occurrence cap keeps the earliest (date, time) rows, ties in feed order, for any VEVENT order', async () => {
  const MAX = 10;
  const D = (n) => ymd(dayOffset(-100 + n));
  const evs = [
    vevent(['UID:daily5', `DTSTART;VALUE=DATE:${D(5)}`, 'RRULE:FREQ=DAILY']),
    vevent(['UID:weekly', `DTSTART;VALUE=DATE:${D(0)}`, 'RRULE:FREQ=WEEKLY']),
    vevent(['UID:timed9', `DTSTART:${D(2)}T090000`]),
    vevent(['UID:allday', `DTSTART;VALUE=DATE:${D(2)}`]),
    vevent(['UID:every3', `DTSTART;VALUE=DATE:${D(0)}`, 'RRULE:FREQ=DAILY;INTERVAL=3']),
    vevent(['UID:timed8', `DTSTART:${D(1)}T080000`, 'RRULE:FREQ=DAILY']),
  ];
  const orders = [[0, 1, 2, 3, 4, 5], [5, 4, 3, 2, 1, 0], [2, 0, 5, 3, 1, 4]];
  const rowKey = (o) => `${o.uid}|${o.dateISO}|${o.time || ''}`;
  for (const order of orders) {
    const text = ics(order.map((i) => evs[i]).join(''));
    // Reference: expand everything with no cap, stable-sort, take the first MAX.
    const ref = load();
    const all = [];
    for (const e of plain(ref.ctx.parseICS(text))) all.push(...plain(ref.ctx.expandEventToDateRange(e, 180)));
    const k = (o) => (o.dateISO || '') + ' ' + (o.time || '');
    const want = all.slice().sort((a, b) => (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0)).slice(0, MAX);
    assert.ok(all.length > 2 * MAX, 'fixture must overflow the cap (and the 2x trim buffer)');

    const h = load({ CAL_FEED_MAX_OCCURRENCES: MAX });
    const { r, feed } = await syncContent(h, text);
    assert.equal(r.truncated, true);
    assert.deepEqual(feed.events.map(rowKey), want.map(rowKey), `order ${order.join(',')}`);
  }
});

test('200k-EXDATE daily rule: fast, persisted, each row carries only its own EXDATEs', async () => {
  const h = load();
  const start = dayOffset(-179);
  const inWindow = isoOf(dayOffset(-170));
  const ex = Array.from({ length: 200000 }, (_, i) => String(19000101 + i));
  ex.push(ymd(dayOffset(-170)));
  const text = ics(vevent([`DTSTART;VALUE=DATE:${ymd(start)}`, `DTEND;VALUE=DATE:${ymd(dayOffset(-177))}`,
    'RRULE:FREQ=DAILY', 'EXDATE;VALUE=DATE:' + ex.join(',')]));
  const { ms, feed } = await syncContent(h, text);
  assert.ok(ms < 2000, `sync took ${ms.toFixed(0)} ms`);
  assert.ok(feed.events.length > 300);
  assert.ok(!feed.events.some((e) => e.dateISO === inWindow), 'EXDATE still cancels its occurrence');
  // 2-day all-day rows: the day-before row keeps the EXDATE (it covers that
  // day), rows elsewhere carry none, so the list is not copied 360 times.
  const before = feed.events.find((e) => e.dateISO === isoOf(dayOffset(-171)));
  assert.deepEqual(before.exdateList, [inWindow]);
  assert.ok(feed.events.every((e) => e.exdateList.length <= 1));
  assert.ok(JSON.parse(h.store.get(FEEDS_KEY)).feeds[0].events.length === feed.events.length, 'persisted');
  // Query semantics unchanged: the multi-day row does not show on the EXDATE day.
  const onEx = plain(h.ctx.getCalFeedEventsForDate(inWindow));
  assert.equal(onEx.length, 0);
});

test('1.9 MB DESCRIPTION on a daily rule is capped so the sync persists', async () => {
  const h = load();
  const text = ics(vevent([`DTSTART;VALUE=DATE:${ymd(dayOffset(-179))}`, 'RRULE:FREQ=DAILY',
    'DESCRIPTION:' + 'x'.repeat(1_900_000)]));
  const { ms, feed } = await syncContent(h, text);
  assert.ok(ms < 2000, `sync took ${ms.toFixed(0)} ms`);
  assert.ok(feed.events.length > 300);
  assert.equal(feed.events[0].description.length, 8000);
  assert.equal(JSON.parse(h.store.get(FEEDS_KEY)).feeds[0].events.length, feed.events.length, 'persisted');
});

test('50k EXDATE;TZID values parse in bounded time (Intl formatter cached)', async () => {
  const h = load();
  const vals = Array.from({ length: 50000 }, () => '20200101T120000').join(',');
  const text = ics(vevent([`DTSTART;VALUE=DATE:${ymd(dayOffset(-10))}`, 'RRULE:FREQ=DAILY;COUNT=3',
    'EXDATE;TZID=America/New_York:' + vals]));
  const { ms, feed } = await syncContent(h, text);
  assert.ok(ms < 3000, `sync took ${ms.toFixed(0)} ms (100k took ~13 s before)`);
  assert.equal(feed.events.length, 3);
});
