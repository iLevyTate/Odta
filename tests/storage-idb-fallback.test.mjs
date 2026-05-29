/**
 * Regression: when JSON.stringify(state) throws (circular ref / exotic value),
 * saveState falls back to storing the RAW object in IndexedDB via structured
 * clone. But loadState's IDB recovery did `JSON.parse(raw)` unconditionally —
 * so JSON.parse(object) coerced to "[object Object]" and threw, defeating the
 * exact recovery the fallback exists for. The recovery must accept a non-string
 * value as the already-deserialized state.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'storage.js'), 'utf8');

test('stringify-failure path stores the raw object in IDB', () => {
  // The catch branch must persist the object (structured clone), not silently
  // drop the write.
  const i = src.indexOf('JSON.stringify failed');
  assert.ok(i > 0, 'stringify-failure branch not found');
  const body = src.slice(i, i + 200);
  assert.match(body, /_idbSet\(STORE_KEY,\s*state\)/, 'fallback must store the raw object');
});

test('IDB recovery coerces a non-string value instead of blindly JSON.parsing', () => {
  // The recovery read must tolerate both a serialized string (normal) and the
  // raw object (stringify-failure fallback).
  assert.match(
    src,
    /typeof raw === 'string'\)?\s*\?\s*JSON\.parse\(raw\)\s*:\s*raw/,
    'IDB recovery must coerce non-string raw to the object directly',
  );
});

test('the coercion contract behaves correctly for both shapes', () => {
  // Mirror the exact expression and prove it round-trips both representations.
  const coerce = (raw) => (typeof raw === 'string' ? JSON.parse(raw) : raw);
  const obj = { v: 8, tasks: [{ id: 1 }], date: '2026-05-28' };
  assert.deepEqual(coerce(JSON.stringify(obj)), obj, 'string form parses');
  assert.strictEqual(coerce(obj), obj, 'object form passes through untouched');
});
