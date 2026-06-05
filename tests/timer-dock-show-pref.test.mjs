/**
 * "Show floating timer on other tabs" preference (Timer tab toggle).
 *
 * The floating dock used to always appear on non-Timer tabs. Users can now turn
 * it off from a subtle toggle on the Focus Timer panel; when off, updateMiniTimer
 * keeps the dock fully off-page everywhere except the Timer tab. State persists
 * via cfg.showTimerDock + saveState, and the toggle reflects the saved value on
 * load.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const ui = readFileSync(join(root, 'js', 'ui.js'), 'utf8');
const timer = readFileSync(join(root, 'js', 'timer.js'), 'utf8');
const storage = readFileSync(join(root, 'js', 'storage.js'), 'utf8');

test('the Focus Timer panel exposes a togDock switch wired to toggleOpt', () => {
  const pomo = html.slice(html.indexOf('data-timer-sub="pomo"'), html.indexOf('data-timer-sub="quick"'));
  assert.ok(/id="togDock"[^>]*role="switch"/.test(pomo), 'togDock switch lives on the Focus Timer panel');
  assert.ok(/id="togDock"[^>]*data-action="toggleOpt"[^>]*data-arg="togDock"|data-arg="togDock"/.test(pomo), 'togDock dispatches toggleOpt');
});

test('toggleOpt maps togDock to cfg.showTimerDock and refreshes the dock', () => {
  assert.ok(/id===['"]togDock['"]\)\{cfg\.showTimerDock=on;/.test(timer), 'togDock sets cfg.showTimerDock');
  assert.ok(/togDock['"]\)\{cfg\.showTimerDock=on;if\(typeof updateMiniTimer/.test(timer), 'togDock re-runs updateMiniTimer');
});

test('updateMiniTimer keeps the dock off-page when the preference is off', () => {
  assert.ok(/cfg\.showTimerDock===false\)\{el\.classList\.remove\('visible'\);return\}/.test(ui),
    'updateMiniTimer bails out (no .visible) when showTimerDock is false');
});

test('preference defaults on and is persisted/restored', () => {
  assert.ok(/showTimerDock:true/.test(timer), 'cfg default includes showTimerDock:true');
  assert.ok(/typeof cfg\.showTimerDock!==['"]boolean['"]\) cfg\.showTimerDock=true/.test(storage), 'load guards the default');
  assert.ok(/setToggle\('togDock', cfg\.showTimerDock!==false\)/.test(storage), 'load syncs the switch to saved state');
});
