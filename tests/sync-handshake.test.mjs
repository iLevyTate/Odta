/**
 * Accept-before-send handshake in js/sync.js (_wireConn).
 *
 * The outbound connector used to send {type:'state', payload:_packState()}
 * the moment the datachannel opened — i.e. the user's ENTIRE task DB shipped
 * to whatever device answered the 6-char pairing code, before that device's
 * user clicked Accept. A mistyped code == full vault disclosure to a stranger.
 *
 * New contract:
 *  - initiator on open: sends only a lightweight 'hello', status 'connecting'.
 *  - acceptor on open (its user already clicked Accept): sends its state.
 *  - the initiator treats ANY substantive (non-hello) message as proof the
 *    remote user accepted, and only then sends its own state. A pre-v74 peer
 *    that eagerly sends 'state'/'patch' therefore still interops.
 *  - syncBroadcast/_scheduleSyncAck are gated on conn._syncReady so live
 *    edits can't leak pre-accept either.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const syncSrc = readFileSync(join(root, 'js', 'sync.js'), 'utf8');

function buildWireConn() {
  const start = syncSrc.indexOf('function _wireConn');
  const end = syncSrc.indexOf('// ── Public API', start);
  assert.ok(start >= 0 && end > start, 'slice _wireConn');
  const block = syncSrc.slice(start, end);

  const calls = { status: [], merges: [] };
  const prelude = `
    let _conn = null, _reconnectTimerId = null, _reconnectAttempt = 3;
    let _syncStatus = 'connecting', _lastConnectCode = 'ABCDEF';
    const SYNC_VERSION = 1, SYNC_ROOM_KEY = 'test_room';
    const _setSyncStatus = (s, m) => { calls.status.push(s); _syncStatus = s; };
    const _packState = () => ({ sentinel: 'FULL_STATE' });
    const _mergeState = (payload, opts) => { calls.merges.push({ payload, opts }); };
    const _idToCode = (id) => String(id).slice(-6).toUpperCase();
    const _scheduleSyncReconnect = () => {};
    const _friendlySyncError = (e) => String(e);
    const _connectTimeoutId = null;
    const clearTimeout = () => {};
    const localStorage = { setItem(){}, getItem(){ return null; }, removeItem(){} };
    const console = { warn(){}, error(){} };
  `;
  const factory = new Function('calls', `${prelude}\n${block}\nreturn _wireConn;`);
  return { wire: factory(calls), calls };
}

function fakeConn({ open = false } = {}) {
  return {
    open,
    peer: 'stupind-abcdef',
    sent: [],
    _h: {},
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); },
    emit(ev, arg) { for (const fn of this._h[ev] || []) fn(arg); },
    send(m) { this.sent.push(m); },
    close() {},
  };
}

test('initiator: channel open sends ONLY hello — never the state payload', () => {
  const { wire } = buildWireConn();
  const conn = fakeConn();
  wire(conn, { role: 'initiator' });
  conn.emit('open');
  assert.deepEqual(conn.sent.map(m => m.type), ['hello'], 'nothing but hello may flow pre-accept');
  assert.ok(!conn._syncReady, 'not ready until the remote accepts');
});

test('initiator: remote state message counts as acceptance and unlocks our state send', () => {
  const { wire, calls } = buildWireConn();
  const conn = fakeConn();
  wire(conn, { role: 'initiator' });
  conn.emit('open');
  conn.emit('data', { type: 'state', payload: { tasks: [] } });
  assert.ok(conn._syncReady, 'remote state == remote accepted');
  const types = conn.sent.map(m => m.type);
  assert.deepEqual(types, ['hello', 'state'], 'our state goes out exactly once, after acceptance');
  assert.equal(calls.merges.length, 1, 'remote state is merged');
  assert.equal(calls.merges[0].opts.isInitialState, true);
  assert.ok(calls.status.includes('connected'));
});

test('initiator: pre-v74 peer interop — an eager patch also counts as acceptance', () => {
  const { wire } = buildWireConn();
  const conn = fakeConn();
  wire(conn, { role: 'initiator' });
  conn.emit('open');
  conn.emit('data', { type: 'patch', payload: {} });
  assert.ok(conn._syncReady);
  assert.deepEqual(conn.sent.map(m => m.type), ['hello', 'state']);
});

test('initiator: an echoed hello does NOT unlock the state send', () => {
  const { wire, calls } = buildWireConn();
  const conn = fakeConn();
  wire(conn, { role: 'initiator' });
  conn.emit('open');
  conn.emit('data', { type: 'hello', v: 1 });
  assert.ok(!conn._syncReady, 'hello is the unauthenticated probe — not consent');
  assert.deepEqual(conn.sent.map(m => m.type), ['hello']);
  assert.equal(calls.merges.length, 0);
});

test('acceptor: wiring an ALREADY-OPEN channel still sends state (no lost open event)', () => {
  const { wire } = buildWireConn();
  // The channel usually finishes opening while the Accept banner is up;
  // PeerJS does not replay 'open' for listeners attached afterwards.
  const conn = fakeConn({ open: true });
  wire(conn, { role: 'acceptor' });
  assert.ok(conn._syncReady, 'accept click IS the consent');
  assert.deepEqual(conn.sent.map(m => m.type), ['state']);
});

test('acceptor: state is sent once, not re-sent when remote data arrives', () => {
  const { wire } = buildWireConn();
  const conn = fakeConn({ open: true });
  wire(conn, { role: 'acceptor' });
  conn.emit('data', { type: 'state', payload: {} });
  assert.deepEqual(conn.sent.map(m => m.type), ['state'], 'no duplicate state on inbound data');
});

test('static: syncBroadcast and the ack scheduler are gated on _syncReady', () => {
  const bIdx = syncSrc.indexOf('function syncBroadcast');
  assert.match(syncSrc.slice(bIdx, bIdx + 400), /_conn\._syncReady/, 'syncBroadcast must check _syncReady');
  const aIdx = syncSrc.indexOf('function _scheduleSyncAck');
  assert.match(syncSrc.slice(aIdx, aIdx + 400), /_conn\._syncReady/, '_scheduleSyncAck must check _syncReady');
});
