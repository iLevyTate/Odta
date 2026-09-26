/**
 * Every command-palette action must call a function that actually exists.
 *
 * Six entries ("Daily brief", "Weekly review", "AI: Rephrase", "AI: Suggest
 * tags", "Save as template", "Apply template") called handlers that were never
 * written, so picking them threw a ReferenceError from the palette's
 * setTimeout(() => item.run()) and nothing happened. Classic scripts share one
 * global scope, so this resolves every identifier called inside a `run:`
 * closure against the function / window.* / top-level declarations across all
 * of js/*.js.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const jsDir = join(root, 'js');
const files = readdirSync(jsDir).filter((f) => f.endsWith('.js')).map((f) => join(jsDir, f));

function definedGlobals() {
  const defined = new Set();
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) defined.add(m[1]);
    for (const m of s.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) defined.add(m[1]);
    for (const m of s.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);
  }
  return defined;
}

const BUILTINS = new Set(['if', 'else', 'typeof', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Math', 'Date',
  'JSON', 'parseInt', 'parseFloat', 'Promise', 'Set', 'Map', 'Error', 'setTimeout', 'clearTimeout',
  'requestAnimationFrame', 'document', 'window', 'console', 'ic', 'run', 'matchMedia']);

test('every command-palette run() target resolves to a defined function', () => {
  const ui = readFileSync(join(jsDir, 'ui.js'), 'utf8');
  const start = ui.indexOf('const navActions=[');
  assert.ok(start >= 0, 'navActions block found in ui.js');
  const end = ui.indexOf('\n  ];', start);
  assert.ok(end > start, 'navActions block terminated');
  const block = ui.slice(start, end);
  const defined = definedGlobals();
  const missing = new Set();
  for (const m of block.matchAll(/run:\(\)=>(\{[\s\S]*?\}|[^,}]*\([^)]*\))/g)) {
    const body = m[1];
    for (const call of body.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = call[1];
      if (BUILTINS.has(name) || defined.has(name)) continue;
      missing.add(name);
    }
  }
  assert.deepEqual([...missing], [], 'palette actions calling undefined functions');
});

test('the six never-implemented palette handlers are no longer advertised', () => {
  const ui = readFileSync(join(jsDir, 'ui.js'), 'utf8');
  for (const name of ['showDailyBriefCard', 'showWeeklyReviewCard', 'rephraseActiveTaskTitle',
    'suggestTagsForTask', 'saveCurrentTaskAsTemplate', 'showApplyTemplateCard']) {
    assert.ok(!new RegExp(`run:\\(\\)=>${name}\\(`).test(ui), `${name} must not be a palette target`);
  }
});
