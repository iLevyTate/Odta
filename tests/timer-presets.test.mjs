/**
 * PHASE_PRESETS table + getPS / getPL in js/timer.js.
 *
 * Sanity test for the preset table: every entry must have valid work/short/
 * long/cycle/label fields, so a typo when adding a new preset is caught at
 * test time (not when a user picks a preset and the timer breaks silently).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'timer.js'), 'utf8');

function loadPresets() {
  const s = src.indexOf('const PHASE_PRESETS');
  const e = src.indexOf('function applyPhasePreset', s);
  assert.ok(s >= 0 && e > s, 'slice PHASE_PRESETS');
  return new Function(`${src.slice(s, e)}\nreturn PHASE_PRESETS;`)();
}

function loadGetPS(cfg) {
  const s = src.indexOf('function getPS(p)');
  const e = src.indexOf('\nfunction getPC(', s);
  assert.ok(s >= 0 && e > s, 'slice getPS');
  return new Function('cfg', `${src.slice(s, e)}\nreturn getPS;`)(cfg);
}

function loadGetPL() {
  const s = src.indexOf('function getPL(p)');
  const e = src.indexOf('\nfunction switchPhase', s);
  assert.ok(s >= 0 && e > s, 'slice getPL');
  return new Function(`${src.slice(s, e)}\nreturn getPL;`)();
}

test('PHASE_PRESETS: every entry has valid work/short/long/cycle/label fields', () => {
  const presets = loadPresets();
  const keys = Object.keys(presets);
  assert.ok(keys.length >= 5, 'expected at least 5 presets');
  for (const [key, p] of Object.entries(presets)) {
    assert.equal(typeof p.work,  'number', `${key}.work`);
    assert.equal(typeof p.short, 'number', `${key}.short`);
    assert.equal(typeof p.long,  'number', `${key}.long`);
    assert.equal(typeof p.cycle, 'number', `${key}.cycle`);
    assert.equal(typeof p.label, 'string', `${key}.label`);
    assert.ok(p.work > 0,  `${key}.work positive`);
    assert.ok(p.short > 0, `${key}.short positive`);
    assert.ok(p.long > 0,  `${key}.long positive`);
    assert.ok(p.cycle >= 1, `${key}.cycle >=1`);
    assert.ok(p.label.length > 0, `${key}.label non-empty`);
  }
});

test('PHASE_PRESETS: contains the canonical "classic" preset (25/5)', () => {
  const presets = loadPresets();
  assert.ok(presets.classic, 'classic preset exists');
  assert.equal(presets.classic.work, 25);
  assert.equal(presets.classic.short, 5);
});

test('getPS: returns seconds for each phase based on cfg', () => {
  const getPS = loadGetPS({ work: 25, short: 5, long: 15 });
  assert.equal(getPS('work'),  25 * 60);
  assert.equal(getPS('short'), 5 * 60);
  assert.equal(getPS('long'),  15 * 60);
});

test('getPS: unknown phase falls through to long branch (locked-in contract)', () => {
  // Source: phase==='work' ? work*60 : phase==='short' ? short*60 : long*60
  // Anything not 'work'/'short' returns long*60. If you change this,
  // update the test; until then this is the contract.
  const getPS = loadGetPS({ work: 25, short: 5, long: 15 });
  assert.equal(getPS('break'),    15 * 60);
  assert.equal(getPS(undefined),  15 * 60);
  assert.equal(getPS(''),         15 * 60);
});

test('getPL: human-readable phase labels', () => {
  const getPL = loadGetPL();
  assert.equal(getPL('work'),  'Focus');
  assert.equal(getPL('short'), 'Short Break');
  assert.equal(getPL('long'),  'Long Break');
  // Same fall-through as getPS: unknowns get the "long" label
  assert.equal(getPL('mystery'), 'Long Break');
});

test('pauseTimer clears the pomodoro tick interval (no leak while paused)', () => {
  // Regression: pauseTimer only set running=false; the 250ms setInterval kept
  // firing for the whole pause (battery drain + background-throttle weirdness).
  const s = src.indexOf('function pauseTimer');
  const e = src.indexOf('\nfunction resumeTimer', s);
  assert.ok(s >= 0 && e > s, 'slice pauseTimer');
  const body = src.slice(s, e);
  assert.match(body, /clearInterval\(tickId\)/, 'pauseTimer must clearInterval(tickId)');
});

test('stopwatch pause branch clears swTickId (no leak while paused)', () => {
  // Regression: the swToggle pause branch left swTickId running indefinitely.
  const s = src.indexOf('function swToggle');
  const e = src.indexOf('\nfunction swTick', s);
  assert.ok(s >= 0 && e > s, 'slice swToggle');
  const body = src.slice(s, e);
  const pauseBranch = body.slice(0, body.indexOf('}else{'));
  assert.match(pauseBranch, /clearInterval\(swTickId\)/, 'swToggle pause branch must clearInterval(swTickId)');
});
