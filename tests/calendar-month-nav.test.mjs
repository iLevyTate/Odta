/**
 * calNav from the un-navigated state (calMonth === null) anchored on today's
 * full date, so setMonth(±1) on the 29th–31st overflowed a shorter neighbour:
 * Jan 31 → "Feb 31" → March skipped February; Mar 31 → "Feb 31" → March again
 * (the previous-month button did nothing). The anchor is now the 1st.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'ui.js'), 'utf8');

function slice(from, to) {
  const s = src.indexOf(from);
  const e = src.indexOf(to, s);
  assert.ok(s >= 0 && e > s, `slice ${from}..${to}`);
  return src.slice(s, e);
}

function load(nowIso) {
  const nowMs = new Date(nowIso).getTime();
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(nowMs); }
    static now() { return nowMs; }
  }
  const sandbox = { Date: FakeDate, String, Number, calMonth: null, renderTaskList() {}, todayISO: () => nowIso.slice(0, 10) };
  vm.createContext(sandbox);
  vm.runInContext(
    'let calMonth=null;\n' + slice('function _calMonthAnchor(', 'function setCalMode(') +
    slice('function calNav(', 'function calToday(') +
    '\nthis.nav=(d)=>{calNav(d);return calMonth;}; this.setMonth=(m)=>{calMonth=m;};',
    sandbox,
  );
  return sandbox;
}

test('next month from Jan 31 lands on February', () => {
  const s = load('2026-01-31T12:00:00');
  assert.strictEqual(s.nav(1), '2026-02');
});

test('previous month from Mar 31 lands on February', () => {
  const s = load('2026-03-31T12:00:00');
  assert.strictEqual(s.nav(-1), '2026-02');
});

test('navigation from an explicit month is unaffected', () => {
  const s = load('2026-03-31T12:00:00');
  s.setMonth('2026-12');
  assert.strictEqual(s.nav(1), '2027-01');
});
