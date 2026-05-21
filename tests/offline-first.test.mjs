/**
 * Offline-first contract guard.
 *
 * Every runtime dependency (transformers.js, chrono-node, the embedding
 * model) is vendored under js/vendor/ or assets/models/ so the app works
 * fully offline from a fresh install. This test pins that contract:
 *
 *   1. Runtime JS under js/ must not embed jsdelivr / unpkg / huggingface
 *      hosts. (config.js / intel.js / nlparse.js previously pointed at
 *      these and silently re-introducing one would break offline use.)
 *   2. The vendored library + ORT WASM files exist in the repo.
 *   3. sw.js precaches the vendored files so they survive an offline reload.
 *   4. Transformers.js is told `allowRemoteModels = false` and is given a
 *      local model path. Without this, a missing weight quietly falls back
 *      to a Hugging Face fetch and the "offline-by-default" promise is gone.
 *
 * Comment text inside source files is allowed to mention the upstream
 * hosts for historical / documentation purposes — the regex strips
 * comments first.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Strip `// line` and `/* block *​/` comments so source-code asserts ignore documentation. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function walkJs(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip the vendor tree — those files are upstream blobs (transformers
      // bundles its own URL strings; we don't audit those).
      if (entry.name === 'vendor') continue;
      walkJs(full, out);
    } else if (/\.(m?js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const CDN_HOSTS = [
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdnjs.cloudflare.com',
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'hf.co',
];

test('no CDN hosts in runtime JS', () => {
  const files = walkJs(join(root, 'js'));
  for (const file of files) {
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const host of CDN_HOSTS) {
      assert.ok(
        !src.includes(host),
        `${file} contains ${host} — every runtime dep must be vendored under js/vendor/`,
      );
    }
  }
});

test('service worker only references huggingface.co as the model mirror', () => {
  // sw.js is allowed to reach Hugging Face as a one-time mirror for missing
  // model weights (see _remoteModelUrl). No other CDN should appear there.
  const src = stripComments(readFileSync(join(root, 'sw.js'), 'utf8'));
  for (const host of CDN_HOSTS) {
    if (host === 'huggingface.co') continue;
    assert.ok(!src.includes(host), `sw.js references ${host} — passthrough is no longer needed`);
  }
  // And the HF reference must be scoped to the model mirror helper, not a
  // generic passthrough — the constant name pins this.
  assert.match(src, /MODEL_REMOTE_ORIGIN\s*=\s*['"]https:\/\/huggingface\.co['"]/, 'HF host must be the named mirror constant');
});

test('vendored libraries are present', () => {
  // If any of these go missing the app falls back to a broken import.
  const required = [
    'js/vendor/chrono-node.min.mjs',
    'js/vendor/transformers/transformers.min.mjs',
    'js/vendor/transformers/ort-wasm-simd-threaded.jsep.mjs',
    'js/vendor/transformers/ort-wasm-simd-threaded.jsep.wasm',
    'js/vendor/peerjs.min.js',
  ];
  for (const rel of required) {
    const st = statSync(join(root, rel));
    assert.ok(st.size > 0, `${rel} is empty`);
  }
});

test('service worker precaches every vendored file', () => {
  const sw = readFileSync(join(root, 'sw.js'), 'utf8');
  const required = [
    './js/vendor/chrono-node.min.mjs',
    './js/vendor/transformers/transformers.min.mjs',
    './js/vendor/transformers/ort-wasm-simd-threaded.jsep.mjs',
    './js/vendor/transformers/ort-wasm-simd-threaded.jsep.wasm',
  ];
  for (const rel of required) {
    assert.ok(sw.includes(`'${rel}'`), `sw.js ASSETS missing ${rel}`);
  }
});

test('intel.js disables remote model fetches and uses local path', () => {
  const src = readFileSync(join(root, 'js/intel.js'), 'utf8');
  // Local models on, remote models off — both required for offline-first.
  assert.match(src, /env\.allowLocalModels\s*=\s*true/, 'must set env.allowLocalModels = true');
  assert.match(src, /env\.allowRemoteModels\s*=\s*false/, 'must set env.allowRemoteModels = false');
  assert.match(src, /env\.localModelPath\s*=\s*MODEL_BASE_PATH/, 'must point env.localModelPath at MODEL_BASE_PATH');
  // ORT WASM directory has to be pinned too or transformers fetches it from
  // a CDN by default and the offline guarantee evaporates.
  assert.match(src, /env\.backends\.onnx\.wasm\.wasmPaths\s*=\s*TRANSFORMERS_WASM_DIR/, 'must set env.backends.onnx.wasm.wasmPaths');
});

test('config.js exposes the vendored URLs (not CDN URLs)', () => {
  const src = readFileSync(join(root, 'js/config.js'), 'utf8');
  assert.match(src, /TRANSFORMERS_URL:\s*['"]\.\/js\/vendor\/transformers\/transformers\.min\.mjs['"]/);
  assert.match(src, /CHRONO_URL:\s*['"]\.\/js\/vendor\/chrono-node\.min\.mjs['"]/);
  assert.match(src, /MODEL_BASE_PATH:\s*['"]\.\/assets\/models\/['"]/);
});

test('sw _remoteModelUrl translates same-origin model paths to HF URLs', async () => {
  // Load sw.js into a sandbox that fakes the SW globals enough to execute
  // the top-level constants + helper. This pins the URL-mapping contract:
  // missing local model files must fall back to the matching HF resource,
  // not an arbitrary path or a wrong repo.
  const src = readFileSync(join(root, 'sw.js'), 'utf8');
  // Snip the helper + its constants — we don't want to evaluate fetch/install handlers.
  const headerEnd = src.indexOf('const ASSETS');
  assert.ok(headerEnd > 0, 'expected ASSETS declaration to delimit the header block');
  const head = src.slice(0, headerEnd)
    // Strip importScripts (no SW global in node) — version.js is irrelevant here.
    .replace(/importScripts\([^)]*\);?/g, '');
  // The helper returns null if the path doesn't match; we evaluate it via Function
  // to keep the test isolated from the rest of the SW.
  const fn = new Function(`${head}\nreturn _remoteModelUrl;`)();
  assert.strictEqual(
    fn('/assets/models/Xenova/bge-small-en-v1.5/config.json'),
    'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/config.json',
  );
  assert.strictEqual(
    fn('/assets/models/Xenova/bge-small-en-v1.5/onnx/model_quantized.onnx'),
    'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/onnx/model_quantized.onnx',
  );
  // Non-model paths must not be rewritten.
  assert.strictEqual(fn('/index.html'), null);
  assert.strictEqual(fn('/js/intel.js'), null);
  // Malformed (missing file segment) returns null — better to 404 than mangle.
  assert.strictEqual(fn('/assets/models/Xenova/bge-small-en-v1.5/'), null);
});
