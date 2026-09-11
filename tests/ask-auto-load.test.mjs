/**
 * Chat-driven model load (js/ui.js + js/ai.js + js/gen-pipeline.js).
 *
 * Before this wave a question typed before the model was in memory parked
 * behind a "Download local AI" button; after the download ai.js overwrote the
 * whole conversation with a static "ready" line and the user had to retype.
 * The chat now downloads the basic model itself, mirrors progress into the
 * turn bubble, and runs the parked question when the load resolves. These
 * are source-slice guards in the style of cmdk-ask-minimize.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ui = readFileSync(join(root, 'js', 'ui.js'), 'utf8');
const ai = readFileSync(join(root, 'js', 'ai.js'), 'utf8');
const pipe = readFileSync(join(root, 'js', 'gen-pipeline.js'), 'utf8');
const worker = readFileSync(join(root, 'js', 'gen-worker.js'), 'utf8');
const gen = readFileSync(join(root, 'js', 'gen.js'), 'utf8');
const css = readFileSync(join(root, 'css', 'main.css'), 'utf8');

/** Slice a top-level `function name(` body by brace matching. */
function fnBody(src, name) {
  const sig = `function ${name}(`;
  const start = src.indexOf(sig);
  assert.ok(start >= 0, `found ${name}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  throw new Error('unbalanced ' + name);
}

test('cmdkAskSubmit: a question asked before the model is loaded auto-loads instead of parking', () => {
  const body = fnBody(ui, 'cmdkAskSubmit');
  assert.ok(body.includes('_cmdkAskAutoLoadThenRun(turn)'), 'not-ready path hands the turn to the auto loader');
  assert.ok(!body.includes("status: 'need-model'"), 'submit no longer parks the question behind a button');
  assert.ok(body.includes('_cmdkAskRunTurn(turn)'), 'ready path runs the turn');
  // The question must be visible in the chat before any loading starts.
  assert.ok(body.indexOf('_cmdkAskNewTurn(q)') < body.indexOf('_cmdkAskAutoLoadThenRun'), 'turn is pushed before the load begins');
});

test('_cmdkAskAutoLoadThenRun: drives the Settings download path, shows progress, then runs the parked question', () => {
  const body = fnBody(ui, '_cmdkAskAutoLoadThenRun');
  assert.ok(body.includes("status: 'loading-model'"), 'turn shows the loading bubble');
  assert.ok(body.includes('genDownloadClick()'), 'reuses the Settings download flow (chip, ribbon, Settings row stay in sync)');
  assert.ok(body.includes('_cmdkAskWaitForGen()'), 'a load already in flight is awaited, not restarted');
  assert.ok(body.includes('_cmdkAskRunTurn(turn)'), 'the parked question runs once the model is ready');
  assert.ok(body.includes('reqId !== _cmdkAskReqSeq'), 'a superseded turn (closed palette / new chat) never runs');
  assert.ok(body.includes("status: 'need-model'") && body.includes('next.error'), 'a failed load falls back to the need-model bubble with the error');
  // Busy while loading so Esc/backdrop minimizes instead of killing the download.
  assert.ok(body.includes('_cmdkAskBusy = true'), 'loading counts as busy');
});

test('progress hook: ai.js forwards download progress into the chat bubble and only repaints on change', () => {
  const sync = fnBody(ai, '_syncGenDownloadProgress');
  assert.ok(sync.includes('cmdkAskOnGenProgress('), 'ai.js calls the chat progress hook');
  const hook = fnBody(ui, 'cmdkAskOnGenProgress');
  assert.ok(hook.includes("t.status === 'loading-model'"), 'targets the turn that is waiting on the model');
  assert.ok(hook.includes('prev.pct === p && prev.line === txt'), 'skips repaints when nothing visible changed');
});

test('ai.js no longer overwrites the conversation DOM when the model becomes ready', () => {
  const chip = fnBody(ai, 'syncGenChip');
  assert.ok(!chip.includes('cmdkAskReply'), 'syncGenChip must not touch #cmdkAskReply');
  assert.ok(!chip.includes('reply.textContent'), 'no static "ready" line replaces the chat');
  assert.ok(chip.includes('cmdkAskOnGenReady'), 'it asks ui.js to repaint from state instead');
});

test('genDownloadClick resolves to whether the model is actually ready', () => {
  const body = fnBody(ai, 'genDownloadClick');
  assert.ok(body.includes('let loadedOk = false'), 'tracks the outcome');
  assert.ok(body.includes('loadedOk = true'), 'set after genLoad resolves');
  assert.match(body, /return loadedOk && typeof isGenReady === 'function' && isGenReady\(\);/, 'returns the readiness');
  assert.ok(body.includes('return false'), 'bails out with false when there is no loader');
});

test('need-model bubble: every state carries a retry / run action and the real download size', () => {
  const render = fnBody(ui, '_renderAskConversation');
  assert.ok(render.includes("t.status === 'loading-model'"), 'loading bubble is rendered');
  assert.ok(render.includes('cmdk-ask-progress-bar'), 'loading bubble has a progress track');
  assert.ok(render.includes("dataset.action = 'cmdkAskCancelLoad'"), 'download can be cancelled from the bubble');
  assert.ok(render.includes("dataset.action = 'cmdkAskRetryLoad'"), 'failed / parked turns can retry');
  assert.ok(render.includes("dataset.action = 'cmdkAskRerunTurn'"), 'a turn parked while the model loaded elsewhere can run');
  assert.ok(render.includes('info.sizeLabel'), 'size comes from the preset (WebGPU–WASM range), not a hard-coded number');
  assert.ok(!render.includes("dataset.action = 'genDownloadClick'"), 'the old fire-and-forget download button is gone');
  const info = fnBody(ui, '_cmdkAskNeedModelInfo');
  assert.ok(info.includes('genPresetSizeLabel'), 'size label comes from gen.js');
  for (const action of ['cmdkAskCancelLoad', 'cmdkAskRetryLoad', 'cmdkAskRerunTurn']) {
    assert.ok(ui.includes(`function ${action}(`), `${action} handler exists`);
  }
  assert.ok(css.includes('.cmdk-ask-progress-bar'), 'progress track is styled');
});

test('repetition penalty is plumbed main thread → worker → pipeline', () => {
  const gg = fnBody(gen, 'genGenerate');
  assert.ok(gg.includes('repetitionPenalty'), 'genGenerate accepts repetitionPenalty');
  const viaWorker = fnBody(gen, '_genGenerateViaWorker');
  assert.ok(viaWorker.includes('repetitionPenalty: payload.repetitionPenalty'), 'worker message carries it');
  const inThread = fnBody(gen, '_genGenerateInThread');
  assert.ok(inThread.includes('repetitionPenalty: payload.repetitionPenalty'), 'main-thread fallback carries it');
  assert.ok(worker.includes('repetitionPenalty: msg.repetitionPenalty'), 'worker forwards it to the engine');
  assert.match(pipe, /generateOpts\.repetition_penalty = repetitionPenalty/, 'engine passes repetition_penalty to the library');
  assert.match(pipe, /repetitionPenalty > 1\) generateOpts\.repetition_penalty/, 'a value of 1 (off) is not sent');
});

test('abort watchdog gives a single-threaded WASM phone time to finish its current token', () => {
  const m = gen.match(/const GEN_ABORT_WATCHDOG_MS = (\d+);/);
  assert.ok(m, 'watchdog constant present');
  assert.ok(Number(m[1]) >= 15000, 'a 9 s watchdog tore down healthy workers after every timeout');
});
