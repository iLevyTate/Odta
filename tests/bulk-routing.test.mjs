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

test('_bulkRoutingFor returns structured overrides for each field', () => {
  assert.match(tasks, /function _bulkRoutingFor\(idx\)\s*\{/, '_bulkRoutingFor must be defined');
  // Each field is { type: 'none' | 'set' | 'ai', value? } so callers can
  // tell "leave alone" from "use this exact value" from "predict at commit".
  assert.match(tasks, /type:\s*['"]none['"]/, 'override shape must include the "none" type');
  assert.match(tasks, /type:\s*['"]set['"]/,  'override shape must include the "set" type');
  assert.match(tasks, /type:\s*['"]ai['"]/,   'override shape must include the "ai" type (mixed AI/manual)');
  // The "ai" mode falls through to the existing enrichment path with no
  // explicit override on either field.
  assert.match(
    tasks,
    /['"]ai['"]\s*mode[\s\S]*?\{\s*list:\s*\{\s*type:\s*['"]none['"]\s*\}/,
    '_bulkRoutingFor must return list:{type:"none"} in ai mode'
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

test('"AI pick" sentinel is offered when intel is loaded', () => {
  // The sentinel lets a user mix AI + manual: e.g. force every task into
  // the Work list but let AI pick categories. Without this option, batch
  // mode is "all-or-nothing" against the model.
  assert.match(tasks, /const BULK_AI_PICK\s*=\s*['"]__AI__['"]/, 'BULK_AI_PICK sentinel must be defined');
  // The dropdown population checks intelOk before pushing the AI option —
  // hiding it when AI isn't reachable so the menu never lies.
  assert.match(
    tasks,
    /if\(intelOk\)\s*opts\.push\(\s*\[BULK_AI_PICK/,
    'batch dropdowns must only show the AI option when intel is ready'
  );
});

test('confirmBulkImport runs predictListId / predictMetadata for AI-sentinel rows', () => {
  // The override pass must handle the "ai" branch on each field — calling
  // the predictor per task — otherwise the sentinel does nothing.
  assert.match(tasks, /route\.list\.type\s*===\s*['"]ai['"]/,     'must check list.type === "ai"');
  assert.match(tasks, /route\.category\.type\s*===\s*['"]ai['"]/,'must check category.type === "ai"');
  assert.match(tasks, /predictListId\(built\[i\]\.name/,         'must call predictListId for AI-list rows');
  assert.match(tasks, /predictMetadata\(built\[i\]\.name/,       'must call predictMetadata for AI-category rows');
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

test('per-task textarea edits must not re-sync full routing controls on every keystroke', () => {
  // _syncBulkRoutingControls → _applyBulkRoutingMode used to re-render all
  // per rows on every input event, wiping manual picks and re-firing N
  // parallel embedding calls.
  const fn = tasks.match(/function _onBulkRoutingTextareaChanged\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(fn, '_onBulkRoutingTextareaChanged must exist');
  assert.doesNotMatch(fn[1], /_syncBulkRoutingControls\(\)/, 'must not call _syncBulkRoutingControls on textarea input');
});

test('_applyBulkRoutingMode only renders per rows when entering per mode', () => {
  assert.match(tasks, /_bulkAppliedRoutingMode/, 'must track last applied routing mode');
  assert.match(
    tasks,
    /mode\s*===\s*['"]per['"]\s*&&\s*_bulkAppliedRoutingMode\s*!==\s*['"]per['"]/,
    'must render per rows only on mode transition into "per"'
  );
});

test('AI mode is disabled in the UI when embeddings are not loaded', () => {
  // Without this, the "Auto-organize" radio would be selectable but
  // confirmBulkImport would silently fall back to no-op enrichment.
  assert.match(tasks, /aiRadio\.disabled\s*=\s*!intelOk/, 'must disable AI radio when intel is not ready');
  // Per-task mode is intentionally NOT gated on intel — the dropdowns work
  // without AI (the user gets blank starting state and routes manually).
  // Re-disabling Per-task would block legitimate manual workflows.
  assert.doesNotMatch(tasks, /perRadio\.disabled\s*=\s*!intelOk/, 'Per-task radio must remain available without AI');
});

test('closing the modal with unsaved per-row edits asks before discarding', () => {
  // Prevents accidental loss of work when a user spent time picking lists
  // per task and then clicks the backdrop. The check only fires when there
  // are user-touched selects; the auto-prefill from AI alone is not a "user edit".
  assert.match(tasks, /function _bulkImportHasUserEdits\(\)/, 'must export an edit-detection helper');
  assert.match(tasks, /querySelector\(['"]select\[data-user-touched="1"\]['"]\)/, 'must scan for user-touched selects');
  assert.match(tasks, /showAppConfirm\([^)]*Discard /, 'must surface the discard prompt via showAppConfirm');
});
