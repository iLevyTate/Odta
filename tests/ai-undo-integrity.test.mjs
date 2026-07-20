/**
 * executeIntelOp snapshot/undo integrity (js/ai.js).
 *
 * aiUndo restores whatever the op snapshotted — so a snapshot that misses
 * state (delete cascade's descendants) or shares references with state the
 * op then mutates in place (habit cycle's completions/checklist) makes Undo
 * silently lossy:
 *  - DELETE_TASK removes the whole subtree, so it must snapshot the whole
 *    subtree; snapshotting only the root permanently lost every descendant.
 *  - MARK_DONE routes recurring tasks through completeHabitCycle, which
 *    push()es into completions and resets checklist items IN PLACE — a
 *    shallow {...t} snapshot shares those references and mutates alongside.
 *  - DUPLICATE_TASK's shallow copy shared valuesAlignment/completions/
 *    checklists/_ext with the source (mutating one corrupted the other) and
 *    carried the source's attachment ids (blob records are keyed by source
 *    task id; removeAttachment deletes the blob unconditionally).
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

test('DELETE_TASK snapshots the removed subtree, and aiUndo restores it', () => {
  const body = caseBody('DELETE_TASK');
  assert.match(body, /subtree:/, 'snapshot carries the descendants');
  assert.match(body, /getTaskDescendantIds/, 'cascade still computed');
  const undoIdx = src.indexOf('function aiUndo');
  const undoBody = src.slice(undoIdx, undoIdx + 1500);
  assert.match(undoBody, /s\.subtree/, 'aiUndo pushes the snapshotted subtree back');
});

test('MARK_DONE takes a deep snapshot (habit cycle mutates nested state in place)', () => {
  assert.match(caseBody('MARK_DONE'), /JSON\.parse\(JSON\.stringify\(t\)\)/);
});

test('DUPLICATE_TASK deep-clones and resets history/attachments', () => {
  const body = caseBody('DUPLICATE_TASK');
  assert.match(body, /JSON\.parse\(JSON\.stringify\(src\)\)/, 'copy shares no nested refs');
  assert.match(body, /completions:\s*\[\]/, 'habit log resets');
  assert.match(body, /attachments:\s*\[\]/, 'attachment ids are per-task, not copied');
  assert.match(body, /sessionEntries:\s*\[\]/, 'session history resets');
  assert.match(body, /checklists/, 'named-checklist done state reset');
});
