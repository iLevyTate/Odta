/**
 * Guards the Ask "minimize to background" invariants in js/ui.js. These are
 * DOM/state-bound functions, so (like the other ui.js guards) we assert on the
 * sliced source rather than executing a full browser shim.
 *
 * The safety-critical property: minimizing must NOT abort the in-flight question
 * or bump the request token (_cmdkAskReqSeq) — otherwise the backgrounded turn
 * gets invalidated and silently dropped, defeating the whole feature. A full
 * close (Esc/backdrop when idle, or the X) MUST still abort.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'ui.js'), 'utf8');

/** Slice a top-level `function name(...){ ... }` body by brace-matching. */
function fnBody(name) {
  const sig = `function ${name}(`;
  const start = src.indexOf(sig);
  assert.ok(start >= 0, `found ${name} in ui.js`);
  const braceOpen = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(braceOpen, i + 1); }
  }
  throw new Error(`unbalanced braces slicing ${name}`);
}

test('cmdkAskMinimize keeps the in-flight turn alive (no abort, no token bump)', () => {
  const body = fnBody('cmdkAskMinimize');
  assert.ok(!body.includes('_cmdkAbortAsk'), 'minimize must not abort the run');
  assert.ok(!body.includes('_cmdkAskReqSeq++'), 'minimize must not invalidate the request token');
  assert.ok(body.includes('_cmdkAskMinimized=true') || body.includes('_cmdkAskMinimized = true'), 'minimize sets the minimized flag');
  assert.ok(body.includes("Modal.close('cmdkOverlay')"), 'minimize hides the overlay');
});

test('cmdkDismiss backgrounds a running Ask instead of closing it', () => {
  const body = fnBody('cmdkDismiss');
  assert.ok(body.includes('_cmdkAskBusy'), 'dismiss decides based on whether a question is running');
  assert.ok(body.includes('cmdkAskMinimize'), 'dismiss minimizes the running case');
  assert.ok(body.includes('closeCmdK'), 'dismiss fully closes the idle case');
});

test('closeCmdK still aborts and clears the conversation', () => {
  const body = fnBody('closeCmdK');
  assert.ok(body.includes('_cmdkAbortAsk'), 'full close aborts the run');
  assert.ok(body.includes('_cmdkAskTurns = []') || body.includes('_cmdkAskTurns=[]'), 'full close clears turns');
  assert.ok(body.includes('_cmdkAskMinimized=false') || body.includes('_cmdkAskMinimized = false'), 'full close resets minimized state');
});

test('openCmdK restores a minimized conversation instead of killing it', () => {
  const body = fnBody('openCmdK');
  assert.ok(body.includes('_cmdkAskMinimized'), 'open checks for a backgrounded conversation');
  assert.ok(body.includes('cmdkRestoreAsk'), 'open restores it');
  // The restore short-circuit must come before the abort, or reopening kills the run.
  assert.ok(body.indexOf('cmdkRestoreAsk') < body.indexOf('_cmdkAbortAsk'), 'restore precedes abort');
});

test('a backgrounded Ask surfaces a tappable finish toast', () => {
  // cmdkAskSubmit contains template literals / regex with braces, so slice it
  // by function boundaries (as cmdk-ask-reason-text does) rather than matching.
  const start = src.indexOf('async function cmdkAskSubmit(');
  const end = src.indexOf('function cmdkAskStop(', start);
  assert.ok(start >= 0 && end > start, 'slice cmdkAskSubmit from ui.js');
  const body = src.slice(start, end);
  assert.ok(body.includes('_cmdkAskMinimized'), 'submit detects the backgrounded case on finish');
  assert.ok(body.includes('showActionToast'), 'submit shows a finish toast');
  assert.ok(body.includes('cmdkRestoreAsk'), 'the toast action restores the conversation');
});
