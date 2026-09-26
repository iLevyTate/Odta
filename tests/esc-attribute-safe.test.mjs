/**
 * esc() must escape quotes, not just & < >.
 *
 * The old textContent→innerHTML implementation never encoded `"` (browsers
 * only escape quotes when serialising attributes, not text nodes), yet several
 * call sites used esc() inside title="…" / value="…". A calendar-feed SUMMARY
 * or a synced list name containing `"` could close the attribute and inject
 * data-action / data-onfocus attributes the delegation dispatcher runs.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'utils.js'), 'utf8');

function loadEsc() {
  const s = src.indexOf('function esc(');
  const e = src.indexOf('/** Escape for HTML double-quoted attributes', s);
  assert.ok(s >= 0 && e > s, 'esc() sliced');
  return new Function(`${src.slice(s, e)}\nreturn esc;`)();
}

test('esc escapes the five HTML-significant characters', () => {
  const esc = loadEsc();
  assert.strictEqual(esc('a"b\'c<d>e&f'), 'a&quot;b&#39;c&lt;d&gt;e&amp;f');
});

test('esc output is safe inside a double-quoted attribute', () => {
  const esc = loadEsc();
  const payload = 'x" data-action="clearAllData" title="';
  const out = esc(payload);
  assert.ok(!out.includes('"'), 'no raw double quote survives');
  assert.ok(!out.includes("'"), 'no raw single quote survives');
});

test('esc keeps the old null / number semantics', () => {
  const esc = loadEsc();
  assert.strictEqual(esc(null), '');
  assert.strictEqual(esc(undefined), '');
  assert.strictEqual(esc(5), '5');
  assert.strictEqual(esc(''), '');
});

test('esc does not depend on a DOM (usable from any context)', () => {
  assert.ok(!/document\.createElement/.test(src.slice(src.indexOf('function esc('), src.indexOf('function escAttr('))));
});
