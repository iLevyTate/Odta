/**
 * Static contract guards for the quick-timer capacity + audio look-ahead
 * caps. Both were previously unbounded — a long timer with frequent chimes
 * would allocate hundreds of oscillators at once, and addQuickTimer never
 * refused, so memory grew with every tap.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const timerSrc = readFileSync(join(root, 'js', 'timer.js'), 'utf8');

test('addQuickTimer enforces QT_MAX cap', () => {
  // Cap constant must be present and addQuickTimer must reference it before
  // pushing a new timer.
  assert.match(timerSrc, /const\s+QT_MAX\s*=\s*\d+/, 'QT_MAX cap constant missing');
  const fnIdx = timerSrc.indexOf('function addQuickTimer');
  assert.ok(fnIdx > 0, 'addQuickTimer not found');
  const body = timerSrc.slice(fnIdx, fnIdx + 1500);
  assert.match(body, /QT_MAX/, 'addQuickTimer must consult QT_MAX');
  assert.match(body, /_pruneFinishedQuickTimers/, 'addQuickTimer must prune finished before refusing');
});

test('scheduleQtAudio caps interval-chime look-ahead', () => {
  // Pre-fix this loop walked qt.totalSec entirely, scheduling potentially
  // thousands of oscillators at start. Post-fix it bails at horizon.
  assert.match(timerSrc, /QT_AUDIO_HORIZON_SEC/, 'audio horizon constant missing');
  const fnIdx = timerSrc.indexOf('function scheduleQtAudio');
  assert.ok(fnIdx > 0, 'scheduleQtAudio not found');
  const body = timerSrc.slice(fnIdx, fnIdx + 2000);
  assert.match(body, /if\(d>=horizon\)break/, 'interval scheduling must break at horizon');
});

test('addQuickPreset prunes via _pruneFinishedQuickTimers at cap', () => {
  // Regression: addQuickPreset called the undefined `pruneFinishedQuickTimers`
  // (missing leading underscore), so clicking a preset button while at QT_MAX
  // threw a ReferenceError instead of pruning or refusing gracefully.
  const fnIdx = timerSrc.indexOf('function addQuickPreset');
  assert.ok(fnIdx > 0, 'addQuickPreset not found');
  const body = timerSrc.slice(fnIdx, fnIdx + 1000);
  assert.match(body, /QT_MAX/, 'addQuickPreset must consult QT_MAX');
  assert.match(body, /_pruneFinishedQuickTimers/, 'addQuickPreset must prune finished before refusing');
});

test('no call to the undefined pruneFinishedQuickTimers helper remains', () => {
  // Only the underscore-prefixed _pruneFinishedQuickTimers is defined; any bare
  // pruneFinishedQuickTimers( call is a ReferenceError waiting to happen.
  const bareCalls = timerSrc.match(/(^|[^_\w])pruneFinishedQuickTimers\s*\(/g) || [];
  assert.equal(bareCalls.length, 0, 'found a call to the undefined pruneFinishedQuickTimers: ' + JSON.stringify(bareCalls));
});

test('_pruneFinishedQuickTimers cancels audio for pruned timers', () => {
  const idx = timerSrc.indexOf('function _pruneFinishedQuickTimers');
  assert.ok(idx > 0, '_pruneFinishedQuickTimers not found');
  const body = timerSrc.slice(idx, idx + 800);
  // Without cancelQtAudio the AudioContext leaks scheduled oscillators on
  // every prune — the whole point of the helper is bounded resource use.
  assert.match(body, /cancelQtAudio/, 'pruned timers must cancel scheduled audio');
});
