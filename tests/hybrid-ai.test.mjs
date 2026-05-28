/**
 * Hybrid AI tests — verify the narrow contracts the embedding-plus-LLM
 * features rely on:
 *   1. Operations carry an optional `_rationale` through the validator
 *      for preview-card display, but it never leaks into executeIntelOp's
 *      mutation path (handled in ai.js; we just check the validator output
 *      shape here).
 *   2. The validator sanitises adversarial rationale payloads instead of
 *      blocking the op wholesale — an LLM giving a noisy explanation must
 *      not cost the user a valid change.
 *   3. The LLM JSON extractor in gen.js tolerates the usual pathologies
 *      (code fences, trailing prose, truncated responses) so the hybrid
 *      helpers (genRefineTaskUpdate, genBreakdownTask, …) degrade to
 *      `null` rather than crashing when weights are small/noisy.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaSrc = readFileSync(join(root, 'js', 'tool-schema.js'), 'utf8');
const genSrc = readFileSync(join(root, 'js', 'gen.js'), 'utf8');

function loadSchema() {
  const win = {};
  const fn = new Function('window', schemaSrc);
  fn(win);
  return win;
}

function loadGen(storage = {}) {
  const fakeLocalStorage = {
    getItem: (k) => (k in storage) ? storage[k] : null,
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
  };
  const win = { addEventListener: () => {}, removeEventListener: () => {} };
  const ctx = { window: win, localStorage: fakeLocalStorage, console, caches: undefined };
  const fn = new Function(...Object.keys(ctx), genSrc);
  fn(...Object.values(ctx));
  return win;
}

function ctxFrom(tasksArr, listsArr) {
  return {
    tasksById: new Map(tasksArr.map((t) => [t.id, t])),
    listsById: new Map((listsArr || []).map((l) => [l.id, l])),
  };
}

test('rationale passthrough: accepted on a valid op and stored verbatim', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 5, name: 'Ship thing', archived: false }], []);
  const r = validateOps(
    [{ name: 'UPDATE_TASK', args: { id: 5, priority: 'high' }, _rationale: 'description mentions "asap"' }],
    ctx,
  );
  assert.equal(r.valid.length, 1);
  assert.equal(r.rejected.length, 0);
  assert.equal(r.valid[0]._rationale, 'description mentions "asap"');
});

test('rationale passthrough: also accepts `rationale` (without underscore) as alias', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 5, name: 'T', archived: false }], []);
  const r = validateOps(
    [{ name: 'MARK_DONE', args: { id: 5 }, rationale: 'user said done in chat' }],
    ctx,
  );
  assert.equal(r.valid.length, 1);
  assert.equal(r.valid[0]._rationale, 'user said done in chat');
});

test('rationale passthrough: clamped at 240 chars and strips control bytes', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 5, name: 'T', archived: false }], []);
  const junk = 'ok\u0000\u0007 ' + 'x'.repeat(500);
  const r = validateOps(
    [{ name: 'MARK_DONE', args: { id: 5 }, _rationale: junk }],
    ctx,
  );
  assert.equal(r.valid.length, 1);
  assert.ok(r.valid[0]._rationale.length <= 240, 'must clamp');
  assert.ok(!/[\x00-\x08]/.test(r.valid[0]._rationale), 'must strip control bytes');
});

test('rationale passthrough: missing/empty rationale leaves the key unset (never stored)', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 5, name: 'T', archived: false }], []);
  const r1 = validateOps([{ name: 'MARK_DONE', args: { id: 5 } }], ctx);
  assert.equal(r1.valid.length, 1);
  assert.equal('_rationale' in r1.valid[0], false);

  const r2 = validateOps([{ name: 'MARK_DONE', args: { id: 5 }, _rationale: '   ' }], ctx);
  assert.equal(r2.valid.length, 1);
  assert.equal('_rationale' in r2.valid[0], false);
});

test('rationale passthrough: non-string rationale is dropped silently', () => {
  const { validateOps } = loadSchema();
  const ctx = ctxFrom([{ id: 5, name: 'T', archived: false }], []);
  const r = validateOps(
    [{ name: 'MARK_DONE', args: { id: 5 }, _rationale: { foo: 'bar' } }],
    ctx,
  );
  assert.equal(r.valid.length, 1, 'op still valid');
  assert.equal('_rationale' in r.valid[0], false, 'bad rationale dropped');
});

test('LLM json extractor: strips ```json fences and ignores trailing prose', () => {
  const win = loadGen();
  const out = win._genExtractJsonObject(
    '```json\n{"accept": {"priority": "high"}, "rationale": "asap"}\n```\n\nthat\'s it',
  );
  assert.deepEqual(out, { accept: { priority: 'high' }, rationale: 'asap' });
});

test('LLM json extractor: truncated responses return null, never throw', () => {
  const win = loadGen();
  // Tiny local models routinely cut off mid-object. Graceful null is the
  // contract our hybrid helpers (genRefineTaskUpdate etc) depend on —
  // `null` triggers fallback to embedding-only behaviour.
  assert.strictEqual(win._genExtractJsonObject('{"a": 1, "b": '), null);
  assert.strictEqual(win._genExtractJsonObject(''), null);
  assert.strictEqual(win._genExtractJsonObject('not json at all'), null);
});

test('LLM json extractor: embedded object inside chatter still parses', () => {
  const win = loadGen();
  const out = win._genExtractJsonObject('Sure! Here is the JSON: {"verdict":"same","reason":"both about taxes"} — let me know.');
  assert.deepEqual(out, { verdict: 'same', reason: 'both about taxes' });
});

test('LLM first-line extractor: trims prose (no 220 cap — that lives in _formatGenTextCallOutput)', () => {
  const win = loadGen();
  const raw = '  This is the answer.  \n\nAnd here is extra commentary we do not want.';
  assert.equal(win._genExtractFirstLine(raw), 'This is the answer.');
});

test('_formatGenTextCallOutput: caps first line at 220 chars after strip+fences', () => {
  const win = loadGen();
  const long = 'x'.repeat(400);
  const raw = '```\n' + long + '\n```';
  const out = win._formatGenTextCallOutput(raw);
  assert.ok(out);
  assert.equal(out.length, 220);
  assert.equal(out, 'x'.repeat(220));
});

test('_formatGenTextCallOutput: empty after strip yields null', () => {
  const win = loadGen();
  assert.strictEqual(win._formatGenTextCallOutput('   \n  \n'), null);
  assert.strictEqual(win._formatGenTextCallOutput(''), null);
});
