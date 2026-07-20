/**
 * The CSP is style-src 'self' with no 'unsafe-inline', so a style="…"
 * attribute — whether in index.html or in JS-built innerHTML strings — is
 * silently BLOCKED: the element renders unstyled and the console fills with
 * violations. (This bit the classification manager's color dots.) Dynamic
 * styles must go through the CSSOM (el.style.x = …), which CSP permits.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const jsFiles = readdirSync(join(root, 'js')).filter((f) => f.endsWith('.js'));

for (const f of jsFiles) {
  test(`js/${f}: no style="…" attributes in generated markup`, () => {
    const src = readFileSync(join(root, 'js', f), 'utf8');
    const hits = [];
    src.split('\n').forEach((line, i) => {
      if (/style=["'\\]/.test(line) && !/^\s*(\/\/|\*)/.test(line)) hits.push(`${f}:${i + 1}`);
    });
    assert.deepStrictEqual(hits, [], `inline style attributes are CSP-blocked: ${hits.join(', ')}`);
  });
}

test('index.html: no style="…" attributes', () => {
  const src = readFileSync(join(root, 'index.html'), 'utf8');
  const hits = [];
  src.split('\n').forEach((line, i) => {
    if (/style="/.test(line) && !/style-src/.test(line)) hits.push(`index.html:${i + 1}`);
  });
  assert.deepStrictEqual(hits, [], `inline style attributes are CSP-blocked: ${hits.join(', ')}`);
});
