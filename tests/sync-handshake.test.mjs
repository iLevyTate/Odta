/**
 * Pairing + wire protocol v3 in js/sync.js.
 *
 * History:
 *  - v74 stopped the initiator shipping its whole task DB the moment the
 *    channel opened; it sent only 'hello' and waited for the remote user to
 *    accept. But it counted ANY non-hello message as that acceptance.
 *  - v79/v80 gave each pair a 256-bit key proved both ways with an HMAC over
 *    the other side's nonce. But the FIRST pairing (and every manual re-pair)
 *    took that key from whoever answered the dialled PeerJS id, which is
 *    first-come on a public broker: a squatter on an offline device's id was
 *    handed a key by the dialer's user, or got the acceptor's user to tap
 *    Accept on a banner. `unavailable-id` also rotated the device id and
 *    silently broke every pairing.
 *
 * Contract pinned here (v81):
 *  - Pairing code = ROOM (the device id suffix) + a 12-character SECRET shown
 *    only on the device that generated it. Pair key = PBKDF2-SHA256(secret,
 *    "odta-sync-v3:" + ROOM, 100 000, 256 bits). The dialer derives and
 *    stores it BEFORE dialling; the acceptor verifies the dialer's proof
 *    against the key stored for that id or the key of its active offer, and
 *    only then proves itself (after Accept when the offer was used).
 *  - A squatter answering a dialled id learns nothing and can't mint a key.
 *    A stranger, a bad proof, another version or plaintext before readiness
 *    gets {type:'refuse', v:3, reason} and no banner. 'pair' is gone.
 *  - After readiness every message is {type:'enc', v:3, iv, ct} (AES-GCM,
 *    HKDF of the pair key, AAD = both nonces + sender role); plaintext,
 *    oversized or undecryptable input closes the link.
 *  - A bare 6-character code only reaches a device we already hold a key
 *    for; a full code always installs its derived key (the re-pair path).
 *  - Inbound handshake failures back off inbound connections; both roles
 *    time out; a busy id is retried, never rotated.
 *
 * Each "device" is the real js/sync.js loaded whole with its own globals,
 * localStorage and DOM stubs; devices talk through a fake PeerJS broker with
 * Node's WebCrypto doing the real PBKDF2 / HMAC / HKDF / AES-GCM. Timers of
 * a second or more are scaled down 100× so timeouts and backoffs are fast.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const syncSrc = readFileSync(join(root, 'js', 'sync.js'), 'utf8');

// Other harnesses (sync-merge, sync-bidirectional) slice on these markers.
const mStart = syncSrc.indexOf('// ── Connection handling');
const mEnd = syncSrc.indexOf('// ── Public API', mStart);
assert.ok(mStart >= 0 && mEnd > mStart, 'connection handling / public API markers present');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 8000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + label);
    await sleep(5);
  }
}
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const hexNonce = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');
const ROOM = 'AB3C9D', SECRET = 'ABCDEFGHJKLM';
const task = (id, name) => ({ id, name, created: '2026-09-01T10:0' + (id % 10), lastModified: 1000 + id, status: 'open' });

// A fake PeerJS broker shared by every device in a test: peers register by
// id (first come, like the real one), connect() delivers a mirrored
// DataConnection to the target on the next tick, and every message crossing
// the wire is recorded so a test can assert on exactly what the other end
// could have seen.
function makeBroker() {
  const peers = new Map();
  const wire = [];
  const clone = (m) => JSON.parse(JSON.stringify(m));
  class Emitter {
    constructor() { this._h = {}; }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; }
    emit(ev, ...a) { for (const fn of [...(this._h[ev] || [])]) fn(...a); }
  }
  class FakeConn extends Emitter {
    constructor(localId, remoteId, outbound) {
      super();
      this.localId = localId; this.peer = remoteId; this.outbound = outbound;
      this.open = false; this.closed = false; this.remote = null; this.sent = [];
    }
    send(msg) {
      if (!this.open) throw new Error('Connection is not open');
      const c = clone(msg);
      this.sent.push(c);
      wire.push({ from: this.localId, to: this.peer, msg: c });
      const r = this.remote;
      setTimeout(() => { if (r && r.open) r.emit('data', clone(msg)); }, 0);
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      const wasOpen = this.open;
      this.open = false;
      const r = this.remote;
      if (wasOpen) this.emit('close');
      if (r && !r.closed) setTimeout(() => r.close(), 0);
    }
  }
  class FakePeer extends Emitter {
    constructor(id) {
      super();
      this.id = id; this.destroyed = false;
      if (peers.has(id)) { setTimeout(() => this.emit('error', { type: 'unavailable-id' }), 0); return; }
      peers.set(id, this);
      setTimeout(() => this.emit('open', id), 0);
    }
    connect(targetId) {
      const local = new FakeConn(this.id, targetId, true);
      setTimeout(() => {
        const target = peers.get(targetId);
        if (!target || target.destroyed) {
          this.emit('error', { type: 'peer-unavailable', message: 'Could not connect to peer ' + targetId });
          return;
        }
        const remote = new FakeConn(targetId, this.id, false);
        local.remote = remote; remote.remote = local;
        target.emit('connection', remote);
        setTimeout(() => { remote.open = true; local.open = true; remote.emit('open'); local.emit('open'); }, 0);
      }, 0);
      return local;
    }
    destroy() { this.destroyed = true; if (peers.get(this.id) === this) peers.delete(this.id); this.emit('disconnected'); }
    reconnect() {}
  }
  const from = (id) => wire.filter((m) => m.from === id);
  const types = (id) => from(id).map((m) => m.msg.type);
  return { FakePeer, wire, peers, from, types };
}

// Load the whole js/sync.js as one device. Returns its private state and
// entry points; the returned object never exposes anything the app itself
// doesn't hold.
function loadDevice({ id, broker, storage = {}, tasks = [] }) {
  const store = new Map(Object.entries({ stupind_peer_id_v2: id, ...storage }));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const els = {};
  const banners = [];
  const log = [];
  const document = {
    getElementById: (eid) => els[eid] || ((eid === 'syncAcceptInbound' || eid === 'syncRejectInbound') ? (els[eid] = {}) : null),
    createElement: () => ({ remove() { delete els[this.id]; } }),
    body: { appendChild(el) { els[el.id] = el; banners.push(el.innerHTML); } },
    activeElement: null,
  };
  const window = { Peer: broker.FakePeer, addEventListener() {} };
  // 45 s handshake timeout → 450 ms, 20 s connect timeout → 200 ms, backoffs
  // 2 s… → 20 ms…; sub-second timers (ack, broadcast, deferred close) as is.
  const scale = (ms) => (ms >= 1000 ? Math.max(1, Math.round(ms / 100)) : ms);
  const setTimeoutScaled = (fn, ms, ...a) => { const t = setTimeout(fn, scale(ms), ...a); if (t && t.unref) t.unref(); return t; };
  const cons = { warn: (...a) => log.push(a.map(String).join(' ')), error: (...a) => log.push(a.map(String).join(' ')), info() {}, log() {} };
  const prelude = `
    var tasks = [], taskIdCtr = 0, lists = [], listIdCtr = 0, activeListId = 1, goals = [], goalIdCtr = 0;
    var timeLog = [], totalPomos = 0, totalBreaks = 0, totalFocusSec = 0, sessionHistory = [], intervals = [], intIdCtr = 0;
    var cfg = {}, theme = 'dark', syncTaskDels = {}, syncListDels = {}, syncGoalDels = {}, stateEpoch = 0, stateNonce = 0;
    var pomosInCycle = 0, phase = 'work', logIdCtr = 0;
    function _reseedIdCtr(n, list){ let m = Math.max(0, parseInt(n, 10) || 0); for (const x of (list || [])) if (x && Number.isFinite(x.id) && x.id > m) m = x.id; return m; }
    function saveState(){}
    function renderAll(){}
    function confirm(){ return true; }
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  `;
  const epilogue = `
    return {
      enable: syncEnable, connect: syncConnect, accept: syncAcceptInbound, reject: syncRejectInbound,
      disconnect: syncDisconnect, reconnectNow: syncReconnectNow, newCode: syncNewPairingCode,
      regenerate: syncRegenerateCode, broadcast: syncBroadcast, onCodeInput: syncOnCodeInput,
      key: _getPairKey, setKey: _setPairKey, offer: _loadSyncOffer, code: _myPairingCode,
      deriveKey: _derivePairKey, deriveEncKey: _deriveEncKey, encrypt: _syncEncrypt, decrypt: _syncDecrypt,
      aad: _syncAad, mac: _syncMac, macEq: _macEq, unb64: _unb64,
      parse: _parseCode, normalize: _normalizeCode, format: _formatPairingCode, randChars: _randChars,
      recordFailure: _recordHandshakeFailure, inboundBlocked: _inboundBlocked,
      throttle: () => ({ failures: _hsFailTimes.length, blockedUntil: _hsBlockedUntil }),
      unblock: () => { _hsBlockedUntil = 0; },
      resetThrottle: () => { _hsFailTimes = []; _hsBlockedUntil = 0; },
      get conn() { return _conn; }, get pending() { return _pendingInboundConn; },
      get status() { return _syncStatus; }, get statusMsg() { return _syncStatusMsg; },
      get peer() { return _peer; }, get lastCode() { return _lastConnectCode; },
      get reconnectPending() { return _reconnectTimerId !== null; },
      get ready() { return !!(_conn && _conn._syncReady); },
      get tasks() { return tasks; }, set tasks(v) { tasks = v; },
      MAX_WIRE: _SYNC_MAX_WIRE_CHARS, PROTO: SYNC_PROTO,
    };
  `;
  const api = new Function('window', 'document', 'localStorage', 'crypto', 'setTimeout', 'clearTimeout', 'console',
    prelude + syncSrc + '\n' + epilogue)(window, document, localStorage, globalThis.crypto, setTimeoutScaled, clearTimeout, cons);
  api.tasks = tasks;
  return Object.assign(api, { id, store, banners, log, els });
}

const A_ID = 'stupind-aaaaaa', B_ID = 'stupind-bbbbbb';
const roomOf = (id) => id.replace(/^stupind-/, '').toUpperCase();
const shortCode = (id) => 'STU-' + roomOf(id).slice(0, 3) + '-' + roomOf(id).slice(3);
const KEY1 = '1'.repeat(64), KEY2 = '2'.repeat(64);

/** A raw peer standing in for an attacker or an older device. */
async function rawPeer(broker, id) {
  const p = new broker.FakePeer(id);
  await until(() => broker.peers.get(id) === p, id + ' registered');
  return p;
}
/** Dial a device from a raw peer; returns the conn and everything it receives. */
async function rawDial(raw, targetId) {
  const got = [];
  const c = raw.connect(targetId);
  c.on('data', (m) => got.push(m));
  await until(() => c.open || c.closed, 'raw dial settles');
  return { c, got };
}
/** Two fresh devices with a completed pairing: A showed its code, B typed it, A accepted. */
async function pairFresh(broker, opts = {}) {
  const A = loadDevice({ id: A_ID, broker, tasks: opts.aTasks || [] });
  const B = loadDevice({ id: B_ID, broker, tasks: opts.bTasks || [] });
  A.enable();
  await until(() => A.peer && A.code(), 'A code');
  B.enable();
  await until(() => B.peer, 'B peer');
  B.connect(A.code());
  await until(() => A.banners.length === 1, 'A banner');
  A.accept();
  await until(() => A.ready && B.ready, 'both ready');
  return { A, B };
}

test('pairing codes: normalise, parse and format', () => {
  const D = loadDevice({ id: A_ID, broker: makeBroker() });
  const full = D.format(ROOM, SECRET);
  assert.equal(full, 'STU-AB3-C9D-ABCD-EFGH-JKLM');
  for (const v of [full, 'ab3c9dabcdefghjklm', 'AB3C9D ABCD EFGH JKLM', ' stu-ab3-c9d-abcd-efgh-jklm ']) {
    assert.deepEqual(D.parse(v), { ok: true, room: ROOM, secret: SECRET }, 'accepts ' + JSON.stringify(v));
  }
  // A bare room parses (it addresses a device we may already hold a key for).
  assert.deepEqual(D.parse('STU-AB3-C9D'), { ok: true, room: ROOM, secret: null });
  assert.deepEqual(D.parse('ab3c9d'), { ok: true, room: ROOM, secret: null });
  assert.equal(D.parse('AB3C9DABCDEFGHJKL').ok, false, '17 chars');
  assert.equal(D.parse('AB3C9DABCDEFGHJKLMN').ok, false, '19 chars');
  assert.equal(D.parse('AB3C9DABCDEFGHJKL0').ok, false, '0 is not in the alphabet');
  assert.equal(D.parse('AB3C9DABCDEFGHJKLI').ok, false, 'I is not in the alphabet');
  assert.equal(D.parse('').ok, false);
  assert.equal(D.parse(null).ok, false);
  // A room that happens to start with S-T-U is not mangled, with or without the display prefix.
  assert.deepEqual(D.parse('STUABCDEFGHJKLMNPQ'), { ok: true, room: 'STUABC', secret: 'DEFGHJKLMNPQ' });
  assert.deepEqual(D.parse('STU-STU-ABC-DEFG-HJKL-MNPQ'), { ok: true, room: 'STUABC', secret: 'DEFGHJKLMNPQ' });
  assert.deepEqual(D.parse('STU-STU-ABC'), { ok: true, room: 'STUABC', secret: null });
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const s = D.randChars(12);
    assert.equal(s.length, 12);
    assert.ok([...s].every((c) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.includes(c)), 'random codes stay inside the alphabet');
    seen.add(s);
  }
  assert.equal(seen.size, 20, 'secrets are random');
  // Live formatting groups as STU-XXX-XXX-YYYY-YYYY-YYYY and enables Connect only for a full code.
  const el = { value: 'ab3c9dabcdefghjklm' };
  D.els.syncConnectBtn = { disabled: true };
  D.els.syncInputHint = { textContent: '', classList: { toggle() {} } };
  D.onCodeInput(el);
  assert.equal(el.value, 'STU-AB3-C9D-ABCD-EFGH-JKLM');
  assert.equal(D.els.syncConnectBtn.disabled, false);
  el.value = 'STU-AB3-C9D';
  D.onCodeInput(el);
  assert.equal(D.els.syncConnectBtn.disabled, true, 'a bare room with no stored key cannot connect');
  assert.match(D.els.syncInputHint.textContent, /6\/18/);
  D.setKey('stupind-ab3c9d', KEY1);
  D.onCodeInput(el);
  assert.equal(D.els.syncConnectBtn.disabled, false, 'a bare room with a stored key can reconnect');
});

test('key derivation and transport: PBKDF2 per (secret, room), HKDF → AES-GCM round-trips, tampering and wrong direction fail', async () => {
  const D = loadDevice({ id: A_ID, broker: makeBroker() });
  const k1 = await D.deriveKey(SECRET, ROOM);
  assert.match(k1, /^[0-9a-f]{64}$/);
  assert.equal(await D.deriveKey(SECRET, ROOM), k1, 'deterministic');
  assert.equal(await D.deriveKey(SECRET.toLowerCase(), ROOM.toLowerCase()), k1, 'case-insensitive');
  assert.notEqual(await D.deriveKey('ABCDEFGHJKLN', ROOM), k1, 'the secret matters');
  assert.notEqual(await D.deriveKey(SECRET, 'AB3C9E'), k1, 'the room salts the derivation');
  // HMAC proofs are 64 hex and compare in constant time.
  const m = await D.mac(k1, ['odta-sync-v3', 'initiator', 'a', 'b', 'n1', 'n2']);
  assert.match(m, /^[0-9a-f]{64}$/);
  assert.equal(await D.mac(k1, ['odta-sync-v3', 'initiator', 'a', 'b', 'n1', 'n2']), m);
  assert.notEqual(await D.mac(k1, ['odta-sync-v3', 'acceptor', 'a', 'b', 'n1', 'n2']), m, 'role is bound');
  assert.equal(D.macEq(m, m), true);
  assert.equal(D.macEq(m, m.slice(0, 63) + (m.endsWith('0') ? '1' : '0')), false);
  assert.equal(D.macEq(m, m.slice(1)), false);
  assert.equal(D.macEq(undefined, m), false);
  // Strict base64.
  assert.equal(D.unb64('not base64!'), null);
  assert.equal(D.unb64('QUJ'), null, 'length not a multiple of 4 is refused');
  assert.equal(D.unb64(123), null);
  assert.deepEqual(Array.from(D.unb64('QUJDRA==')), [65, 66, 67, 68]);
  // Transport.
  const keys = await D.deriveEncKey(k1);
  const wrong = await D.deriveEncKey(await D.deriveKey('ABCDEFGHJKLN', ROOM));
  const aadOut = D.aad('n1', 'n2', 'initiator');
  const aadIn = D.aad('n1', 'n2', 'acceptor');
  const inner = { type: 'state', payload: { tasks: [task(1, 'private thought')] } };
  const wire = await D.encrypt(keys, aadOut, inner);
  assert.equal(wire.type, 'enc');
  assert.equal(wire.v, 3);
  assert.equal(Buffer.from(wire.iv, 'base64').length, 12, '96-bit IV');
  assert.ok(!JSON.stringify(wire).includes('private thought'), 'ciphertext carries no plaintext');
  assert.deepEqual(await D.decrypt(keys, aadOut, wire), inner);
  await assert.rejects(D.decrypt(wrong, aadOut, wire), 'wrong key');
  await assert.rejects(D.decrypt(keys, aadIn, wire), 'direction is bound through the AAD');
  await assert.rejects(D.decrypt(keys, D.aad('n1', 'nX', 'initiator'), wire), 'session nonces are bound');
  const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
  await assert.rejects(D.decrypt(keys, aadOut, { ...wire, ct: flip(wire.ct) }), 'tampered ciphertext');
  await assert.rejects(D.decrypt(keys, aadOut, { ...wire, v: 2 }), 'version pinned');
  await assert.rejects(D.decrypt(keys, aadOut, { ...wire, iv: b64(new Uint8Array(8)) }), 'iv length checked');
  await assert.rejects(D.decrypt(keys, aadOut, { type: 'state', payload: {} }), 'plaintext is never accepted');
  await assert.rejects(D.decrypt(keys, aadOut, { ...wire, ct: 'A'.repeat(D.MAX_WIRE + 4) }), 'an oversized ciphertext is refused');
  const again = await D.encrypt(keys, aadOut, inner);
  assert.notEqual(again.iv, wire.iv, 'fresh IV per message');
  assert.notEqual(again.ct, wire.ct);
});

test('first pairing: the dialer proves the secret-derived key, the acceptor asks its user, then only ciphertext flows', async () => {
  const broker = makeBroker();
  const A = loadDevice({ id: A_ID, broker, tasks: [task(1, 'from A')] });
  const B = loadDevice({ id: B_ID, broker, tasks: [task(2, 'from B')] });
  A.enable();
  await until(() => A.peer && A.status === 'waiting', 'A waiting');
  const code = A.code();
  assert.ok(code && /^STU-AAA-AAA-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), 'a fresh device offers a full code: ' + code);
  assert.equal(A.offer().secret.length, 12);
  B.enable();
  await until(() => B.peer, 'B peer');
  assert.equal(B.key(A_ID), null);
  B.connect(code);
  await until(() => A.banners.length === 1, 'A shows the banner');
  assert.match(A.banners[0], /Incoming sync/);
  assert.doesNotMatch(A.banners[0], /Re-pair/);
  assert.equal(B.key(A_ID), await B.deriveKey(A.offer().secret, 'AAAAAA'), 'B installed the derived key before dialling');
  assert.equal(A.key(B_ID), null, 'A stores nothing before Accept');
  assert.deepEqual(broker.types(B_ID), ['hello', 'auth'], 'the dialer proves itself first');
  assert.deepEqual(broker.types(A_ID), ['hello'], 'the acceptor has signed nothing before Accept');
  assert.equal(A.ready, false);
  assert.equal(B.ready, false);
  A.accept();
  await until(() => A.ready && B.ready, 'both ready');
  await until(() => A.tasks.length === 2 && B.tasks.length === 2, 'state merged both ways');
  assert.equal(A.key(B_ID), B.key(A_ID), 'both hold the same key');
  assert.equal(A.offer(), null, 'the offer is consumed by the pairing');
  assert.equal(A.code(), null);
  assert.deepEqual(broker.types(A_ID).slice(0, 2), ['hello', 'auth']);
  assert.ok(broker.types(A_ID).slice(2).length >= 1 && broker.types(A_ID).slice(2).every((t) => t === 'enc'), 'A: only enc after the handshake: ' + broker.types(A_ID).join(','));
  assert.ok(broker.types(B_ID).slice(2).length >= 1 && broker.types(B_ID).slice(2).every((t) => t === 'enc'), 'B: only enc after the handshake: ' + broker.types(B_ID).join(','));
  assert.ok(!broker.wire.some((m) => m.msg.type === 'pair'), "the 'pair' message type is gone");
  assert.ok(!/from A|from B|"tasks"|"payload"/.test(JSON.stringify(broker.wire)), 'no task data in plaintext on the wire');
  assert.deepEqual(A.tasks.map((t) => t.name).sort(), ['from A', 'from B']);
  assert.deepEqual(B.tasks.map((t) => t.name).sort(), ['from A', 'from B']);
  assert.equal(A.status, 'connected');
  assert.equal(B.status, 'connected');
  assert.equal(B.store.get('stupind_sync_room'), 'STU-AAA-AAA', 'the room (never the secret) is remembered');
  assert.equal(A.store.get('stupind_sync_room'), 'STU-BBB-BBB');
  // A later save broadcasts an encrypted patch the other side merges.
  const before = broker.wire.length;
  A.tasks.push(task(3, 'later from A'));
  A.broadcast();
  await until(() => B.tasks.some((t) => t.id === 3), 'patch merged');
  const later = broker.wire.slice(before);
  assert.ok(later.length >= 1 && later.every((m) => m.msg.type === 'enc'), 'patches are encrypted');
  assert.ok(!JSON.stringify(later).includes('later from A'));
});

test('paired devices reconnect on boot with mutual proof and no banner', async () => {
  const broker = makeBroker();
  const pairs = (id) => JSON.stringify({ [id]: KEY1 });
  const A = loadDevice({ id: A_ID, broker, storage: { stupind_sync_pairs: pairs(B_ID) } });
  const B = loadDevice({ id: B_ID, broker, storage: { stupind_sync_pairs: pairs(A_ID), stupind_sync_room: 'STU-AAA-AAA' } });
  A.enable();
  await until(() => A.peer, 'A peer');
  assert.equal(A.code(), null, 'a paired device does not mint an offer on its own');
  B.enable();
  await until(() => A.ready && B.ready, 'auto-dial from the stored room completes');
  assert.equal(A.banners.length, 0, 'a proven device is accepted silently');
  assert.deepEqual(broker.types(B_ID).slice(0, 2), ['hello', 'auth']);
  assert.deepEqual(broker.types(A_ID).slice(0, 2), ['hello', 'auth']);
  assert.ok(broker.wire.slice(4).every((m) => m.msg.type === 'enc'));
  assert.equal(A.key(B_ID), KEY1, 'no key is replaced on a reconnect');
  assert.equal(B.key(A_ID), KEY1);
  assert.equal(A.pending, null);
  assert.equal(A.lastCode, 'STU-BBB-BBB', 'the acceptor remembers its peer for reconnects');
});

test('a squatter on a paired id gets nothing from an auto-reconnect, whatever it sends, and cannot mint a key', async () => {
  const broker = makeBroker();
  const squatter = await rawPeer(broker, A_ID);
  const seen = [];
  squatter.on('connection', (c) => {
    c.on('data', (m) => {
      seen.push(m);
      if (m.type === 'hello') c.send({ type: 'hello', v: 3, nonce: hexNonce() });
      if (m.type === 'auth') {
        c.send({ type: 'auth', v: 3, mac: 'a'.repeat(64) });
        c.send({ type: 'pair', key: 'f'.repeat(64) });
        c.send({ type: 'state', payload: { tasks: [task(9, 'evil')], syncTaskDels: { 1: Date.now() + 200000 } } });
        c.send({ type: 'ping' });
      }
    });
  });
  const B = loadDevice({ id: B_ID, broker, tasks: [task(1, 'guest secret task')],
    storage: { stupind_sync_pairs: JSON.stringify({ [A_ID]: KEY1 }), stupind_sync_room: 'STU-AAA-AAA' } });
  B.enable();
  await until(() => B.status === 'error', 'B rejects the squatter');
  assert.match(B.statusMsg, /could not prove it is the device you paired/);
  await sleep(30);
  assert.deepEqual(seen.map((m) => m.type), ['hello', 'auth'], 'the squatter got nothing beyond hello + proof');
  assert.ok(!JSON.stringify(seen).includes('guest secret task'));
  assert.ok(!broker.types(B_ID).includes('enc') && !broker.types(B_ID).includes('state'), 'the vault never left B');
  assert.equal(B.key(A_ID), KEY1, 'a reconnect never takes a new key');
  assert.equal(B.tasks.length, 1, 'no pre-auth payload is merged');
  assert.equal(B.tasks[0].name, 'guest secret task');
  assert.equal(B.conn, null, 'B hung up');
  assert.equal(B.lastCode, null, 'no auto-redial into the same refusal');
  assert.equal(B.reconnectPending, false);
});

test('acceptor: a forged proof, a stranger with no active code, a v2 hello and plaintext state are refused with a reason and no banner', async () => {
  const broker = makeBroker();
  // A has an active pairing code (fresh device) …
  const A = loadDevice({ id: A_ID, broker, tasks: [task(1, 'host secret task')] });
  A.enable();
  await until(() => A.peer && A.code(), 'A code');
  const raw = await rawPeer(broker, 'stupind-xxxxxx');

  // (a) forged proof against the offer
  let { c, got } = await rawDial(raw, A_ID);
  c.send({ type: 'hello', v: 3, nonce: hexNonce() });
  c.send({ type: 'auth', v: 3, mac: 'b'.repeat(64) });
  await until(() => c.closed, 'closed a');
  assert.deepEqual(got.map((m) => m.type), ['hello', 'refuse']);
  assert.deepEqual(got[1], { type: 'refuse', v: 3, reason: 'bad-proof' });
  assert.equal(A.banners.length, 0, 'a failed proof never raises a banner');
  assert.equal(A.key('stupind-xxxxxx'), null);
  assert.ok(A.offer(), 'the offer survives a failed attempt');
  assert.equal(A.inboundBlocked(), true, 'the failure throttles inbound connections');
  assert.match(A.statusMsg, /could not prove/);

  // (b) v2 hello
  A.resetThrottle();
  ({ c, got } = await rawDial(raw, A_ID));
  c.send({ type: 'hello', v: 2, nonce: hexNonce(), paired: true });
  await until(() => c.closed, 'closed b');
  assert.deepEqual(got.map((m) => m.type), ['hello', 'refuse']);
  assert.equal(got[1].reason, 'version');
  assert.match(A.statusMsg, /different Odta sync version/);

  // (c) plaintext state before any handshake (a v78 dialer, or a probe)
  A.resetThrottle();
  ({ c, got } = await rawDial(raw, A_ID));
  c.send({ type: 'state', payload: { tasks: [task(9, 'evil')] } });
  await until(() => c.closed, 'closed c');
  assert.equal(got.at(-1).type, 'refuse');
  assert.equal(got.at(-1).reason, 'version');
  assert.equal(A.tasks.length, 1, 'nothing merged');

  // (d) ciphertext before the handshake
  A.resetThrottle();
  ({ c, got } = await rawDial(raw, A_ID));
  c.send({ type: 'enc', v: 3, iv: b64(new Uint8Array(12)), ct: b64(new Uint8Array(32)) });
  await until(() => c.closed, 'closed d');
  assert.equal(got.at(-1).type, 'refuse');

  // (e) a stranger when no pairing code is active: A2 is paired with someone, offers nothing.
  const A2 = loadDevice({ id: 'stupind-aaaaa2', broker, storage: { stupind_sync_pairs: JSON.stringify({ [B_ID]: KEY1 }) } });
  A2.enable();
  await until(() => A2.peer, 'A2 peer');
  assert.equal(A2.code(), null);
  ({ c, got } = await rawDial(raw, 'stupind-aaaaa2'));
  c.send({ type: 'hello', v: 3, nonce: hexNonce() });
  await until(() => c.closed, 'closed e');
  assert.deepEqual(got.map((m) => m.type), ['hello', 'refuse']);
  assert.equal(got[1].reason, 'no-pairing');
  assert.equal(A2.banners.length, 0);
  assert.equal(A2.key('stupind-xxxxxx'), null);
  assert.ok(!JSON.stringify(broker.wire).includes('host secret task'), 'the host never sent its tasks');
  assert.ok(!broker.wire.some((m) => m.msg.type === 'auth' && m.from !== 'stupind-xxxxxx'), 'the acceptor signed nothing for a stranger');
});

test('dialer: refuse is a hard failure with an explanation and no auto-redial; pre-v3 answers stop with an update message', async () => {
  const broker = makeBroker();
  const C_ID = 'stupind-cccccc';
  const B = loadDevice({ id: B_ID, broker, storage: { stupind_sync_pairs: JSON.stringify({ [C_ID]: KEY1 }) } });
  B.enable();
  await until(() => B.peer, 'B peer');
  const raw = await rawPeer(broker, C_ID);
  let reply = null;
  raw.on('connection', (c) => c.on('data', (m) => { if (m.type === 'hello' && reply) for (const r of reply) c.send(r); }));

  const dial = async (answers, re) => {
    reply = answers;
    B.connect('STU-CCC-CCC');
    await until(() => B.status === 'error' && B.conn === null, 'B fails');
    assert.match(B.statusMsg, re);
    assert.equal(B.lastCode, null, 'no auto-redial');
    assert.equal(B.reconnectPending, false);
    assert.ok(!broker.types(B_ID).includes('enc'), 'nothing encrypted left B');
  };
  await dial([{ type: 'refuse', v: 3, reason: 'bad-proof' }], /could not verify the pairing/);
  await dial([{ type: 'refuse', v: 3, reason: 'no-pairing' }], /not paired with this device/);
  await dial([{ type: 'refuse', v: 3, reason: 'version' }], /update Odta on the other device/i);
  await dial([{ type: 'refuse', v: 3, reason: 'rejected' }], /declined/);
  // A v2 acceptor: hello v2, or its user's Accept → 'pair' + plaintext state.
  await dial([{ type: 'hello', v: 2, nonce: hexNonce(), paired: false }], /different Odta sync version/);
  await dial([{ type: 'pair', key: 'f'.repeat(64) }, { type: 'state', payload: { tasks: [] } }], /older Odta/);
  // A v78 acceptor: no hello at all, just state after Accept.
  await dial([{ type: 'state', payload: { tasks: [task(9, 'x')] } }], /older Odta/);
  assert.equal(B.tasks.length, 0, 'nothing merged from a pre-v3 peer');
  assert.equal(B.key(C_ID), KEY1, 'the stored key is untouched by refusals');
});

test('a bare 6-character code is refused without a stored key; a full code installs the derived key before dialling', async () => {
  const broker = makeBroker();
  const B = loadDevice({ id: B_ID, broker });
  B.enable();
  await until(() => B.peer, 'B peer');
  const wireBefore = broker.wire.length;
  B.connect('STU-ZZZ-ZZZ');
  assert.equal(B.status, 'error');
  assert.match(B.statusMsg, /Enter the full pairing code shown on the other device \(18 characters after STU-\)\. Older 6-character codes can no longer pair\./);
  assert.equal(B.key('stupind-zzzzzz'), null);
  assert.equal(B.conn, null, 'no dial went out');
  await sleep(20);
  assert.equal(broker.wire.length, wireBefore);
  // Full code: derived key stored, then the dial (nobody is registered → code not found).
  B.connect('STU-ZZZ-ZZZ-' + SECRET.slice(0, 4) + '-' + SECRET.slice(4, 8) + '-' + SECRET.slice(8));
  await until(() => B.key('stupind-zzzzzz'), 'key derived');
  assert.equal(B.key('stupind-zzzzzz'), await B.deriveKey(SECRET, 'ZZZZZZ'));
  await until(() => /Code not found/.test(B.statusMsg), 'dial attempted');
  // Now the bare code is enough to (re)dial that device.
  B.connect('STU-ZZZ-ZZZ');
  assert.equal(B.status, 'connecting');
  assert.equal(B.lastCode, 'STU-ZZZ-ZZZ');
  await until(() => /Code not found/.test(B.statusMsg), 'second dial attempted');
});

test('re-pair after a reset: a full code replaces a stored key on the dialer, and the intact acceptor shows a re-pair banner', async () => {
  const broker = makeBroker();
  // B still holds an old key for A; A was reset (fresh storage, same id) and shows a new code.
  const A = loadDevice({ id: A_ID, broker, tasks: [task(1, 'from A')] });
  const B = loadDevice({ id: B_ID, broker, storage: { stupind_sync_pairs: JSON.stringify({ [A_ID]: KEY1 }) } });
  A.enable();
  await until(() => A.peer && A.code(), 'A code');
  B.enable();
  await until(() => B.peer, 'B peer');
  B.connect(A.code());
  await until(() => A.banners.length === 1, 'A banner');
  assert.match(A.banners[0], /Incoming sync/, 'A holds no key for B: a plain first-pairing banner');
  assert.notEqual(B.key(A_ID), KEY1, 'the typed code replaced the stale key');
  A.accept();
  await until(() => A.ready && B.ready, 'both ready');
  assert.equal(A.key(B_ID), B.key(A_ID));
  await until(() => B.tasks.length === 1, 'state merged');

  // The other direction: B holds a key for the reset device C, which was wiped and dials B with B's new code.
  const B2 = loadDevice({ id: 'stupind-bbbbb2', broker, storage: { stupind_sync_pairs: JSON.stringify({ 'stupind-cccccc': KEY2 }) } });
  B2.enable();
  await until(() => B2.peer, 'B2 peer');
  assert.equal(B2.code(), null, 'paired: no automatic offer');
  B2.newCode();
  assert.ok(B2.code(), 'Generate pairing code mints an offer without touching the id or the pairs');
  assert.equal(B2.key('stupind-cccccc'), KEY2);
  assert.equal(B2.peer.id, 'stupind-bbbbb2');
  const C = loadDevice({ id: 'stupind-cccccc', broker });
  C.enable();
  await until(() => C.peer, 'C peer');
  C.connect(B2.code());
  await until(() => B2.banners.length === 1, 'B2 banner');
  assert.match(B2.banners[0], /Re-pair request/, 'a stored key that no longer matches, but the current code proved: re-pair banner');
  assert.equal(B2.key('stupind-cccccc'), KEY2, 'nothing replaced before Accept');
  B2.accept();
  await until(() => B2.ready && C.ready, 'both ready');
  assert.notEqual(B2.key('stupind-cccccc'), KEY2, 'Accept replaced the stale key');
  assert.equal(B2.key('stupind-cccccc'), C.key('stupind-bbbbb2'));
  assert.equal(B2.offer(), null, 'the offer is consumed');
});

test('a stored room without a key is not auto-dialled: the room is forgotten and the panel says so', async () => {
  const broker = makeBroker();
  const A = loadDevice({ id: A_ID, broker });
  A.enable();
  await until(() => A.peer, 'A peer');
  const B = loadDevice({ id: B_ID, broker, storage: { stupind_sync_room: 'STU-AAA-AAA' } });
  B.enable();
  await until(() => B.peer && B.status === 'unpaired', 'B unpaired');
  await sleep(30);
  assert.equal(broker.types(B_ID).length, 0, 'no hello left B');
  assert.equal(B.conn, null);
  assert.equal(B.store.get('stupind_sync_room'), undefined, 'the unprovable room is forgotten');
  assert.equal(A.banners.length, 0);
  // Reconnect now with nothing provable does not dial either.
  B.reconnectNow();
  assert.equal(B.status, 'unpaired');
  assert.equal(B.conn, null);
});

test('after readiness only ciphertext is accepted: plaintext, an oversized or an undecryptable message closes the link', async () => {
  const broker = makeBroker();
  const { A, B } = await pairFresh(broker, { aTasks: [task(1, 'from A')] });
  await until(() => B.tasks.length === 1, 'initial merge');
  const inject = async (msg, re) => {
    await until(() => A.ready && B.ready && A.conn && A.conn.open, 'link up');
    const aConn = A.conn;
    B.conn.send(msg);
    await until(() => A.conn !== aConn, 'A dropped the link');
    assert.equal(A.status, 'error');
    assert.match(A.statusMsg, re);
    assert.equal(A.tasks.length, 1, 'nothing merged');
    assert.equal(A.tasks[0].name, 'from A');
    // B notices the drop and redials with its stored key; A takes it silently.
    await until(() => A.ready && B.ready, 'reconnected', 4000);
    assert.equal(A.banners.length, 1, 'no new banner for a known device');
  };
  await inject({ type: 'patch', payload: { tasks: [task(99, 'evil')] } }, /unencrypted message after pairing/);
  await inject({ type: 'enc', v: 3, iv: b64(new Uint8Array(12)), ct: 'A'.repeat(A.MAX_WIRE + 4) }, /too large/);
  await inject({ type: 'enc', v: 3, iv: b64(new Uint8Array(12)), ct: b64(new Uint8Array(48)) }, /could not decrypt/);
  await inject({ type: 'ping' }, /unencrypted/);
});

test('handshake failures throttle inbound connections: doubling back-off, ten in fifteen minutes closes on arrival', async () => {
  const broker = makeBroker();
  const A = loadDevice({ id: A_ID, broker });
  A.enable();
  await until(() => A.peer && A.code(), 'A code');
  const raw = await rawPeer(broker, 'stupind-xxxxxx');
  let { c, got } = await rawDial(raw, A_ID);
  c.send({ type: 'hello', v: 2, nonce: hexNonce() });
  await until(() => c.closed, 'refused');
  assert.equal(got.at(-1).type, 'refuse');
  // The next arrival is closed without a word.
  ({ c, got } = await rawDial(raw, A_ID));
  await until(() => c.closed, 'closed on arrival');
  assert.deepEqual(got, [], 'nothing is said to a throttled peer');
  assert.equal(A.pending, null);
  // Back-off schedule: 2 s, 4 s, 8 s … capped at 60 s; ten failures in the window block outright.
  A.resetThrottle();
  const waits = [];
  for (let i = 1; i <= 10; i++) {
    const t0 = Date.now();
    A.recordFailure();
    waits.push(A.throttle().blockedUntil - t0);
  }
  assert.ok(waits[0] >= 1990 && waits[0] <= 2100, '2 s after one failure: ' + waits[0]);
  assert.ok(waits[1] >= 3990 && waits[1] <= 4100, '4 s after two');
  assert.ok(waits[2] >= 7990 && waits[2] <= 8100, '8 s after three');
  assert.ok(waits[5] >= 59990 && waits[5] <= 60100, 'capped at 60 s');
  assert.equal(A.throttle().failures, 10);
  A.unblock();
  assert.equal(A.inboundBlocked(), true, 'ten failures in the window stop answering even after the back-off');
  ({ c, got } = await rawDial(raw, A_ID));
  await until(() => c.closed, 'closed while blocked');
  assert.deepEqual(got, []);
  // Once cleared a legitimate pairing goes through again.
  A.resetThrottle();
  assert.equal(A.inboundBlocked(), false);
  const B = loadDevice({ id: B_ID, broker });
  B.enable();
  await until(() => B.peer, 'B peer');
  B.connect(A.code());
  await until(() => A.banners.length === 1, 'banner after reset');
  A.accept();
  await until(() => A.ready && B.ready, 'paired');
});

test('the handshake times out on both roles, with room for the Accept tap, and an inbound timeout counts as a failure', async () => {
  const broker = makeBroker();
  // Dialer: the answering peer says hello and then nothing.
  const silent = await rawPeer(broker, A_ID);
  silent.on('connection', (c) => c.on('data', (m) => { if (m.type === 'hello') c.send({ type: 'hello', v: 3, nonce: hexNonce() }); }));
  const B = loadDevice({ id: B_ID, broker, storage: { stupind_sync_pairs: JSON.stringify({ [A_ID]: KEY1 }) } });
  B.enable();
  await until(() => B.peer, 'B peer');
  B.connect('STU-AAA-AAA');
  await until(() => B.status === 'connecting' && /accept/.test(B.statusMsg), 'waiting for accept');
  await until(() => B.status === 'error', 'dialer timeout', 3000);
  assert.match(B.statusMsg, /did not finish pairing in time/);
  assert.equal(B.conn, null);
  assert.equal(B.lastCode, null, 'no auto-redial after a timeout');
  // Acceptor: a peer opens a channel and never speaks.
  const H = loadDevice({ id: 'stupind-hhhhhh', broker });
  H.enable();
  await until(() => H.peer && H.code(), 'H code');
  const raw = await rawPeer(broker, 'stupind-xxxxxx');
  const { c, got } = await rawDial(raw, 'stupind-hhhhhh');
  await until(() => c.closed, 'acceptor timeout', 3000);
  assert.deepEqual(got.map((m) => m.type), ['hello'], 'only the hello was ever sent');
  assert.match(H.statusMsg, /timed out/);
  assert.equal(H.inboundBlocked(), true);
  assert.equal(H.pending, null);
});

test('Reject on the banner tells the dialer, keeps the offer and stores no key', async () => {
  const broker = makeBroker();
  const A = loadDevice({ id: A_ID, broker });
  const B = loadDevice({ id: B_ID, broker });
  A.enable();
  await until(() => A.peer && A.code(), 'A code');
  B.enable();
  await until(() => B.peer, 'B peer');
  const code = A.code();
  B.connect(code);
  await until(() => A.banners.length === 1, 'banner');
  A.reject();
  await until(() => B.status === 'error' && B.conn === null, 'B told');
  assert.match(B.statusMsg, /declined the pairing/);
  assert.equal(B.lastCode, null);
  assert.equal(A.key(B_ID), null);
  assert.equal(A.code(), code, 'the offer survives a rejection');
  assert.equal(A.ready, false);
  assert.ok(!broker.types(A_ID).includes('auth'), 'A never proved itself to a peer it rejected');
});

test('unavailable-id retries with the same id instead of rotating it', async () => {
  const broker = makeBroker();
  const squatter = await rawPeer(broker, B_ID);
  const B = loadDevice({ id: B_ID, broker, storage: { stupind_sync_pairs: JSON.stringify({ [A_ID]: KEY1 }) } });
  B.enable();
  await until(() => /busy on the broker/.test(B.statusMsg), 'first retry message');
  assert.equal(B.store.get('stupind_peer_id_v2'), B_ID, 'the id is kept');
  await until(() => /Close other Odta tabs/.test(B.statusMsg), 'gave up after three retries', 3000);
  assert.equal(B.store.get('stupind_peer_id_v2'), B_ID);
  assert.equal(B.key(A_ID), KEY1, 'pairings survive');
  assert.equal(B.peer, null);
  // The other tab goes away: Reconnect brings the engine back on the same id.
  squatter.destroy();
  B.reconnectNow();
  await until(() => B.peer && B.status === 'waiting', 'registered');
  assert.equal(B.peer.id, B_ID);
});

test('both devices dialling each other at once keep the connection the lower id started', async () => {
  const broker = makeBroker();
  const A = loadDevice({ id: A_ID, broker, storage: { stupind_sync_pairs: JSON.stringify({ [B_ID]: KEY1 }) } });
  const B = loadDevice({ id: B_ID, broker, storage: { stupind_sync_pairs: JSON.stringify({ [A_ID]: KEY1 }) } });
  A.enable(); B.enable();
  await until(() => A.peer && B.peer && A.status === 'waiting' && B.status === 'waiting', 'both registered');
  A.connect('STU-BBB-BBB');
  B.connect('STU-AAA-AAA');
  await until(() => A.ready && B.ready, 'converged');
  await sleep(50);
  assert.equal(A.conn.outbound, true, 'A (lower id) kept the dial it placed');
  assert.equal(B.conn.outbound, false, 'B kept the inbound from A');
  assert.equal(A.conn.remote, B.conn, 'both ends hold the same link');
  assert.equal(A.banners.length + B.banners.length, 0);
  assert.equal(A.reconnectPending, false);
  assert.equal(B.reconnectPending, false);
});

test('reset sync identity mints a new id and drops every pairing and the offer', async () => {
  const broker = makeBroker();
  const A = loadDevice({ id: A_ID, broker, storage: { stupind_sync_pairs: JSON.stringify({ [B_ID]: KEY1 }), stupind_sync_room: 'STU-BBB-BBB' } });
  A.enable();
  await until(() => A.peer, 'A peer');
  const oldPeer = A.peer;
  await A.regenerate();
  await until(() => A.peer && A.peer !== oldPeer, 'new peer');
  assert.notEqual(A.peer.id, A_ID);
  assert.match(A.peer.id, /^stupind-[a-z2-9]{6}$/);
  assert.equal(oldPeer.destroyed, true);
  assert.equal(A.key(B_ID), null);
  assert.equal(A.store.get('stupind_sync_room'), undefined);
  assert.ok(A.code(), 'a fresh identity offers a code again');
});

test('static: no pair message, keys and offers never ride in the state or a backup, ready gates the senders', () => {
  assert.doesNotMatch(syncSrc, /type:\s*'pair'/, "the 'pair' message type is never sent");
  assert.doesNotMatch(syncSrc, /msg\.type === 'pair'/, "the 'pair' message type is never handled");
  assert.match(syncSrc, /const SYNC_PROTO = 3;/);
  const pIdx = syncSrc.indexOf('function _packState');
  const pBody = syncSrc.slice(pIdx, syncSrc.indexOf('\n}', pIdx));
  assert.doesNotMatch(pBody, /SYNC_PAIRS_KEY|_loadSyncPairs|SYNC_OFFER_KEY|_loadSyncOffer|secret/);
  const storage = readFileSync(join(root, 'js', 'storage.js'), 'utf8');
  assert.doesNotMatch(storage, /stupind_sync_pairs|SYNC_PAIRS|stupind_sync_offer|SYNC_OFFER/);
  const bIdx = syncSrc.indexOf('function syncBroadcast');
  assert.match(syncSrc.slice(bIdx, bIdx + 400), /_conn\._syncReady/, 'syncBroadcast must check _syncReady');
  const aIdx = syncSrc.indexOf('function _scheduleSyncAck');
  assert.match(syncSrc.slice(aIdx, aIdx + 400), /_conn\._syncReady/, '_scheduleSyncAck must check _syncReady');
  assert.doesNotMatch(syncSrc.slice(bIdx, bIdx + 1200), /_conn\.send\(/, 'syncBroadcast never bypasses the encrypting sender');
  const i = syncSrc.indexOf("_peer.on('connection'");
  const body = syncSrc.slice(i, syncSrc.indexOf('});', i));
  assert.match(body, /_inboundBlocked\(\)/);
  assert.match(body, /_conn\.peer === conn\.peer/);
  assert.match(body, /_myPeerId\(\) < String\(conn\.peer\)/);
  const r = syncSrc.indexOf('function _syncMarkReady');
  assert.match(syncSrc.slice(r, syncSrc.indexOf('\n}', r)), /clearTimeout\(_reconnectTimerId\)/);
  const u = syncSrc.indexOf("t === 'unavailable-id'");
  assert.doesNotMatch(syncSrc.slice(u, u + 1200), /removeItem\(SYNC_PEER_KEY\)/, 'a busy id is never rotated');
  assert.match(syncSrc, /SYNC_KDF_ITERATIONS = 100000/);
  assert.match(syncSrc, /SYNC_HANDSHAKE_TIMEOUT_MS = 45000/);
});
