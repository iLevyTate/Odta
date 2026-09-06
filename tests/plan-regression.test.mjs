/**
 * Lightweight regression guards for bug-review plan (timer pause/skip, storage, kNN dim).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('timer: skipPhase does not count elapsed when paused (wasRunning guard)', () => {
  const src = readFileSync(join(root, 'js', 'timer.js'), 'utf8');
  // Whitespace-tolerant regex: still asserts the semantic guarantee
  // (wasRunning captured BEFORE running is mutated, then el derived from
  // the captured wasRunning) without locking in a specific code-layout.
  assert.match(
    src,
    /function skipPhase\(\)\s*\{\s*const wasRunning\s*=\s*running\s*;[\s\S]*?const el\s*=\s*wasRunning\s*\?\s*(?:Math\.max\(0,\s*)?Math\.floor/,
    'skipPhase should derive el only when wasRunning',
  );
});

test('storage: _isStatePristine has no undefined intentions check', () => {
  const src = readFileSync(join(root, 'js', 'storage.js'), 'utf8');
  assert.equal(src.includes('intentions'), false, 'stale "intentions" ref must not exist');
  const i = src.indexOf('function _isStatePristine(');
  assert.ok(i >= 0);
  const j = src.indexOf('function exportData(', i);
  const body = src.slice(i, j);
  assert.match(body, /window\._stateDirty/);
  assert.equal(body.includes('intentions'), false);
});

test('intel-features: kNN and semanticSearch skip vec dim mismatch', () => {
  const src = readFileSync(join(root, 'js', 'intel-features.js'), 'utf8');
  assert.match(
    src,
    /if\(!rec\s*\|\|\s*!rec\.vec\s*\|\|\s*rec\.vec\.length\s*!==\s*queryVec\.length\)\s*continue/,
    'kNN in predictMetadataFromVec guards vec length',
  );
  const sem = src.indexOf('async function semanticSearch(');
  assert.ok(sem >= 0);
  const tail = src.slice(sem, sem + 1200);
  assert.match(
    tail,
    /if\(!rec\s*\|\|\s*!rec\.vec\s*\|\|\s*rec\.vec\.length\s*!==\s*q\.length\)\s*continue/,
  );
  assert.match(src, /alignValuesFromVec[\s\S]*?Number\.isFinite\(x\.sim\)/);
});
