#!/usr/bin/env node
/**
 * Atomically bumps the version string in both js/version.js and sw.js.
 * Usage: node scripts/bump-version.mjs v33
 *
 * Updates:
 *   - js/version.js  → ODTAULAI_RELEASE.version, .buildDate, .swCache
 *   - sw.js          → CACHE_NAME
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const version = process.argv[2];
if (!version || version === '-h' || version === '--help') {
  console.error('Usage: node scripts/bump-version.mjs <version>');
  console.error('Example: node scripts/bump-version.mjs v33');
  process.exit(version ? 0 : 1);
}
if (!/^v\d+(?:\.\d+)*$/.test(version)) {
  console.error(`Invalid version '${version}' — expected something like v33 or v33.1`);
  process.exit(1);
}

const cacheName = `odtaulai-${version}`;
const buildDate = new Date().toISOString().slice(0, 10);

// ── Update js/version.js ──────────────────────────────────────────────────
// version.js must work in BOTH window (script tag) and ServiceWorkerGlobalScope
// (importScripts) — assign to `self`, which is defined in both contexts.
const versionPath = resolve(root, 'js/version.js');
const newVersionJs = `/** Single source for release identity. Loadable from both a window
 *  scope (script tag) and a ServiceWorkerGlobalScope (importScripts).
 *  sw.js and pwa.js both read \`swCache\` from here. */
(function(scope){
  scope.ODTAULAI_RELEASE = {
    version: '${version}',
    buildDate: '${buildDate}',
    swCache: '${cacheName}',
  };
})(typeof self !== 'undefined' ? self : this);
`;
writeFileSync(versionPath, newVersionJs, 'utf-8');

// ── Update sw.js CACHE_NAME ───────────────────────────────────────────────
// Match either `const` or `let` — sw.js reassigns CACHE_NAME after
// importScripts('./js/version.js'), so the binding is `let`.
const swPath = resolve(root, 'sw.js');
let swSrc = readFileSync(swPath, 'utf-8');
swSrc = swSrc.replace(
  /(const|let|var)\s+CACHE_NAME\s*=\s*'[^']+'/,
  `$1 CACHE_NAME = '${cacheName}'`
);
writeFileSync(swPath, swSrc, 'utf-8');

// ── Update js/pwa.js inline-SW fallback string ────────────────────────────
// The version-sync test asserts this stays in lock-step with version.js, so
// keep it bumped alongside sw.js to avoid red CI on every release.
const pwaPath = resolve(root, 'js/pwa.js');
let pwaSrc = readFileSync(pwaPath, 'utf-8');
// Match any odtaulai-* literal (not just v-prefixed) so a stale value left
// by a bad bump can still be re-bumped without manual editing.
pwaSrc = pwaSrc.replace(
  /:\s*'odtaulai-[^']+'/,
  `: '${cacheName}'`
);
writeFileSync(pwaPath, pwaSrc, 'utf-8');

console.log(`Bumped to ${version}`);
console.log(`   js/version.js  → version:'${version}', swCache:'${cacheName}', buildDate:'${buildDate}'`);
console.log(`   sw.js           → CACHE_NAME:'${cacheName}'`);
console.log(`   js/pwa.js       → inline fallback:'${cacheName}'`);
