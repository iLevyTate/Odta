/**
 * Fully-minimizable timer dock (index.html + css/main.css + js).
 *
 * The dock's minimize used to only hide the label/time — grip, play and the
 * phase dot stayed on screen. It now collapses fully to a small clock handle
 * (everything else hidden); clicking the handle restores it. State persists via
 * the existing cfg.timerDock.minimized + saveState path.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const css = readFileSync(join(root, 'css', 'main.css'), 'utf8');
const dockJs = readFileSync(join(root, 'js', 'timer-dock.js'), 'utf8');
const ui = readFileSync(join(root, 'js', 'ui.js'), 'utf8');

test('a restore handle exists in the dock and toggles minimize', () => {
  assert.ok(/id="timerDockHandle"[^>]*data-action="toggleTimerDockMin"/.test(html), 'restore handle → toggleTimerDockMin');
  // It lives inside the dock element.
  const dock = html.slice(html.indexOf('id="timerDock"'), html.indexOf('</div>', html.indexOf('id="timerDockHandle"')) + 6);
  assert.ok(/id="timerDockHandle"/.test(dock), 'handle is inside the timer dock');
});

test('minimized state collapses to ONLY the handle', () => {
  assert.ok(/\.timer-dock--min > :not\(\.timer-dock-handle\)\{display:none!important\}/.test(css),
    'everything except the handle is hidden when minimized');
  assert.ok(/\.timer-dock--min \.timer-dock-handle\{display:flex\}/.test(css), 'handle shown when minimized');
  assert.ok(/\.timer-dock-handle\{[^}]*display:none/.test(css), 'handle hidden by default (expanded)');
});

test('minimize is persisted and applied on init', () => {
  const toggle = dockJs.slice(dockJs.indexOf('function toggleTimerDockMin('), dockJs.indexOf('function toggleTimerDockMin(') + 400);
  assert.ok(/c\.minimized = !c\.minimized/.test(toggle), 'toggles cfg.timerDock.minimized');
  assert.ok(/timer-dock--min/.test(toggle), 'toggles the class');
  assert.ok(/saveState\(/.test(toggle), 'persists via saveState');
  assert.ok(/if\(c\.minimized\) dock\.classList\.add\('timer-dock--min'\)/.test(dockJs), 'init re-applies minimized state');
});

test('the dock carries a running flag so the collapsed handle can pulse', () => {
  assert.ok(/el\.classList\.toggle\('timer-running', !!running\)/.test(ui), 'updateMiniTimer sets timer-running on the dock');
  assert.ok(/\.timer-dock--min\.timer-running \.timer-dock-handle\{animation:pulse/.test(css), 'handle pulses while running');
  assert.ok(/prefers-reduced-motion[^}]*\.timer-dock--min\.timer-running \.timer-dock-handle\{animation:none\}/.test(css.replace(/\s+/g, ' ')),
    'pulse respects reduced motion');
});
