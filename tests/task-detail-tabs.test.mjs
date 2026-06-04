/**
 * Segmented task-detail panel (index.html + js/ui.js).
 *
 * The detail editor was one ~2000px scroll of stacked field groups. It is now
 * split into three panes — Details / Tracking / More — shown one at a time via
 * switchTaskDetailTab. These guards lock in the structure and wiring; every
 * field keeps its original id, so openTaskDetail's population logic is unchanged.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ui = readFileSync(join(root, 'js', 'ui.js'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');

// Scope to the task-detail modal block.
const mdStart = html.indexOf('id="taskModal"');
const mdEnd = html.indexOf('<div class="modal-foot">', mdStart);
const modal = html.slice(mdStart, mdEnd);

test('three section tabs route through switchTaskDetailTab', () => {
  for (const pane of ['details', 'tracking', 'more']) {
    const re = new RegExp(`class="md-tab[^"]*"[^>]*data-action="switchTaskDetailTab"[^>]*data-arg="${pane}"`);
    assert.ok(re.test(modal), `tab button for "${pane}" present`);
  }
});

test('three tab panes exist, with tracking + more hidden by default', () => {
  for (const pane of ['details', 'tracking', 'more']) {
    assert.ok(new RegExp(`class="md-tabpane"[^>]*data-pane="${pane}"`).test(modal), `pane "${pane}" present`);
  }
  // Details visible, the other two start hidden.
  assert.ok(/data-pane="tracking" hidden/.test(modal), 'tracking pane hidden initially');
  assert.ok(/data-pane="more" hidden/.test(modal), 'more pane hidden initially');
});

test('the old single-scroll <details> sections are gone from the modal', () => {
  assert.ok(!/md-section-sum/.test(modal), 'no collapsible md-section summaries remain in the modal');
});

test('every field id is preserved (openTaskDetail wiring untouched)', () => {
  for (const id of ['mdStatusChips','mdPriorityChips','mdDue','mdRemindAt','mdRecur','mdSnoozeUntil',
                    'mdTypeChips','mdDesc','mdTagsEditor','mdList','mdStartDate','mdEstimate','mdTracked',
                    'mdCompletionNote','mdSessions','mdHabitLog','mdCategoryChips','mdEffortChips',
                    'mdEnergyChips','mdAttachments','mdUrl','mdBlockedBy','mdChecklist','mdNotes']) {
    assert.ok(modal.includes(`id="${id}"`), `field #${id} still present in the modal`);
  }
});

test('switchTaskDetailTab is defined and openTaskDetail resets to Details', () => {
  assert.ok(/function switchTaskDetailTab\(/.test(ui), 'switchTaskDetailTab defined');
  assert.ok(/window\.switchTaskDetailTab\s*=/.test(ui), 'switchTaskDetailTab exposed on window');
  const open = ui.slice(ui.indexOf('function openTaskDetail('));
  assert.ok(/switchTaskDetailTab\(['"]details['"]\)/.test(open.slice(0, open.indexOf('Modal.open('))),
    'openTaskDetail resets to the Details pane on open');
});
