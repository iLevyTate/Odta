/**
 * nlparse.js — async quick-add enrichment via chrono.
 * Verifies the dynamic-import fallback path and _isoDate coercion edges
 * (the previously untested surface flagged in the audit). chrono-node is
 * vendored under js/vendor/ — the URL is configurable via ODTAULAI_CONFIG
 * so tests / mirrors can swap in a different path.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'nlparse.js'), 'utf8');

test('nlparse: dynamic chrono import is wrapped in try/catch — load failure is non-fatal', () => {
  // The audit flagged silent failure: chrono load is optional, and the function
  // must fall back to base parseQuickAdd if the import throws.
  assert.match(src, /try\s*\{[\s\S]*loadChrono\(\)[\s\S]*\}\s*catch/, 'parseQuickAddAsync must catch chrono import errors');
  assert.match(src, /console\.warn\(['"]\[nlparse\] chrono failed/, 'failure must be logged, not silently dropped');
});

test('nlparse: returns base parse when chrono module shape is unexpected', () => {
  // If chrono loads but lacks .parse, we must still return the base result.
  assert.match(src, /if\s*\(\s*!parser\s*\)\s*return\s+base/, 'missing parser falls back to base');
});

test('nlparse: _isoDate rejects invalid dates with null', () => {
  // Extract _isoDate body to verify NaN handling.
  const idx = src.indexOf('function _isoDate');
  assert.ok(idx >= 0, '_isoDate must exist');
  const body = src.slice(idx, src.indexOf('\n}', idx));
  assert.match(body, /Number\.isNaN/, '_isoDate must guard against invalid Date');
  assert.match(body, /return null/, 'invalid input returns null, not a malformed string');
});

test('nlparse: loadChrono memoizes successful loads', () => {
  // _chronoMod cache prevents repeated CDN hits.
  assert.match(src, /if\s*\(\s*_chronoMod\s*\)\s*return\s+_chronoMod/, 'memoize successful load');
  assert.match(src, /if\s*\(\s*_chronoLoad\s*\)\s*return\s+_chronoLoad/, 'memoize in-flight load');
});

test('nlparse: respects ODTAULAI_CONFIG.CHRONO_URL override', () => {
  // Tests / forks / mirrors want to swap the vendored path (e.g. for a
  // bundler rewrite). The runtime constant must come from config when set.
  assert.match(src, /window\.ODTAULAI_CONFIG[\s\S]*CHRONO_URL/, 'chrono URL must come from config when present');
});

test('nlparse: chrono URL points at the vendored bundle, not a CDN', () => {
  // Offline-first: no jsdelivr / unpkg fallbacks left in the source.
  assert.match(src, /['"]\.\/js\/vendor\/chrono-node\.min\.mjs['"]/, 'default URL must be the vendored bundle');
  assert.doesNotMatch(src, /cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com/, 'must not reference any CDN host');
});

test('nlparse: skips chrono when title is empty after sync parse', () => {
  assert.match(src, /if\s*\(\s*!base\.name\s*\)\s*return\s+base/, 'short-circuit when no title remains');
});

test('nlparse: strips matched chrono span from task title', () => {
  assert.match(src, /function _applyChronoResult/, '_applyChronoResult helper must exist');
  assert.match(src, /r0\.text/, 'must remove matched text from name');
});

test('nlparse: debounced live preview hook exists', () => {
  assert.match(src, /scheduleLiveParsePreview/, 'live preview scheduler exported');
});
