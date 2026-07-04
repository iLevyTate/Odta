/**
 * Static guards for the external-content taint plumbing (prompt-injection
 * containment). The behavioral half lives in tests/ask-pipeline.test.mjs;
 * these pin the wiring that can't easily run standalone:
 *  - ask.js declares the external-read allow-list including GET_CALENDAR_EVENTS
 *  - ui.js's auto-apply branch checks turn.externalContent BEFORE the
 *    _cmdkApplyTurnOps call, so tainted batches always land in review.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const askSrc = readFileSync(join(root, 'js', 'ask.js'), 'utf8');
const uiSrc = readFileSync(join(root, 'js', 'ui.js'), 'utf8');

test('ask.js: ASK_EXTERNAL_READS exists and covers GET_CALENDAR_EVENTS', () => {
  const m = askSrc.match(/ASK_EXTERNAL_READS\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, 'ASK_EXTERNAL_READS declaration');
  assert.match(m[1], /GET_CALENDAR_EVENTS/, 'calendar reads are external content');
});

test('ask.js: ops-bearing returns carry the externalContent flag', () => {
  // Both the main return and the write-retry return can hand ops to the UI —
  // each must carry the taint or the write-retry becomes a bypass.
  const count = (askSrc.match(/externalContent:\s*externalReads/g) || []).length;
  assert.ok(count >= 2, `expected the taint on both ops returns, found ${count}`);
});

test('ui.js: auto-apply branch gates on externalContent before applying', () => {
  // The first occurrence is a header label; the branch is the `if(...)`.
  const autoIdx = uiSrc.indexOf("if(_cmdkAskApplyMode === 'auto')");
  assert.ok(autoIdx >= 0, 'auto-apply branch exists');
  const branch = uiSrc.slice(autoIdx, autoIdx + 2500);
  const gateIdx = branch.indexOf('externalContent');
  const applyIdx = branch.indexOf('_cmdkApplyTurnOps');
  assert.ok(gateIdx >= 0, 'auto branch must check externalContent');
  assert.ok(applyIdx >= 0, 'auto branch applies via _cmdkApplyTurnOps');
  assert.ok(gateIdx < applyIdx, 'the taint check must run BEFORE ops are applied');
});
