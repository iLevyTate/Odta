/**
 * Regression: the calendar "+Task" buttons (agenda + month views) built
 *   data-args='${JSON.stringify([feedId, uid, dateISO])}'
 * inside a SINGLE-quoted attribute. JSON.stringify escapes " but not ', and the
 * uid comes straight from an untrusted ICS feed (only length-capped). A uid
 * containing an apostrophe terminated the attribute early, so parseArgs hit a
 * JSON.parse error, returned [], and createTaskFromCalEvent ran with no
 * feedId/uid/date — the button silently created nothing (plus stray attributes
 * were injected onto the <button>). Both sites must wrap the JSON in escAttr.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// The real escAttr from the app.
function loadEscAttr() {
  const src = readFileSync(join(root, 'js', 'utils.js'), 'utf8');
  const start = src.indexOf('function escAttr(');
  const end = src.indexOf('function stampCompletion(', start);
  assert.ok(start >= 0 && end > start, 'slice escAttr');
  return new Function(`${src.slice(start, end)}\n return escAttr;`)();
}

// Faithful mirror of parseArgs() in js/event-delegation.js (small + stable).
// A guard test below asserts the real source still matches this JSON.parse logic.
function parseArgs(el) {
  if (!el || !el.dataset) return [];
  const ds = el.dataset;
  if (ds.args) {
    try {
      const a = JSON.parse(ds.args);
      return Array.isArray(a) ? a : [a];
    } catch (e) { return []; }
  }
  if (ds.arg !== undefined) return [ds.arg];
  return [];
}

// Minimal model of how a browser decodes the HTML attribute value back into
// element.dataset.args. escAttr only ever emits these five entities.
function decodeAttr(s) {
  return s
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const escAttr = loadEscAttr();

// Reproduce exactly how ui.js builds the attribute (post-fix).
function buildArgs(feedId, uid, dateISO) {
  return escAttr(JSON.stringify([String(feedId), uid, String(dateISO || '')]));
}

test('a uid containing an apostrophe round-trips intact through the attribute', () => {
  const uid = "abc'def@evil";
  const attrVal = buildArgs('f1', uid, '2026-01-12');
  // Single-quoted attribute must not be terminated early by the apostrophe.
  assert.ok(!attrVal.includes("'"), 'escAttr must encode the apostrophe (no raw \')');
  const el = { dataset: { args: decodeAttr(attrVal) } };
  assert.deepEqual(parseArgs(el), ['f1', uid, '2026-01-12'],
    'parseArgs must recover the exact [feedId, uid, dateISO]');
});

test('the unescaped form (pre-fix) would break parseArgs', () => {
  const uid = "abc'def";
  // What the buggy code produced: raw JSON inside a single-quoted attribute.
  const raw = JSON.stringify(['f1', uid, '2026-01-12']);
  // The browser would terminate the attribute at the first apostrophe.
  const truncated = raw.slice(0, raw.indexOf("'"));
  const el = { dataset: { args: truncated } };
  assert.deepEqual(parseArgs(el), [], 'truncated JSON fails to parse → empty args');
});

test('the mirrored parseArgs logic matches the real event-delegation.js source', () => {
  const src = readFileSync(join(root, 'js', 'event-delegation.js'), 'utf8');
  assert.ok(/function parseArgs\(/.test(src), 'parseArgs still exists');
  assert.ok(/JSON\.parse\(ds\.args\)/.test(src), 'parseArgs still JSON.parses ds.args');
  assert.ok(/catch\s*\(e\)\s*\{\s*return \[\]/.test(src), 'parse failure still returns []');
});

test('both calendar "+Task" sites in ui.js wrap data-args in escAttr', () => {
  const ui = readFileSync(join(root, 'js', 'ui.js'), 'utf8');
  const matches = ui.match(/data-action="createTaskFromCalEvent" data-args='\$\{[^}]*\}'/g) || [];
  assert.equal(matches.length, 2, 'expected exactly two createTaskFromCalEvent buttons');
  for (const m of matches) {
    assert.ok(m.includes('escAttr(JSON.stringify('),
      `data-args must be escAttr-wrapped: ${m}`);
  }
});
