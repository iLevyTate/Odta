/**
 * Contract guards for the Tools-tab pending-ops preview. Rows must stay
 * readable after renderAIPanel rebuilds and list-move proposals must carry
 * display snapshots so preview text does not depend on live task lookups.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const aiSrc = readFileSync(join(root, 'js', 'ai.js'), 'utf8').replace(/\r\n/g, '\n');
const toolSrc = readFileSync(join(root, 'js', 'tool-schema.js'), 'utf8').replace(/\r\n/g, '\n');
const cssSrc = readFileSync(join(root, 'css', 'main.css'), 'utf8').replace(/\r\n/g, '\n');

test('pending preview mounts cards via DOM text nodes', () => {
  assert.match(aiSrc, /function _mountPendingListMoveCard\(/, 'list-move mount helper');
  assert.match(aiSrc, /titleEl\.textContent = st\.title/, 'task title uses textContent');
  assert.match(aiSrc, /fromEl\.textContent = st\.fromList/, 'from list uses textContent');
  assert.match(aiSrc, /toEl\.textContent = st\.toList/, 'to list uses textContent');
});

test('renderAIPanel preserves or rebuilds pending preview instead of leaving shells', () => {
  const fnIdx = aiSrc.indexOf('function renderAIPanel');
  assert.ok(fnIdx > 0, 'renderAIPanel not found');
  const fnEnd = aiSrc.indexOf('\n}\n', fnIdx);
  assert.ok(fnEnd > fnIdx, 'renderAIPanel end not found');
  const body = aiSrc.slice(fnIdx, fnEnd);
  assert.match(body, /_pendingListHasVisibleText\(livePending\)/, 'visible-text guard before preserve');
  assert.match(body, /pendingSlot\.replaceWith\(keepPending\)/, 'must reattach live preview');
  assert.match(body, /else if\(_pendingOps\.length\)\{\s*_renderPendingOps\(\)/, 'must rebuild when preview is blank');
});

test('auto-organize embeds list-move preview snapshots on ops', () => {
  assert.match(aiSrc, /_preview:\s*\{[\s\S]*taskName[\s\S]*fromList[\s\S]*toList/, 'auto-organize adds _preview snapshot');
  assert.match(aiSrc, /pv\.fromList|snapName|pv\.taskName/, 'describeOpStructured reads preview snapshot');
});

test('validateOps preserves _preview metadata for review cards', () => {
  assert.match(toolSrc, /validated\._preview\s*=\s*\{/, 'validateOps copies _preview');
});

test('pending row styles use explicit readable text colors', () => {
  assert.match(cssSrc, /\.pending-simple-title\{[^}]*color:var\(--text-1\)/, 'title uses text-1 token');
  assert.match(cssSrc, /\.pending-route-vals\{[^}]*color:var\(--text-1\)/, 'route uses text-1 token');
  assert.match(cssSrc, /\.pending-move-title\{[^}]*color:var\(--text-1\)/, 'list-move title uses text-1');
  assert.match(cssSrc, /\.pending-move-route\{[^}]*color:var\(--text-2\)/, 'list-move route uses text-2');
});

test('pending mobile layout keeps scroll viewport and tap-friendly row heights', () => {
  assert.ok(
    /\.pending-move-head\{[^}]*min-height:\s*56px/.test(cssSrc),
    'mobile pending-move-head min-height 56px',
  );
  assert.ok(
    /\.pending-list\{[^}]*max-height:\s*min\(50vh,\s*420px\)/.test(cssSrc),
    'pending-list capped with viewport-relative max',
  );
});
