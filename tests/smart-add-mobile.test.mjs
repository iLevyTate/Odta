/**
 * Smart-add on mobile: delegation exports, sheet wiring, touch-target CSS.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ai = readFileSync(join(root, 'js', 'ai.js'), 'utf8');
const ui = readFileSync(join(root, 'js', 'ui.js'), 'utf8');
const css = readFileSync(join(root, 'css', 'main.css'), 'utf8');

test('smart-add chip remove handlers are exported for data-action delegation', () => {
  assert.match(ai, /window\.smartAddRemove\s*=\s*smartAddRemove/, 'smartAddRemove on window');
  assert.match(ai, /window\.smartAddRemoveTag\s*=\s*smartAddRemoveTag/, 'smartAddRemoveTag on window');
});

test('opening the quick-add sheet refreshes the enhance button visibility', () => {
  assert.match(ui, /function openQuickAddSheet[\s\S]*?maybeShowEnhanceBtn/, 'sheet open syncs enhance btn');
});

test('Cmd/Ctrl+N uses the FAB path so mobile opens the add sheet', () => {
  assert.match(ui, /quickAddFabClick\(\)/, 'keyboard shortcut routes through FAB handler');
});

test('mobile CSS gives smart-add controls adequate touch targets', () => {
  assert.match(css, /\.task-enhance-btn[^{]*\{[^}]*min-width:44px/s, '44px min touch width');
  assert.match(css, /\.task-input-wrap\{overflow:visible\}/, 'input wrap does not clip action buttons');
});

test('smart add predicts list and life area like bulk import', () => {
  assert.match(ai, /async function _buildSmartAddSuggestions[\s\S]*?predictMetadata[\s\S]*?predictListId/, 'shared enrich helper routes list + metadata');
  assert.match(ai, /shouldApplySmartAdd[\s\S]*?max-width:640px/, 'mobile submit uses smart-add routing when intel is ready');
  assert.match(ai, /_focusListForRoutedTask[\s\S]*?activeListId\s*=\s*listId/, 'switches active list so routed tasks are visible');
  assert.match(ai, /data-action="smartAddRemove" data-arg="listId"/, 'list chip is removable in preview');
});
