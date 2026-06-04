/**
 * Unified save model for the task-detail modal (js/ui.js + index.html).
 *
 * The editor used to mix two save behaviours: chip fields auto-committed, but
 * typed text only persisted on an explicit "Save" (and was reverted on
 * Cancel/ESC). List changes were silently lost on close because `listId` was
 * not in the snapshot-synced chip fields. These guards lock in the fix:
 * text/date fields autosave on blur, the footer is Delete + Done (no Save/
 * Cancel), and `listId` survives a close.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ui = readFileSync(join(root, 'js', 'ui.js'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');

test('listId is in the snapshot-synced chip fields (list change survives close)', () => {
  const m = ui.match(/const TASK_MODAL_CHIP_FIELDS\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, 'TASK_MODAL_CHIP_FIELDS declaration found');
  assert.ok(/'listId'/.test(m[1]), "TASK_MODAL_CHIP_FIELDS must include 'listId'");
});

test('text fields autosave: _autosaveTaskDetailText exists and is bound on blur/change', () => {
  assert.ok(/function _autosaveTaskDetailText\(/.test(ui), '_autosaveTaskDetailText defined');
  assert.ok(/addEventListener\(['"]focusout['"]/.test(ui), 'focusout listener bound for autosave');
  assert.ok(/addEventListener\(['"]change['"]/.test(ui), 'change listener bound for autosave');
  assert.ok(/_bindTaskDetailAutosave\(\)/.test(ui), '_bindTaskDetailAutosave invoked in openTaskDetail');
});

test('closeTaskDetail commits pending text on the way out (no discard prompt)', () => {
  const start = ui.indexOf('async function closeTaskDetail(');
  assert.ok(start >= 0, 'closeTaskDetail found');
  const body = ui.slice(start, start + 1400);
  assert.ok(/_autosaveTaskDetailText\(\)/.test(body), 'closeTaskDetail autosaves before close');
  assert.ok(!/Discard unsaved text edits/.test(ui), 'the discard-confirm prompt is gone');
  assert.ok(!/function _taskModalHasUnsavedTextEdits\(/.test(ui), 'orphaned unsaved-edits check removed');
});

test('task-detail footer is Delete + Done only (no Save/Cancel)', () => {
  const start = html.indexOf('id="taskModal"');
  assert.ok(start >= 0, 'taskModal block found');
  const block = html.slice(start, html.indexOf('</div>\n</div>', start) + 20);
  const foot = block.slice(block.indexOf('class="modal-foot"'));
  assert.ok(/data-action="closeTaskDetail">Done</.test(foot), 'footer has a Done button -> closeTaskDetail');
  assert.ok(!/data-action="saveTaskDetail"/.test(foot), 'footer no longer has a Save button');
  assert.ok(!/mfoot-cancel/.test(foot), 'footer no longer has a Cancel button');
});
