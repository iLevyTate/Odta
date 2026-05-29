/**
 * Regression: renderMdAttachments() is async and awaits IndexedDB reads between
 * minting object URLs. Two overlapping renders (rapid add/remove, or re-open)
 * could interleave so a superseded run kept appending <img>/<audio> nodes and
 * object URLs after the newer run had already revoked them and rebuilt the DOM
 * — leaving broken thumbnails and leaked/instantly-revoked blob URLs. A
 * monotonic render token must bail every superseded continuation.
 *
 * DOM/IDB-coupled, so this guards the token wiring at the source level (the
 * end-to-end behaviour is covered by the smoke suite).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'ui.js'), 'utf8');

function sliceRender() {
  const i = src.indexOf('async function renderMdAttachments(');
  assert.ok(i > 0, 'renderMdAttachments not found');
  const e = src.indexOf('window.renderMdAttachments = renderMdAttachments;', i);
  assert.ok(e > i, 'slice renderMdAttachments');
  return src.slice(i, e);
}

test('a monotonic render token is declared', () => {
  assert.match(src, /let\s+_mdAttachRenderSeq\s*=\s*0/, 'render token must exist');
});

test('the token is captured at render start, before revoking prior URLs', () => {
  const body = sliceRender();
  const capture = body.indexOf('const mySeq = ++_mdAttachRenderSeq');
  const revoke = body.indexOf('_revokeMdAttachUrls()');
  assert.ok(capture >= 0, 'must capture mySeq = ++_mdAttachRenderSeq');
  assert.ok(revoke > capture, 'token must be captured before _revokeMdAttachUrls()');
});

test('every async continuation bails when superseded', () => {
  const body = sliceRender();
  const checks = body.match(/if\(mySeq !== _mdAttachRenderSeq\)\s*return/g) || [];
  // One after listTaskAttachments, one per image/audio await, one before the
  // final host.appendChild(grid) → at least 4 guards.
  assert.ok(checks.length >= 4, `expected >=4 supersession guards, found ${checks.length}`);
});

test('the final grid append is guarded', () => {
  const body = sliceRender();
  const guardIdx = body.lastIndexOf('if(mySeq !== _mdAttachRenderSeq) return');
  const appendIdx = body.indexOf('host.appendChild(grid)');
  assert.ok(guardIdx >= 0 && appendIdx > guardIdx, 'the last guard must precede host.appendChild(grid)');
});
