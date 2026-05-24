/**
 * Board view (Phase 3): cards are top-level only — roots, plus any visible
 * subtask whose parent is filtered out (so it doesn't vanish). Subtasks of a
 * visible parent are nested under that parent behind a disclosure pill.
 *
 * renderBoard is DOM/closure-heavy, so this pins (a) the selection predicate's
 * semantics via a standalone replica and (b) the source wiring of the new
 * nesting pieces.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ui = readFileSync(join(root, 'js', 'ui.js'), 'utf8');

// Mirror of the predicate used inside renderBoard.
function topLevelForStatus(visible, st) {
  const set = new Set(visible.map((t) => t.id));
  return visible.filter(
    (t) => (t.status || 'open') === st && (!t.parentId || !set.has(t.parentId)),
  );
}

test('roots appear as cards; subtasks of a visible parent do not', () => {
  const visible = [
    { id: 1, status: 'open', parentId: null },
    { id: 2, status: 'open', parentId: 1 }, // nested under visible parent
  ];
  const cards = topLevelForStatus(visible, 'open').map((t) => t.id);
  assert.deepEqual(cards, [1], 'only the root is a top-level card');
});

test('a visible subtask whose parent is filtered out is promoted to a card', () => {
  const visible = [
    { id: 2, status: 'open', parentId: 99 }, // parent 99 not in the visible set
  ];
  const cards = topLevelForStatus(visible, 'open').map((t) => t.id);
  assert.deepEqual(cards, [2], 'orphaned-visible subtask still shows');
});

test('cards are grouped by their own status column', () => {
  const visible = [
    { id: 1, status: 'open', parentId: null },
    { id: 2, status: 'done', parentId: null },
  ];
  assert.deepEqual(topLevelForStatus(visible, 'open').map((t) => t.id), [1]);
  assert.deepEqual(topLevelForStatus(visible, 'done').map((t) => t.id), [2]);
});

test('renderBoard source filters to top-level and wires the disclosure', () => {
  assert.match(ui, /!t\.parentId\s*\|\|\s*!visibleSet\.has\(t\.parentId\)/, 'top-level predicate present');
  assert.match(ui, /data-action="toggleBoardExpand"|dataset\.action='toggleBoardExpand'|pill\.dataset\.action='toggleBoardExpand'/, 'expander wired');
  assert.match(ui, /function _boardMiniCard/, 'mini-card builder present');
  assert.match(ui, /window\.toggleBoardExpand\s*=/, 'toggleBoardExpand exported');
  assert.match(ui, /t\.boardExpanded/, 'expansion state persisted on boardExpanded');
});
