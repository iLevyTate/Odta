/**
 * v76 second wave — findings from the three-lens audit (notification path,
 * generative stack, timer/background layer) that followed the headline fixes.
 * Functional tests where the code slices cleanly; source-shape guards for the
 * one-line invariants that are easy to regress.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');
const tasksSrc = read('js/tasks.js');
const audioSrc = read('js/audio.js');
const timerSrc = read('js/timer.js');
const aiSrc = read('js/ai.js');
const uiSrc = read('js/ui.js');
const appSrc = read('js/app.js');
const storageSrc = read('js/storage.js');
const genPipeSrc = read('js/gen-pipeline.js');
const genWorkerSrc = read('js/gen-worker.js');
const genSrc = read('js/gen.js');

// ───────────────────────── reminders ─────────────────────────

function runCheckReminders({ tasks, cfg, permission = 'granted', nowMs }) {
  const s = tasksSrc.indexOf('const REMINDER_DUE_STALE_MS');
  const e = tasksSrc.indexOf('// Nudge the user once when they create a remindAt');
  assert.ok(s >= 0 && e > s, 'slice checkReminders');
  const block = tasksSrc.slice(s, e);
  const notified = [];
  const chimes = [];
  const win = { Notification: { permission } };
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(nowMs); }
    static now() { return nowMs; }
  }
  const ctx = {
    tasks, cfg, window: win, Notification: win.Notification, console,
    Date: FakeDate,
    fmtDue: (d) => d, getCategoryDef: () => null,
    notify: (title, body, opts) => notified.push({ title, body, opts }),
    playChime: (c) => chimes.push(c),
    saveState: () => {},
  };
  new Function(...Object.keys(ctx), block + '\ncheckReminders();')(...Object.values(ctx));
  return { notified, chimes };
}

const NOW = new Date('2026-09-06T15:00:00').getTime();

test('checkReminders: a stale implicit due-date reminder is consumed silently, an explicit one still fires as Missed', () => {
  const tasks = [
    { id: 1, name: 'Old due', dueDate: '2026-08-20', status: 'open', reminderFired: false },
    { id: 2, name: 'Explicit', remindAt: '2026-09-01T09:00', status: 'open', reminderFired: false },
  ];
  const { notified } = runCheckReminders({ tasks, cfg: { notif: true, sound: true, dueNotify: true }, nowMs: NOW });
  assert.equal(tasks[0].reminderFired, true, 'stale due-date reminder is marked fired');
  assert.equal(notified.length, 1, 'only the explicit reminder notifies');
  assert.match(notified[0].title, /^Missed: Explicit/);
  assert.equal(notified[0].opts.data.url, './?tab=tasks&task=2', 'cold-open URL carries the task id');
  assert.equal(notified[0].opts.data.taskId, 2);
});

test('checkReminders: today\'s due-date reminder fires as "Due now"', () => {
  const tasks = [{ id: 3, name: 'Today', dueDate: '2026-09-06', status: 'open', reminderFired: false }];
  const { notified } = runCheckReminders({ tasks, cfg: { notif: true, sound: true }, nowMs: NOW });
  assert.equal(notified.length, 1);
  assert.match(notified[0].title, /^Missed: Today|^Due now: Today/);
});

test('checkReminders: more than three at once collapse into one summary notification', () => {
  const tasks = [1, 2, 3, 4, 5].map((i) => ({ id: i, name: 'T' + i, remindAt: '2026-09-06T14:00', status: 'open', reminderFired: false }));
  const { notified } = runCheckReminders({ tasks, cfg: { notif: true, sound: true }, nowMs: NOW });
  assert.equal(notified.length, 1);
  assert.match(notified[0].title, /^5 task reminders/);
  assert.ok(tasks.every((t) => t.reminderFired));
});

test('checkReminders: notifications toggled off (permission still granted) falls back to the chime instead of vanishing', () => {
  const tasks = [{ id: 9, name: 'Chime me', remindAt: '2026-09-06T14:55', status: 'open', reminderFired: false }];
  const { notified, chimes } = runCheckReminders({ tasks, cfg: { notif: false, sound: true }, nowMs: NOW });
  assert.equal(notified.length, 0);
  assert.deepEqual(chimes, ['bell']);
  assert.equal(tasks[0].reminderFired, true);
});

test('checkReminders: a malformed remindAt is cleared once and the due-date path takes over', () => {
  const tasks = [{ id: 4, name: 'Bad', remindAt: 'garbage', dueDate: '2026-09-06', status: 'open', reminderFired: false }];
  const { notified } = runCheckReminders({ tasks, cfg: { notif: true, sound: true }, nowMs: NOW });
  assert.equal(tasks[0].remindAt, null);
  assert.equal(notified.length, 1, 'due-date branch fired in the same pass');
});

// ───────────────────────── quick-add clock roll-forward ─────────────────────────

function loadQuickAdd(fixedNow) {
  const h = tasksSrc.indexOf('function _qaPad2(n)');
  const s = tasksSrc.indexOf('function parseQuickAdd(raw)');
  const e = tasksSrc.indexOf('async function addTask()', s);
  assert.ok(h >= 0 && s > h && e > s);
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(fixedNow.getTime()); }
    static now() { return fixedNow.getTime(); }
  }
  const iso = fixedNow.getFullYear() + '-' + String(fixedNow.getMonth() + 1).padStart(2, '0') + '-' + String(fixedNow.getDate()).padStart(2, '0');
  return new Function('todayISO', 'Date', tasksSrc.slice(h, e) + '\nreturn parseQuickAdd;')(() => iso, FakeDate);
}

test('quick-add: a bare clock earlier than now means tomorrow; later today and explicit dates stay put', () => {
  const parse = loadQuickAdd(new Date(2026, 8, 6, 15, 0, 0)); // 15:00 local
  assert.equal(parse('standup 09:30').props.remindAt, '2026-09-07T09:30');
  assert.equal(parse('standup 09:30').props.dueDate, '2026-09-07');
  assert.equal(parse('lunch at noon').props.remindAt, '2026-09-07T12:00');
  assert.equal(parse('call mom at 4pm').props.remindAt, '2026-09-06T16:00');
  assert.equal(parse('standup 09:30 today').props.remindAt, '2026-09-06T09:30', 'an explicit date is never rolled');
});

// ───────────────────────── download progress aggregator ─────────────────────────

test('progress aggregator: a known shard total is never clobbered by the first zero-loaded event', () => {
  const s = aiSrc.indexOf('function _makeProgressAggregator');
  const e = aiSrc.indexOf('\nfunction ', s + 10);
  assert.ok(s >= 0 && e > s);
  const emitted = [];
  const agg = new Function(aiSrc.slice(s, e) + '\nreturn _makeProgressAggregator;')()((pct) => emitted.push(pct));
  agg({ status: 'progress', file: 'tokenizer.json', loaded: 500000, total: 500000 });
  agg({ status: 'done', file: 'tokenizer.json' });
  agg({ status: 'progress', file: 'model_q4.onnx', loaded: 0, total: 200e6 });
  assert.ok(emitted[emitted.length - 1] <= 1, 'first model event must not report ~50%: ' + emitted.join(','));
  agg({ status: 'progress', file: 'model_q4.onnx', loaded: 100e6, total: 200e6 });
  assert.ok(Math.abs(emitted[emitted.length - 1] - 50) <= 1, 'half the bytes → ~50%: ' + emitted.join(','));
  // The percentage may legitimately drop when a large shard joins the
  // denominator (the old ratio clamp froze it there); what must never
  // regress is the byte-level progress within the known-size set.
  agg({ status: 'progress', file: 'model_q4.onnx', loaded: 90e6, total: 200e6 }); // an out-of-order event
  assert.ok(emitted[emitted.length - 1] >= 50, 'byte progress is monotonic: ' + emitted.join(','));
});

// ───────────────────────── stopwatch chime horizon ─────────────────────────

test('scheduleSwIntervalChimes returns the covered horizon so swTick can re-arm past it', () => {
  const s = audioSrc.indexOf('const SW_LOOKAHEAD_SEC');
  const e = audioSrc.indexOf('function cancelSwIntervalChimes');
  assert.ok(s >= 0 && e > s);
  const node = () => ({ type: '', frequency: { setValueAtTime() {} }, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, start() {}, stop() {} });
  const fakeCtx = { currentTime: 0, destination: {}, createOscillator: node, createGain: node };
  const fn = new Function('cfg', 'getAudioCtx', 'CH', audioSrc.slice(s, e) + '\nreturn scheduleSwIntervalChimes;')(
    { sound: true }, () => fakeCtx, { bell: { freq: [880], type: 'sine', decay: 0.8 } });
  const nodes = [];
  const h = fn(0, [{ id: 1, intervalSec: 10, target: 'sw', chime: 'bell' }], {}, nodes);
  assert.equal(h, 2000, '200-fire cap × 10 s');
  assert.equal(nodes.length, 200);
  const h2 = fn(0, [{ id: 2, intervalSec: 60, target: 'sw', chime: 'bell' }], {}, []);
  assert.equal(h2, 3600, 'lookahead cap');
  assert.equal(fn(0, [], {}, []), null);
  assert.match(timerSrc, /elSec>=swAudioHorizonEl\)\{\s*cancelSwIntervalChimes\(swScheduledIntervalNodes\);\s*swAudioHorizonEl=scheduleSwIntervalChimes\(elSec/, 'swTick re-arms at the horizon');
  assert.match(timerSrc, /function _qtMaybeRearmAudio/, 'quick timers re-arm too');
  assert.equal((timerSrc.match(/\n\s*_qtMaybeRearmAudio\(qt,totalEl\);/g) || []).length, 2, 'both quick tick paths re-arm');
});

// ───────────────────────── source-shape guards ─────────────────────────

test('timer: keepalive is released when a timer completes naturally, is skipped, or is reset', () => {
  const onComplete = timerSrc.slice(timerSrc.indexOf('function onPhaseComplete()'), timerSrc.indexOf('let _pendingAdvanceTimer'));
  assert.match(onComplete, /if\(!willAutoAdvance\) maybeStopKeepalive\(\)/);
  const skip = timerSrc.slice(timerSrc.indexOf('function skipPhase()'), timerSrc.indexOf('async function resetAll'));
  assert.match(skip, /maybeStopKeepalive\(\)/);
  assert.match(timerSrc, /phase='work';pomosInCycle=0;fireCounts=\{\};maybeStopKeepalive\(\);/, 'resetAll');
  assert.match(timerSrc, /cancelScheduledAudio\(\);fireCounts=\{\};maybeStopKeepalive\(\);/, 'resetPhase');
  assert.equal((timerSrc.match(/saveState\('auto'\);\s*maybeStopKeepalive\(\);/g) || []).length, 2, 'both quick-timer completion paths');
});

test('audio: wake-lock request/stop race is guarded and the gesture primer stays armed', () => {
  assert.match(audioSrc, /let _wakeLockWanted=false;/);
  assert.match(audioSrc, /if\(!_wakeLockWanted\|\|_wakeLock\)\{ try\{l\.release\(\)\}catch\(e\)\{\} return; \}/);
  assert.ok(!/document\.removeEventListener\('pointerdown', prime, true\)/.test(audioSrc), 'primer must not disarm itself');
  assert.match(audioSrc, /setActionHandler\('play',\(\)=>\{\s*try\{ if\(!running&&typeof getTimerState==='function'&&getTimerState\(\)==='paused'\) resumeTimer\(\);/, 'play only resumes a paused Pomodoro');
  assert.match(audioSrc, /setActionHandler\('pause',null\)/, 'media handlers cleared on stop');
});

test('audio.notify: the service-worker path falls back to the main thread when the SW refuses', () => {
  const fn = audioSrc.slice(audioSrc.indexOf('function notify(title, body, opts)'), audioSrc.indexOf('// ========== BACKGROUND RESILIENCE'));
  assert.match(fn, /const mainThreadFallback = \(\) => \{/);
  assert.match(fn, /\}\)\.catch\(mainThreadFallback\);/);
  assert.match(fn, /if\(cfg\.notif===false\)return;/, 'undefined cfg.notif no longer suppresses notifications');
});

test('boot: restored quick timers get audio + keepalive; expired ones get their completion; ?task= routes to the task', () => {
  assert.match(appSrc, /if\(qt\._needsCompletion\)\{[\s\S]*?addLog\(qt\.label,qt\.totalSec,'quick'\)/);
  assert.match(appSrc, /else if\(qt\.running\)\{\s*if\(typeof scheduleQtAudio==='function' && cfg\.sound\) scheduleQtAudio\(qt\);\s*if\(typeof startKeepalive==='function'\) startKeepalive\(\);/);
  assert.match(appSrc, /function applyTaskFromUrl\(\)/);
  assert.match(appSrc, /if\(cfg\.linkTask && phase==='work' && activeTaskId && !taskStartedAt\) taskStartedAt = Date\.now\(\);/);
  assert.match(storageSrc, /qt\._needsCompletion=true/);
  assert.match(storageSrc, /quickTimers: quickTimers\.map\(_qtSerializable\)/, 'runtime audio nodes never serialised');
  assert.match(storageSrc, /window\.addEventListener\('pagehide', \(\) => \{ try\{ saveState\('unload'\); \}/);
});

test('storage/sync: cfg is normalised and the Settings switches follow a synced cfg', () => {
  assert.match(storageSrc, /if\(typeof c\.notif!=='boolean'\) c\.notif=true;/);
  assert.match(storageSrc, /setToggle\('togDueNotify', cfg\.dueNotify!==false\);/);
  assert.match(read('js/sync.js'), /syncCfgToggles\(\)/);
  assert.match(read('index.html'), /id="togDueNotify"/);
  assert.match(timerSrc, /if\(id==='togDueNotify'\)\{cfg\.dueNotify=on\}/);
  assert.match(uiSrc, /if\(src\.dueDate!==el\.dataset\.date\)src\.reminderFired=false;/, 'calendar drag-drop re-arms the reminder');
  assert.match(storageSrc, /if\(nd !== T\.dueDate && !\('reminderFired' in obj\)\) T\.reminderFired = false;/, 'import re-arms on a moved due date');
});

test('ai executor: SET_RECUR without a recur value is rejected; RESCHEDULE only re-arms when the reminder time moves', () => {
  assert.match(aiSrc, /case 'SET_RECUR':\{[\s\S]*?if\(a\.recur === undefined && !\('recur' in a\)\) return null;/);
  assert.match(aiSrc, /if\(a\.remindAt != null \|\| \(dueChanged && !t\.remindAt\)\) t\.reminderFired = false;/);
});

test('ai settings: cancelling a download is not reported as a crash', () => {
  assert.match(aiSrc, /if\(raw === 'LOAD_ABORTED' \|\| raw === 'GEN_DISPOSED'\)\{[\s\S]*?showExportToast\('Download cancelled\.'\)/);
});

test('ui: palette abort is scoped to Ask, destructive confirm keeps its chrome, rejected rows are readable', () => {
  const abort = uiSrc.slice(uiSrc.indexOf('function _cmdkAbortAsk()'), uiSrc.indexOf('function cmdkSetAskMode'))
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/genAbort\(\)/.test(abort), '_cmdkAbortAsk must not abort unrelated LLM work');
  assert.match(uiSrc, /showAppConfirm\(msg, \{ destructive: true, okLabel: 'Apply' \}\)/);
  assert.match(uiSrc, /function showAppConfirm\(message, chrome\)/);
  assert.match(uiSrc, /op = String\(rawOp\.name \|\| rawOp\.op \|\| 'op'\);/);
  assert.match(uiSrc, /if\(lbl === turn\.text\) return;/, 'no full re-render per streamed token');
});

test('gen: WASM loads are watchdogged and cancellable; dispose settles a load in flight; worker survives dispose mid-load', () => {
  assert.match(genPipeSrc, /function _watchLoad\(promise, \{ signal, idleMs \} = \{\}\)/);
  assert.match(genPipeSrc, /device: 'wasm',[\s\S]*?\{ signal, idleMs: GEN_LOAD_IDLE_TIMEOUT_MS \}/);
  assert.match(genPipeSrc, /_configureEnv\(fresh\.env\);/, 're-import re-applies env');
  assert.match(genPipeSrc, /'\?'\) \+ 'ortgen=' \+ importGen/, 're-import is cache-busted');
  assert.match(genSrc, /function genDispose\(\)\{[\s\S]*?_genLoading = false;\s*_genLoadPromise = null;/);
  assert.match(genSrc, /function genAbortLoad\(\)\{[\s\S]*?_genTeardownWorker\('LOAD_ABORTED'\)/);
  assert.match(genSrc, /async function _genGenerateInThread[\s\S]*?Promise\.race\(\[/, 'in-thread generation has an abort watchdog');
  assert.match(genWorkerSrc, /const eng = engine;[\s\S]*?if\(engine !== eng\)\{ post\(\{ type: 'load-error', message: 'LOAD_ABORTED' \}\); break; \}/);
});

test('ask: one shared time budget across ops turns, write retry and prose pass', () => {
  const askSrc = read('js/ask.js');
  assert.match(askSrc, /const deadline = Date\.now\(\) \+ totalCapMs;/);
  assert.match(askSrc, /function _askRemainingBudget\(opts, defaultMs\)/);
  assert.equal((askSrc.match(/const budget = _askRemainingBudget\(opts, /g) || []).length, 2);
  assert.match(askSrc, /feedId: e\.feedId != null \? String\(e\.feedId\) : undefined, eventUid: e\.uid/, 'calendar reads expose the ids CREATE_FROM_EVENT needs');
});
