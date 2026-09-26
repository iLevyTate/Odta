/**
 * Shell / boot-time wiring regressions (index.html CSP, sw.js, timer alarms,
 * app.js catch-up ordering, modal close, tab switching).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('CSP allows blob: media (keepalive element + voice-note playback)', () => {
  const html = read('index.html');
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /media-src 'self' blob:/);
});

test('service worker serves the shell cache-first and fails install on core-asset errors', () => {
  const sw = read('sw.js');
  const nav = sw.slice(sw.indexOf('if(isNavigation){'), sw.indexOf('e.respondWith(\n    caches.match(e.request)'));
  assert.match(nav, /caches\.match\('\.\/index\.html'\)\.then\(cached =>/, 'navigation reads the precached shell first');
  assert.match(nav, /c\.put\('\.\/index\.html', clone\)/, 'background refresh keeps a single shell copy');
  assert.match(sw, /const coreFailed = failed\.filter\(f => !\/assets\\\/models\\\/\/\.test\(f\.url\)\);/);
  assert.match(sw, /throw new Error\('\[sw\] precache failed for core assets/);
});

test('notification clicks prefer an app-shell client', () => {
  const sw = read('sw.js');
  const click = sw.slice(sw.indexOf("addEventListener('notificationclick'"));
  assert.match(click, /const isShell = \(c\) =>/);
  assert.match(click, /focusable\.find\(isShell\)/);
});

test('every timer teardown path re-syncs the shared alarm store', () => {
  const timer = read('js/timer.js');
  for (const name of ['skipPhase', 'resetAll', 'resetPhase', 'removeQuickTimer']) {
    const s = timer.indexOf(`function ${name}(`);
    const e = timer.indexOf('\nfunction ', s + 1);
    const body = timer.slice(s, e > s ? e : undefined);
    assert.match(body, /window\.OdtaAlarms\.schedule\(\)/, `${name} reschedules alarms`);
  }
});

test('alarm store honours the Notifications toggle and permission', () => {
  const alarms = read('js/alarms.js');
  const s = alarms.indexOf('function rebuild(opts) {');
  assert.match(alarms.slice(s, s + 900), /var list = notifGranted\(\) \? collect\(\) : \[\];/);
  const timer = read('js/timer.js');
  assert.match(timer, /window\.OdtaAlarms\.schedule\(\{force:true\}\)/, 'toggle flip re-arms / clears the store');
});

test('boot catch-up completions wait for the fired-alarm list', () => {
  const app = read('js/app.js');
  assert.match(app, /window\._runRehydrateCompletions = \(function\(\)\{/);
  const boot = app.slice(app.indexOf('(function bootAlarms(){'));
  assert.match(boot, /refreshFired\(\)\s*\.then\(\(\) => \{[\s\S]*?_runRehydrateCompletions\(\);[\s\S]*?rebuild\(\{ force: true \}\)/);
  assert.match(app, /notifyAlarm\('qt:'\+qt\.id/, 'quick-timer catch-up dedupes against the SW');
  assert.match(app, /onPhaseComplete\(\{ entrySec: _segmentSec \}\)/, 'linked task is credited');
});

test('closing the task modal no longer swaps the task object out from under the index', () => {
  const ui = read('js/ui.js');
  const s = ui.indexOf('async function closeTaskDetail(');
  const e = ui.indexOf('\nfunction ', s + 1);
  const body = ui.slice(s, e);
  assert.ok(!/tasks\[si\]\s*=\s*snap/.test(body), 'revert-by-replacement removed');
  assert.match(body, /_taskModalSnapshot=null;/);
});

test('switching tabs dismisses (not destroys) a running Ask turn', () => {
  const ui = read('js/ui.js');
  const s = ui.indexOf('function showTab(tab){');
  assert.match(ui.slice(s, s + 500), /cmdkDismiss\(\)/);
  assert.ok(!/function showTab\(tab\)\{\s*if\(typeof closeCmdK==='function'\)closeCmdK\(\);/.test(ui));
});

test('day-view calendar applies feed colours too', () => {
  const ui = read('js/ui.js');
  const s = ui.indexOf("if(calMode==='day'){");
  assert.match(ui.slice(s, s + 400), /_applyCalFeedColors\(container\)/);
});
