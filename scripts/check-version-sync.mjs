#!/usr/bin/env node
/**
 * CI check: ensures the CACHE_NAME in sw.js matches swCache in js/version.js.
 * Run: node scripts/check-version-sync.mjs
 * Exits 0 on match, 1 on mismatch.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const versionSrc = readFileSync(resolve(root, 'js/version.js'), 'utf-8');
const swSrc      = readFileSync(resolve(root, 'sw.js'), 'utf-8');
const pwaSrc     = readFileSync(resolve(root, 'js/pwa.js'), 'utf-8');

// Extract swCache from version.js
const versionMatch = versionSrc.match(/swCache\s*:\s*['"]([^'"]+)['"]/);
if (!versionMatch) {
  console.error('Could not find swCache in js/version.js');
  process.exit(1);
}
const versionCache = versionMatch[1];

// Extract CACHE_NAME from sw.js. The default-initializer may be `const` or
// `let` (the latter when sw.js overwrites it from importScripts('version.js')),
// so match either binding form.
const swMatch = swSrc.match(/(?:const|let|var)\s+CACHE_NAME\s*=\s*['"]([^'"]+)['"]/);
if (!swMatch) {
  console.error('Could not find CACHE_NAME in sw.js');
  process.exit(1);
}
const swCache = swMatch[1];

// Extract the inline-SW fallback string from js/pwa.js. The fallback is the
// hardcoded literal used when window.ODTAULAI_RELEASE.swCache is unavailable
// (e.g. version.js failed to load). Pattern matches: ` : 'odtaulai-vNN'`.
const pwaMatch = pwaSrc.match(/:\s*['"](odtaulai-v[^'"]+)['"]/);
if (!pwaMatch) {
  console.error('Could not find inline-SW cache fallback in js/pwa.js');
  process.exit(1);
}
const pwaCache = pwaMatch[1];

const drifts = [];
if (versionCache !== swCache)  drifts.push(['sw.js CACHE_NAME', swCache]);
if (versionCache !== pwaCache) drifts.push(['js/pwa.js inline fallback', pwaCache]);

if (drifts.length) {
  console.error('Version drift detected!');
  console.error(`   js/version.js  swCache: '${versionCache}'`);
  drifts.forEach(([where, val]) => console.error(`   ${where.padEnd(30)} '${val}'`));
  console.error('\n   Run: node scripts/bump-version.mjs <new-version>');
  process.exit(1);
}

console.log(`Version sync OK: '${versionCache}'`);
