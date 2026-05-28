/**
 * Unit tests for _cmdkAskReasonText (js/ui.js) — maps askRun failure reasons to
 * user-facing copy. Sliced out of ui.js (which is DOM-bound) the same way the
 * ask-pipeline tests slice pure helpers, so we can exercise it under node.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadReasonText() {
  const src = readFileSync(join(root, 'js', 'ui.js'), 'utf8');
  const start = src.indexOf('function _cmdkAskReasonText(');
  const end = src.indexOf('async function cmdkAskSubmit(', start);
  assert.ok(start >= 0 && end > start, 'slice _cmdkAskReasonText from ui.js');
  const slice = src.slice(start, end);
  const mod = new Function(`${slice}\n return { _cmdkAskReasonText };`);
  return mod()._cmdkAskReasonText;
}

test('_cmdkAskReasonText: known reasons map to friendly copy', () => {
  const f = loadReasonText();
  assert.equal(f('ABORTED'), 'Stopped.');
  assert.match(f('TIMEOUT'), /Timed out/);
  assert.match(f('PARSE_FAILED'), /parse a valid plan/);
  assert.match(f('PARSE_FAILED:no_ops'), /parse a valid plan/);
});

test('_cmdkAskReasonText: internal codes never leak verbatim', () => {
  const f = loadReasonText();
  // These used to render the raw token (e.g. "SCHEMA_UNAVAILABLE") to the user.
  for (const code of ['SCHEMA_UNAVAILABLE', 'ASK_HELPERS_MISSING']) {
    const out = f(code);
    assert.ok(!out.includes(code), `must not surface raw code: ${out}`);
    assert.match(out, /warming up/i);
  }
});

test('_cmdkAskReasonText: unknown / non-string reasons get a generic message', () => {
  const f = loadReasonText();
  const generic = /Something went wrong/i;
  assert.match(f('SOME_FUTURE_CODE'), generic);
  assert.match(f(''), generic);
  assert.match(f(null), generic);
  assert.match(f(undefined), generic);
});
