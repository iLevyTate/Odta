/**
 * Regression: the saveState change-detection baseline (_prevTaskSnapshot) was
 * built with a shallow {...t}, which shares nested arrays/objects with the live
 * task. An in-place mutation (checklist toggle, completions.push, sessions++,
 * tags edit) then mutated BOTH the task and its own baseline, so the diff saw
 * no change and never bumped lastModified — silently losing the edit under
 * last-write-wins sync. The baseline must be a deep clone.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const storageSrc = readFileSync(join(root, 'js', 'storage.js'), 'utf8').replace(/\r\n/g, '\n');

function loadSnapshotTask() {
  const s = storageSrc.indexOf('function _snapshotTask');
  assert.ok(s > 0, '_snapshotTask not found');
  const e = storageSrc.indexOf('\nfunction resetTaskSnapshotBaseline', s);
  assert.ok(e > s, 'slice _snapshotTask');
  return new Function(`${storageSrc.slice(s, e)}\nreturn _snapshotTask;`)();
}

test('_snapshotTask deep-clones nested arrays/objects (no shared references)', () => {
  const _snapshotTask = loadSnapshotTask();
  const task = {
    id: 1,
    name: 'Demo',
    tags: ['a'],
    checklist: [{ id: 1, text: 'step', done: false }],
    completions: ['2026-05-27'],
    sessionEntries: [{ ts: 't', durationSec: 60 }],
  };
  const snap = _snapshotTask(task);

  // Mutate the LIVE task's nested structures in place.
  task.checklist[0].done = true;
  task.completions.push('2026-05-28');
  task.tags.push('b');
  task.sessionEntries.push({ ts: 't2', durationSec: 30 });

  // The baseline must NOT have moved — otherwise the JSON diff would see no
  // change and lastModified would never bump.
  assert.equal(snap.checklist[0].done, false, 'checklist baseline must be independent');
  assert.equal(snap.completions.length, 1, 'completions baseline must be independent');
  assert.equal(snap.tags.length, 1, 'tags baseline must be independent');
  assert.equal(snap.sessionEntries.length, 1, 'sessionEntries baseline must be independent');

  // And the comparator (JSON.stringify per field) would now detect the change.
  assert.notEqual(JSON.stringify(task.checklist), JSON.stringify(snap.checklist));
  assert.notEqual(JSON.stringify(task.completions), JSON.stringify(snap.completions));
});

test('snapshot baseline sites use _snapshotTask, not shallow {...t}', () => {
  // Guard against a regression to the shallow clone at any of the three sites.
  assert.equal(
    /_prevTaskSnapshot\[t\.id\]\s*=\s*\{\s*\.\.\.t\s*\}/.test(storageSrc),
    false,
    'a snapshot site still uses shallow {...t}',
  );
  const sites = storageSrc.match(/_prevTaskSnapshot\[t\.id\]\s*=\s*_snapshotTask\(t\)/g) || [];
  assert.ok(sites.length >= 3, 'expected all three snapshot sites to use _snapshotTask, found ' + sites.length);
});
