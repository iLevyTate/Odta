/**
 * onTaskInputKey in js/tasks.js — keyboard router for the main task input.
 *
 * The `?`-prefix entry point is one of three Ask-LLM affordances documented
 * in README (alongside Cmd/Ctrl+K and the Ask toggle chip). This file locks
 * its routing contract so future edits to onTaskInputKey can't silently
 * regress it back to creating a literal task named "? do the thing".
 *
 * The handler is a classic-script function that reaches for several globals
 * (openCmdK, addTask, applySmartAddAndSubmit, window._smartAddPreview, etc.).
 * We slice the function source out of tasks.js and run it in a fresh vm
 * context with those globals pre-bound to spies, so the test never needs a
 * DOM. This mirrors how other tests in this directory isolate browser code.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(root, 'js', 'tasks.js'), 'utf8');
const FN_START = SRC.indexOf('function onTaskInputKey(event){');
const FN_TAIL  = SRC.indexOf('\nwindow.onTaskInputKey=onTaskInputKey;', FN_START);
assert.ok(FN_START >= 0 && FN_TAIL > FN_START, 'failed to slice onTaskInputKey from tasks.js');
const FN_SRC = SRC.slice(FN_START, FN_TAIL);

function loadHandler(){
  const calls = {
    openCmdK: [],
    applySmartAddAndSubmit: 0,
    addTask: 0,
    clearLiveParsePreview: 0,
    maybeShowEnhanceBtn: 0,
  };
  const win = { _smartAddPreview: null };
  const ctx = {
    window: win,
    openCmdK: (opts) => { calls.openCmdK.push(opts); },
    applySmartAddAndSubmit: () => { calls.applySmartAddAndSubmit++; },
    addTask: () => { calls.addTask++; },
    clearLiveParsePreview: () => { calls.clearLiveParsePreview++; },
    maybeShowEnhanceBtn: () => { calls.maybeShowEnhanceBtn++; },
  };
  vm.createContext(ctx);
  vm.runInContext(`${FN_SRC}\nthis.__handler = onTaskInputKey;`, ctx);
  return { handler: ctx.__handler, calls, window: win };
}

function makeEnter(value){
  const target = { value };
  let prevented = false;
  return {
    key: 'Enter',
    isComposing: false,
    target,
    preventDefault(){ prevented = true; },
    get prevented(){ return prevented; },
    get target_(){ return target; },
  };
}

test('onTaskInputKey: `?` prefix routes to Ask with rest as prefill', () => {
  const { handler, calls, window } = loadHandler();
  const ev = makeEnter('? archive everything done last week');
  handler(ev);
  assert.equal(ev.prevented, true, 'preventDefault must fire so the literal task is not created');
  assert.equal(calls.addTask, 0, 'addTask must NOT be called when ? prefix is present');
  assert.equal(calls.applySmartAddAndSubmit, 0);
  assert.deepEqual(calls.openCmdK, [{ ask: true, prefill: 'archive everything done last week' }]);
  assert.equal(ev.target_.value, '', 'task input must be cleared after routing');
  assert.equal(window._smartAddPreview, null, 'smart-add preview must be cleared');
});

test('onTaskInputKey: bare `?` opens Ask with empty prefill', () => {
  const { handler, calls } = loadHandler();
  handler(makeEnter('?'));
  assert.deepEqual(calls.openCmdK, [{ ask: true, prefill: '' }]);
  assert.equal(calls.addTask, 0);
});

test('onTaskInputKey: leading whitespace before `?` still routes to Ask', () => {
  const { handler, calls } = loadHandler();
  handler(makeEnter('   ? help me organize'));
  assert.deepEqual(calls.openCmdK, [{ ask: true, prefill: 'help me organize' }]);
});

test('onTaskInputKey: `?` prefix takes precedence over smart-add preview', () => {
  // Without this guard, an in-flight smart-add preview would intercept Enter
  // and push the `?` query in as a literal task.
  const { handler, calls, window } = loadHandler();
  window._smartAddPreview = { name: 'pretend preview' };
  handler(makeEnter('? what do I have due this week'));
  assert.equal(calls.applySmartAddAndSubmit, 0);
  assert.equal(calls.addTask, 0);
  assert.deepEqual(calls.openCmdK, [{ ask: true, prefill: 'what do I have due this week' }]);
  assert.equal(window._smartAddPreview, null, 'preview must be cleared so it does not fire on next Enter');
});

test('onTaskInputKey: plain text + Enter falls through to addTask (no Ask routing)', () => {
  const { handler, calls } = loadHandler();
  handler(makeEnter('buy milk tomorrow'));
  assert.equal(calls.addTask, 1);
  assert.equal(calls.openCmdK.length, 0);
  assert.equal(calls.applySmartAddAndSubmit, 0);
});

test('onTaskInputKey: smart-add preview + plain text → applySmartAddAndSubmit', () => {
  const { handler, calls, window } = loadHandler();
  window._smartAddPreview = { name: 'preview' };
  handler(makeEnter('buy milk'));
  assert.equal(calls.applySmartAddAndSubmit, 1);
  assert.equal(calls.addTask, 0);
  assert.equal(calls.openCmdK.length, 0);
});

test('onTaskInputKey: `?` only counts at the start — mid-string `?` is a literal task', () => {
  const { handler, calls } = loadHandler();
  handler(makeEnter('what is this ? thing'));
  assert.equal(calls.addTask, 1);
  assert.equal(calls.openCmdK.length, 0);
});
