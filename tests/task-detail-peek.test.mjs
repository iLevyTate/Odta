/**
 * Side-peek drawer + j/k navigation for the task editor (css/main.css + js/ui.js).
 *
 * On wide viewports the task editor docks to the right edge as a full-height
 * drawer (Linear "peek") so the list stays visible; narrow/touch keep the
 * centered dialog. j / k step between tasks without leaving the panel. These
 * are source-level guards; geometry/behaviour are covered by the puppeteer run.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'css', 'main.css'), 'utf8');
const ui = readFileSync(join(root, 'js', 'ui.js'), 'utf8');

test('wide-viewport drawer rules are scoped to #taskModal at >=900px', () => {
  const m = css.match(/@media \(min-width:900px\)\{([\s\S]*?)\n  \}/);
  assert.ok(m, 'min-width:900px media block present');
  const block = m[1];
  assert.ok(/#taskModal\.modal-overlay\{[^}]*justify-content:flex-end/.test(block), 'overlay docks to the right edge');
  assert.ok(/#taskModal \.modal\{[^}]*transform:translateX\(100%\)/.test(block), 'panel slides in from the right');
  assert.ok(/#taskModal\.modal-overlay\.open \.modal\{transform:translateX\(0\)\}/.test(block), 'open state seats the panel');
  assert.ok(/#taskModal \.modal-body\{[^}]*flex:1/.test(block), 'body fills the drawer height');
});

test('drawer styling does not leak to other modals (scoped to #taskModal)', () => {
  const m = css.match(/@media \(min-width:900px\)\{([\s\S]*?)\n  \}/);
  // Every selector in the block should be qualified with #taskModal.
  const selectors = m[1].split('}').map(s=>s.split('{')[0].trim()).filter(Boolean);
  for (const sel of selectors) {
    assert.ok(sel.includes('#taskModal'), `selector "${sel}" must be scoped to #taskModal`);
  }
});

test('j/k task stepping is wired and guarded against typing', () => {
  assert.ok(/function _taskDetailStep\(dir\)/.test(ui), '_taskDetailStep defined');
  assert.ok(/window\._taskDetailStep\s*=/.test(ui), '_taskDetailStep exposed');
  // The keydown handler ignores text inputs and only acts on the topmost task modal.
  const kd = ui.slice(ui.indexOf("addEventListener('keydown'", ui.indexOf('_bindTaskDetailAutosave')));
  assert.ok(/Modal\.isOpen\('taskModal'\)/.test(kd), 'guarded to the open task modal');
  assert.ok(/tag==='input'\|\|tag==='textarea'/.test(kd), 'ignores typing in fields');
  assert.ok(/e\.key==='j'.*_taskDetailStep\(1\)/s.test(kd), 'j steps forward');
  assert.ok(/e\.key==='k'.*_taskDetailStep\(-1\)/s.test(kd), 'k steps backward');
});
