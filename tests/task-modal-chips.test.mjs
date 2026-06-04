/**
 * Regression guard: every chip handler in the task-detail modal must call
 * _commitChipChange so the mutation is persisted (saveState) and the chip
 * portion of _taskModalSnapshot is refreshed — otherwise close-without-Save
 * silently reverts the user's chip click via the snapshot, which is exactly
 * the "feels unfinished" bug the audit flagged.
 *
 * This is a static-text test against js/ui.js so the contract holds even
 * without a JSDOM harness. If a future patch removes _commitChipChange from
 * a chip handler the test catches it.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ui = readFileSync(join(root, 'js', 'ui.js'), 'utf8');

test('task-modal chip handlers call _commitChipChange', () => {
  // Each marker is the unique mutation line in a chip handler. The line
  // immediately following (or within the next 4 lines) must contain the
  // commit call.
  const expectations = [
    { marker: 't.effort=t.effort===key?null:key;',    label: 'effort' },
    { marker: 't.energyLevel=t.energyLevel===key?null:key;', label: 'energyLevel' },
    { marker: 't.category=t.category===key?null:key;', label: 'category' },
    { marker: 't.type=key;',                          label: 'type' },
    { marker: "t.recur=key==='none'?null:key;",      label: 'recur' },
  ];
  for(const { marker, label } of expectations){
    const idx = ui.indexOf(marker);
    assert.ok(idx >= 0, `marker for ${label} chip not found — handler refactored?`);
    const window = ui.slice(idx, idx + (label === 'recur' ? 900 : 600));
    assert.match(window, /_commitChipChange\(t\)/, `${label} chip mutation must call _commitChipChange`);
  }
});

test('status/priority pickers persist via _commitTaskProp → _commitChipChange', () => {
  // Status/Priority moved from chip groups to header-pill popovers; they now
  // mutate inside pickStatus/pickPriority and persist through _commitTaskProp.
  for(const fn of ['pickStatus', 'pickPriority']){
    const idx = ui.indexOf(`function ${fn}(id, anchor)`);
    assert.ok(idx >= 0, `${fn} not found`);
    assert.match(ui.slice(idx, idx + 900), /_commitTaskProp\(t, before\)/, `${fn} must call _commitTaskProp`);
  }
  // And _commitTaskProp itself commits chip-style (snapshot-synced) for the open task.
  const cIdx = ui.indexOf('function _commitTaskProp(');
  assert.ok(cIdx >= 0, '_commitTaskProp not found');
  assert.match(ui.slice(cIdx, cIdx + 500), /_commitChipChange\(t\)/, '_commitTaskProp must call _commitChipChange');
});

test('addTag and removeTag persist via _commitChipChange', () => {
  // Tag mutations were previously fire-and-forget; the close-revert path
  // erased them. Both helpers must commit.
  const addIdx = ui.indexOf('function addTag(');
  const rmIdx  = ui.indexOf('function removeTag(');
  assert.ok(addIdx > 0 && rmIdx > 0, 'addTag/removeTag not found');
  const addBody = ui.slice(addIdx, addIdx + 300);
  const rmBody  = ui.slice(rmIdx,  rmIdx  + 300);
  assert.match(addBody, /_commitChipChange\(t\)/, 'addTag must call _commitChipChange');
  assert.match(rmBody,  /_commitChipChange\(t\)/, 'removeTag must call _commitChipChange');
});

test('toggleTaskDone persists via _commitChipChange', () => {
  const idx = ui.indexOf('function toggleTaskDone()');
  assert.ok(idx > 0, 'toggleTaskDone not found');
  // Cap window at function end (next top-level function) — generous slice
  // of 2000 chars is plenty without dragging in unrelated functions.
  const body = ui.slice(idx, idx + 2000);
  assert.match(body, /_commitChipChange\(t\)/, 'toggleTaskDone must call _commitChipChange');
});

test('_commitChipChange refreshes snapshot for chip-driven fields', () => {
  // Locate the helper definition and check it covers the canonical chip
  // field set. Any new chip field added to the modal should also appear
  // here so close-revert doesn't reintroduce the silent-reset bug.
  const idx = ui.indexOf('TASK_MODAL_CHIP_FIELDS');
  assert.ok(idx > 0, 'TASK_MODAL_CHIP_FIELDS list not found');
  const body = ui.slice(idx, idx + 400);
  ['priority','effort','energyLevel','category','type','recur','tags','status'].forEach(f => {
    assert.match(body, new RegExp(`['"]${f}['"]`), `TASK_MODAL_CHIP_FIELDS must include ${f}`);
  });
});
