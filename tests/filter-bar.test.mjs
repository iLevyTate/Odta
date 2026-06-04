/**
 * Tasks-screen chrome guard.
 *
 * The Tasks screen used to stack five horizontal-scroll strips (lists, tags,
 * smart views, search, control bar). Those were consolidated into a compact
 * `.filter-bar`. With the ClickUp-style shell, Lists + Views moved into the
 * left sidebar (#appSidebar) — so the #fbLists trigger now opens that sidebar
 * (as a drawer on mobile) instead of a Lists bottom sheet, and only the Tags
 * and View sheets remain. This test pins:
 *   1. the filter-bar triggers exist and carry the expected data-action,
 *   2. every relocated control still lives in the DOM exactly once (so the
 *      existing filter/sort JS that reads them by id keeps working),
 *   3. each trigger's data-action resolves to a `window.<fn>=` defined in js/.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

test('compact filter bar exposes the four triggers', () => {
  assert.match(html, /id="filterBar"/, 'filter bar container present');
  for (const [id, action] of [
    ['fbLists', 'toggleSidebar'],
    ['fbTags', 'openTagsSheet'],
    ['fbSearch', 'toggleSearchBar'],
    ['fbView', 'openViewSheet'],
  ]) {
    const rx = new RegExp(`id="${id}"[^>]*data-action="${action}"|data-action="${action}"[^>]*id="${id}"`);
    assert.match(html, rx, `${id} trigger wired to ${action}`);
  }
});

test('the Tags and View option sheets exist and reuse the modal-overlay chrome', () => {
  // Lists + Views now live in the left sidebar, so the Lists sheet is gone;
  // the Tags and View sheets remain as bottom sheets.
  for (const id of ['tagsSheet', 'viewSheet']) {
    const rx = new RegExp(`class="modal-overlay sheet"[^>]*id="${id}"|id="${id}"[^>]*class="modal-overlay sheet"`);
    assert.match(html, rx, `${id} is a modal-overlay sheet`);
  }
});

test('Lists + Views are surfaced in the left sidebar', () => {
  // The ClickUp-style rail hosts the lists hierarchy and smart-view chips.
  assert.match(html, /class="app-sidebar"[^>]*id="appSidebar"|id="appSidebar"/, 'sidebar present');
  assert.match(html, /<div class="sidebar-lists"[^>]*>[^]*id="listsBar"[^]*id="smartViews"/, 'sidebar hosts #listsBar and #smartViews');
});

test('relocated filter controls remain in the DOM (exactly once)', () => {
  // The existing filter/sort code reads these by id; they moved into sheets but
  // must still be present and unique.
  const ids = [
    'taskSearch', 'filterStatus', 'filterPriority', 'taskSortSel', 'groupBySel',
    'filterCategory', 'listsBar', 'smartViews', 'tagsBar',
    'viewList', 'viewBoard', 'viewCal', 'filtersSummary', 'filtersActiveCount',
    'hideHabitsInMain', 'showCompletedAll', 'activeFiltersBar', 'searchBarWrap',
  ];
  for (const id of ids) {
    const count = (html.match(new RegExp(`id="${id}"`, 'g')) || []).length;
    assert.strictEqual(count, 1, `#${id} should appear exactly once, found ${count}`);
  }
});

test('sheet open/close handlers are defined on window in js/', () => {
  const ui = readFileSync(join(root, 'js/ui.js'), 'utf8');
  for (const fn of [
    'openSheet', 'closeSheet', 'bindSheetSwipe',
    'openListsSheet', 'closeListsSheet', 'closeListsSheetOnBackdrop',
    'openTagsSheet', 'closeTagsSheet', 'closeTagsSheetOnBackdrop',
    'openViewSheet', 'closeViewSheet', 'closeViewSheetOnBackdrop',
    'toggleSearchBar',
  ]) {
    assert.match(ui, new RegExp(`window\\.${fn}\\s*=`), `window.${fn} must be defined`);
  }
});

test('syncFilterBar is defined and called from the render path', () => {
  const tasks = readFileSync(join(root, 'js/tasks.js'), 'utf8');
  assert.match(tasks, /window\.syncFilterBar\s*=/, 'syncFilterBar exported');
  assert.match(tasks, /syncFilterBar\(\)/, 'syncFilterBar invoked');
});
