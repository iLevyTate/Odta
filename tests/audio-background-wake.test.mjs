/**
 * Background audio + wake reconciliation (js/audio.js, js/timer.js).
 *
 * The reported symptom: chimes and completion notifications stop once the
 * app is backgrounded / the screen locks. Two root causes, both pinned here:
 *
 *  1. The keepalive oscillator ran at 0.0001 gain (≈ -80 dBFS). Chrome only
 *     treats a tab as "playing audio" above -72.25 dBFS (amplitude 1/4096),
 *     so the tab was classified silent — no media session, normal background
 *     throttling / freezing, AudioContext suspended on screen-lock.
 *  2. On wake, pre-scheduled Web Audio chimes whose clock had stalled were
 *     assumed to have played (the `audioScheduled` guard), so the completion
 *     chime never sounded and the stale nodes fired late instead.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const audioSrc = readFileSync(join(root, 'js', 'audio.js'), 'utf8');
const timerSrc = readFileSync(join(root, 'js', 'timer.js'), 'utf8');

const CHROME_SILENCE_AMPLITUDE = 1 / 4096; // -72.25 dBFS

test('keepalive gain sits above Chrome\'s silence threshold and stays inaudible in practice', () => {
  const m = audioSrc.match(/const KEEPALIVE_GAIN\s*=\s*([0-9.]+)/);
  assert.ok(m, 'KEEPALIVE_GAIN constant must exist');
  const gain = parseFloat(m[1]);
  const rmsDb = 20 * Math.log10(gain / Math.SQRT2);
  assert.ok(rmsDb > -72.25 + 6, `keepalive must clear -72.25 dBFS with margin, got ${rmsDb.toFixed(1)} dBFS`);
  assert.ok(gain > CHROME_SILENCE_AMPLITUDE * 4, 'amplitude must be comfortably above 1/4096');
  assert.ok(gain <= 0.01, 'keepalive must remain far below audible levels');
  const f = audioSrc.match(/const KEEPALIVE_FREQ_HZ\s*=\s*([0-9.]+)/);
  assert.ok(f && parseFloat(f[1]) <= 25, 'keepalive tone must stay sub-audible (≤ 25 Hz)');
  assert.match(audioSrc, /_keepaliveGain\.gain\.value\s*=\s*KEEPALIVE_GAIN/);
});

/** Load the audio-clock block with a fake AudioContext + controllable clocks. */
function loadClockBlock() {
  const s = audioSrc.indexOf('let _audioClockRef=null;');
  const e = audioSrc.indexOf('if(typeof window!==\'undefined\'){ window.audioClockStalledSec');
  assert.ok(s >= 0 && e > s, 'slice audio clock block');
  const block = audioSrc.slice(s, e);
  const state = { wallMs: 1_000_000, audioSec: 100 };
  const fakeCtx = { get currentTime() { return state.audioSec; } };
  const fn = new Function('_audioCtx', 'Date',
    block + '\nreturn { mark: _markAudioClock, stalled: audioClockStalledSec, lost: scheduledAudioLost };');
  const api = fn(fakeCtx, { now: () => state.wallMs });
  return { api, state };
}

test('audioClockStalledSec: 0 while the audio clock keeps pace with wall time', () => {
  const { api, state } = loadClockBlock();
  api.mark();
  state.wallMs += 600_000; state.audioSec += 600;
  assert.equal(api.stalled(), 0);
  assert.equal(api.lost(), false);
});

test('audioClockStalledSec: reports the gap when the AudioContext was suspended while hidden', () => {
  const { api, state } = loadClockBlock();
  api.mark();
  state.wallMs += 600_000; state.audioSec += 5; // clock froze ~10 min in
  assert.ok(Math.abs(api.stalled() - 595) < 0.001, 'stall = wall - audio');
  assert.equal(api.lost(), true);
});

test('audioClockStalledSec: no mark → 0 (never spuriously replays chimes)', () => {
  const { api, state } = loadClockBlock();
  state.wallMs += 999_999;
  assert.equal(api.stalled(), 0);
  assert.equal(api.lost(), false);
});

test('visibilitychange: marks the clock on hide, measures before resume on show, and passes the stall to the timer reconcile', () => {
  const handler = audioSrc.slice(audioSrc.indexOf("document.addEventListener('visibilitychange',()=>{"), audioSrc.indexOf('// ========== WORKER-BASED BACKGROUND TICK'));
  const hidden = handler.slice(0, handler.indexOf('}else{'));
  const shown = handler.slice(handler.indexOf('}else{'));
  assert.match(hidden, /_markAudioClock\(\)/);
  const measure = shown.indexOf('audioClockStalledSec()');
  const resume = shown.indexOf('.resume()');
  assert.ok(measure >= 0 && resume > measure, 'stall must be measured BEFORE resume() restarts the clock');
  assert.match(shown, /_reconcileTimerAfterWake\(\{audioStalledSec:stalledSec\}\)/);
});

/** Run _reconcileTimerAfterWake with stubbed timer globals and record what it does. */
function runReconcile({ stalledSec, running = false, quick = [], swRunning = false, sound = true }) {
  const s = timerSrc.indexOf('function _audioLost()');
  const e = timerSrc.indexOf('window._reconcileTimerAfterWake=_reconcileTimerAfterWake;');
  assert.ok(s >= 0 && e > s, 'slice reconcile block');
  const block = timerSrc.slice(s, e);
  const log = [];
  const names = {
    scheduledAudioLost: () => stalledSec > 1.5,
    cancelScheduledAudio: () => log.push('cancelPomo'),
    cancelSwIntervalChimes: () => log.push('cancelSw'),
    cancelQtAudio: (qt) => log.push('cancelQt:' + qt.id),
    tick: () => log.push('tick'),
    _bgQuickTick: () => log.push('quickTick'),
    ensureQuickTick: () => log.push('ensureQuickTick'),
    swTick: () => log.push('swTick'),
    schedulePhaseAudio: () => log.push('schedulePomo'),
    scheduleQtAudio: (qt) => log.push('scheduleQt:' + qt.id),
    scheduleSwIntervalChimes: () => log.push('scheduleSw'),
    renderQuickTimers: () => log.push('render'),
    running, quickTimers: quick, swRunning, swElapsed: 0, intervals: [], swFireCounts: {}, swScheduledIntervalNodes: [],
    cfg: { sound },
    document: { hidden: false },
  };
  new Function(...Object.keys(names), block + '\n_reconcileTimerAfterWake({audioStalledSec:' + stalledSec + '});')(...Object.values(names));
  return log;
}

test('_reconcileTimerAfterWake: no stall → just catch-up ticks, scheduled audio left alone', () => {
  const log = runReconcile({ stalledSec: 0, running: true, quick: [{ id: 1, running: true }], swRunning: true });
  assert.deepEqual(log, ['tick', 'quickTick', 'ensureQuickTick', 'swTick', 'render']);
});

test('_reconcileTimerAfterWake: stalled clock → cancel stale nodes, tick (plays overdue chimes), then reschedule what still runs', () => {
  const log = runReconcile({ stalledSec: 600, running: true, quick: [{ id: 1, running: true }, { id: 2, running: false }], swRunning: true });
  const idx = (k) => log.indexOf(k);
  for (const k of ['cancelPomo', 'cancelSw', 'cancelQt:1', 'cancelQt:2', 'tick', 'quickTick', 'swTick', 'schedulePomo', 'scheduleQt:1', 'scheduleSw']) {
    assert.ok(idx(k) >= 0, 'expected ' + k + ' in ' + log.join(','));
  }
  assert.ok(!log.includes('scheduleQt:2'), 'paused quick timers are not rescheduled');
  assert.ok(idx('cancelPomo') < idx('tick') && idx('tick') < idx('schedulePomo'), 'cancel → tick → reschedule order');
  assert.ok(idx('cancelQt:1') < idx('quickTick') && idx('quickTick') < idx('scheduleQt:1'));
});

test('_reconcileTimerAfterWake: stalled but sound off → cancels stale nodes, reschedules nothing', () => {
  const log = runReconcile({ stalledSec: 600, running: true, sound: false });
  assert.ok(log.includes('cancelPomo') && log.includes('tick'));
  assert.ok(!log.includes('schedulePomo'));
});

test('completion + interval chime guards honour a lost audio clock', () => {
  // Every "scheduled audio already covered this" short-circuit must also
  // consult _audioLost(), otherwise a phase that ends while the context is
  // suspended completes silently.
  assert.match(timerSrc, /if\(cfg\.sound&&\(!audioScheduled\|\|_audioLost\(\)\)\)\(phase==='work'\?playTransition:playBreakEnd\)\(\)/);
  assert.match(timerSrc, /if\(cfg\.sound&&\(!audioScheduled\|\|_audioLost\(\)\)\)playChime\(iv\.chime\)/);
  assert.equal((timerSrc.match(/\(!qt\._audioScheduled\|\|_audioLost\(\)\)/g) || []).length, 4, 'both quick-tick paths × (interval + completion)');
  assert.match(timerSrc, /swScheduledIntervalNodes\.length===0\|\|_audioLost\(\)/);
  assert.ok(!/if\(cfg\.sound&&!audioScheduled\)/.test(timerSrc), 'no unguarded audioScheduled short-circuit may remain');
  assert.ok(!/if\(cfg\.sound&&!qt\._audioScheduled\)/.test(timerSrc));
});
