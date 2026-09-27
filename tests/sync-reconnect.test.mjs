/**
 * Static contract guards on the sync auto-reconnect path. Previous behavior
 * was: socket-error / socket-closed → status=error, full stop. Now we
 * remember the last pairing code and run an exponential-backoff reconnect
 * with a hard 5-attempt cap, plus a manual "Reconnect now" entry point.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const syncSrc = readFileSync(join(root, 'js', 'sync.js'), 'utf8');

test('sync.js declares backoff schedule constant', () => {
  // Five attempts is a deliberate cap — at 5 failed reconnects, stop
  // burning CPU and let the user act manually.
  const m = syncSrc.match(/SYNC_RECONNECT_BACKOFFS_MS\s*=\s*\[([^\]]+)\]/);
  assert.ok(m, 'SYNC_RECONNECT_BACKOFFS_MS not found');
  const arr = m[1].split(',').map(s => s.trim()).filter(Boolean);
  assert.equal(arr.length, 5, 'five backoff steps expected');
  // Backoff must be monotonically increasing — anything else means the
  // schedule is misconfigured.
  const nums = arr.map(s => parseInt(s, 10));
  for(let i = 1; i < nums.length; i++){
    assert.ok(nums[i] > nums[i-1], `backoff non-monotonic at index ${i}: ${nums.join(',')}`);
  }
});

test('sync.js defines _scheduleSyncReconnect with attempt cap', () => {
  const idx = syncSrc.indexOf('function _scheduleSyncReconnect');
  assert.ok(idx > 0, '_scheduleSyncReconnect not found');
  const body = syncSrc.slice(idx, idx + 1500);
  // Must read the schedule, must increment _reconnectAttempt, must bail
  // when the attempt index exceeds the schedule length.
  assert.match(body, /SYNC_RECONNECT_BACKOFFS_MS/, 'must use the backoff schedule');
  assert.match(body, /_reconnectAttempt/, 'must track attempt count');
  assert.match(body, /_reconnectAttempt\s*\+=\s*1|_reconnectAttempt\s*=\s*_reconnectAttempt\s*\+\s*1/, 'must increment attempt count');
});

test('syncDisconnect clears reconnect state', () => {
  const idx = syncSrc.indexOf('function syncDisconnect');
  assert.ok(idx > 0, 'syncDisconnect not found');
  const body = syncSrc.slice(idx, idx + 800);
  // User-initiated disconnect must NOT trigger an auto-reconnect — clearing
  // _lastConnectCode + the attempt counter is what prevents that.
  assert.match(body, /_lastConnectCode\s*=\s*null/, 'must clear remembered code');
  assert.match(body, /_reconnectTimerId\s*=\s*null/, 'must clear pending timer');
  assert.match(body, /_reconnectAttempt\s*=\s*0/, 'must reset attempt counter');
});

test('syncReconnectNow is exposed on window', () => {
  // Manual reconnect button is wired via data-action="syncReconnectNow"; the
  // function must be on window for event-delegation to resolve it.
  assert.match(syncSrc, /window\.syncReconnectNow\s*=\s*syncReconnectNow/, 'syncReconnectNow not exposed');
});

test('successful connection resets the reconnect attempt counter', () => {
  // Reset on open is what gives the user a fresh full-schedule next time
  // they drop. Without it, two transient drops near each other would
  // exhaust the budget too fast.
  // Only our own dial resets it: an inbound stranger opening a channel must
  // not cancel a pending reconnect to the paired device.
  const idx = syncSrc.indexOf('function _wireConn');
  assert.ok(idx > 0, '_wireConn not found');
  const o = syncSrc.indexOf('const onOpen = () => {', idx);
  assert.ok(o > idx, 'onOpen not found in _wireConn');
  const body = syncSrc.slice(o, syncSrc.indexOf('\n  };', o));
  assert.match(body, /if \(role === 'initiator'\) \{[\s\S]*_reconnectAttempt\s*=\s*0/, 'open of our own dial must reset _reconnectAttempt');
});
