/**
 * Static contract guards on the Tools-tab AI panel error surface. Before this
 * fix, when the embedding model failed to load (CDN offline or fetch error),
 * renderAIPanel() always rendered the "Loading model…" status, kept the retry
 * button hidden, and on every re-render called syncHeaderAIChip('loading',…)
 * — clobbering the error state set by app.js. Net effect: a permanent
 * "Loading model…" with no retry, even though the underlying load had given up.
 *
 * These guards lock the post-fix contract so the regression cannot return.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Normalize CRLF so delimiter scans behave the same on Windows checkouts.
const aiSrc = readFileSync(join(root, 'js', 'ai.js'), 'utf8').replace(/\r\n/g, '\n');

const fnIdx = aiSrc.indexOf('function renderAIPanel');
assert.ok(fnIdx > 0, 'renderAIPanel not found');
const fnEnd = aiSrc.indexOf('\n}\n', fnIdx);
assert.ok(fnEnd > fnIdx, 'renderAIPanel end not found');
const body = aiSrc.slice(fnIdx, fnEnd);

test('renderAIPanel reads chip error state', () => {
  assert.match(body, /_embedChipState\s*===\s*['"]error['"]/, 'must check _embedChipState === "error"');
});

test('renderAIPanel surfaces a non-loading status pill on error', () => {
  // Status text must not be hard-coded to "Loading model…" when the load failed.
  assert.match(body, /failed\s*\?\s*\(?_embedChipMsg/, 'must use _embedChipMsg as primary error text');
  assert.match(body, /Could not load model/, 'must have a fallback error label');
  // The intel-status-chip class must be able to take the "error" modifier.
  assert.match(body, /intel-status--\$\{statusKind\}/, 'status class must use statusKind variable');
});

test('renderAIPanel un-hides the retry button on failure', () => {
  // The retry button template must include a conditional `hidden` attribute
  // that drops the attribute when failed=true. A plain unconditional `hidden`
  // would re-hide the button on every re-render after a load failure.
  const retryLine = body.match(/data-action="intelRetryLoad"[^>]+/);
  assert.ok(retryLine, 'retry button not found');
  assert.match(retryLine[0], /failed\s*\?\s*''\s*:\s*'\s*hidden'/, 'retry hidden attr must be conditional on failed');
});

test('renderAIPanel does not blindly overwrite chip back to loading', () => {
  // The trailing chip-sync must respect 'error' state. The pre-fix code was a
  // bare `else syncHeaderAIChip('loading', …)` which clobbered any error set
  // by app.js after the intelLoad rejection.
  assert.match(body, /failed\)\s*syncHeaderAIChip\(\s*['"]error['"]/, 'must propagate error to header chip');
  assert.doesNotMatch(body, /^\s*else\s+syncHeaderAIChip\(\s*['"]loading['"][^)]*\);\s*$/m, 'must not unconditionally reset to loading');
});

test('disabled-action subtitles point to retry on failure', () => {
  // The "Embedding model loading…" subtitle on disabled action buttons used
  // to stay forever after a failure. It must now switch to a retry hint.
  assert.match(body, /Model unavailable[^']*tap Retry above/, 'must include "Model unavailable — tap Retry above"');
});

test('app.js still calls syncHeaderAIChip("error",…) on load failure', () => {
  // Defense in depth: the rejection handler in app.js must continue to set
  // the chip state to error so renderAIPanel (which now reads that state)
  // can render the failure surface even if it re-renders later.
  const appSrc = readFileSync(join(root, 'js', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
  const intelLoadIdx = appSrc.indexOf('intelLoad(onProgress)');
  assert.ok(intelLoadIdx > 0, 'intelLoad call not found in app.js');
  // .then branch is long (migration, centroids, embeddings) — need range that includes .catch.
  const tail = appSrc.slice(intelLoadIdx, intelLoadIdx + 9000);
  assert.match(tail, /syncHeaderAIChip\(\s*['"]error['"]/, 'app.js must mark chip error on intelLoad rejection');
});
