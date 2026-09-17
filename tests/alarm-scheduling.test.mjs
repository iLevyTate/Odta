/**
 * Alarm scheduling (js/alarm-store.js, js/alarms.js, sw.js, js/timer.js,
 * js/tasks.js).
 *
 * The reported symptom: with the PWA installed but not on screen, the timer
 * "inconsistently or most of the time" doesn't ring — you have to keep the app
 * pulled up for notifications to work.
 *
 * Root cause: delivery was entirely page-driven. onPhaseComplete() and
 * checkReminders() called notify() at the moment the MAIN THREAD noticed a
 * deadline had passed, and the service worker only ever rendered what it was
 * handed (SHOW_NOTIFICATION). A backgrounded PWA does not keep a main thread:
 * the browser throttles its timers, then freezes the page (suspending its
 * dedicated Workers, so audio.js's 1s tick stops too), then discards it. The
 * silent-oscillator keepalive holds that off on desktop and not at all on iOS,
 * where WebKit suspends the AudioContext on background — hence "periodically".
 *
 * The fix moves the DECISION off the page: pending deadlines are written to an
 * IndexedDB both contexts can read, parked on Notification Triggers where the
 * platform has them, and flushed by the service worker on any wake. These
 * tests pin the contract so it can't quietly regress back to page-only.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const storeSrc = read('js', 'alarm-store.js');
const alarmsSrc = read('js', 'alarms.js');
const swSrc = read('sw.js');
const timerSrc = read('js', 'timer.js');
const tasksSrc = read('js', 'tasks.js');
const appSrc = read('js', 'app.js');
const htmlSrc = read('index.html');

/**
 * Slice a top-level function body by brace matching. These are written on one
 * dense line in timer.js, so a `\n}` terminator never matches.
 */
function fnBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

test('the shared store is loadable from both a window and a worker scope', () => {
  // It is <script>-ed on the page AND importScripts()-ed by sw.js, so it must
  // stay a classic script that only touches `self`.
  assert.match(storeSrc, /\}\)\(self\);\s*$/, 'alarm-store must be IIFE-bound to self');
  assert.doesNotMatch(storeSrc, /^\s*import\s/m, 'no ESM imports — importScripts cannot load them');
  assert.doesNotMatch(storeSrc, /\bdocument\./, 'no DOM access — there is no document in a SW');
  assert.match(swSrc, /importScripts\('\.\/js\/alarm-store\.js'\)/);
  assert.match(htmlSrc, /<script src="js\/alarm-store\.js"><\/script>/);
  assert.match(htmlSrc, /<script src="js\/alarms\.js"><\/script>/);
});

test('alarm scripts load before the modules that register sources', () => {
  const iStore = htmlSrc.indexOf('js/alarm-store.js');
  const iAlarms = htmlSrc.indexOf('js/alarms.js');
  const iTimer = htmlSrc.indexOf('js/timer.js');
  const iTasks = htmlSrc.indexOf('js/tasks.js');
  assert.ok(iStore > -1 && iAlarms > iStore, 'alarms.js must follow alarm-store.js');
  assert.ok(iTimer > iAlarms, 'timer.js registers a source, so it must load after alarms.js');
  assert.ok(iTasks > iAlarms, 'tasks.js registers a source, so it must load after alarms.js');
});

test('both new scripts are precached so offline installs keep alarms working', () => {
  assert.match(swSrc, /'\.\/js\/alarm-store\.js',/);
  assert.match(swSrc, /'\.\/js\/alarms\.js',/);
});

test('the service worker decides when, not just what to draw', () => {
  // The whole point: a wake from ANY source flushes overdue alarms.
  assert.match(swSrc, /async function flushDueAlarms\(/);
  assert.match(swSrc, /function serviceAlarms\(/);
  for (const [evt, why] of [
    ["activate", 'an update that lands while away must deliver'],
    ["message", 'the page pushed a new alarm set'],
    ["periodicsync", 'the coarse day-scale safety net'],
    ["sync", 'one-off background sync'],
  ]) {
    assert.ok(
      new RegExp(`addEventListener\\('${evt}'`).test(swSrc),
      `sw.js must handle '${evt}' — ${why}`,
    );
  }
  // The fetch handler is the one that rescues a frozen page: any request into
  // scope wakes the worker, and it delivers then.
  assert.match(swSrc, /_lastFetchFlush[\s\S]{0,200}e\.waitUntil\(serviceAlarms\(\)\)/,
    'fetch must opportunistically flush (throttled)');
});

test('the SW timer is an optimisation, never the mechanism', () => {
  // A service worker is killed after seconds of idle, so a setTimeout out to a
  // 25-minute phase end would simply never fire. Arming must be bounded, with
  // the wake-flush carrying everything beyond the horizon.
  const m = swSrc.match(/const ALARM_TIMER_HORIZON_MS\s*=\s*([^;]+);/);
  assert.ok(m, 'missing ALARM_TIMER_HORIZON_MS');
  const horizon = Function('"use strict";return (' + m[1] + ')')();
  assert.ok(horizon <= 5 * 60 * 1000,
    `arming horizon must stay short (a SW does not live for minutes), got ${horizon}ms`);
  assert.match(swSrc, /if\(delay > ALARM_TIMER_HORIZON_MS\) return;/);
});

test('an alarm the SW delivered is not announced a second time by the page', () => {
  // The duplicate-notification bug: the SW rings while backgrounded, then the
  // page's catch-up tick rings again on return.
  assert.match(timerSrc, /function notifyAlarm\(alarmId, title, body, opts\)\{/);
  assert.match(timerSrc, /window\.OdtaAlarms\.wasFired\(alarmId\)[\s\S]{0,120}return;/);
  // Every completion path must go through the guarded helper, not raw notify().
  assert.match(timerSrc, /notifyAlarm\('pomo',\s*getPL\(phase\)\+' Complete'/);
  assert.match(timerSrc, /notifyAlarm\('qt:'\+qt\.id,'Timer done'/);
  assert.doesNotMatch(timerSrc, /\n\s*notify\(getPL\(phase\)\+' Complete'/,
    'phase completion must not call notify() directly any more');
  // Reminders carry an alarmId through the same gate.
  assert.match(tasksSrc, /alarmId: 'task:'\+t\.id/);
  assert.match(tasksSrc, /OdtaAlarms\.wasFired\(alarmId\)[\s\S]{0,140}return;/);
  // And the SW stamps delivery so the page can see it.
  assert.match(swSrc, /store\.markFired\(a\.id, now\)/);
  assert.match(swSrc, /type: 'ALARM_FIRED'/);
});

test('the page learns what fired BEFORE it runs its own catch-up', () => {
  // refreshFired() must precede rebuild() at boot, otherwise the first
  // checkReminders()/tick() pass re-announces everything the SW delivered.
  const boot = appSrc.match(/bootAlarms[\s\S]*?\}\)\(\);/);
  assert.ok(boot, 'missing bootAlarms');
  const iRefresh = boot[0].indexOf('refreshFired');
  const iRebuild = boot[0].indexOf('rebuild');
  assert.ok(iRefresh > -1 && iRebuild > iRefresh,
    'refreshFired() must run before rebuild()');
  assert.match(alarmsSrc, /if \(document\.hidden\) _onHide\(\);\s*else refreshFired\(\)/,
    'returning to the foreground must refresh the fired set first');
});

test('the alarm set is pushed down on every path out of the foreground', () => {
  // freeze/pagehide are the events that actually fire when a mobile OS takes
  // the app away; visibilitychange is the desktop-tab case. Missing one means
  // the SW is left holding a stale deadline.
  for (const evt of ['visibilitychange', 'pagehide', 'freeze']) {
    assert.ok(new RegExp(`'${evt}'`).test(alarmsSrc), `alarms.js must listen for '${evt}'`);
  }
});

test('sources project live state, so a cancelled timer cannot leave an alarm ringing', () => {
  assert.match(timerSrc, /function _pomodoroAlarms\(\)\{/);
  assert.match(timerSrc, /function _quickTimerAlarms\(\)\{/);
  assert.match(tasksSrc, /function _taskReminderAlarms\(\)\{/);
  // A paused / stopped timer contributes nothing at all.
  assert.match(timerSrc, /if\(!running \|\| !Number\.isFinite\(startedAt\)\) return \[\];/);
  assert.match(timerSrc, /quickTimers\.filter\(qt => qt && qt\.running && !qt\.finished\)/);
  // replaceAll is a wholesale swap — that is what makes the above sufficient.
  assert.match(alarmsSrc, /st\.replaceAll\(list\)/);
  assert.match(storeSrc, /if \(!keep\[id\]\) store\.delete\(id\);/);
  // Every transition that moves a deadline re-pushes.
  for (const fn of ['startTimer', 'pauseTimer', 'resumeTimer', 'toggleQuickTimer']) {
    const body = fnBody(timerSrc, fn);
    assert.ok(body, `cannot locate ${fn}`);
    assert.match(body, /OdtaAlarms\.schedule\(\)/, `${fn} must re-push the alarm set`);
  }
});

test('a rescheduled alarm rings again; an untouched one keeps its fired flag', () => {
  // Carrying firedAt across a rebuild is what stops duplicates. Carrying it
  // across a CHANGED deadline would silently swallow the new alarm.
  assert.match(storeSrc, /var carry = \(prev && prev\.at === a\.at\);/);
  assert.match(storeSrc, /firedAt: carry \? \(prev\.firedAt \|\| 0\) : 0/);
});

test('task reminder projection is bounded', () => {
  // Parking hundreds of OS-level triggers is abusive and browsers cap it.
  const horizon = tasksSrc.match(/const REMINDER_ALARM_HORIZON_MS\s*=\s*([^;]+);/);
  const max = tasksSrc.match(/const REMINDER_ALARM_MAX\s*=\s*(\d+);/);
  assert.ok(horizon && max, 'missing reminder projection bounds');
  assert.ok(Number(max[1]) <= 64, 'cap the number of parked reminders');
  assert.match(tasksSrc, /out\.slice\(0, REMINDER_ALARM_MAX\)/);
  // Past-due reminders stay checkReminders()' job — they are not "scheduled".
  assert.match(tasksSrc, /if\(remindTime <= now\) return;/);
  assert.match(alarmsSrc, /if \(a\.at <= now\) return;/);
});

test('Notification Triggers are feature-detected and never assumed', () => {
  assert.match(alarmsSrc, /'showTrigger' in Notification\.prototype/);
  assert.match(alarmsSrc, /typeof self\.TimestampTrigger === 'function'/);
  assert.match(alarmsSrc, /showTrigger: new self\.TimestampTrigger\(a\.at\)/);
  // A rejected trigger must not break the rebuild — layer 2 still covers it.
  assert.match(alarmsSrc, /trigger rejected for/);
  // Obsolete triggers are retired, or a cancelled timer still rings.
  assert.match(alarmsSrc, /getNotifications\(\{ includeTriggered: true \}\)/);
  assert.match(alarmsSrc, /try \{ n\.close\(\); \} catch \(_\) \{\}/);
  // Only ever touch notifications this scheduler owns.
  assert.match(alarmsSrc, /if \(!\(n\.data && n\.data\.odtaAlarmId\)\) return;/);
});

test('scheduling respects the notification opt-out and permission state', () => {
  assert.match(alarmsSrc, /if \(Notification\.permission !== 'granted'\) return false;/);
  assert.match(alarmsSrc, /if \(typeof cfg !== 'undefined' && cfg && cfg\.notif === false\) return false;/);
});

test('the media keepalive is a real element with a non-silent source', () => {
  const audioSrc = read('js', 'audio.js');
  // A muted element takes no audio focus, which defeats the entire purpose.
  assert.doesNotMatch(audioSrc, /_keepaliveEl[\s\S]{0,400}\.muted\s*=\s*true/);
  assert.match(audioSrc, /el\.loop = true;/);
  assert.match(audioSrc, /function _buildKeepaliveWavUrl\(\)\{/);
  // The WAV amplitude must clear Chrome's silence threshold like the
  // oscillator does — a run of zeros would read as silence.
  assert.match(audioSrc, /const amp = Math\.round\(32767 \* KEEPALIVE_GAIN\);/);
  // Started and stopped in lockstep with the oscillator keepalive.
  assert.match(audioSrc, /_startMediaKeepalive\(\);\s*\n\s*_acquireWakeLock\(\);/);
  assert.match(audioSrc, /_stopMediaKeepalive\(\);/);
  // The blob URL is released, or every start/stop cycle leaks one.
  assert.match(audioSrc, /URL\.revokeObjectURL\(_keepaliveEl\.src\)/);
});
