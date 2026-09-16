/**
 * Embeddings must not be lost on machines where WebGPU is advertised but
 * unusable. `navigator.gpu` exists in Chrome/Edge on VMs, remote desktops,
 * blocklisted drivers and with hardware acceleration off — there
 * requestAdapter() resolves null. Attempting the WebGPU pipeline in that state
 * wedges the shared ONNX Runtime instance, so the WASM fallback in the catch
 * below it fails too, reporting the *WebGPU* error. Reproduced in headless
 * Chromium (adapter null): the model never loaded, and every Retry repeated
 * the same sequence. With the adapter probed first, the same browser loads the
 * model on WASM in ~1.6 s.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const intelSrc = readFileSync(join(root, 'js', 'intel.js'), 'utf8');
const genSrc = readFileSync(join(root, 'js', 'gen-pipeline.js'), 'utf8');

/** Pull a function body out of a source file by name. */
function fnBody(src, name) {
  const s = src.indexOf('async function ' + name);
  assert.ok(s >= 0, name + ' must exist');
  let i = src.indexOf('{', s), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > s, name + ' body must be balanced');
  return src.slice(s, end);
}

function loadProbe(nav) {
  const body = fnBody(intelSrc, '_probeIntelWebGPU');
  return new Function('navigator', body + '\nreturn _probeIntelWebGPU;')(nav);
}

test('the embedding loader decides on a real adapter, not on navigator.gpu existing', () => {
  const decision = intelSrc.match(/const tryWebGPU = ([^\n;]+);/);
  assert.ok(decision, 'intelLoad still picks a device');
  assert.match(decision[1], /_probeIntelWebGPU\(\)/, 'the device choice comes from the probe');
  assert.doesNotMatch(decision[1], /!!navigator\.gpu/, 'presence of the API is not the test');
});

test('_probeIntelWebGPU: adapter present and device granted → WebGPU', async () => {
  let destroyed = false;
  const probe = loadProbe({
    gpu: { requestAdapter: async () => ({ requestDevice: async () => ({ destroy(){ destroyed = true; } }) }) },
  });
  assert.equal(await probe(), true);
  assert.equal(destroyed, true, 'the probe device is released, not leaked');
});

test('_probeIntelWebGPU: the null-adapter case that wedged ORT → false', async () => {
  // Exactly what headless Chromium and a GPU-blocklisted desktop return.
  const probe = loadProbe({ gpu: { requestAdapter: async () => null } });
  assert.equal(await probe(), false);
});

test('_probeIntelWebGPU: adapter that refuses a device → false', async () => {
  const probe = loadProbe({ gpu: { requestAdapter: async () => ({ requestDevice: async () => null }) } });
  assert.equal(await probe(), false);
});

test('_probeIntelWebGPU: a throwing or absent WebGPU API → false, never a rejection', async () => {
  const thrower = loadProbe({ gpu: { requestAdapter: async () => { throw new Error('GPUAdapter request failed'); } } });
  assert.equal(await thrower(), false);
  const missing = loadProbe({});
  assert.equal(await missing(), false);
});

test('the WASM fallback inside the load path is still there as a second line of defence', () => {
  const load = intelSrc.slice(intelSrc.indexOf('async function intelLoad'));
  assert.match(load, /catch\s*\(e\)\s*\{[\s\S]*device: 'wasm'/,
    'a WebGPU pipeline that fails for some other reason still falls back');
});

test('the generative path keeps its own equivalent probe', () => {
  // The two probes are deliberate twins; intel.js must not grow a dependency
  // on the optional generative module, and neither may lose the adapter check.
  const gen = fnBody(genSrc, '_probeWebGPU');
  assert.match(gen, /requestAdapter\(\)/);
  assert.match(gen, /requestDevice\(\)/);
});
