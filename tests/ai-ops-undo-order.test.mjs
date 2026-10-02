/**
 * js/ai.js proposed-op executor / undo regressions:
 *  - aiUndo replays snapshots in REVERSE apply order (two ops on one task in
 *    a batch used to leave the intermediate state behind).
 *  - DELETE_TASK writes sync tombstones, purges embeddings and stops a timer
 *    on the removed task, like the UI delete; undo clears the tombstones and
 *    re-stamps the restored copies.
 *  - MOVE_TASK refuses to make a task its own parent.
 *  - SPLIT_TASK deep-clones the source and resets attachments / history.
 *  - Previewed CLASSIFY_TASK predictions are not recomputed at apply time.
 *  - The list-move summary escapes list names.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'ai.js'), 'utf8');

function caseBody(name) {
  const s = src.indexOf(`case '${name}':`);
  assert.ok(s >= 0, `case ${name} found`);
  const e = src.indexOf("case '", s + 6);
  return src.slice(s, e > s ? e : undefined);
}
function fnBlock(name) {
  const s = src.indexOf(`function ${name}(`);
  assert.ok(s >= 0, `${name} found`);
  const e = src.indexOf('\nfunction ', s + 1);
  return src.slice(s, e > s ? e : undefined);
}

test('aiUndo walks the flattened snapshots backwards', () => {
  const body = fnBlock('aiUndo');
  assert.match(body, /for\(let i = flat\.length - 1; i >= 0; i--\)/);
  assert.ok(!/flat\.forEach\(/.test(body), 'forward replay removed');
  assert.match(body, /delete syncTaskDels\[x\.id\]/, 'deleted-task tombstones cleared on restore');
  assert.match(body, /syncTaskDels\[s\.id\] = restoredAt/, 'undone creations are tombstoned');
});

test('DELETE_TASK mirrors removeTask bookkeeping', () => {
  const body = caseBody('DELETE_TASK');
  assert.match(body, /syncTaskDels\[rid\] = lmOf\[rid\] \|\| Date\.now\(\)/, 'tombstones stamped past each task\'s own clock');
  assert.match(body, /embedStore\.purge\(removedIds\)/);
  assert.match(body, /activeTaskId = null/);
});

test('MOVE_TASK rejects self-parenting', () => {
  assert.match(caseBody('MOVE_TASK'), /a\.newParentId === t\.id\) return null/);
});

test('SPLIT_TASK siblings are deep clones with fresh history', () => {
  const body = caseBody('SPLIT_TASK');
  assert.match(body, /JSON\.parse\(JSON\.stringify\(src\)\)/);
  for (const f of ['attachments', 'checklists', 'sessionEntries', 'relatedTo', 'activity']) {
    assert.match(body, new RegExp(`${f}:\\s*\\[\\]`), `${f} reset`);
  }
  assert.match(body, /remindAt:\s*null/);
  assert.match(body, /reminderFired:\s*false/);
});

test('_enrichClassifyOps skips ops that already carry a previewed prediction', () => {
  assert.match(fnBlock('_enrichClassifyOps'), /!op\._previewCategory/);
});

test('list-move summary escapes list names', () => {
  assert.match(fnBlock('_pendingListMoveSummary'), /esc\(_listNameById\(lid\)\)/);
});
