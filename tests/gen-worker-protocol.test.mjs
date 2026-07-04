/**
 * Verifies the main-thread proxy in js/gen.js drives the generative LLM Web
 * Worker through the documented message protocol — and, crucially, that the
 * proxy NEVER blocks the main thread on inference: it posts a message and
 * awaits an async reply. This is the structural regression guard for the
 * "UI froze mid-analysis" bug that motivated moving the pipeline off-thread.
 *
 * We don't spin up a real Worker (that would download a model); instead a fake
 * Worker captures the posted messages and lets the test play the worker's
 * replies, so we can assert load/generate/token/result/abort/error handling.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'gen.js'), 'utf8');
const workerSrc = readFileSync(join(root, 'js', 'gen-worker.js'), 'utf8');

test('model switch frees the prior pipeline (no leak): both load paths dispose before recreating', () => {
  // Worker path: the 'load' handler must dispose the existing engine before
  // overwriting it, or switching presets leaks the old model's weights
  // (WASM heap / WebGPU buffers).
  const loadCase = workerSrc.slice(workerSrc.indexOf("case 'load'"), workerSrc.indexOf("case 'abort-load'"));
  const disposeIdx = loadCase.indexOf('engine.dispose()');
  const createIdx = loadCase.indexOf('createGenEngine(');
  assert.ok(disposeIdx >= 0, "worker 'load' must dispose the prior engine");
  assert.ok(createIdx >= 0, "worker 'load' must create the engine");
  assert.ok(disposeIdx < createIdx, 'dispose must happen before the new engine is created');

  // Main-thread fallback: same guard in _genLoadInThread.
  const inThread = src.slice(src.indexOf('async function _genLoadInThread'));
  assert.match(inThread.slice(0, 300), /_genEngine\.dispose\(\)/, 'in-thread loader must dispose the prior engine');
});

function loadGen() {
  const storage = {};
  const fakeLocalStorage = {
    getItem: (k) => (k in storage) ? storage[k] : null,
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
  };
  const win = { addEventListener: () => {}, removeEventListener: () => {} };

  let lastWorker = null;
  class FakeWorker {
    constructor(url, opts) {
      this.url = url;
      this.opts = opts;
      this.posted = [];
      this.terminated = false;
      this.onmessage = null;
      this.onerror = null;
      this.onmessageerror = null;
      lastWorker = this;
    }
    postMessage(msg) { this.posted.push(msg); }
    terminate() { this.terminated = true; }
    /** Test helper: deliver a worker→main message. */
    emit(data) { if (this.onmessage) this.onmessage({ data }); }
    /** Test helper: simulate a worker crash. */
    crash(message) { if (this.onerror) this.onerror({ message }); }
  }

  const ctx = {
    window: win,
    localStorage: fakeLocalStorage,
    console,
    caches: undefined,
    Worker: FakeWorker,
    AbortController,
  };
  const fn = new Function(...Object.keys(ctx), src);
  fn(...Object.values(ctx));
  return { win, getWorker: () => lastWorker };
}

test('worker load: posts a load message and reflects the worker reply into state', async () => {
  const { win, getWorker } = loadGen();
  const progressEvents = [];
  const loadPromise = win.genLoad('onnx-community/Qwen2.5-0.5B-Instruct', 'q4', (ev) => progressEvents.push(ev));

  const w = getWorker();
  assert.ok(w, 'a worker should have been spawned');
  assert.equal(w.opts.type, 'module', 'worker must be a module worker');
  const loadMsg = w.posted.find(m => m.type === 'load');
  assert.ok(loadMsg, 'a load message must be posted');
  assert.equal(loadMsg.modelId, 'onnx-community/Qwen2.5-0.5B-Instruct');
  assert.ok(loadMsg.transformersUrl, 'load message carries the transformers url');
  assert.equal(win.isGenLoading(), true);

  // Worker streams download progress, then reports success.
  w.emit({ type: 'progress', ev: { progress: 42, status: 'downloading' } });
  w.emit({ type: 'loaded', device: 'wasm', modelId: 'onnx-community/Qwen2.5-0.5B-Instruct', finalSlug: 'onnx-community/Qwen2.5-0.5B-Instruct' });

  await loadPromise;
  assert.deepEqual(progressEvents, [{ progress: 42, status: 'downloading' }]);
  assert.equal(win.isGenReady(), true);
  assert.equal(win.isGenLoading(), false);
  assert.equal(win.getGenDevice(), 'wasm');
  assert.equal(win.getGenModel(), 'onnx-community/Qwen2.5-0.5B-Instruct');
});

test('worker load: a load-error rejects with the worker message and leaves LLM not-ready', async () => {
  const { win, getWorker } = loadGen();
  const loadPromise = win.genLoad('onnx-community/Qwen2.5-0.5B-Instruct', 'q4');
  getWorker().emit({ type: 'load-error', message: 'Unauthorized 401' });
  await assert.rejects(loadPromise, /Unauthorized/);
  assert.equal(win.isGenReady(), false);
  assert.equal(win.isGenLoading(), false);
});

async function loadReady(harness) {
  const p = harness.win.genLoad('onnx-community/Qwen2.5-0.5B-Instruct', 'q4');
  harness.getWorker().emit({ type: 'loaded', device: 'wasm', modelId: 'onnx-community/Qwen2.5-0.5B-Instruct', finalSlug: 'onnx-community/Qwen2.5-0.5B-Instruct' });
  await p;
}

test('worker generate: posts a generate message, streams tokens, and resolves with the result', async () => {
  const harness = loadGen();
  await loadReady(harness);
  const { win, getWorker } = harness;
  const w = getWorker();

  const tokens = [];
  const genPromise = win.genGenerate({
    messages: [{ role: 'user', content: 'hi' }],
    onToken: (t) => tokens.push(t),
  });

  const genMsg = w.posted.find(m => m.type === 'generate');
  assert.ok(genMsg, 'a generate message must be posted');
  assert.equal(typeof genMsg.reqId, 'number');
  assert.deepEqual(genMsg.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(win.isGenGenerating(), true);

  w.emit({ type: 'token', reqId: genMsg.reqId, text: 'Hel' });
  w.emit({ type: 'token', reqId: genMsg.reqId, text: 'lo' });
  w.emit({ type: 'result', reqId: genMsg.reqId, text: 'Hello' });

  const out = await genPromise;
  assert.equal(out, 'Hello');
  assert.deepEqual(tokens, ['Hel', 'lo']);
  assert.equal(win.isGenGenerating(), false);
});

test('worker generate: a pre-aborted signal rejects up-front and never posts a generate', async () => {
  const harness = loadGen();
  await loadReady(harness);
  const { win, getWorker } = harness;
  const w = getWorker();
  const before = w.posted.length;

  const ctl = new AbortController();
  ctl.abort(); // already aborted before the call
  const genPromise = win.genGenerate({ messages: [{ role: 'user', content: 'hi' }], signal: ctl.signal });

  await assert.rejects(genPromise, /GEN_ABORTED/);
  // Critical: the worker would process our 'abort' before registering the
  // request (losing the interrupt) and then run to completion — so we must not
  // start the generation at all when the caller's signal is already aborted.
  assert.ok(
    !w.posted.slice(before).some(m => m.type === 'generate'),
    'no generate message must be posted for a pre-aborted signal',
  );
  assert.equal(win.isGenGenerating(), false);
});

test('worker abort: aborting the signal posts an abort for that reqId and surfaces GEN_ABORTED', async () => {
  const harness = loadGen();
  await loadReady(harness);
  const { win, getWorker } = harness;
  const w = getWorker();

  const ctl = new AbortController();
  const genPromise = win.genGenerate({ messages: [{ role: 'user', content: 'long task' }], signal: ctl.signal });
  const genMsg = w.posted.find(m => m.type === 'generate');

  ctl.abort();
  const abortMsg = w.posted.find(m => m.type === 'abort' && m.reqId === genMsg.reqId);
  assert.ok(abortMsg, 'aborting the signal must post an abort for the matching reqId');

  // The worker honors the interrupt and reports the aborted generation.
  w.emit({ type: 'gen-error', reqId: genMsg.reqId, message: 'GEN_ABORTED' });
  await assert.rejects(genPromise, /GEN_ABORTED/);
  assert.equal(win.isGenGenerating(), false);
});

test('genAbort / genAbortLoad / genDispose post the broadcast control messages', async () => {
  const harness = loadGen();
  await loadReady(harness);
  const { win, getWorker } = harness;
  const w = getWorker();

  win.genAbort();
  assert.ok(w.posted.some(m => m.type === 'abort-all'), 'genAbort broadcasts abort-all');

  win.genAbortLoad();
  assert.ok(w.posted.some(m => m.type === 'abort-load'), 'genAbortLoad posts abort-load');

  win.genDispose();
  assert.ok(w.posted.some(m => m.type === 'dispose'), 'genDispose posts dispose');
  assert.equal(win.isGenReady(), false);
});

test('worker crash: onerror rejects in-flight generations and marks the LLM not-ready', async () => {
  const harness = loadGen();
  await loadReady(harness);
  const { win, getWorker } = harness;
  const w = getWorker();

  const genPromise = win.genGenerate({ messages: [{ role: 'user', content: 'group my tasks' }] });
  assert.ok(w.posted.find(m => m.type === 'generate'));

  // Simulate the worker thread dying mid-analysis (e.g. ONNX OOM kill).
  w.crash('worker terminated');

  await assert.rejects(genPromise, /worker terminated/);
  assert.equal(win.isGenReady(), false);
  assert.equal(win.isGenGenerating(), false);
  assert.ok(w.terminated, 'the dead worker is terminated so a fresh one can be spawned');
});

// ── Abort watchdog: a WEDGED worker (stuck in native ONNX code, never
// answering the abort message) must not leave genGenerate unsettled forever —
// that stuck _genGenInFlight made Stop a permanent no-op. Fake timers capture
// the watchdog callback so the tests control when it "fires".
function loadGenFakeTimers() {
  const storage = {};
  const fakeLocalStorage = {
    getItem: (k) => (k in storage) ? storage[k] : null,
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
  };
  const win = { addEventListener: () => {}, removeEventListener: () => {} };

  let lastWorker = null;
  class FakeWorker {
    constructor(url, opts) {
      this.url = url; this.opts = opts; this.posted = []; this.terminated = false;
      this.onmessage = null; this.onerror = null; this.onmessageerror = null;
      lastWorker = this;
    }
    postMessage(msg) { this.posted.push(msg); }
    terminate() { this.terminated = true; }
    emit(data) { if (this.onmessage) this.onmessage({ data }); }
  }

  const timers = { seq: 0, pending: new Map(), cleared: [] };
  const fakeSetTimeout = (fn, ms) => { const id = ++timers.seq; timers.pending.set(id, { fn, ms }); return id; };
  const fakeClearTimeout = (id) => { timers.cleared.push(id); timers.pending.delete(id); };

  const ctx = {
    window: win,
    localStorage: fakeLocalStorage,
    console,
    caches: undefined,
    Worker: FakeWorker,
    AbortController,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
  };
  const fn = new Function(...Object.keys(ctx), src);
  fn(...Object.values(ctx));
  return { win, getWorker: () => lastWorker, timers };
}

test('abort watchdog: a wedged worker gets terminated and the caller sees GEN_ABORTED', async () => {
  const harness = loadGenFakeTimers();
  const { win, getWorker, timers } = harness;
  const p = win.genLoad('onnx-community/Qwen2.5-0.5B-Instruct', 'q4');
  getWorker().emit({ type: 'loaded', device: 'wasm', modelId: 'onnx-community/Qwen2.5-0.5B-Instruct', finalSlug: 'onnx-community/Qwen2.5-0.5B-Instruct' });
  await p;
  const w = getWorker();

  const ctl = new AbortController();
  const genPromise = win.genGenerate({ messages: [{ role: 'user', content: 'long task' }], signal: ctl.signal });
  const genMsg = w.posted.find(m => m.type === 'generate');

  ctl.abort();
  assert.ok(w.posted.some(m => m.type === 'abort' && m.reqId === genMsg.reqId), 'abort posted');
  const watchdog = [...timers.pending.values()].find(t => t.ms >= 5000);
  assert.ok(watchdog, 'an abort watchdog timer must be armed');

  // The worker never answers (wedged in native code) — the watchdog fires.
  watchdog.fn();

  await assert.rejects(genPromise, /GEN_ABORTED/, 'caller sees the abort, not a hang');
  assert.equal(win.isGenGenerating(), false, 'in-flight refcount must unstick');
  assert.equal(win.isGenReady(), false, 'wedged worker is torn down');
  assert.ok(w.terminated, 'wedged worker is terminated');

  // A fresh load must spawn a NEW worker (the dead one was discarded).
  const p2 = win.genLoad('onnx-community/Qwen2.5-0.5B-Instruct', 'q4');
  const w2 = getWorker();
  assert.notStrictEqual(w2, w, 'next load spawns a fresh worker');
  w2.emit({ type: 'loaded', device: 'wasm', modelId: 'onnx-community/Qwen2.5-0.5B-Instruct', finalSlug: 'onnx-community/Qwen2.5-0.5B-Instruct' });
  await p2;
  assert.equal(win.isGenReady(), true);
});

test('abort watchdog: a cooperative abort clears the watchdog and keeps the worker', async () => {
  const harness = loadGenFakeTimers();
  const { win, getWorker, timers } = harness;
  const p = win.genLoad('onnx-community/Qwen2.5-0.5B-Instruct', 'q4');
  getWorker().emit({ type: 'loaded', device: 'wasm', modelId: 'onnx-community/Qwen2.5-0.5B-Instruct', finalSlug: 'onnx-community/Qwen2.5-0.5B-Instruct' });
  await p;
  const w = getWorker();

  const ctl = new AbortController();
  const genPromise = win.genGenerate({ messages: [{ role: 'user', content: 'long task' }], signal: ctl.signal });
  const genMsg = w.posted.find(m => m.type === 'generate');

  ctl.abort();
  const armed = [...timers.pending.keys()];
  assert.ok(armed.length > 0, 'watchdog armed on abort');

  // Worker honors the interrupt in time.
  w.emit({ type: 'gen-error', reqId: genMsg.reqId, message: 'GEN_ABORTED' });
  await assert.rejects(genPromise, /GEN_ABORTED/);

  assert.ok(armed.every(id => timers.cleared.includes(id)), 'watchdog cleared on settle');
  assert.equal(w.terminated, false, 'healthy worker must NOT be recycled');
  assert.equal(win.isGenReady(), true, 'LLM stays ready after a cooperative abort');
});
