/**
 * event-delegation.js — the CSP-safe dispatcher that replaced inline onclick=.
 * The audit flagged this as completely untested despite being the boundary
 * that allowed dropping CSP 'unsafe-inline'.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'event-delegation.js'), 'utf8');

function makeEl(opts = {}) {
  const ds = opts.dataset || {};
  const tag = (opts.tag || 'BUTTON').toUpperCase();
  const el = {
    tagName: tag,
    dataset: ds,
    contains: (other) => other === el,
    closest(sel){
      if(sel === '[data-action]') return ds.action ? el : null;
      if(sel === '[role="button"][data-action]') return (opts.role === 'button' && ds.action) ? el : null;
      if(sel === 'input, textarea, select, button, [contenteditable="true"]'){
        return (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') ? el : null;
      }
      return null;
    },
    click(){ this._clicked = true; },
  };
  return el;
}

function loadDispatcher(){
  const handlers = { click: [], keydown: [] };
  const fakeDoc = {
    addEventListener(type, fn){ (handlers[type] = handlers[type] || []).push(fn); },
  };
  const fakeWin = { ODTAULAI_DELEGATION_READY: false };
  // Evaluate the IIFE source with our fakes bound. We pass fakeWin both as
  // the named parameter and as `this` so any bare `window.X` lookup inside
  // the source resolves to the same object.
  const fn = new Function('document', 'window', src);
  fn.call(fakeWin, fakeDoc, fakeWin);
  return { handlers, win: fakeWin };
}

test('event-delegation: click dispatches to window[data-action] with parsed args', () => {
  const { handlers, win } = loadDispatcher();
  let received = null;
  win.testHandler = function(...args){ received = args; };
  const el = makeEl({ dataset: { action: 'testHandler', args: '["hello", 42]' } });
  handlers.click[0]({ target: el });
  assert.ok(received, 'handler must have been invoked');
  assert.strictEqual(received[0], 'hello');
  assert.strictEqual(received[1], 42);
  // Event is passed as the LAST argument so handlers can opt in.
  assert.ok(received[2] && received[2].target === el, 'event passed as final arg');
});

test('event-delegation: malformed data-args JSON is silently dropped to []', () => {
  const { handlers, win } = loadDispatcher();
  let received = null;
  win.argsHandler = function(...args){ received = args; };
  const el = makeEl({ dataset: { action: 'argsHandler', args: '{this is not json' } });
  handlers.click[0]({ target: el });
  assert.ok(received, 'handler must still be invoked despite bad JSON');
  assert.strictEqual(received.length, 1, 'only the event arg remains');
});

test('event-delegation: data-arg (single) takes precedence when data-args is absent', () => {
  const { handlers, win } = loadDispatcher();
  let received = null;
  win.singleArgHandler = function(...args){ received = args; };
  const el = makeEl({ dataset: { action: 'singleArgHandler', arg: '7' } });
  handlers.click[0]({ target: el });
  assert.strictEqual(received[0], '7');
});

test('event-delegation: missing window[data-action] is a silent no-op', () => {
  const { handlers } = loadDispatcher();
  const el = makeEl({ dataset: { action: 'definitelyNotDefined_' + Math.random() } });
  handlers.click[0]({ target: el });
});

test('event-delegation: keyboard Enter on role=button non-button synthesizes click', () => {
  const { handlers, win } = loadDispatcher();
  win.kbHandler = function(){};
  const el = makeEl({ tag: 'DIV', role: 'button', dataset: { action: 'kbHandler' } });
  let prevented = false;
  // Two keydown handlers register: the generic data-onkeydown family and the
  // role=button activation handler. Fire both so the test exercises whichever
  // is responsible.
  for(const h of handlers.keydown){
    h({ key: 'Enter', target: el, preventDefault(){ prevented = true; } });
  }
  assert.strictEqual(prevented, true);
  assert.strictEqual(el._clicked, true);
});

test('event-delegation: Enter on a real <button> is NOT re-synthesised', () => {
  const { handlers } = loadDispatcher();
  const el = makeEl({ tag: 'BUTTON', role: 'button', dataset: { action: 'noop' } });
  for(const h of handlers.keydown){
    h({ key: 'Enter', target: el, preventDefault(){} });
  }
  assert.notStrictEqual(el._clicked, true);
});

test('event-delegation: a thrown handler is caught and logged, not propagated', () => {
  const { handlers, win } = loadDispatcher();
  const origErr = console.error;
  let logged = false;
  console.error = () => { logged = true; };
  try {
    win.boomHandler = function(){ throw new Error('boom'); };
    const el = makeEl({ dataset: { action: 'boomHandler' } });
    handlers.click[0]({ target: el });
    assert.strictEqual(logged, true);
  } finally {
    console.error = origErr;
  }
});

test('event-delegation: ODTAULAI_DELEGATION_READY flag is set', () => {
  const { win } = loadDispatcher();
  assert.strictEqual(win.ODTAULAI_DELEGATION_READY, true);
});

test('event-delegation: non-bubbling events (toggle/focus/blur) register in capture phase', () => {
  // focus/blur/toggle never reach document in the bubble phase — a
  // bubble-phase delegated listener for them would silently never fire.
  const byType = {};
  const fakeDoc = {
    addEventListener(type, fn, opts){ (byType[type] = byType[type] || []).push(!!opts); },
  };
  const fakeWin = { ODTAULAI_DELEGATION_READY: false };
  new Function('document', 'window', src).call(fakeWin, fakeDoc, fakeWin);
  for (const type of ['toggle', 'focus', 'blur']) {
    assert.ok(byType[type] && byType[type].some(Boolean), `${type} listener uses capture phase`);
  }
  for (const type of ['change', 'input', 'submit']) {
    assert.ok(byType[type] && byType[type].every(c => !c), `${type} listener stays bubble-phase`);
  }
});
