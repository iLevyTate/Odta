/**
 * Smoke tests for js/gen.js config bookkeeping — primarily the cfgVersion
 * migration that moves users off the stale Xenova/* slugs onto the current
 * HuggingFaceTB/* defaults. These are safety-critical: if the migration
 * regresses, users silently get stuck on a 401-ing model id.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'gen.js'), 'utf8');

function loadGen(storage = {}, navOverride = null) {
  // Minimal browser-like shim so gen.js's module-top code runs.
  const fakeLocalStorage = {
    getItem: (k) => (k in storage) ? storage[k] : null,
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
  };
  const win = { addEventListener: () => {}, removeEventListener: () => {} };
  const ctx = { window: win, localStorage: fakeLocalStorage, console, caches: undefined };
  if (navOverride) ctx.navigator = navOverride;
  const fn = new Function(...Object.keys(ctx), src);
  fn(...Object.values(ctx));
  return { win, storage };
}

test('gen cfg: fresh user gets HuggingFaceTB default with cfgVersion stamped', () => {
  const { win, storage } = loadGen();
  const cfg = win.getGenCfg();
  assert.equal(cfg.enabled, false);
  assert.match(cfg.modelId, /^HuggingFaceTB\/SmolLM2-135M/, 'the basic 135M model is the default for every device');
  assert.equal(cfg.cfgVersion, 3);
  assert.equal(cfg.timeoutSec, 60);
});

test('gen cfg: stale Xenova id is migrated to current default', () => {
  const { win, storage } = loadGen({
    stupind_gen_cfg: JSON.stringify({
      enabled: true,
      modelId: 'Xenova/SmolLM2-360M-Instruct',
      dtype: 'q4',
      timeoutSec: 60,
      downloaded: true,
    }),
  });
  const cfg = win.getGenCfg();
  assert.match(cfg.modelId, /^HuggingFaceTB\//);
  assert.equal(cfg.downloaded, false, 'migration must force a re-download check');
  assert.equal(cfg.cfgVersion, 3);
});

test('gen cfg v3: a never-downloaded 360M default moves to the basic 135M model', () => {
  const { win } = loadGen({
    stupind_gen_cfg: JSON.stringify({ enabled: true, modelId: 'HuggingFaceTB/SmolLM2-360M-Instruct', dtype: 'q4', cfgVersion: 2, downloadedIds: [], timeoutSec: 30 }),
  });
  const cfg = win.getGenCfg();
  assert.equal(cfg.modelId, 'HuggingFaceTB/SmolLM2-135M-Instruct');
  assert.equal(cfg.cfgVersion, 3);
  assert.equal(cfg.timeoutSec, 60, 'a stored copy of the old 30 s mobile default is lifted');
});

test('gen cfg v3: a downloaded 360M stays put and a hand-set timeout is kept', () => {
  const { win } = loadGen({
    stupind_gen_cfg: JSON.stringify({ enabled: true, modelId: 'HuggingFaceTB/SmolLM2-360M-Instruct', dtype: 'q4', cfgVersion: 2, downloadedIds: ['HuggingFaceTB/SmolLM2-360M-Instruct'], timeoutSec: 45 }),
  });
  const cfg = win.getGenCfg();
  assert.equal(cfg.modelId, 'HuggingFaceTB/SmolLM2-360M-Instruct', 'cached weights keep working — do not force a re-download');
  assert.equal(cfg.downloaded, true);
  assert.equal(cfg.timeoutSec, 45);
});

test('gen cfg v3: the gated onnx-community 360M slug is renamed to the public -ONNX repack', () => {
  const { win } = loadGen({
    stupind_gen_cfg: JSON.stringify({ enabled: true, modelId: 'onnx-community/SmolLM2-360M-Instruct', dtype: 'q4', cfgVersion: 2, downloadedIds: ['onnx-community/SmolLM2-360M-Instruct'] }),
  });
  const cfg = win.getGenCfg();
  assert.equal(cfg.modelId, 'onnx-community/SmolLM2-360M-Instruct-ONNX');
  assert.deepEqual(cfg.downloadedIds, ['onnx-community/SmolLM2-360M-Instruct-ONNX']);
  assert.ok(!win.getGenPresets().some(p => p.id === 'onnx-community/SmolLM2-360M-Instruct'), 'the 401-ing slug is no longer offered as a preset');
});

test('gen presets: sizes are the real weight files and the size label covers both backends', () => {
  const { win } = loadGen();
  const presets = win.getGenPresets();
  const basic = presets[0];
  assert.match(basic.id, /SmolLM2-135M/);
  assert.equal(basic.sizeMb, 180, 'model_q4.onnx (WASM) is 182 MB on the Hub');
  assert.equal(basic.sizeMbGpu, 118, 'model_q4f16.onnx (WebGPU) is 118 MB on the Hub');
  assert.equal(win.genPresetSizeLabel(basic), '118–180 MB');
  assert.equal(win.genPresetSizeLabel({ sizeMb: 50 }), '~50 MB');
  for (const p of presets) assert.ok(p.sizeMbGpu <= p.sizeMb, 'the WASM file is the larger one for ' + p.id);
});

test('gen cfg: valid modern id passes through untouched', () => {
  const { win } = loadGen({
    stupind_gen_cfg: JSON.stringify({
      enabled: true,
      modelId: 'onnx-community/Qwen2.5-0.5B-Instruct',
      dtype: 'q4',
      downloaded: true,
      cfgVersion: 2,
    }),
  });
  const cfg = win.getGenCfg();
  assert.equal(cfg.modelId, 'onnx-community/Qwen2.5-0.5B-Instruct');
  assert.equal(cfg.downloaded, true);
});

test('gen cfg: low-RAM device defaults to 135M Tiny preset', () => {
  const { win } = loadGen({}, { userAgent: 'test', deviceMemory: 2 });
  const cfg = win.getGenCfg();
  assert.match(cfg.modelId, /135M/, 'low-RAM should pick the Tiny preset by default');
});

test('gen cfg: unknown future modelId gets migrated forward', () => {
  const { win } = loadGen({
    stupind_gen_cfg: JSON.stringify({
      enabled: true,
      modelId: 'some-org/SomeFutureModel-That-Isnt-In-Presets',
      dtype: 'q4',
      downloaded: true,
      cfgVersion: 2,
    }),
  });
  const cfg = win.getGenCfg();
  // Not in presets → must migrate to a known id.
  const presets = win.getGenPresets();
  assert.ok(presets.some(p => p.id === cfg.modelId), 'migrated id must be a known preset');
});

test('gen model presets: every preset id is well-formed (org/name)', () => {
  const { win } = loadGen();
  const presets = win.getGenPresets();
  assert.ok(presets.length >= 3);
  for (const p of presets) {
    assert.match(p.id, /^[\w-]+\/[\w.-]+$/, 'preset id must look like org/name: ' + p.id);
    assert.ok(p.dtype, 'dtype required');
    assert.ok(p.sizeMb > 0, 'sizeMb required');
    assert.ok(p.label, 'label required');
  }
});

test('clearAskHistory empties stored history', () => {
  const { win, storage } = loadGen();
  win.pushAskHistory('test one');
  win.pushAskHistory('test two');
  assert.equal(win.getAskHistory().length, 2);
  win.clearAskHistory();
  assert.equal(win.getAskHistory().length, 0);
});

test('pushAskHistory dedupes and caps at 5', () => {
  const { win } = loadGen();
  for (let i = 0; i < 10; i++) win.pushAskHistory('q' + i);
  assert.equal(win.getAskHistory().length, 5);
  // dedupe
  win.pushAskHistory('q9');
  const hist = win.getAskHistory();
  const q9count = hist.filter(h => h.text === 'q9').length;
  assert.equal(q9count, 1);
});

test('gen presets: primary HuggingFaceTB ids have an onnx-community alt slug mapped', () => {
  // The fallback table in gen.js must cover both SmolLM2 HF-TB primaries.
  const src = readFileSync(join(root, 'js', 'gen.js'), 'utf8');
  assert.match(src, /HuggingFaceTB\/SmolLM2-360M-Instruct[\s\S]*onnx-community\/SmolLM2-360M-Instruct/);
  assert.match(src, /HuggingFaceTB\/SmolLM2-135M-Instruct[\s\S]*onnx-community\/SmolLM2-135M-Instruct-ONNX/);
});

test('gen presets: alt-slug fallback is gated behind 401/403/404 heuristic', () => {
  // Sanity — the retry path must NOT fire on generic errors; only missing-file
  // responses. Otherwise a transient network blip would silently flip users
  // to the alternate mirror and keep them there forever. The pipeline engine
  // (shared by the worker and the main-thread fallback) owns this guard.
  const src = readFileSync(join(root, 'js', 'gen-pipeline.js'), 'utf8');
  assert.match(src, /_isMissingFileError/, 'must define _isMissingFileError guard');
  assert.match(src, /altSlug && _isMissingFileError\(e\)/, 'fallback must be gated on missing-file');
});
