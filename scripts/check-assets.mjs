#!/usr/bin/env node
/**
 * CI check: ensures every <script> and <link rel="stylesheet"> in index.html
 * is listed in the sw.js ASSETS array, and vice versa for JS/CSS files.
 * Run: node scripts/check-assets.mjs
 * Exits 0 on match, 1 on mismatch.
 */
import { readFileSync } from 'fs';
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
const swAssets = new Set(
  [...assetsMatch[1].matchAll(/'([^']+)'|"([^"]+)"/g)]
    .map(m => (m[1] || m[2]).replace(/^\.\//, ''))
);

// Parse <script src="..."> and <link rel="stylesheet" href="..."> from index.html
const htmlAssets = new Set();
for (const m of htmlSrc.matchAll(/<script\s+src="([^"]+)"/g)) {
  htmlAssets.add(m[1]);
}
for (const m of htmlSrc.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"/g)) {
  htmlAssets.add(m[1]);
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

// Check: every JS/CSS in sw.js should exist in index.html (skip non-code assets like icons, manifest, and vendor/ scripts loaded dynamically)
for (const asset of swAssets) {
  const normalized = asset.replace(/^\.\//, '');
  if (!/\.(js|css)$/.test(normalized)) continue;
  if (/vendor\//.test(normalized)) continue; // vendor scripts are dynamically imported
  if (!htmlAssets.has(normalized) && !htmlAssets.has('./' + normalized)) {
    console.error(`sw.js ASSETS lists '${asset}' but index.html doesn't reference it`);
    ok = false;
  }
}

if (!ok) {
  console.error('\n   Fix: update the ASSETS array in sw.js or the <script>/<link> tags in index.html');
  process.exit(1);
}

console.log(`Asset sync OK: ${htmlAssets.size} HTML refs, ${swAssets.size} SW entries`);
