/**
 * Ask entry-point gating (js/ui.js).
 *
 * Generative Ask is hidden until the user enables it in Settings. This locks
 * the contract that `cmdkSetAskMode(true)` is a no-op when the feature is off
 * (the default), so the palette can never silently enter Ask mode for a user
 * who hasn't opted in. We slice `_askEntryEnabled` + `cmdkSetAskMode` out of
 * the DOM-bound ui.js and run them in a vm context with the dependencies
 * stubbed, mirroring how the other cmdk/ask unit tests isolate browser code.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(root, 'js', 'ui.js'), 'utf8');

function slice(startMarker, endMarker){
  const start = SRC.indexOf(startMarker);
  const end = SRC.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `failed to slice ${startMarker} from ui.js`);
  return SRC.slice(start, end);
}

const GATE_SRC = slice('function _askEntryEnabled()', 'function openCmdK(');
const SETMODE_SRC = slice('function cmdkSetAskMode(on){', 'function cmdkToggleAsk');

function loadCtx({ genEnabled }){
  const calls = { applyMode: 0, render: 0, abort: 0, initApply: 0 };
  const ctx = {
    isGenEnabled: () => genEnabled,
    cmdkMode: 'find',
    _cmdkAskBusy: false,
    _cmdkAskCtl: null,
    _cmdkAskTurns: [],
    _cmdkAbortAsk: () => { calls.abort++; },
    _cmdkInitApplyModeFromCfg: () => { calls.initApply++; },
    _applyCmdkMode: () => { calls.applyMode++; },
    renderCmdK: () => { calls.render++; },
  };
  vm.createContext(ctx);
  vm.runInContext(`${GATE_SRC}\n${SETMODE_SRC}\nthis.__set = cmdkSetAskMode; this.__enabled = _askEntryEnabled;`, ctx);
  return { ctx, calls };
}

test('_askEntryEnabled reflects isGenEnabled()', () => {
  assert.equal(loadCtx({ genEnabled: true }).ctx.__enabled(), true);
  assert.equal(loadCtx({ genEnabled: false }).ctx.__enabled(), false);
});

test('cmdkSetAskMode(true) enters Ask mode when generative Ask is enabled', () => {
  const { ctx, calls } = loadCtx({ genEnabled: true });
  ctx.__set(true);
  assert.equal(ctx.cmdkMode, 'ask');
  assert.equal(calls.initApply, 1, 'apply-mode default initialised on entering Ask');
});

test('cmdkSetAskMode(true) is a no-op (stays in find) when disabled', () => {
  const { ctx, calls } = loadCtx({ genEnabled: false });
  ctx.__set(true);
  assert.equal(ctx.cmdkMode, 'find', 'must not enter Ask mode when feature is off');
  assert.equal(calls.initApply, 0, 'Ask-only init must not run when gated off');
});

test('cmdkSetAskMode(false) always leaves Ask mode regardless of gate', () => {
  const { ctx } = loadCtx({ genEnabled: false });
  ctx.cmdkMode = 'ask';
  ctx.__set(false);
  assert.equal(ctx.cmdkMode, 'find');
});
