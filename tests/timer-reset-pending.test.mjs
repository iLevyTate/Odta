/**
 * resetAll / resetPhase in js/timer.js — pending auto-advance/auto-start
 * cancellation.
 *
 * When a phase completes with autoBreak/autoWork on, _scheduleAutoAdvance /
 * _scheduleAutoStart arm setTimeouts whose callbacks flip the phase and call
 * startTimer() unconditionally. Both reset paths must cancel those pending
 * timers, otherwise a user's explicit reset is overridden ~300ms later by an
 * auto-start (the async confirm dialog in resetAll widens that window).
 * resetPhase gained the cancellation in the #15 UX-audit fix; resetAll was
 * missed — this locks both in.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'timer.js'), 'utf8');

function fnBody(name) {
  const s = src.indexOf(`function ${name}(`);
  assert.ok(s >= 0, `found function ${name}`);
  // Slice to the next top-level function/comment banner — good enough for a
  // containment check on this file's flat structure.
  const e = src.indexOf('\nfunction ', s + 1);
  return src.slice(s, e > s ? e : undefined);
}

for (const name of ['resetAll', 'resetPhase']) {
  test(`${name}: cancels both pending auto-advance and auto-start timers`, () => {
    const body = fnBody(name);
    assert.match(body, /clearTimeout\(_pendingAdvanceTimer\)/, `${name} clears _pendingAdvanceTimer`);
    assert.match(body, /_pendingAdvanceTimer\s*=\s*null/, `${name} nulls _pendingAdvanceTimer`);
    assert.match(body, /clearTimeout\(_pendingStartTimer\)/, `${name} clears _pendingStartTimer`);
    assert.match(body, /_pendingStartTimer\s*=\s*null/, `${name} nulls _pendingStartTimer`);
  });
}

test('startTimer/resumeTimer persist state (cross-tab dirty flag)', () => {
  // saveState('user') marks the tab dirty so a cross-tab storage event merges
  // instead of wholesale-applying the other tab's snapshot over the running
  // timer (storage.js _onStorageFromOtherTab dirty branch).
  assert.match(fnBody('startTimer'), /saveState\('user'\)/);
  assert.match(fnBody('resumeTimer'), /saveState\('user'\)/);
});
