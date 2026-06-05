/**
 * Minimizable timer dock (index.html + css/main.css + js).
 *
 * Minimize shrinks the floating dock to a smaller PILL — the label/time block
 * collapses away while the phase dot, play and minimize controls stay on screen
 * so it's still a recognizable, drivable pill (not a round puck). State persists
 * via cfg.timerDock.minimized + saveState and is re-applied on init.
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

test('a minimize button exists in the dock and toggles minimize', () => {
  assert.ok(/class="timer-dock-min"[^>]*data-action="toggleTimerDockMin"/.test(html), 'minimize button → toggleTimerDockMin');
  // It lives inside the dock element.
  const dock = html.slice(html.indexOf('id="timerDock"'), html.indexOf('</div>', html.indexOf('id="timerDock"')) + 6);
  assert.ok(/timer-dock-min/.test(dock), 'minimize button is inside the timer dock');
});

test('minimized state shrinks to a pill (hides only the label/time)', () => {
  assert.ok(/\.timer-dock--min \.mt-info,\s*\.timer-dock--min \.mt-open\{display:none!important\}/.test(css),
    'the label/time block and open hint are hidden when minimized');
  // The dock is NOT collapsed to a round puck.
  assert.ok(!/\.timer-dock--min\{[^}]*border-radius:999px/.test(css), 'minimized dock is not a round puck');
});

test('minimize is persisted and applied on init', () => {
  const toggle = dockJs.slice(dockJs.indexOf('function toggleTimerDockMin('), dockJs.indexOf('function toggleTimerDockMin(') + 400);
  assert.ok(/c\.minimized = !c\.minimized/.test(toggle), 'toggles cfg.timerDock.minimized');
  assert.ok(/timer-dock--min/.test(toggle), 'toggles the class');
  assert.ok(/saveState\(/.test(toggle), 'persists via saveState');
  assert.ok(/if\(c\.minimized\) dock\.classList\.add\('timer-dock--min'\)/.test(dockJs), 'init re-applies minimized state');
});

test('the phase dot still pulses while a timer runs', () => {
  assert.ok(/\.mt-phase-dot\.running\{animation:pulse/.test(css), 'running phase dot pulses');
});
