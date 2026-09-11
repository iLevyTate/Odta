/**
 * Kanban drop zones (js/ui.js _initBoardSortables + css/main.css).
 *
 * Reported as "drag and drop on cards no longer works". Root cause, verified
 * with real pointer/touch events in headless Chromium: SortableJS was
 * configured with swapThreshold 0.65 + invertSwap true, which makes the
 * middle 65% of every card a dead zone, and the "Drop tasks here"
 * placeholder counted as a sortable item, so a card dropped onto the centre
 * of an empty column (the natural target, and on phones the only visible
 * part of the neighbouring column) never registered a move and snapped
 * back. These guards pin the configuration that makes the whole card and
 * the whole empty column accept a drop.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ui = readFileSync(join(root, 'js', 'ui.js'), 'utf8');
const css = readFileSync(join(root, 'css', 'main.css'), 'utf8');

function boardOpts() {
  const start = ui.indexOf('function _initBoardSortables(');
  const end = ui.indexOf('function renderBoard(', start);
  assert.ok(start >= 0 && end > start, 'sliced _initBoardSortables');
  // Strip line comments so prose about the old configuration can't match.
  return ui.slice(start, end).replace(/^\s*\/\/.*$/gm, '');
}

test('board Sortable: only cards are items, so the empty-column placeholder is never a swap target', () => {
  const src = boardOpts();
  assert.match(src, /draggable:\s*'\.board-card'/, "draggable: '.board-card'");
});

test('board Sortable: the whole card is the swap zone (no inverted dead centre)', () => {
  const src = boardOpts();
  assert.match(src, /swapThreshold:\s*1\b/, 'swapThreshold must be 1');
  assert.ok(!/invertSwap:\s*true/.test(src), 'invertSwap:true reintroduces the dead centre');
});

test('board CSS: placeholder hidden mid-drag and the column body keeps a drop height', () => {
  assert.match(css, /body\.board--dragging \.board-col-empty\{display:none\}/, 'placeholder hidden while dragging');
  const body = css.match(/\.board-col-body\{[^}]*\}/);
  assert.ok(body && /min-height:\s*\d+px/.test(body[0]), 'column body has a min-height so an empty column stays a target');
});

test('board CSS: the nesting strip still gets a visible height during a drag', () => {
  assert.match(css, /body\.board--dragging \.board-card-children\.is-empty[\s\S]{0,200}min-height:\s*24px/, 'indent-by-drop target remains');
});
