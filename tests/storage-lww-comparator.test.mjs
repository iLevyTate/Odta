/**
 * saveState change-detection comparator + migration version gate.
 *
 * 1. fieldsToCompare drives the implicit lastModified bump: a task field that
 *    is persisted and synced but missing from this list means edits touching
 *    only that field never bump lastModified — and last-write-wins merge
 *    (P2P sync / cross-tab) silently discards them. The named-checklists
 *    editors, completion-note editor, and modal snooze all rely on the
 *    comparator (they never stamp lastModified themselves), so their fields
 *    must be listed.
 *
 * 2. SCHEMA_VERSION must be >= the highest step(N) target in migrateState.
 *    saveState persists v: SCHEMA_VERSION, so a step above SCHEMA_VERSION is
 *    never gated and re-runs on EVERY load (this is how the step(9)
 *    default-list backfill kept resurrecting deleted default Lists).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'storage.js'), 'utf8');

test('fieldsToCompare covers the comparator-dependent synced fields', () => {
  const m = src.match(/const fieldsToCompare = \[([\s\S]*?)\];/);
  assert.ok(m, 'fieldsToCompare declaration found');
  const listed = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  for (const f of ['checklist', 'checklists', 'completionNote', 'hiddenUntil', 'valuesNote', 'notes', 'attachments']) {
    assert.ok(listed.includes(f), `fieldsToCompare must include '${f}'`);
  }
});

test('SCHEMA_VERSION gates every migration step', () => {
  const vm = src.match(/const SCHEMA_VERSION = (\d+);/);
  assert.ok(vm, 'SCHEMA_VERSION declaration found');
  const version = parseInt(vm[1], 10);
  const targets = [...src.matchAll(/^\s*step\((\d+),/gm)].map(x => parseInt(x[1], 10));
  assert.ok(targets.length >= 1, 'migration steps found');
  const maxStep = Math.max(...targets);
  assert.ok(
    version >= maxStep,
    `SCHEMA_VERSION (${version}) must be >= highest step target (${maxStep}) — ` +
    'otherwise that step is never gated and re-runs on every load'
  );
});
