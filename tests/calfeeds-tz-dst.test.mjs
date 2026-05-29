/**
 * Regression: parseICSDate computed the TZID offset once, evaluated at the wall
 * time treated as UTC. Near a DST transition that guess lands on the wrong side
 * of the boundary, putting a TZID datetime an hour off. A second pass evaluates
 * the offset at the candidate instant and corrects it.
 *
 * Assertions recover the ABSOLUTE instant by round-tripping the returned
 * local {iso,time} through new Date() (local parse), so they're independent of
 * the test runner's own timezone.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'calfeeds.js'), 'utf8');

function loadDateFns() {
  const start = src.indexOf('function parseICSDate(');
  const end = src.indexOf('const CAL_FETCH_MAX_BYTES');
  assert.ok(start >= 0 && end > start, 'slice date helpers');
  return new Function('window', `${src.slice(start, end)}\n return { parseICSDate, _tzOffsetAtInstantMin, getTzOffsetMinutes };`)({});
}

// Recover the absolute UTC ms from a returned local {iso,time}.
function instantMs(r) { return new Date(`${r.iso}T${r.time}:00`).getTime(); }

test('UTC datetime parses to the exact instant', () => {
  const { parseICSDate } = loadDateFns();
  const r = parseICSDate('20260701T120000Z', false);
  assert.equal(instantMs(r), Date.UTC(2026, 6, 1, 12, 0));
});

test('summer TZID (EDT, -4) converts to the correct instant', () => {
  const { parseICSDate } = loadDateFns();
  const r = parseICSDate('20260701T120000', false, 'America/New_York');
  assert.equal(instantMs(r), Date.UTC(2026, 6, 1, 16, 0), '12:00 EDT == 16:00 UTC');
});

test('winter TZID (EST, -5) converts to the correct instant', () => {
  const { parseICSDate } = loadDateFns();
  const r = parseICSDate('20260101T120000', false, 'America/New_York');
  assert.equal(instantMs(r), Date.UTC(2026, 0, 1, 17, 0), '12:00 EST == 17:00 UTC');
});

test('a wall time just after fall-back resolves to EST, not EDT (two-pass fix)', () => {
  // 2026-11-01 05:00 in New York is unambiguously EST (-5) -> 10:00 UTC.
  // The old single-pass offset (evaluated at 05:00 treated as UTC, where NY is
  // still 01:00 EDT) returned -4 and produced 09:00 UTC — an hour early.
  const { parseICSDate } = loadDateFns();
  const r = parseICSDate('20261101T050000', false, 'America/New_York');
  assert.equal(instantMs(r), Date.UTC(2026, 10, 1, 10, 0), '05:00 EST == 10:00 UTC after the fall-back');
});

test('_tzOffsetAtInstantMin reports the offset at a real instant', () => {
  const { _tzOffsetAtInstantMin } = loadDateFns();
  assert.equal(_tzOffsetAtInstantMin('America/New_York', Date.UTC(2026, 6, 1, 12, 0)), -240, 'EDT');
  assert.equal(_tzOffsetAtInstantMin('America/New_York', Date.UTC(2026, 0, 1, 12, 0)), -300, 'EST');
  assert.equal(_tzOffsetAtInstantMin('UTC', Date.UTC(2026, 6, 1, 12, 0)), 0);
});

test('an unknown TZID falls back to floating local time (no throw)', () => {
  const { parseICSDate } = loadDateFns();
  const r = parseICSDate('20260701T120000', false, 'Not/AZone');
  assert.equal(r.time, '12:00', 'floating fallback keeps the wall time');
  assert.equal(r.iso, '2026-07-01');
});
