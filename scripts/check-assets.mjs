#!/usr/bin/env node
/**
 * CI check: ensures every <script> and <link rel="stylesheet"> in index.html
 * is listed in the sw.js ASSETS array, and vice versa for JS/CSS files.
 * Run: node scripts/check-assets.mjs
 * Exits 0 on match, 1 on mismatch.
 */
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const htmlSrc = readFileSync(resolve(root, 'index.html'), 'utf-8');
const swSrc   = readFileSync(resolve(root, 'sw.js'), 'utf-8');

// Parse ASSETS array from sw.js — extract all quoted strings between [ and ];
const assetsMatch = swSrc.match(/const\s+ASSETS\s*=\s*\[([\s\S]*?)\]/);
if (!assetsMatch) {
  console.error('Could not parse ASSETS array from sw.js');
  process.exit(1);
}
// Strip // comments first — an apostrophe inside a comment (e.g. "hasn't")
// would otherwise pair with a real string quote and produce garbage entries.
const assetsBody = assetsMatch[1].replace(/\/\/[^\n]*/g, '');
const swAssets = new Set(
  [...assetsBody.matchAll(/'([^']+)'|"([^"]+)"/g)]
    .map(m => (m[1] || m[2]).replace(/^\.\//, ''))
);

// Parse <script src="..."> and <link rel="stylesheet" href="..."> from
// index.html. Deliberately attribute-order agnostic: `<script type="module"
// src=…>` or `<link href=… rel="stylesheet">` must not silently escape the
// check (a skipped ref would be missing from the SW precache with no CI
// signal).
const htmlAssets = new Set();
for (const m of htmlSrc.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) {
  htmlAssets.add(m[1]);
}
for (const m of htmlSrc.matchAll(/<link\b[^>]*>/g)) {
  if (!/\brel="stylesheet"/.test(m[0])) continue;
  const href = m[0].match(/\bhref="([^"]+)"/);
  if (href) htmlAssets.add(href[1]);
}

let ok = true;

// Check: every JS/CSS in index.html should be in sw.js ASSETS
for (const asset of htmlAssets) {
  const normalized = asset.replace(/^\.\//, '');
  if (!swAssets.has(normalized) && !swAssets.has('./' + normalized)) {
    console.error(`index.html references '${asset}' but sw.js ASSETS is missing it`);
    ok = false;
  }
}

// Modules that are never <script>-tagged because they're loaded dynamically:
// gen-worker.js is spawned as a module Web Worker and gen-pipeline.js is
// imported by both the worker and gen.js's main-thread fallback. They still
// belong in the SW precache so the on-device LLM works offline.
const DYNAMIC_MODULES = new Set(['js/gen-worker.js', 'js/gen-pipeline.js']);

// Check: every JS/CSS in sw.js should exist in index.html (skip non-code assets like icons, manifest, and vendor/ or dynamically-imported scripts)
for (const asset of swAssets) {
  const normalized = asset.replace(/^\.\//, '');
  if (!/\.(js|css)$/.test(normalized)) continue;
  if (/vendor\//.test(normalized)) continue; // vendor scripts are dynamically imported
  if (DYNAMIC_MODULES.has(normalized)) continue; // worker / fallback engine, loaded dynamically
  if (!htmlAssets.has(normalized) && !htmlAssets.has('./' + normalized)) {
    console.error(`sw.js ASSETS lists '${asset}' but index.html doesn't reference it`);
    ok = false;
  }
}

// Check: every referenced local file actually exists on disk. Cross-reference
// alone can't catch a file that was deleted while still listed in BOTH
// index.html and sw.js — the SW tolerates a 404 at precache time
// ('precache-incomplete'), so without this the asset silently vanishes
// offline with no CI signal.
for (const asset of new Set([...htmlAssets, ...swAssets])) {
  if (/^(https?:)?\/\//.test(asset) || asset.startsWith('data:')) continue;
  const relPath = asset.replace(/^\.\//, '').replace(/[?#].*$/, '');
  if (!relPath) continue;
  // Model weights are optional by design — sw.js precaches them tolerantly
  // and they only exist after `npm run fetch-models`.
  if (relPath.startsWith('assets/models/')) continue;
  if (!existsSync(resolve(root, relPath))) {
    console.error(`referenced asset '${asset}' does not exist on disk (${relPath})`);
    ok = false;
  }
}

if (!ok) {
  console.error('\n   Fix: update the ASSETS array in sw.js or the <script>/<link> tags in index.html');
  process.exit(1);
}

console.log(`Asset sync OK: ${htmlAssets.size} HTML refs, ${swAssets.size} SW entries`);
