#!/usr/bin/env node
/**
 * Download the embedding model weights into ./assets/models/ so the app
 * works fully offline. Run once on your machine after cloning:
 *
 *   npm run fetch-models
 *
 * Then commit the resulting files so anyone who clones the repo gets the
 * offline-ready build without having to re-fetch.
 *
 * Source: https://huggingface.co/Xenova/bge-small-en-v1.5
 *
 * The list of files mirrors what Transformers.js fetches when loading
 * `pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', { device: 'wasm' })`
 * — see `js/intel.js` for the runtime call. Keep it in sync if the model
 * preset changes (e.g. switching to a WebGPU-only fp16 build).
 */

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_ID = 'Xenova/bge-small-en-v1.5';
const HF_BASE = `https://huggingface.co/${MODEL_ID}/resolve/main`;
const OUT_DIR = join(ROOT, 'assets', 'models', MODEL_ID);

// Files required for the quantized WASM pipeline. If you switch to fp16 /
// fp32 or to a different model, update this list (and the SW precache list
// in sw.js) so both paths stay aligned.
const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'onnx/model_quantized.onnx',
];

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function download(file) {
  const url = `${HF_BASE}/${file}`;
  const out = join(OUT_DIR, file);
  if (await exists(out)) {
    process.stdout.write(`  · ${file} (already present, skipping)\n`);
    return { file, skipped: true };
  }
  await mkdir(dirname(out), { recursive: true });
  process.stdout.write(`  ↓ ${file} ... `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(out, buf);
  process.stdout.write(`${(buf.byteLength / 1024 / 1024).toFixed(1)} MB\n`);
  return { file, bytes: buf.byteLength };
}

console.log(`Fetching ${MODEL_ID} from Hugging Face into ${OUT_DIR}`);
const results = [];
for (const f of FILES) {
  try {
    results.push(await download(f));
  } catch (err) {
    console.error(`  ✗ ${f}: ${err.message}`);
    process.exitCode = 1;
  }
}
const totalBytes = results.reduce((s, r) => s + (r.bytes || 0), 0);
console.log(`Done. Fetched ${totalBytes ? (totalBytes / 1024 / 1024).toFixed(1) + ' MB' : '0 MB'}; ${results.filter(r => r.skipped).length} skipped.`);
console.log(`Next: commit the files under assets/models/ so other clones don't need to re-fetch.`);
