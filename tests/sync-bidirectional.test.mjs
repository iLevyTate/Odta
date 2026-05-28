/**
 * Bidirectional P2P sync contract guards (js/sync.js + js/storage.js).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const syncSrc = readFileSync(join(root, 'js', 'sync.js'), 'utf8');
const storageSrc = readFileSync(join(root, 'js', 'storage.js'), 'utf8');

test('sync.js: _packState includes stateNonce', () => {
  assert.match(syncSrc, /stateEpoch,\s*stateNonce,/);
});

test('sync.js: merge uses persistAfterSyncMerge instead of saveState auto', () => {
  const idx = syncSrc.indexOf('function _mergeState');
  assert.ok(idx >= 0);
  const body = syncSrc.slice(idx, syncSrc.indexOf('// ── Connection handling', idx));
  assert.match(body, /persistAfterSyncMerge\(re,\s*rn\)/);
  assert.doesNotMatch(body, /saveState\('auto'\)/);
});

test('sync.js: post-merge ack scheduler exists', () => {
  assert.match(syncSrc, /function _scheduleSyncAck/);
  assert.match(syncSrc, /hadLocalWins \|\| opts\.isInitialState/);
});

test('sync.js: syncBroadcast skips while _syncApplying', () => {
  const idx = syncSrc.indexOf('function syncBroadcast');
  assert.ok(idx >= 0);
  const body = syncSrc.slice(idx, idx + 120);
  assert.match(body, /if\s*\(\s*_syncApplying\s*\)\s*return/);
});

test('sync.js: inbound accept remembers peer code for reconnect', () => {
  const idx = syncSrc.indexOf('function syncAcceptInbound');
  assert.ok(idx >= 0);
  const body = syncSrc.slice(idx, idx + 350);
  assert.match(body, /_lastConnectCode\s*=\s*_idToCode\(conn\.peer\)/);
});

test('storage.js: saveState sync reason skips broadcast', () => {
  assert.match(storageSrc, /const isSyncMerge = reason === 'sync'/);
  assert.match(storageSrc, /if\s*\(\s*!isSyncMerge && typeof syncBroadcast/);
});

test('storage.js: persistAfterSyncMerge exported on window', () => {
  assert.match(storageSrc, /window\.persistAfterSyncMerge\s*=\s*persistAfterSyncMerge/);
});

test('storage.js: relatedTo tracked in saveState diff fields', () => {
  assert.match(storageSrc, /'relatedTo','attachments'/);
});
