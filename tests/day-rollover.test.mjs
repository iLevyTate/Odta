/**
 * AUDIT.md M-5 — extract day-rollover decision logic from js/app.js and
 * unit-test every branch. Day-rollover bugs (a 23:59 → 00:01 archive split,
 * a modal-mid-edit nag that fires twice, etc.) are invisible in CI without
 * direct coverage; the function used to live as 60 lines inside a 850-line
 * coordinator module with zero tests.
 *
 * `planDayRollover` is the pure piece — given current day, last known day,
 * modal state, deferral bookkeeping, and the clock, it returns the action
 * to take. _handleDayRollover (still in app.js) does the side effects.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadPlanDayRollover(){
  const src = readFileSync(join(root, 'js', 'app.js'), 'utf8');
  const region = /\/\/ region planDayRollover-test-extract\s*([\s\S]*?)\/\/ endregion planDayRollover-test-extract/;
  const m = src.match(region);
  assert.ok(m, 'app.js must contain planDayRollover test region markers');
  return new Function(`${m[1]}\nreturn planDayRollover;`)();
}

const planDayRollover = loadPlanDayRollover();
const MAX_DEFER = 30 * 60 * 1000;

test('same day: noop, clears any pending defer state', () => {
  // Even if pendingSince + nagShown were set from a prior in-progress
  // rollover, hitting same-day resets both — the decision is "we're in sync".
  const plan = planDayRollover('2026-05-21', '2026-05-21', false, 12345, true, 99999, MAX_DEFER);
  assert.equal(plan.action, 'noop');
  assert.equal(plan.nextPendingSince, 0);
  assert.equal(plan.nextNagShown, false);
});

test('first boot (lastKnown null): noop, no defer set', () => {
  const plan = planDayRollover('2026-05-21', null, false, 0, false, 1000, MAX_DEFER);
  assert.equal(plan.action, 'noop');
  assert.equal(plan.nextPendingSince, 0);
});

test('today missing (clock unavailable): noop, no defer set', () => {
  // todayKey() can return null if the date helper fails to load — the
  // safe move is to do nothing this tick.
  const plan = planDayRollover(null, '2026-05-20', false, 0, false, 1000, MAX_DEFER);
  assert.equal(plan.action, 'noop');
});

test('new day, no modal: rollover, cleared state', () => {
  const plan = planDayRollover('2026-05-22', '2026-05-21', false, 0, false, 1000, MAX_DEFER);
  assert.equal(plan.action, 'rollover');
  assert.equal(plan.nextPendingSince, 0);
  assert.equal(plan.nextNagShown, false);
});

test('new day, modal open, first tick: defer; records pendingSince=now', () => {
  const now = 1_000_000;
  const plan = planDayRollover('2026-05-22', '2026-05-21', true, 0, false, now, MAX_DEFER);
  assert.equal(plan.action, 'defer');
  assert.equal(plan.nextPendingSince, now);
  assert.equal(plan.nextNagShown, false);
});

test('new day, modal open, within defer window: defer; preserves pendingSince', () => {
  const since = 1_000_000;
  const now = since + 5 * 60 * 1000; // 5 minutes in
  const plan = planDayRollover('2026-05-22', '2026-05-21', true, since, false, now, MAX_DEFER);
  assert.equal(plan.action, 'defer');
  assert.equal(plan.nextPendingSince, since);
  assert.equal(plan.nextNagShown, false);
});

test('new day, modal open, past defer cap, nag not yet shown: nag once + record nagShown', () => {
  const since = 1_000_000;
  const now = since + MAX_DEFER + 1;
  const plan = planDayRollover('2026-05-22', '2026-05-21', true, since, false, now, MAX_DEFER);
  assert.equal(plan.action, 'nag');
  assert.equal(plan.nextPendingSince, since);
  assert.equal(plan.nextNagShown, true);
});

test('new day, modal open, past defer cap, nag already shown: defer silently — no second nag', () => {
  const since = 1_000_000;
  const now = since + MAX_DEFER + 60_000;
  const plan = planDayRollover('2026-05-22', '2026-05-21', true, since, true, now, MAX_DEFER);
  assert.equal(plan.action, 'defer');
  assert.equal(plan.nextPendingSince, since);
  assert.equal(plan.nextNagShown, true);
});

test('modal closes after defer: next tick proceeds with rollover, state cleared', () => {
  // Sequence: previous tick deferred (modal was open, pendingSince=X).
  // User closes modal; on the next interval tick, isModalOpen=false →
  // rollover, and both pendingSince + nagShown reset to defaults.
  const plan = planDayRollover('2026-05-22', '2026-05-21', false, 1_000_000, false, 2_000_000, MAX_DEFER);
  assert.equal(plan.action, 'rollover');
  assert.equal(plan.nextPendingSince, 0);
  assert.equal(plan.nextNagShown, false);
});

test('defer cap boundary: now - since exactly equal to maxDeferMs triggers nag', () => {
  // The branch uses `>=`, not `>`, so the boundary tick fires the nag.
  // Worth pinning so a future refactor doesn't accidentally weaken to `>`.
  const since = 1_000_000;
  const now = since + MAX_DEFER;
  const plan = planDayRollover('2026-05-22', '2026-05-21', true, since, false, now, MAX_DEFER);
  assert.equal(plan.action, 'nag');
});
