/**
 * Ctrl/Cmd+K must catch the keystrokes typed right after the shortcut.
 *
 * History: the "unified easing language" rule in css/main.css sets
 * transition-duration on .cmdk-panel without a transition-property, so the
 * panel animated `all`, inherited `visibility` included. .cmdk-overlay flips
 * visibility:hidden → visible on open, so for the panel's first frame the
 * input was still hidden. Modal.open's rAF focus() on #cmdkInput was then a
 * silent no-op, document.activeElement stayed <body>, and "probe" typed after
 * Ctrl+K vanished. Measured in headless Chromium: activeElement was BODY at
 * +0, +50, +150, +400 and +800 ms; clicking the header ⌘K button didn't
 * focus the input either.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'css', 'main.css'), 'utf8');
const modal = readFileSync(join(root, 'js', 'modal.js'), 'utf8');

/** Last transition-property declared for an exact selector list entry. */
function transitionPropertyOf(sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let last = null;
  for (const m of css.matchAll(new RegExp('(?:^|[\\s,}])' + esc + '\\s*\\{([^}]*)\\}', 'g'))) {
    const d = m[1].match(/transition-property:\s*([^;}]+)/);
    if (d) last = d[1].trim();
    const sh = m[1].match(/(?:^|;)\s*transition:\s*([^;}]+)/);
    if (sh) last = sh[1].trim();
  }
  return last;
}

test('.cmdk-panel names its transition properties instead of animating all', () => {
  const tp = transitionPropertyOf('.cmdk-panel');
  assert.ok(tp, '.cmdk-panel needs an explicit transition-property');
  assert.doesNotMatch(tp, /\ball\b/, `.cmdk-panel transition-property is "${tp}"`);
  assert.doesNotMatch(tp, /\bvisibility\b/, 'visibility must not transition on the panel');
});

test('the overlay still owns the visibility flip', () => {
  const open = css.match(/\.cmdk-overlay\.open\{([^}]*)\}/);
  assert.ok(open, '.cmdk-overlay.open rule missing');
  assert.match(open[1], /visibility:visible/);
  assert.match(open[1], /visibility 0s linear 0s/, 'open must show the overlay without delay');
});

test('Modal retries an immediate focus that did not take once the overlay settles', () => {
  // settle() runs on transitionend or the 400 ms safety timer.
  const settle = modal.match(/const settle = function\(\)\{([\s\S]*?)\n\s{6}\};/);
  assert.ok(settle, 'settle() not found in js/modal.js');
  assert.match(settle[1], /deferFocus\s*\|\|\s*!el\.contains\(document\.activeElement\)/,
    'settle must re-apply focus when it is not already inside the overlay');
});

test('openCmdK still asks Modal to focus the input', () => {
  const ui = readFileSync(join(root, 'js', 'ui.js'), 'utf8');
  const fn = ui.match(/function openCmdK\(opts\)\{([\s\S]*?)\n\}/);
  assert.ok(fn);
  assert.match(fn[1], /Modal\.open\('cmdkOverlay',\s*\{[^}]*focus:'#cmdkInput'/);
});
