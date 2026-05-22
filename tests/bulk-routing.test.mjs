/**
 * Bulk-paste import — list + category routing modes.
 *
 * Pins the new three-mode UX so a future refactor can't silently revert
 * the choices a user makes in the preview modal:
 *
 *   - "ai":    embeddings auto-route each task (existing behaviour).
 *   - "batch": one list + category, applied to every imported task.
 *   - "per":   per-row dropdowns, AI suggestions used as defaults.
 *
 * The tests check the public source contract — markup, exported helpers,
 * and the override logic inside confirmBulkImport — without trying to
 * spin up a DOM. Browser-level interaction is covered by the smoke flow.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const tasks = readFileSync(join(root, 'js', 'tasks.js'), 'utf8');

test('bulk-import modal exposes the three routing modes', () => {
  // Without these radios the new UX can't be reached at all.
  for (const id of ['bulkRouteModeAi', 'bulkRouteModeBatch', 'bulkRouteModePer']) {
    assert.match(html, new RegExp(`id="${id}"`), `missing radio #${id}`);
  }
  // Modes must share the same radio group so they're mutually exclusive.
  const occurrences = (html.match(/name="bulkRouteMode"/g) || []).length;
  assert.ok(occurrences >= 3, 'three radios must share name="bulkRouteMode"');
});

test('bulk-import modal has batch list + category selects', () => {
  assert.match(html, /id="bulkRouteBatchList"/, 'missing #bulkRouteBatchList');
  assert.match(html, /id="bulkRouteBatchCat"/,  'missing #bulkRouteBatchCat');
  // The panel containing them must default to hidden so the modal doesn't
  // open with a "Same for all" UI exposed before the user picks the mode.
  assert.match(
    html,
    /id="bulkRouteBatchPanel"[^>]*\bhidden\b/,
    '#bulkRouteBatchPanel must start hidden (the radio reveals it)'
  );
});

test('per-task preview container exists and is initially hidden', () => {
  assert.match(html, /id="bulkRoutePerRows"/, 'missing #bulkRoutePerRows');
  assert.match(
    html,
    /id="bulkRoutePerRows"[^>]*\bhidden\b/,
    '#bulkRoutePerRows must start hidden (rendered on demand when mode=per)'
  );
});

test('the legacy single-checkbox auto-organize control is gone', () => {
  // The old #bulkImportAuto checkbox would conflict with the new three-mode
  // radios — and the JS no longer references it. Make sure no future PR
  // re-introduces it by accident.
  assert.doesNotMatch(html, /id="bulkImportAuto(?!Wrap)"/, 'old #bulkImportAuto checkbox must be gone');
  assert.doesNotMatch(html, /id="bulkImportAutoWrap"/,       'old #bulkImportAutoWrap must be gone');
  assert.doesNotMatch(tasks, /_syncBulkImportAutoToggle/,     'old _syncBulkImportAutoToggle must be removed');
});

test('_bulkRoutingMode reads the checked radio (defaults to "ai")', () => {
  // Source-level check — runtime behaviour relies on querying the radio
  // group by name. Make sure the helper exists and is exposed.
  assert.match(tasks, /function _bulkRoutingMode\(\)\s*\{/, '_bulkRoutingMode must be defined');
  assert.match(tasks, /window\._bulkRoutingMode\s*=\s*_bulkRoutingMode/, 'must be exposed on window for testability');
  assert.match(
    tasks,
    /querySelector\(\s*['"]input\[name="bulkRouteMode"\]:checked['"]\s*\)/,
    'must read the checked radio in the bulkRouteMode group'
  );
});

test('_bulkRoutingFor returns null for "ai" mode and reads chosen values otherwise', () => {
  assert.match(tasks, /function _bulkRoutingFor\(idx\)\s*\{/, '_bulkRoutingFor must be defined');
  // "ai" mode short-circuits to no override.
  assert.match(
    tasks,
    /_bulkRoutingFor[\s\S]*?return\s*\{\s*listId:\s*null,\s*category:\s*null\s*\}\s*;\s*\}\s*$/m,
    '_bulkRoutingFor must fall through to {listId:null, category:null} in "ai" mode'
  );
  // "batch" mode reads the two dropdowns by id.
  assert.match(tasks, /gid\('bulkRouteBatchList'\)/, 'must read #bulkRouteBatchList in batch mode');
  assert.match(tasks, /gid\('bulkRouteBatchCat'\)/,  'must read #bulkRouteBatchCat in batch mode');
  // "per" mode looks up the row by data-idx.
  assert.match(
    tasks,
    /querySelector\(\s*['"]li\.bulk-route-row\[data-idx="['"]?\s*\+\s*idx/,
    'per-task mode must look up the row by its data-idx attribute'
  );
});

test('confirmBulkImport applies routing overrides AFTER enrichment', () => {
  // The override must win over enriched values; otherwise picking "Same
  // for all" wouldn't actually pin the list when intel is also running.
  const overrideIdx = tasks.indexOf("if(mode === 'batch' || mode === 'per')");
  const enrichIdx   = tasks.indexOf('Auto-organizing ');
  const persistIdx  = tasks.indexOf('Persist phase');
  assert.ok(overrideIdx > 0, 'routing-override block missing in confirmBulkImport');
  assert.ok(enrichIdx > 0,   'enrichment block missing in confirmBulkImport');
  assert.ok(persistIdx > 0,  'persist phase comment missing in confirmBulkImport');
  assert.ok(overrideIdx > enrichIdx,  'override must come AFTER enrichment so it wins');
  assert.ok(overrideIdx < persistIdx, 'override must come BEFORE persist so it lands on tasks');
});

test('per-task preview pre-fills AI suggestions but respects user edits', () => {
  // The dataset.userTouched guard prevents a slow predictListId promise
  // from clobbering a value the user already changed.
  assert.match(tasks, /dataset\.userTouched\s*=\s*'1'/, 'must mark user-edited rows');
  assert.match(
    tasks,
    /!row\.listSel\.dataset\.userTouched/,
    'must check userTouched before pre-filling list select'
  );
  assert.match(
    tasks,
    /!row\.catSel\.dataset\.userTouched/,
    'must check userTouched before pre-filling category select'
  );
});

test('AI mode is disabled in the UI when embeddings are not loaded', () => {
  // Without this, the "Auto-organize" radio would be selectable but
  // confirmBulkImport would silently fall back to no-op enrichment.
  assert.match(tasks, /aiRadio\.disabled\s*=\s*!intelOk/, 'must disable AI radio when intel is not ready');
  assert.match(tasks, /perRadio\.disabled\s*=\s*!intelOk/, 'must disable Per-task radio when intel is not ready');
});
