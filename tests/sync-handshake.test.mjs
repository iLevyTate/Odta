/**
 * Authenticated pairing handshake in js/sync.js (_wireConn and friends).
 *
 * History:
 *  - v74 stopped the initiator shipping its whole task DB the moment the
 *    channel opened; it sent only 'hello' and waited for the remote user to
 *    accept. But it counted ANY non-hello message as that acceptance.
 *  - Devices were identified by the PeerJS id alone, which anyone can
 *    register on the broker while it's free. So while a paired device was
 *    offline, whoever registered its id got the full vault on the next
 *    auto-reconnect by sending {type:'ping'}, and could push tombstones back.
 *
 * Contract pinned here:
 *  - First pairing: only the acceptor's Accept click unlocks anything. It
 *    mints a key and sends {type:'pair'}; both sides store it.
 *  - Later connections: both sides prove the key with an HMAC over the other
 *    side's nonce; the acceptor then connects without a banner.
 *  - Before proof or Accept, state / patch / ping are ignored, and nothing
 *    but hello / auth / pair is sent.
 *  - A reconnect that already holds a key never accepts a new 'pair'; only a
 *    code the user typed again (manual) may replace it.
 *
 * Each "device" is a fresh instance of the real handshake slice with its own
 * globals and localStorage; the two ends talk over a linked fake channel and
 * use Node's WebCrypto.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const syncSrc = readFileSync(join(root, 'js', 'sync.js'), 'utf8');

const start = syncSrc.indexOf('// ── Connection handling');
const end = syncSrc.indexOf('// ── Public API', start);
assert.ok(start >= 0 && end > start, 'slice connection handling block');
const block = syncSrc.slice(start, end);

function makeDevice(peerId) {
  const log = { status: [], merges: [], banners: [] };
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const els = {};
  const document = {
    getElementById: (id) => els[id] || ((id === 'syncAcceptInbound' || id === 'syncRejectInbound') ? (els[id] = {}) : null),
    createElement: () => ({ remove() { delete els[this.id]; } }),
    body: { appendChild(el) { els[el.id] = el; log.banners.push(el.innerHTML); } },
  };
  const api = new Function('log', 'localStorage', 'document', 'crypto', `
    const window = {};
    let _conn = null, _pendingInboundConn = null, _reconnectTimerId = null, _reconnectAttempt = 0;
    let _syncStatus = 'waiting', _lastConnectCode = null, _connectTimeoutId = null;
    let taskIdCtr = 0, _syncSentTaskIdCtr = null;
    const _peer = { id: ${JSON.stringify(peerId)} };
    const SYNC_ROOM_KEY = 'room';
    const esc = (s) => String(s);
    const _setSyncStatus = (s, m) => { _syncStatus = s; log.status.push(m ? s + ':' + m : s); };
    const _packState = () => ({ sentinel: 'FULL_STATE_OF_' + _peer.id });
    const _mergeState = (payload, opts) => { log.merges.push({ payload, opts }); };
    const _idToCode = (id) => String(id).replace(/^stupind-/, '').toUpperCase();
    const _scheduleSyncReconnect = () => {};
    const _friendlySyncError = (e) => String(e);
    const console = { warn(){}, error(){}, info(){} };
    ${block}
    return {
      wire: (conn, opts) => { if (opts && opts.role === 'acceptor') _pendingInboundConn = conn; _wireConn(conn, opts); },
      accept: () => syncAcceptInbound(),
      reject: () => syncRejectInbound(),
      key: (id) => _getPairKey(id),
      setKey: (id, k) => _setPairKey(id, k),
      get conn() { return _conn; },
      get pending() { return _pendingInboundConn; },
      get status() { return _syncStatus; },
    };
  `)(log, localStorage, document, globalThis.crypto);
  return Object.assign(api, { id: peerId, log, store });
}

/** Two linked DataConnection fakes. a lives on the dialler, b on the dialled side. */
function link(dialler, dialled) {
  const mk = (peer) => ({
    peer, open: false, closed: false, sent: [], _h: {},
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); },
    emit(ev, arg) { for (const fn of this._h[ev] || []) fn(arg); },
    send(m) {
      this.sent.push(m);
      const o = this._other;
      setImmediate(() => { if (!o.closed) o.emit('data', structuredClone(m)); });
    },
    close() {
      if (this.closed) return;
      this.closed = true; this.emit('close');
      const o = this._other; if (!o.closed) { o.closed = true; o.emit('close'); }
    },
  });
  const a = mk(dialled.id), b = mk(dialler.id);
  a._other = b; b._other = a;
  return { a, b, open() { a.open = b.open = true; a.emit('open'); b.emit('open'); } };
}

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 5)); };
const types = (conn) => conn.sent.map((m) => m.type);

/** An attacker end: records what it receives, sends what it's told. */
function rogue(id) {
  return { id, got: [] };
}

async function pairFresh(A, B) {
  const L = link(A, B);
  A.wire(L.a, { role: 'initiator', manual: true });
  B.wire(L.b, { role: 'acceptor' });
  L.open();
  await settle();
  B.accept();
  await settle();
  return L;
}

test('first pairing: nothing but hello flows until the acceptor clicks Accept', async () => {
  const A = makeDevice('stupind-aaaaaa'), B = makeDevice('stupind-bbbbbb');
  const L = link(A, B);
  A.wire(L.a, { role: 'initiator', manual: true });
  B.wire(L.b, { role: 'acceptor' });
  L.open();
  await settle();
  assert.deepEqual(types(L.a), ['hello']);
  assert.deepEqual(types(L.b), ['hello']);
  assert.equal(B.log.banners.length, 1, 'acceptor asks its user');
  assert.match(B.log.banners[0], /Incoming sync/);
  assert.ok(!L.a._syncReady && !L.b._syncReady);
  assert.equal(A.log.merges.length + B.log.merges.length, 0);
});

test('first pairing: Accept mints one key both sides store, then state flows both ways once', async () => {
  const A = makeDevice('stupind-aaaaaa'), B = makeDevice('stupind-bbbbbb');
  const L = await pairFresh(A, B);
  assert.ok(L.a._syncReady && L.b._syncReady);
  assert.ok(A.key(B.id) && A.key(B.id) === B.key(A.id), 'shared key stored against the other id');
  assert.deepEqual(types(L.b), ['hello', 'pair', 'state']);
  assert.deepEqual(types(L.a), ['hello', 'state']);
  assert.equal(A.log.merges.length, 1);
  assert.equal(B.log.merges.length, 1);
  assert.equal(A.log.merges[0].payload.sentinel, 'FULL_STATE_OF_stupind-bbbbbb');
  assert.equal(A.log.merges[0].opts.isInitialState, true);
});

test('reconnect between paired devices authenticates both ways with no banner', async () => {
  const A = makeDevice('stupind-aaaaaa'), B = makeDevice('stupind-bbbbbb');
  await pairFresh(A, B);
  const bannersBefore = B.log.banners.length;
  const L = link(A, B);
  A.wire(L.a, { role: 'initiator' });
  B.wire(L.b, { role: 'acceptor' });
  L.open();
  await settle();
  assert.equal(B.log.banners.length, bannersBefore, 'a proven device is accepted silently');
  assert.ok(L.a._syncReady && L.b._syncReady);
  assert.deepEqual(types(L.a), ['hello', 'auth', 'state']);
  assert.deepEqual(types(L.b), ['hello', 'auth', 'state']);
  assert.equal(B.pending, null);
});

test('squatter on a paired id gets nothing from an auto-reconnect, whatever it sends', async () => {
  const A = makeDevice('stupind-aaaaaa'), B = makeDevice('stupind-bbbbbb');
  await pairFresh(A, B);
  // E registered B's id while B was offline. A dials "B" and reaches E.
  const E = makeDevice('stupind-bbbbbb');
  const mergesBefore = A.log.merges.length;
  const L = link(A, E);
  A.wire(L.a, { role: 'initiator' });
  L.open();
  await settle();
  const nonce = '0'.repeat(32);
  for (const m of [
    { type: 'ping' },
    { type: 'state', payload: { tasks: [] } },
    { type: 'patch', payload: { syncTaskDels: { 1: Date.now() } } },
    { type: 'hello', v: 2, nonce, paired: false },
    { type: 'pair', key: 'f'.repeat(64) },
  ]) L.b.send(m);
  await settle();
  assert.ok(!types(L.a).includes('state'), 'the vault never leaves A');
  assert.ok(!types(L.a).includes('pong'), 'no reply to pre-auth ping');
  assert.equal(A.log.merges.length, mergesBefore, 'no pre-auth payload is merged');
  assert.notEqual(A.key(B.id), 'f'.repeat(64), 'a reconnect never takes a new key');
  assert.ok(L.a.closed, 'A hangs up');
  assert.equal(A.status, 'error');
});

test('a forged auth MAC is rejected', async () => {
  const A = makeDevice('stupind-aaaaaa'), B = makeDevice('stupind-bbbbbb');
  await pairFresh(A, B);
  const mergesBefore = A.log.merges.length;
  const L = link(A, { id: B.id });
  A.wire(L.a, { role: 'initiator' });
  L.open();
  await settle();
  L.b.send({ type: 'hello', v: 2, nonce: '1'.repeat(32), paired: true });
  L.b.send({ type: 'auth', mac: 'a'.repeat(64) });
  L.b.send({ type: 'state', payload: {} });
  await settle();
  assert.ok(!L.a._syncReady);
  assert.ok(!types(L.a).includes('state'));
  assert.equal(A.log.merges.length, mergesBefore);
  assert.ok(L.a.closed);
});

test('inbound stranger claiming to be paired still needs Accept, and pre-accept data is ignored', async () => {
  const B = makeDevice('stupind-bbbbbb');
  const X = rogue('stupind-xxxxxx');
  const L = link(X, B);
  B.wire(L.b, { role: 'acceptor' });
  L.open();
  await settle();
  L.a.send({ type: 'hello', v: 2, nonce: '2'.repeat(32), paired: true });
  L.a.send({ type: 'auth', mac: 'b'.repeat(64) });
  L.a.send({ type: 'state', payload: { tasks: [] } });
  L.a.send({ type: 'patch', payload: {} });
  await settle();
  assert.equal(B.log.banners.length, 1, 'no key for this id: the user decides');
  assert.ok(!L.b._syncReady);
  assert.equal(B.log.merges.length, 0);
  assert.deepEqual(types(L.b), ['hello'], 'B sends nothing else before Accept');
});

test('acceptor holding a key warns when that id comes back unable to prove it', async () => {
  const A = makeDevice('stupind-aaaaaa'), B = makeDevice('stupind-bbbbbb');
  await pairFresh(A, B);
  const A2 = makeDevice('stupind-aaaaaa'); // A's id again, but no key: a reset device or a squatter
  const L = link(A2, B);
  A2.wire(L.a, { role: 'initiator', manual: true });
  B.wire(L.b, { role: 'acceptor' });
  L.open();
  await settle();
  assert.match(B.log.banners.at(-1), /Re-pair request/);
  assert.ok(!L.b._syncReady && !L.a._syncReady);
  assert.deepEqual(types(L.b), ['hello'], 'B proves nothing to a peer that has no key');
});

test('initiator hangs up when the acceptor cannot prove the key it holds', async () => {
  const A = makeDevice('stupind-aaaaaa'), B = makeDevice('stupind-bbbbbb');
  await pairFresh(A, B);
  A.setKey(B.id, 'c'.repeat(64)); // keys no longer match
  const L = link(A, B);
  A.wire(L.a, { role: 'initiator' });
  B.wire(L.b, { role: 'acceptor' });
  L.open();
  await settle();
  assert.ok(!L.a._syncReady && !L.b._syncReady);
  assert.ok(!types(L.a).includes('state') && !types(L.b).includes('state'));
  assert.ok(L.a.closed);
});

test('manual re-entry of a code may re-pair after the other device was reset', async () => {
  const A = makeDevice('stupind-aaaaaa'), B = makeDevice('stupind-bbbbbb');
  await pairFresh(A, B);
  const oldKey = A.key(B.id);
  const B2 = makeDevice('stupind-bbbbbb'); // B reinstalled: same id, empty storage
  const L = link(A, B2);
  A.wire(L.a, { role: 'initiator', manual: true });
  B2.wire(L.b, { role: 'acceptor' });
  L.open();
  await settle();
  B2.accept();
  await settle();
  assert.ok(L.a._syncReady && L.b._syncReady);
  assert.notEqual(A.key(B.id), oldKey);
  assert.equal(A.key(B.id), B2.key(A.id));
});

test('an automatic reconnect refuses to re-pair even if the other user clicks Accept', async () => {
  const A = makeDevice('stupind-aaaaaa'), B = makeDevice('stupind-bbbbbb');
  await pairFresh(A, B);
  const oldKey = A.key(B.id);
  const B2 = makeDevice('stupind-bbbbbb');
  const L = link(A, B2);
  A.wire(L.a, { role: 'initiator' });
  B2.wire(L.b, { role: 'acceptor' });
  L.open();
  await settle();
  B2.accept();
  await settle();
  assert.ok(!L.a._syncReady);
  assert.ok(!types(L.a).includes('state'));
  assert.equal(A.key(B.id), oldKey);
  assert.equal(A.status, 'error');
});

test('initiator facing a pre-v79 device stops with an update message instead of waiting', async () => {
  const A = makeDevice('stupind-aaaaaa');
  const L = link(A, { id: 'stupind-oooooo' });
  A.wire(L.a, { role: 'initiator', manual: true });
  L.open();
  await settle();
  L.b.send({ type: 'hello', v: 1 });
  L.b.send({ type: 'state', payload: {} });
  await settle();
  assert.ok(!types(L.a).includes('state'));
  assert.equal(A.log.merges.length, 0);
  assert.match(A.log.status.at(-1), /older Odta/);
});

test('an already-open inbound channel still says hello (PeerJS does not replay open)', async () => {
  const B = makeDevice('stupind-bbbbbb');
  const L = link({ id: 'stupind-aaaaaa' }, B);
  L.a.open = L.b.open = true;
  B.wire(L.b, { role: 'acceptor' });
  assert.deepEqual(types(L.b), ['hello']);
});

test('static: syncBroadcast and the ack scheduler are gated on _syncReady', () => {
  const bIdx = syncSrc.indexOf('function syncBroadcast');
  assert.match(syncSrc.slice(bIdx, bIdx + 400), /_conn\._syncReady/, 'syncBroadcast must check _syncReady');
  const aIdx = syncSrc.indexOf('function _scheduleSyncAck');
  assert.match(syncSrc.slice(aIdx, aIdx + 400), /_conn\._syncReady/, '_scheduleSyncAck must check _syncReady');
});

test('static: pairing keys never ride in the synced state or a backup', () => {
  const pIdx = syncSrc.indexOf('function _packState');
  const pBody = syncSrc.slice(pIdx, syncSrc.indexOf('\n}', pIdx));
  assert.doesNotMatch(pBody, /SYNC_PAIRS_KEY|_loadSyncPairs/);
  const storage = readFileSync(join(root, 'js', 'storage.js'), 'utf8');
  assert.doesNotMatch(storage, /stupind_sync_pairs|SYNC_PAIRS/);
});

test('initiator facing a v78 acceptor (no hello, just state after Accept) stops instead of waiting', async () => {
  const A = makeDevice('stupind-aaaaaa');
  const L = link(A, { id: 'stupind-oooooo' });
  A.wire(L.a, { role: 'initiator', manual: true });
  L.open();
  await settle();
  L.b.send({ type: 'state', payload: { tasks: [] } });
  await settle();
  assert.ok(!L.a._syncReady);
  assert.equal(A.log.merges.length, 0);
  assert.ok(!types(L.a).includes('state'));
  assert.match(A.log.status.at(-1), /older Odta/);
  assert.ok(L.a.closed);
});

test('static: simultaneous dials keep the connection the lower id started', () => {
  const i = syncSrc.indexOf("_peer.on('connection'");
  const body = syncSrc.slice(i, syncSrc.indexOf('});', i));
  assert.match(body, /_conn\.peer === conn\.peer/);
  assert.match(body, /_myPeerId\(\) < String\(conn\.peer\)/);
});

test('static: a proven connection cancels any pending reconnect', () => {
  const i = syncSrc.indexOf('function _syncMarkReady');
  const body = syncSrc.slice(i, syncSrc.indexOf('\n}', i));
  assert.match(body, /clearTimeout\(_reconnectTimerId\)/);
});
