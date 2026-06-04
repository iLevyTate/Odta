/**
 * Header property pills + shared inline pickers (index.html + js/ui.js).
 *
 * Status / Priority / Due / List moved out of the Details pane into one-click
 * header pills, each opening a popover via the shared pickStatus/pickPriority/
 * pickDue (also used by the task-row ⋯ menu). These guards lock in the markup,
 * the de-duplication, and the wiring.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ui = readFileSync(join(root, 'js', 'ui.js'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const mdStart = html.indexOf('id="taskModal"');
const modal = html.slice(mdStart, html.indexOf('<div class="modal-foot">', mdStart));

test('header pills exist and route to the picker wrappers', () => {
  assert.ok(/id="mdPills"/.test(modal), 'pills container present');
  assert.ok(/id="mdPillStatus"[^>]*data-action="pickStatusPill"/.test(modal), 'status pill → pickStatusPill');
  assert.ok(/id="mdPillPriority"[^>]*data-action="pickPriorityPill"/.test(modal), 'priority pill → pickPriorityPill');
  assert.ok(/id="mdPillDue"[^>]*data-action="pickDuePill"/.test(modal), 'due pill → pickDuePill');
  assert.ok(/id="mdListTrigger"[^>]*data-action="openListDropdown"/.test(modal), 'list pill → openListDropdown');
});

test('mdDue / mdList kept as hidden canonical inputs the save logic reads', () => {
  assert.ok(/id="mdDue"/.test(modal) && /id="mdList"/.test(modal), 'mdDue and mdList still in the modal');
});

test('the duplicated Status/Priority chip groups were removed from the panes', () => {
  assert.ok(!/id="mdStatusChips"/.test(modal), 'mdStatusChips removed');
  assert.ok(!/id="mdPriorityChips"/.test(modal), 'mdPriorityChips removed');
});

test('shared pickers are defined, exposed, and used by the row ⋯ menu', () => {
  for (const fn of ['pickStatus', 'pickPriority', 'pickDue']) {
    assert.ok(new RegExp(`function ${fn}\\(id, anchor\\)`).test(ui), `${fn} defined`);
    assert.ok(new RegExp(`window\\.${fn}\\s*=`).test(ui), `${fn} exposed`);
  }
  // Row overflow menu offers the same quick-edits, anchored to the ⋯ button.
  assert.ok(/pickStatus\(id, anchor\)/.test(ui), 'row menu: Status…');
  assert.ok(/pickPriority\(id, anchor\)/.test(ui), 'row menu: Priority…');
  assert.ok(/pickDue\(id, anchor\)/.test(ui), 'row menu: Due date…');
});

test('openTaskDetail populates the pills (no chip rebuild)', () => {
  const open = ui.slice(ui.indexOf('function openTaskDetail('));
  const head = open.slice(0, open.indexOf('Modal.open('));
  assert.ok(/_updateTaskPillLabels\(t\)/.test(head), 'openTaskDetail refreshes pill labels');
  assert.ok(!/gid\('mdStatusChips'\)/.test(head), 'no mdStatusChips rebuild in openTaskDetail');
});

test('resting row hides the default "Open" status badge', () => {
  assert.ok(/t\.status!=='open'\)\s*\n?\s*\?\s*'<button[^']*status-badge/.test(ui)
        || /t\.status&&t\.status!=='open'/.test(ui), 'status badge gated to non-open statuses');
});
