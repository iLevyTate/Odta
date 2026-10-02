// ========== P2P SYNC (WebRTC via PeerJS) ==========
// Devices sync directly — no server sees your data.
// PeerJS cloud only handles the initial handshake (SDP/ICE exchange).
// After that, data flows device-to-device via RTCDataChannel.
//
// ── Pairing + wire protocol (v3) ─────────────────────────────────────────
// PeerJS ids are first-come on a public broker with no proof of ownership, so
// an id on its own is never trusted. Pairing carries a secret:
//
//   pairing code = STU-XXX-XXX-YYYY-YYYY-YYYY. ROOM (XXX-XXX) is this device's
//                  6-character id suffix, unchanged from earlier versions;
//                  SECRET (YYYY-YYYY-YYYY) is 12 random characters shown only
//                  on the device that generated it, replaced by "Generate new
//                  pairing code" and consumed by the first pairing made with it.
//   pair key     = PBKDF2-SHA256(SECRET, "odta-sync-v3:" + ROOM, 100 000
//                  iterations, 256 bits), stored per peer id in
//                  `stupind_sync_pairs`. v79/v80 pairs already hold a shared
//                  256-bit key there and keep working.
//   handshake    = both ends send {type:"hello", v:3, nonce}; the dialer sends
//                  {type:"auth", v:3, mac} = HMAC-SHA256(key, role | ids | both
//                  nonces); the acceptor verifies it against the key stored
//                  for that id, or the key of its active pairing code, and only
//                  then answers with its own auth (after its user taps Accept
//                  when the pairing code was used). Anything else, a bad proof
//                  or another version gets {type:"refuse", v:3, reason} and the
//                  connection is closed.
//   transport    = after readiness every message is {type:"enc", v:3, iv, ct}:
//                  AES-256-GCM under HKDF(pair key), with both nonces and the
//                  sender's role as additional data, decrypted before the
//                  merge runs. Plaintext after readiness closes the link.
//
// Peer ID format: `stupind-<6 alphanumeric>` (never includes "stu" as suffix).
// Displayed as `STU-XXX-XXX` where the first "STU" is branding only.
// A legacy v1 bug produced 9-char ids starting with "stu" (the brand accidentally
// embedded in the id), rendered as "STU-STU-XXXXXX". We migrate those on boot.
const SYNC_PEER_KEY    = (window.ODTAULAI_CONFIG && window.ODTAULAI_CONFIG.STORAGE_KEYS && window.ODTAULAI_CONFIG.STORAGE_KEYS.SYNC_PEER) || 'stupind_peer_id_v2'; // cleaned format
const SYNC_PEER_KEY_V1 = (window.ODTAULAI_CONFIG && window.ODTAULAI_CONFIG.STORAGE_KEYS && window.ODTAULAI_CONFIG.STORAGE_KEYS.SYNC_PEER_V1) || 'stupind_peer_id';    // legacy — detected & migrated
const SYNC_ROOM_KEY    = (window.ODTAULAI_CONFIG && window.ODTAULAI_CONFIG.STORAGE_KEYS && window.ODTAULAI_CONFIG.STORAGE_KEYS.SYNC_ROOM) || 'stupind_sync_room';
const SYNC_VERSION     = 1;
const CODE_ALPHABET    = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Crockford-ish, no 0/O/1/I (32 symbols)
const SYNC_ROOM_LEN    = 6;    // characters of a device id suffix (the "XXX-XXX" part of a code)
const SYNC_SECRET_LEN  = 12;   // characters of the pairing secret (60 bits)
const SYNC_CODE_LEN    = SYNC_ROOM_LEN + SYNC_SECRET_LEN;

let _peer        = null;   // PeerJS instance
let _conn        = null;   // active DataConnection
let _syncEnabled = false;
let _syncStatus  = 'off';  // 'off' | 'loading' | 'unpaired' | 'waiting' | 'connecting' | 'connected' | 'error'
let _syncStatusMsg = '';   // detail behind an 'error' status, kept across panel re-renders
let _myRoomCode  = null;
let _lastSyncAt  = null;
let _connectTimeoutId = null;
let _pendingInboundConn = null;
// Auto-reconnect state. Sync used to set status='error' on socket-closed and
// stop, leaving the user stuck. Now we remember the target code, schedule a
// retry with exponential backoff (2s, 4s, 8s, 16s, 30s), and stop after the
// fifth attempt — at which point the user can manually click Reconnect.
let _lastConnectCode    = null;
let _reconnectAttempt   = 0;
let _reconnectTimerId   = null;
const SYNC_RECONNECT_BACKOFFS_MS = [2000, 4000, 8000, 16000, 30000];
let _syncApplying = false;
let _syncSentTaskIdCtr = null;   // taskIdCtr as sent in our last initial state (see _syncResolveIdCollisions)
let _syncAckTimer = null;

// ── Helpers ─────────────────────────────────────────────────────────────────

function _clampSyncTs(ts){
  let n = typeof ts === 'number' ? ts : NaN;
  if(!Number.isFinite(n) && ts != null){
    const p = Date.parse(String(ts));
    n = Number.isFinite(p) ? p : NaN;
  }
  if(!Number.isFinite(n)) return 0;
  const now = Date.now();
  if(n > now + 300000) return now;
  return n;
}

// Crypto-strong random string over CODE_ALPHABET. Its 32 symbols divide 256
// evenly, so `byte % 32` is exactly uniform. Used for the device id suffix
// and for the 12-character pairing secret.
function _randChars(len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s;
}

function _genPeerId() {
  // 6 random chars → stable peer id. No "stu" baked in.
  return 'stupind-' + _randChars(SYNC_ROOM_LEN).toLowerCase();
}

// Map a PeerJS / DataConnection error to a human-readable string.
// Without this, users see raw tokens like "peer-unavailable" or "network"
// in the sync panel and assume the app is broken. Falls through to the raw
// message when no mapping is known so we never lose information.
function _friendlySyncError(err){
  const t = (err && (err.type || err.code)) || '';
  const map = {
    'peer-unavailable':     'Code not found — other device is offline or the code is mistyped.',
    'network':              'Network error — check your internet connection.',
    'server-error':         'Matchmaking server unreachable — retrying.',
    'socket-error':         'Lost connection to matchmaking server — retrying.',
    'socket-closed':        'Matchmaking connection closed — retrying.',
    'disconnected':         'Disconnected from the broker — reconnecting.',
    'browser-incompatible': 'Browser does not support WebRTC data channels.',
    'webrtc':               'WebRTC negotiation failed — try Reconnect or pairing again.',
    'unavailable-id':       "This device's sync id is busy on the broker — retrying.",
  };
  if(t && map[t]) return map[t];
  if(err && err.message) return String(err.message);
  return 'Connection failed';
}

function _setSyncStatus(status, msg) {
  _syncStatus = status;
  // Remember the detail so re-rendering the panel (closing and reopening
  // Settings) doesn't degrade a specific error to a generic "Error".
  _syncStatusMsg = msg || (status === 'error' ? _syncStatusMsg : '');
  const el = document.getElementById('syncStatus');
  const dot = document.getElementById('syncDot');
  if (!el) return;
  // Surface the connected peer's code so a user with 3+ devices can tell
  // *which* one they're paired with (#11 in UX audit).
  const peerCode = (status === 'connected' && _conn && _conn.peer) ? _idToCode(_conn.peer) : null;
  const labels = {
    off:       '○ Sync off',
    loading:   '◌ Loading…',
    unpaired:  '○ Not paired — enter the pairing code from your other device',
    waiting:   '◌ Waiting for peer…',
    connecting:'◌ ' + (msg || 'Connecting…'),
    connected: peerCode ? ('● Synced with ' + peerCode) : '● Synced',
    error:     '✕ ' + (_syncStatusMsg || 'Error'),
  };
  el.textContent = labels[status] || status;
  if (dot) dot.className = 'sync-dot sync-dot--' + status;
  // The Reconnect button depends on the status; keep it in step.
  if (typeof _renderSyncActionRow === 'function') _renderSyncActionRow();
}

/**
 * Normalize input: uppercase, strip everything but letters and digits, and
 * drop the "STU" display prefix when what remains is a whole code. A room
 * that itself starts with S-T-U is left alone because only the lengths 9
 * (prefix + room) and 21 (prefix + full code) trigger the strip.
 */
function _normalizeCode(code) {
  const raw = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.startsWith('STU') && (raw.length === SYNC_ROOM_LEN + 3 || raw.length === SYNC_CODE_LEN + 3)) return raw.slice(3);
  return raw;
}

/**
 * Parse a typed code. A full code (room + secret) pairs; a bare room only
 * addresses a device we already hold a key for (see syncConnect).
 * → {ok:true, room, secret|null} | {ok:false, message}
 */
function _parseCode(code) {
  const n = _normalizeCode(code);
  if (!n) return { ok: false, message: 'Enter a pairing code' };
  if (![...n].every(c => CODE_ALPHABET.includes(c))) {
    return { ok: false, message: 'Invalid code — pairing codes only use the digits 2-9 and letters other than I and O.' };
  }
  if (n.length === SYNC_ROOM_LEN) return { ok: true, room: n, secret: null };
  if (n.length === SYNC_CODE_LEN) return { ok: true, room: n.slice(0, SYNC_ROOM_LEN), secret: n.slice(SYNC_ROOM_LEN) };
  return { ok: false, message: 'Invalid code — expected ' + SYNC_CODE_LEN + ' letters/digits after STU- (' + n.length + ' entered)' };
}

/** True for a well-formed code of either length (a bare room still needs a stored key to connect). */
function _isValidCode(code) {
  return _parseCode(code).ok;
}

/** Peer id for a code or room ("STU-AB3-C9D", "AB3C9D…" → "stupind-ab3c9d"). */
function _codeToId(code) {
  const room = _normalizeCode(code).slice(0, SYNC_ROOM_LEN);
  return 'stupind-' + room.toLowerCase();
}

/** Upper-case id suffix ("stupind-ab3c9d" → "AB3C9D"): the ROOM half of a code and the KDF salt. */
function _idToRoom(id) {
  return String(id || '').replace(/^stupind-/, '').toUpperCase();
}

function _idToCode(id) {
  const raw = _idToRoom(id);
  // Display legacy 9-char ids (starting with STU) as clean "STU-XXX-XXX" too —
  // the embedded STU is branding noise, not an address component.
  const suffix = (raw.length === 9 && raw.startsWith('STU')) ? raw.slice(3) : raw;
  if (suffix.length === 6) return 'STU-' + suffix.slice(0,3) + '-' + suffix.slice(3);
  // Any other length: best-effort symmetric split (shouldn't happen post-migration)
  const half = Math.ceil(suffix.length / 2);
  return 'STU-' + suffix.slice(0, half) + '-' + suffix.slice(half);
}

/** Full pairing code for display: STU-XXX-XXX-YYYY-YYYY-YYYY. */
function _formatPairingCode(room, secret) {
  const s = String(secret || '');
  return _idToCode('stupind-' + String(room || '').toLowerCase()) + '-' + s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12);
}

/** True if the stored peer id is a legacy "stupind-stuXXXXXX" entry (double-STU bug). */
function _isLegacyPeerId(id) {
  if (!id) return false;
  const suffix = id.replace(/^stupind-/, '').toLowerCase();
  return suffix.length === 9 && suffix.startsWith('stu');
}

// ── PeerJS loader (CDN, lazy) ────────────────────────────────────────────────

function _loadPeerJS() {
  return new Promise((res, rej) => {
    if (window.Peer) return res(window.Peer);
    // PeerJS is vendored under js/vendor/ and precached by the SW. No CDN
    // fallback — offline-first means the local file is the only source.
    const s = document.createElement('script');
    s.src = './js/vendor/peerjs.min.js';
    s.onload  = () => res(window.Peer);
    s.onerror = () => rej(new Error('Failed to load PeerJS from js/vendor/peerjs.min.js'));
    document.head.appendChild(s);
  });
}

// ── State packaging ──────────────────────────────────────────────────────────

function _packState() {
  // Package current live state for transmission
  return {
    syncV:    SYNC_VERSION,
    sentAt:   Date.now(),
    tasks,    taskIdCtr,
    lists,    listIdCtr,   activeListId,
    goals,    goalIdCtr,
    timeLog,
    totalPomos, totalBreaks, totalFocusSec,
    sessionHistory,
    intervals, intIdCtr,
    cfg,
    theme,
    syncTaskDels, syncListDels, syncGoalDels,
    stateEpoch, stateNonce,
    pomosInCycle, phase, logIdCtr,
  };
}

function _mergeDelMapPair(local, remote) {
  const o = { ...(local || {}) };
  if (!remote || typeof remote !== 'object' || Array.isArray(remote)) return o;
  for (const [k, v] of Object.entries(remote)) {
    const id = parseInt(k, 10);
    if (!Number.isFinite(id)) continue;
    const rv = _clampSyncTs(v);
    if (o[id] == null) o[id] = rv;
    else o[id] = Math.max(_clampSyncTs(o[id]), rv);
  }
  return o;
}

function _listOrGoalLM(x) {
  if (!x) return 0;
  if (typeof x.lastModified === 'number' && x.lastModified > 0) return _clampSyncTs(x.lastModified);
  return 0;
}

const _SYNC_MAX_MSG_CHARS = 2_500_000;
const _SYNC_MAX_TASKS = 100_000;
const _SYNC_MAX_LISTS = 20_000;
const _SYNC_MAX_GOALS = 50_000;
const _SYNC_MAX_SH_MERGE = 500;

function _syncIncomingPayloadInvalid(remote) {
  if (!remote || typeof remote !== 'object' || Array.isArray(remote)) return true;
  let n = 0;
  try { n = JSON.stringify(remote).length; } catch (e) { return true; }
  if (n > _SYNC_MAX_MSG_CHARS) return true;
  if (remote.syncV != null && remote.syncV !== SYNC_VERSION) return true;
  if (Array.isArray(remote.tasks) && remote.tasks.length > _SYNC_MAX_TASKS) return true;
  if (Array.isArray(remote.lists) && remote.lists.length > _SYNC_MAX_LISTS) return true;
  if (Array.isArray(remote.goals) && remote.goals.length > _SYNC_MAX_GOALS) return true;
  return false;
}

// Union two id-keyed lists (remote wins on an id collision). Entries without
// an id (legacy rows) are kept from both sides, deduplicated by content, so a
// union never silently drops what one device logged.
function _syncUnionById(a, b) {
  const m = new Map();
  const extra = [];
  const seen = new Set();
  for (const x of [...(a || []), ...(b || [])]) {
    if (!x) continue;
    if (x.id != null) { m.set(x.id, x); continue; }
    let k; try { k = JSON.stringify(x); } catch (_) { k = String(x); }
    if (seen.has(k)) continue;
    seen.add(k); extra.push(x);
  }
  return [...m.values(), ...extra];
}
function _syncMergeTimeLogsById(a, b) { return _syncUnionById(a, b); }

function _syncMergeIntervalsById(a, b) { return _syncUnionById(a, b); }

function _syncMergeSessionHist(a, b) {
  // sessionHistory entries carry no id ({type:'work'} / {type:'short'}), so
  // a plain concatenation of two copies of the same history doubled it on
  // every merge. Treat the shorter list as a prefix of the longer one when
  // it is, and only append the genuinely new tail.
  const la = Array.isArray(a) ? a : [], lb = Array.isArray(b) ? b : [];
  const short = la.length <= lb.length ? la : lb, long = la.length <= lb.length ? lb : la;
  let prefix = true;
  for (let i = 0; i < short.length; i++) {
    if (JSON.stringify(short[i]) !== JSON.stringify(long[i])) { prefix = false; break; }
  }
  const out = prefix ? long.slice() : [...la, ...lb];
  return out.length > _SYNC_MAX_SH_MERGE ? out.slice(-_SYNC_MAX_SH_MERGE) : out;
}

function _taskSyncLm(t){
  if(!t) return 0;
  return _clampSyncTs(t.lastModified || t.completedAt || 0);
}

function _localHadSyncWins(remote){
  const remoteTaskMap = new Map((remote.tasks || []).filter(Boolean).map(t => [t.id, t]));
  for(const t of tasks){
    if(!t || t.id == null) continue;
    const rt = remoteTaskMap.get(t.id);
    if(!rt) return true;
    if(_taskSyncLm(t) > _taskSyncLm(rt)) return true;
  }
  const remoteListMap = new Map((remote.lists || []).filter(l => l && l.id != null).map(l => [l.id, l]));
  for(const l of lists){
    if(!l || l.id == null) continue;
    const rl = remoteListMap.get(l.id);
    if(!rl) return true;
    if(_listOrGoalLM(l) > _listOrGoalLM(rl)) return true;
  }
  const remoteGoalMap = new Map((remote.goals || []).filter(g => g && g.id != null).map(g => [g.id, g]));
  for(const g of goals){
    if(!g || g.id == null) continue;
    const rg = remoteGoalMap.get(g.id);
    if(!rg) return true;
    if(_listOrGoalLM(g) > _listOrGoalLM(rg)) return true;
  }
  return false;
}

function _scheduleSyncAck(){
  if(_syncApplying) return;
  if(_syncAckTimer) clearTimeout(_syncAckTimer);
  _syncAckTimer = setTimeout(() => {
    _syncAckTimer = null;
    if(!_conn || !_conn.open || !_conn._syncReady || _syncApplying) return;
    _syncSend(_conn, { type: 'patch', payload: _packState() });
  }, 300);
}

/**
 * Two devices that each create tasks while apart take the same next ids, and
 * the id-keyed LWW merge then silently keeps one task of each pair. Pairing a
 * phone and a laptop that both had tasks lost roughly half of them (measured
 * over real PeerJS: "Task from A" and "Task from B" were both id 1, and both
 * devices ended with only B's). A task's `created` is set once and never
 * rewritten, so the same id with a different `created` is two tasks.
 *
 * On the initial state exchange both devices resolve every such pair the same
 * way without talking to each other: the older task keeps the id; the other
 * moves to max(both counters, every id either side holds) + rank, in id
 * order; references that pointed at the moved task follow it. Same-minute
 * collisions (`created` has minute precision) stay undetectable.
 */
function _syncResolveIdCollisions(remoteTasks, remoteCtr, sentCtr){
  const localById = new Map(tasks.map(t => [t.id, t]));
  const pairs = [];
  for (const rt of remoteTasks) {
    const lt = rt && localById.get(rt.id);
    if (!lt) continue;
    const lc = String(lt.created || ''), rc = String(rt.created || '');
    if (!lc || !rc || lc === rc) continue;
    pairs.push({ id: rt.id, lt, rt, localLoses: lc > rc });
  }
  if (!pairs.length) return 0;
  pairs.sort((a, b) => a.id - b.id);
  let next = Math.max(_reseedIdCtr(sentCtr, tasks), _reseedIdCtr(remoteCtr, remoteTasks));
  const localMoves = new Map(), remoteMoves = new Map();
  for (const p of pairs) {
    const nid = ++next;
    if (p.localLoses) { localMoves.set(p.id, nid); p.lt.id = nid; }
    else { remoteMoves.set(p.id, nid); p.rt.id = nid; }
  }
  const follow = (list, moves) => {
    if (!moves.size) return;
    const m = (x) => (moves.has(x) ? moves.get(x) : x);
    for (const t of list) {
      if (!t) continue;
      if (t.parentId != null && moves.has(t.parentId)) t.parentId = moves.get(t.parentId);
      if (Array.isArray(t.blockedBy)) t.blockedBy = t.blockedBy.map(m);
      if (Array.isArray(t.relatedTo)) t.relatedTo = t.relatedTo.map(m);
    }
  };
  // A moved task's own subtasks and links come from the same side it did.
  follow(tasks, localMoves);
  follow(remoteTasks, remoteMoves);
  if (typeof activeTaskId !== 'undefined' && localMoves.has(activeTaskId)) activeTaskId = localMoves.get(activeTaskId);
  return pairs.length;
}

function _mergeState(remote, opts){
  opts = opts || {};
  if (!remote || typeof remote !== 'object' || Array.isArray(remote)) return;
  if (_syncIncomingPayloadInvalid(remote)) {
    console.warn('[sync] rejected oversized or invalid sync payload');
    return;
  }

  const hadLocalWins = _localHadSyncWins(remote);
  _syncApplying = true;
  try {
  const repair = (typeof _repairTask === 'function') ? _repairTask : (t=>t);

  let mergedTaskDels = _mergeDelMapPair(
    (typeof syncTaskDels === 'object' && syncTaskDels) ? syncTaskDels : {},
    remote.syncTaskDels
  );
  let mergedListDels = _mergeDelMapPair(
    (typeof syncListDels === 'object' && syncListDels) ? syncListDels : {},
    remote.syncListDels
  );
  let mergedGoalDels = _mergeDelMapPair(
    (typeof syncGoalDels === 'object' && syncGoalDels) ? syncGoalDels : {},
    remote.syncGoalDels
  );

  const repairedRemoteTasks = (remote.tasks || []).map(repair).filter(Boolean);
  if (opts.isInitialState) {
    _syncResolveIdCollisions(repairedRemoteTasks, remote.taskIdCtr,
      typeof _syncSentTaskIdCtr === 'number' ? _syncSentTaskIdCtr : taskIdCtr);
  }
  const localMap = new Map(tasks.map(t => [t.id, t]));

  for (const [id, t] of [...localMap.entries()]) {
    const d = mergedTaskDels[id];
    if (d == null) continue;
    const tLM = _clampSyncTs(t.lastModified || t.completedAt || 0);
    if (_clampSyncTs(d) > tLM) localMap.delete(id);
  }

  for (const rt of repairedRemoteTasks) {
    if (!rt) continue;
    const delT = mergedTaskDels[rt.id];
    const rLM = _clampSyncTs(rt.lastModified || rt.completedAt || 0);
    if (delT != null && _clampSyncTs(delT) > rLM) continue;

    const lt = localMap.get(rt.id);
    if (!lt) {
      localMap.set(rt.id, rt);
    } else {
      const lLM = _clampSyncTs(lt.lastModified || lt.completedAt || 0);
      if (rLM > lLM) localMap.set(rt.id, rt);
    }
  }
  for (const t of localMap.values()) {
    if (mergedTaskDels[t.id] != null) {
      const tLM = _clampSyncTs(t.lastModified || t.completedAt || 0);
      if (tLM > _clampSyncTs(mergedTaskDels[t.id])) delete mergedTaskDels[t.id];
    }
  }
  syncTaskDels = mergedTaskDels;

  tasks = Array.from(localMap.values());
  taskIdCtr = _reseedIdCtr(Math.max(_reseedIdCtr(taskIdCtr), _reseedIdCtr(remote.taskIdCtr)), tasks);
  if (typeof rebuildTaskIdIndex === 'function') rebuildTaskIdIndex();
  if (typeof repairOrphanedTaskParents === 'function') repairOrphanedTaskParents();
  // Merged tasks bring the peer's checklist / note ids; keep the allocators
  // ahead of them so the next item added here can't collide.
  if (typeof reseedChecklistAndNoteIdCtrs === 'function') reseedChecklistAndNoteIdCtrs();

  const listMap = new Map(lists.map(l => [l.id, l]));
  for (const rl0 of (remote.lists || [])) {
    const rl = typeof _repairList === 'function' ? _repairList(rl0) : rl0;
    if (!rl || rl.id == null) continue;
    if (mergedListDels[rl.id] != null && _clampSyncTs(mergedListDels[rl.id]) > _listOrGoalLM(rl)) continue;
    const ex = listMap.get(rl.id);
    if (!ex) listMap.set(rl.id, rl);
    else if (_listOrGoalLM(rl) > _listOrGoalLM(ex)) listMap.set(rl.id, rl);
  }
  for (const [id, l] of [...listMap.entries()]) {
    if (mergedListDels[id] != null && _clampSyncTs(mergedListDels[id]) > _listOrGoalLM(l)) listMap.delete(id);
  }
  lists = Array.from(listMap.values());
  listIdCtr = _reseedIdCtr(Math.max(_reseedIdCtr(listIdCtr), _reseedIdCtr(remote.listIdCtr)), lists);
  syncListDels = mergedListDels;

  const goalMap = new Map(goals.map(g => [g.id, g]));
  for (const rg of (remote.goals || [])) {
    if (!rg || rg.id == null) continue;
    if (mergedGoalDels[rg.id] != null && _clampSyncTs(mergedGoalDels[rg.id]) > _listOrGoalLM(rg)) continue;
    const ex = goalMap.get(rg.id);
    if (!ex) goalMap.set(rg.id, rg);
    else if (_listOrGoalLM(rg) > _listOrGoalLM(ex)) goalMap.set(rg.id, rg);
  }
  for (const [id, g] of [...goalMap.entries()]) {
    if (mergedGoalDels[id] != null && _clampSyncTs(mergedGoalDels[id]) > _listOrGoalLM(g)) goalMap.delete(id);
  }
  goals = Array.from(goalMap.values());
  goalIdCtr = _reseedIdCtr(Math.max(_reseedIdCtr(goalIdCtr), _reseedIdCtr(remote.goalIdCtr)), goals);
  syncGoalDels = mergedGoalDels;

  const re = _clampSyncTs(
    remote.stateEpoch != null
      ? remote.stateEpoch
      : (typeof remote.sentAt === 'number' ? remote.sentAt : 0)
  );
  const le = _clampSyncTs(typeof stateEpoch !== 'undefined' ? stateEpoch : 0);
  // Nonce tiebreaker for the same-ms-collision case (see storage.js stateNonce).
  const rn = typeof remote.stateNonce === 'number' ? remote.stateNonce : 0;
  const ln = (typeof stateNonce === 'number') ? stateNonce : 0;
  const _remoteWinsExact = (re === le && re > 0 && rn > ln);
  if (re > le || _remoteWinsExact) {
    // Logs are append-only on both sides: union them by id (and tail-merge
    // the session history) exactly as the cross-tab path does, instead of
    // taking the newer device's copy wholesale — that dropped every session
    // this device had logged since the last sync, and the ack round-trip
    // then erased them on the peer too.
    if (Array.isArray(remote.timeLog)) timeLog = _syncMergeTimeLogsById(timeLog, remote.timeLog);
    if (Array.isArray(remote.sessionHistory)) sessionHistory = _syncMergeSessionHist(sessionHistory, remote.sessionHistory);
    if (Array.isArray(remote.intervals)) intervals = _syncMergeIntervalsById(intervals, remote.intervals);
    if (remote.totalPomos != null) totalPomos = Math.max(0, parseInt(remote.totalPomos, 10) || 0);
    if (remote.totalBreaks != null) totalBreaks = Math.max(0, parseInt(remote.totalBreaks, 10) || 0);
    if (remote.totalFocusSec != null) totalFocusSec = Math.max(0, parseInt(remote.totalFocusSec, 10) || 0);
    // Logs are unioned above, so the id allocators must stay ahead of BOTH
    // sides' entries — taking the peer's counter verbatim could re-issue an
    // id a kept local entry already uses.
    if (remote.intIdCtr != null) intIdCtr = Math.max(intIdCtr, Math.max(0, parseInt(remote.intIdCtr, 10) || 0));
    if (remote.logIdCtr != null) logIdCtr = Math.max(logIdCtr, Math.max(0, parseInt(remote.logIdCtr, 10) || 0));
    if (remote.pomosInCycle != null) pomosInCycle = Math.max(0, parseInt(remote.pomosInCycle, 10) || 0);
    if (remote.phase && ['work', 'short', 'long'].includes(remote.phase)) phase = remote.phase;
    if (remote.cfg && typeof remote.cfg === 'object') {
      cfg = remote.cfg;
      // Same normalization the backup-import path applies: a peer's cfg is
      // semi-trusted input, so classification category ids/labels must pass
      // the allow-list rather than land verbatim (AUDIT H-1 defense in depth).
      if (typeof normalizeCfg === 'function') normalizeCfg(cfg);
      else if (typeof ensureClassificationConfig === 'function') ensureClassificationConfig(cfg);
      // Keep the Settings switches (and the notification diagnostic) in step
      // with the cfg that just arrived — otherwise a peer that turned
      // notifications off silently mutes this device behind a green toggle.
      if (typeof syncCfgToggles === 'function') { try { syncCfgToggles(); } catch (_) {} }
    }
    if (remote.theme && ['dark', 'light'].includes(remote.theme)) theme = remote.theme;
  } else if (re === le && re > 0 && rn === ln) {
    if (Array.isArray(remote.timeLog)) timeLog = _syncMergeTimeLogsById(timeLog, remote.timeLog);
    if (Array.isArray(remote.sessionHistory)) sessionHistory = _syncMergeSessionHist(sessionHistory, remote.sessionHistory);
    if (Array.isArray(remote.intervals)) intervals = _syncMergeIntervalsById(intervals, remote.intervals);
    if (remote.totalPomos != null) totalPomos = Math.max(totalPomos, Math.max(0, parseInt(remote.totalPomos, 10) || 0));
    if (remote.totalBreaks != null) totalBreaks = Math.max(totalBreaks, Math.max(0, parseInt(remote.totalBreaks, 10) || 0));
    if (remote.totalFocusSec != null) totalFocusSec = Math.max(totalFocusSec, Math.max(0, parseInt(remote.totalFocusSec, 10) || 0));
    if (remote.intIdCtr != null) intIdCtr = Math.max(intIdCtr, Math.max(0, parseInt(remote.intIdCtr, 10) || 0));
    if (remote.logIdCtr != null) logIdCtr = Math.max(logIdCtr, Math.max(0, parseInt(remote.logIdCtr, 10) || 0));
    // NOTE: pomosInCycle is a cadence POSITION (0..cfg.cycle), not a cumulative
    // counter. Math.max-ing it on a same-ms tie can push it past cfg.cycle and
    // wedge the long-break cadence (it never resets), so keep the local value
    // on an exact collision — matching storage.js _mergeRemoteStateLww.
  }

  if(typeof persistAfterSyncMerge === 'function') persistAfterSyncMerge(re, rn);
  else if(typeof saveState === 'function') saveState('sync');
  } catch (e) {
    console.warn('[sync] mergeState failed', e);
  } finally {
    _syncApplying = false;
  }

  _lastSyncAt = Date.now();
  if(typeof renderAll === 'function') renderAll();
  if(hadLocalWins || opts.isInitialState) _scheduleSyncAck();
}

// ── Connection handling ─────────────────────────────────────────────────────

// ── Pairing authentication ──────────────────────────────────────────────────
// A device used to be identified by its PeerJS id alone (`stupind-` + 6
// characters), which anyone can register on the public broker while it is
// free. v79 gave each pair a shared 256-bit key, proved both ways with an
// HMAC over the other side's fresh nonce before anything else is processed —
// but the FIRST pairing, and every manual re-pair, still took that key from
// whoever answered the dialled id (the acceptor minted it on Accept and sent
// it over the channel). While a device was offline a squatter on its id got a
// key handed to it, or got the other user to tap Accept on a banner.
//
// v3 turns that around: the key is derived from a secret that only ever
// appears on the screen of the device that generated it (the pairing code),
// so whoever answers the dialled id must already know the secret to prove
// anything. The acceptor never mints keys and never signs for a stranger: it
// verifies the dialer's proof first — against the key stored for that id, or
// the key of its active pairing code — and only then proves itself. A dialer
// that fails its proof, a stranger with no active pairing code, an older
// protocol version or plaintext before readiness are refused and closed,
// never shown a banner. Once ready, every message travels AES-GCM encrypted
// under a key derived from the pair key, so a broker or a peer on the wire
// sees no task data and can't replay a message into another session.
const SYNC_PAIRS_KEY = (window.ODTAULAI_CONFIG && window.ODTAULAI_CONFIG.STORAGE_KEYS && window.ODTAULAI_CONFIG.STORAGE_KEYS.SYNC_PAIRS) || 'stupind_sync_pairs';
const SYNC_PROTO = 3;
const SYNC_KDF_ITERATIONS = 100000;
const SYNC_KDF_SALT_PREFIX = 'odta-sync-v3:';
const SYNC_HANDSHAKE_TIMEOUT_MS = 45000;   // room for the other user to tap Accept
// Base64 of AES-GCM over a max-size JSON payload, plus envelope headroom.
const _SYNC_MAX_WIRE_CHARS = Math.ceil(_SYNC_MAX_MSG_CHARS * 1.4) + 1024;
const _HEX64 = /^[0-9a-f]{64}$/;
const _HEX32 = /^[0-9a-f]{32}$/;

function _loadSyncPairs(){
  try {
    const o = JSON.parse(localStorage.getItem(SYNC_PAIRS_KEY) || '{}');
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch(e) { return {}; }
}
function _getPairKey(peerId){
  const k = _loadSyncPairs()[String(peerId || '')];
  return (typeof k === 'string' && _HEX64.test(k)) ? k : null;
}
function _setPairKey(peerId, hex){
  const o = _loadSyncPairs();
  if (hex) o[String(peerId)] = hex; else delete o[String(peerId)];
  try { localStorage.setItem(SYNC_PAIRS_KEY, JSON.stringify(o)); } catch(e) { /* LS fire-and-forget */ }
}
function _pairCount(){
  return Object.keys(_loadSyncPairs()).filter(id => _HEX64.test(String(_loadSyncPairs()[id] || ''))).length;
}
function _randHex(nBytes){
  const a = new Uint8Array(nBytes);
  crypto.getRandomValues(a);
  return _bytesToHex(a);
}
function _bytesToHex(bytes){
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
function _hexToBytes(hex){
  return new Uint8Array(String(hex).match(/../g).map(h => parseInt(h, 16)));
}
function _b64(bytes){
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}
// Strict base64 → bytes, or null. Wire fields are attacker-controlled, so a
// malformed string must never throw its way out of the handler.
function _unb64(str){
  if (typeof str !== 'string' || str.length > _SYNC_MAX_WIRE_CHARS || str.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(str)) return null;
  try {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch(e) { return null; }
}
function _syncCryptoOk(){
  return typeof crypto !== 'undefined' && !!crypto.subtle && typeof crypto.getRandomValues === 'function';
}
/** HMAC-SHA256(key, parts.join('|')) as hex. `role` in parts stops reflection. */
async function _syncMac(keyHex, parts){
  const key = await crypto.subtle.importKey('raw', _hexToBytes(keyHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(parts.join('|')));
  return _bytesToHex(new Uint8Array(sig));
}
// Constant-time comparison: the accumulated XOR never short-circuits on the
// first differing character, so timing reveals nothing about how much of a
// proof matched. (A length mismatch is not secret.)
function _macEq(a, b){
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function _myPeerId(){ return (_peer && _peer.id) || ''; }

// ── Key derivation + message crypto ─────────────────────────────────────────

/** Pair key from a pairing code: PBKDF2-SHA256(secret, "odta-sync-v3:" + ROOM, 100 000 iterations, 256 bits), hex. */
async function _derivePairKey(secret, room){
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(String(secret).toUpperCase()), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(SYNC_KDF_SALT_PREFIX + String(room).toUpperCase()), iterations: SYNC_KDF_ITERATIONS, hash: 'SHA-256' },
    base, 256);
  return _bytesToHex(new Uint8Array(bits));
}

/** AES-256-GCM transport key from a pair key: HKDF-SHA256(ikm = the 32 key bytes, salt "odta-sync-v3", info "enc"). */
async function _deriveEncKey(keyHex){
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', _hexToBytes(keyHex), { name: 'HKDF' }, false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('odta-sync-v3'), info: enc.encode('enc') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// Additional data binds every ciphertext to this session (both nonces) and
// to its direction, so a message can't be replayed into a later session or
// reflected back at its sender.
function _syncAad(initiatorNonce, acceptorNonce, senderRole){
  return new TextEncoder().encode('odta-sync-v3|' + initiatorNonce + '|' + acceptorNonce + '|' + senderRole);
}

async function _syncEncrypt(aesKey, aad, inner){
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const pt = new TextEncoder().encode(JSON.stringify(inner));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, aesKey, pt);
  return { type: 'enc', v: SYNC_PROTO, iv: _b64(iv), ct: _b64(new Uint8Array(ct)) };
}

// Throws on anything that isn't a well-formed, authentic ciphertext.
async function _syncDecrypt(aesKey, aad, msg){
  if (!msg || msg.type !== 'enc' || msg.v !== SYNC_PROTO) throw new Error('not an enc message');
  if (typeof msg.ct !== 'string' || msg.ct.length > _SYNC_MAX_WIRE_CHARS) throw new Error('oversized ciphertext');
  const iv = _unb64(msg.iv);
  const ct = _unb64(msg.ct);
  if (!iv || iv.length !== 12 || !ct || ct.length < 16) throw new Error('bad iv/ct');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, aesKey, ct);
  const inner = JSON.parse(new TextDecoder().decode(pt));
  if (!inner || typeof inner !== 'object' || Array.isArray(inner) || typeof inner.type !== 'string') throw new Error('bad inner message');
  return inner;
}

// ── Pairing offer (this device's current pairing code) ──────────────────────
// {secret, createdAt}, held in memory only: the secret is never written to
// localStorage (or anywhere else), so a fresh code is minted each time sync
// starts on an unpaired device. It is shown in the panel while the offer
// exists, so anyone who copies the code can pair until a new one is generated;
// the first successful pairing made with it removes it.

function _validSecret(s){
  return typeof s === 'string' && s.length === SYNC_SECRET_LEN && [...s].every(c => CODE_ALPHABET.includes(c));
}
let _syncOffer = null;   // { secret, createdAt } or null; memory only
function _loadSyncOffer(){
  const o = _syncOffer;
  if (!o || !_validSecret(o.secret)) return null;
  return { secret: o.secret, createdAt: o.createdAt };
}
function _clearSyncOffer(){
  _syncOffer = null;
  _offerKeyCache = null;
}
function _mintSyncOffer(){
  const o = { secret: _randChars(SYNC_SECRET_LEN), createdAt: Date.now() };
  _syncOffer = o;
  _offerKeyCache = null;
  return { secret: o.secret, createdAt: o.createdAt };
}
/** This device's stored id without minting one (null before the first sync init). */
function _storedPeerId(){
  try { return localStorage.getItem(SYNC_PEER_KEY) || null; } catch(e) { return null; }
}
function _myRoom(){
  return _idToRoom(_myPeerId() || _storedPeerId() || '');
}
/** The full pairing code to show, or null when no offer is active. Never logged. */
function _myPairingCode(){
  const o = _loadSyncOffer();
  const room = _myRoom();
  return (o && room.length === SYNC_ROOM_LEN) ? _formatPairingCode(room, o.secret) : null;
}
// The offer's key, derived once per (secret, room) and cached, so repeated
// strangers don't cost a 100k-iteration PBKDF2 each. Null when no offer.
let _offerKeyCache = null;   // { secret, room, promise }
function _offerKeyPromise(){
  const o = _loadSyncOffer();
  const room = _myRoom();
  if (!o || room.length !== SYNC_ROOM_LEN) return null;
  if (_offerKeyCache && _offerKeyCache.secret === o.secret && _offerKeyCache.room === room) return _offerKeyCache.promise;
  const promise = _derivePairKey(o.secret, room);
  const entry = { secret: o.secret, room, promise };
  _offerKeyCache = entry;
  promise.catch(() => { if (_offerKeyCache === entry) _offerKeyCache = null; });
  return promise;
}

// ── Handshake failure throttle ──────────────────────────────────────────────
// Every failed inbound handshake backs off inbound connections: 2 s, 4 s, …
// up to 60 s, and ten failures inside 15 minutes stop answering altogether
// until they age out. A peer guessing secrets is closed on arrival instead of
// being handed anything to test against.

let _hsFailTimes = [];
let _hsBlockedUntil = 0;
const _HS_FAIL_WINDOW_MS = 15 * 60 * 1000;
const _HS_FAIL_MAX = 10;

function _pruneHsFailures(){
  const now = Date.now();
  _hsFailTimes = _hsFailTimes.filter(t => now - t < _HS_FAIL_WINDOW_MS);
  return now;
}
function _recordHandshakeFailure(){
  const now = _pruneHsFailures();
  _hsFailTimes.push(now);
  const n = _hsFailTimes.length;
  _hsBlockedUntil = now + Math.min(2000 * Math.pow(2, n - 1), 60000);
}
function _inboundBlocked(){
  const now = _pruneHsFailures();
  return now < _hsBlockedUntil || _hsFailTimes.length >= _HS_FAIL_MAX;
}

// ── Incoming-connection consent banner ──────────────────────────────────────

function syncHideIncomingBanner(){
  const b = document.getElementById('syncIncomingBar');
  if(b) b.remove();
}

/**
 * Shown only for a peer that has already proved it holds this device's
 * current pairing code. kind: 'new' (no key stored for this id yet) |
 * 'repair' (a key is stored for this id; Accept replaces it — the other
 * device was reset or reinstalled and pairs again with a fresh code).
 */
function syncShowIncomingBanner(peerLabel, kind){
  syncHideIncomingBanner();
  const bar = document.createElement('div');
  bar.id = 'syncIncomingBar';
  bar.className = 'sync-incoming-bar';
  const safePeer = (typeof esc === 'function') ? esc(String(peerLabel || 'unknown')) : String(peerLabel || 'unknown');
  const msg = kind === 'repair'
    ? '<strong>Re-pair request</strong> from <code>'+safePeer+'</code>. It holds your current pairing code, but this device was paired with that id before; accepting replaces the old pairing. Accept only if you reset or reinstalled that device.'
    : '<strong>Incoming sync</strong> from <code>'+safePeer+'</code>. It holds your current pairing code. Accept only if this is your device.';
  bar.innerHTML = '<div class="sync-incoming-inner">'+msg+'</div>'
    +'<div class="sync-incoming-actions">'
    +'<button type="button" class="btn-primary btn-sm" id="syncAcceptInbound">Accept</button>'
    +'<button type="button" class="btn-ghost btn-sm" id="syncRejectInbound">Reject</button></div>';
  document.body.appendChild(bar);
  document.getElementById('syncAcceptInbound').onclick = () => syncAcceptInbound();
  document.getElementById('syncRejectInbound').onclick = () => syncRejectInbound();
}

/** The user clicked Accept: store the key the peer proved, retire the offer, finish the handshake. */
function syncAcceptInbound(){
  const conn = _pendingInboundConn;
  if(!conn || typeof conn._syncAccept !== 'function') return;
  _pendingInboundConn = null;
  syncHideIncomingBanner();
  // Remember the peer for reconnects; the handshake stores its key.
  _lastConnectCode = _idToCode(conn.peer);
  conn._syncAccept();
}

function syncRejectInbound(){
  const conn = _pendingInboundConn;
  _pendingInboundConn = null;
  syncHideIncomingBanner();
  if(conn && typeof conn._syncReject === 'function') conn._syncReject();
  else if(conn){ try{ conn.close(); }catch(e){} }
}

/** Encrypt-and-send on a ready connection; false when the link isn't ready. */
function _syncSend(conn, inner){
  if (!conn || !conn._syncReady || typeof conn._syncSend !== 'function') return false;
  conn._syncSend(inner);
  return true;
}

/** Proof accepted both ways (and Accept clicked when needed): unlock the channel and exchange state once. */
function _syncMarkReady(conn){
  if (conn._syncReady) return;
  conn._syncReady = true;
  // A proven connection supersedes any backoff still counting down; left
  // running, it would call syncConnect() and close this one.
  if(_reconnectTimerId){ clearTimeout(_reconnectTimerId); _reconnectTimerId = null; }
  _reconnectAttempt = 0;
  _setSyncStatus('connected');
  try { localStorage.setItem(SYNC_ROOM_KEY, _idToCode(conn.peer)); } catch(e) { /* LS fire-and-forget */ }
  // The counter this state carries is one input to _syncResolveIdCollisions;
  // the peer uses the same value from the payload, so both agree on new ids.
  _syncSentTaskIdCtr = taskIdCtr;
  _syncSend(conn, { type: 'state', payload: _packState() });
}

/**
 * Wire a DataConnection for the handshake. role 'initiator' = we dialled
 * (syncConnect has already stored the pair key for this id); role
 * 'acceptor' = an inbound connection, held in _pendingInboundConn until the
 * peer proves a stored key (auto-accept, no banner) or the active pairing
 * code (Accept banner).
 */
function _wireConn(conn, opts) {
  const role = (opts && opts.role) || 'initiator';
  const initiator = role === 'initiator';
  if (initiator) _conn = conn;
  const peerLabel = _idToCode(conn.peer);
  const sess = {
    myNonce: _randHex(16),
    peerNonce: null,
    sentAuth: false,
    peerProved: false,   // the other side's proof verified
    keyHex: null,        // the key this session was verified with
    keyMode: null,       // acceptor: 'stored' | 'offer'
    storedKey: null,     // acceptor: key on file for this id, if any
    offerKey: null,      // acceptor: promise of the active offer's key, if any
    ready: false,
    failed: false,
    aadOut: null,
    aadIn: null,
    encKey: null,        // Promise<CryptoKey>
    inbox: Promise.resolve(),
    outbox: Promise.resolve(),
    timer: null,
  };

  const clearTimer = () => { if (sess.timer) { clearTimeout(sess.timer); sess.timer = null; } };

  // Close without answering further, never auto-redial into the same refusal,
  // and (for an inbound peer) count the failure towards the throttle.
  const fail = (userMsg, reason, deferClose) => {
    if (sess.failed) return;
    sess.failed = true;
    clearTimer();
    console.warn('[sync] link failed (' + role + '):', reason || userMsg);
    // Only a failed inbound HANDSHAKE feeds the throttle: it exists to slow a
    // peer guessing at secrets, not to lock out a paired device whose link
    // broke after it had proved itself.
    if (!initiator && !sess.ready) _recordHandshakeFailure();
    if (_pendingInboundConn === conn) { _pendingInboundConn = null; syncHideIncomingBanner(); }
    if (initiator) {
      _lastConnectCode = null;
      if (_connectTimeoutId) { clearTimeout(_connectTimeoutId); _connectTimeoutId = null; }
    }
    // Null out _conn BEFORE closing: PeerJS emits 'close' synchronously, and
    // the close handler must not flip the status or schedule a reconnect.
    const wasCurrent = _conn === conn;
    if (wasCurrent) _conn = null;
    const close = () => { try { conn.close(); } catch(e) {} };
    if (deferClose) setTimeout(close, 100); else close();
    // Don't stomp on a live link with another device.
    if (initiator || wasCurrent || !(_conn && _conn._syncReady)) _setSyncStatus('error', userMsg);
  };

  // Acceptor: tell the dialer why before hanging up (after a beat, so the
  // message leaves the channel first).
  const refuse = (reason, userMsg) => {
    try { conn.send({ type: 'refuse', v: SYNC_PROTO, reason }); } catch(e) { /* closing anyway */ }
    fail(userMsg, 'refused: ' + reason, true);
  };

  const armTimeout = () => {
    clearTimer();
    sess.timer = setTimeout(() => {
      if (sess.ready || sess.failed) return;
      fail(initiator
        ? peerLabel + ' did not finish pairing in time. Make sure it runs the same Odta version, then try again (and tap Accept on it if it asks).'
        : 'Sync pairing timed out — ' + peerLabel + ' did not complete the handshake.', 'timeout');
    }, SYNC_HANDSHAKE_TIMEOUT_MS);
  };

  // Encrypt-then-send, serialised so messages leave in the order queued even
  // though AES-GCM is asynchronous.
  const send = (inner) => {
    sess.outbox = sess.outbox.then(async () => {
      if (sess.failed || !sess.ready) return;
      const wire = await _syncEncrypt(await sess.encKey, sess.aadOut, inner);
      if (!sess.failed && conn.open) conn.send(wire);
    }).catch(e => console.warn('[Sync] send', e));
  };

  const sendAuth = async () => {
    if (sess.sentAuth || !sess.peerNonce) return;
    const key = initiator ? _getPairKey(conn.peer) : sess.keyHex;
    if (!key) return;
    sess.sentAuth = true;
    const mac = await _syncMac(key, ['odta-sync-v3', role, _myPeerId(), conn.peer, sess.peerNonce, sess.myNonce]);
    if (sess.failed) return;
    try { conn.send({ type: 'auth', v: SYNC_PROTO, mac }); } catch(e) { console.warn('[Sync] send auth', e); }
  };

  const verifyMac = async (keyHex, mac) => {
    if (!keyHex || typeof mac !== 'string' || !_HEX64.test(mac)) return false;
    const want = await _syncMac(keyHex, ['odta-sync-v3', initiator ? 'acceptor' : 'initiator', conn.peer, _myPeerId(), sess.myNonce, sess.peerNonce]);
    return _macEq(mac, want);
  };

  // Make this the live connection (replacing any other) and remember the peer.
  const adopt = () => {
    if (_pendingInboundConn === conn) _pendingInboundConn = null;
    syncHideIncomingBanner();
    if (_conn && _conn !== conn) { const old = _conn; _conn = null; try { old.close(); } catch(e) {} }
    _conn = conn;
    _lastConnectCode = _idToCode(conn.peer);
  };

  const becomeReady = () => {
    if (sess.ready || sess.failed) return;
    sess.ready = true;
    clearTimer();
    const iNonce = initiator ? sess.myNonce : sess.peerNonce;
    const aNonce = initiator ? sess.peerNonce : sess.myNonce;
    sess.aadOut = _syncAad(iNonce, aNonce, role);
    sess.aadIn  = _syncAad(iNonce, aNonce, initiator ? 'acceptor' : 'initiator');
    sess.encKey = _deriveEncKey(sess.keyHex);
    sess.encKey.catch(() => { /* surfaced by the first send / receive */ });
    conn._syncSend = send;
    _syncMarkReady(conn);
  };

  // Accept / Reject from the banner, queued behind whatever is in flight so
  // they can't interleave with a message being verified.
  conn._syncAccept = () => {
    sess.inbox = sess.inbox.then(async () => {
      if (sess.failed || sess.ready || !sess.peerProved || !sess.keyHex) return;
      _setPairKey(conn.peer, sess.keyHex);
      if (sess.keyMode === 'offer') _clearSyncOffer();
      adopt();
      await sendAuth();
      if (sess.failed) return;
      becomeReady();
      if (typeof renderSyncPanel === 'function') renderSyncPanel();
    }).catch(e => console.warn('[Sync] accept', e));
  };
  conn._syncReject = () => {
    sess.inbox = sess.inbox.then(() => {
      if (sess.failed || sess.ready) return;
      try { conn.send({ type: 'refuse', v: SYNC_PROTO, reason: 'rejected' }); } catch(e) { /* closing anyway */ }
      sess.failed = true;
      clearTimer();
      if (_conn === conn) _conn = null;
      setTimeout(() => { try { conn.close(); } catch(e) {} }, 100);
    }).catch(e => console.warn('[Sync] reject', e));
  };

  const showBanner = (kind) => {
    if (sess.ready || sess.failed || _pendingInboundConn !== conn) return;
    syncShowIncomingBanner(peerLabel, kind);
  };

  // Plain handlers for authenticated, decrypted messages.
  const dispatch = (inner) => {
    if (inner.type === 'state') {
      _mergeState(inner.payload, { isInitialState: true });
    } else if (inner.type === 'patch') {
      _mergeState(inner.payload);
    } else if (inner.type === 'ping') {
      send({ type: 'pong' });
    }
    // Unknown authenticated types are ignored (forward compatibility).
  };

  const onOpen = () => {
    if (sess.failed) return;
    // Our own dial opened: reset the backoff. (Not for inbound: a stranger
    // dialling in must not cancel a pending reconnect to the paired device.)
    if (role === 'initiator') {
      if(_reconnectTimerId){ clearTimeout(_reconnectTimerId); _reconnectTimerId = null; }
      _reconnectAttempt = 0;
    }
    try { conn.send({ type: 'hello', v: SYNC_PROTO, nonce: sess.myNonce }); }
    catch(e) { console.warn('[Sync] send hello', e); }
    if (role === 'initiator') _setSyncStatus('connecting', 'Waiting for the other device to accept…');
    if (!sess.ready) armTimeout();
  };

  const handleHandshake = async (msg) => {
    if (msg.type === 'hello') {
      if (msg.v !== SYNC_PROTO) {
        if (initiator) return fail(peerLabel + ' runs a different Odta sync version. Update Odta on the other device, then pair again.', 'version ' + String(msg.v));
        return refuse('version', peerLabel + ' runs a different Odta sync version — refused. Update Odta on the other device.');
      }
      if (typeof msg.nonce !== 'string' || !_HEX32.test(msg.nonce)) {
        if (initiator) return fail(peerLabel + ' sent a malformed handshake — connection closed.', 'bad nonce');
        return refuse('bad-proof', peerLabel + ' sent a malformed handshake — refused.');
      }
      if (sess.peerNonce) return;   // duplicate hello
      sess.peerNonce = msg.nonce;
      if (initiator) { await sendAuth(); return; }   // the dialer proves itself first
      // Acceptor: what could this id prove against?
      sess.storedKey = _getPairKey(conn.peer);
      sess.offerKey = _offerKeyPromise();
      if (!sess.storedKey && !sess.offerKey) {
        return refuse('no-pairing', peerLabel + ' tried to connect but is not paired with this device and no pairing code is active — refused.');
      }
      return;   // wait for its auth
    }
    if (msg.type === 'auth') {
      if (sess.peerProved) return;
      if (!sess.peerNonce || typeof msg.mac !== 'string') {
        if (initiator) return fail(peerLabel + ' sent a malformed proof — connection closed.', 'auth before hello');
        return refuse('bad-proof', peerLabel + ' sent a malformed proof — refused.');
      }
      if (initiator) {
        const key = _getPairKey(conn.peer);
        const ok = await verifyMac(key, msg.mac);
        if (sess.failed) return;
        if (!ok) return fail(peerLabel + ' could not prove it is the device you paired. If you reset it, generate a new pairing code on it and enter that here.', 'bad acceptor proof');
        sess.peerProved = true;
        sess.keyHex = key;
        becomeReady();
        return;
      }
      // Acceptor: the stored key for this id first, then the active offer.
      let mode = null, key = null;
      if (sess.storedKey && await verifyMac(sess.storedKey, msg.mac)) { mode = 'stored'; key = sess.storedKey; }
      else if (sess.offerKey) {
        let offerKey = null;
        try { offerKey = await sess.offerKey; } catch(e) { offerKey = null; }
        if (offerKey && await verifyMac(offerKey, msg.mac)) { mode = 'offer'; key = offerKey; }
      }
      if (sess.failed) return;
      if (!mode) return refuse('bad-proof', peerLabel + ' could not prove it holds a pairing with this device — refused.');
      sess.peerProved = true;
      sess.keyHex = key;
      sess.keyMode = mode;
      if (mode === 'stored') {
        // A device we already paired with: no banner, take over as the live link.
        adopt();
        await sendAuth();
        if (sess.failed) return;
        becomeReady();
        return;
      }
      // Pairing-code path: the user decides. The handshake timer keeps running.
      showBanner(sess.storedKey ? 'repair' : 'new');
      return;
    }
    if (msg.type === 'refuse') {
      if (!initiator) return fail(peerLabel + ' refused the connection.', 'refuse from dialer');
      const why = {
        'no-pairing': peerLabel + " is not paired with this device and has no pairing code active. Generate a pairing code on it and enter that here.",
        'bad-proof':  peerLabel + ' refused this device: it could not verify the pairing. If either device was reset, generate a new pairing code on ' + peerLabel + ' and enter that here.',
        'version':    peerLabel + ' runs a different Odta sync version — update Odta on the other device, then pair again.',
        'rejected':   peerLabel + ' declined the pairing.',
      };
      return fail(why[msg.reason] || (peerLabel + ' refused to pair.'), 'refused by peer: ' + String(msg.reason));
    }
    // Anything else before readiness: a pre-v3 device (hello v2's 'pair',
    // a v78 acceptor's plaintext state) or a probe. Never processed.
    if (initiator) return fail(peerLabel + ' runs an older Odta. Update Odta on the other device, then pair again.', 'pre-v3 message ' + msg.type);
    return refuse('version', peerLabel + ' sent an unencrypted ' + msg.type + ' before pairing — refused. Update Odta on the other device.');
  };

  const handle = async (msg) => {
    if (sess.failed) return;
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
      return fail('Sync message from ' + peerLabel + ' could not be read — connection closed.', 'malformed');
    }
    if (!sess.ready) return handleHandshake(msg);
    // After readiness nothing but ciphertext is acceptable.
    if (msg.type !== 'enc') return fail(peerLabel + ' sent an unencrypted message after pairing — connection closed.', 'plaintext after ready');
    if (typeof msg.ct !== 'string' || msg.ct.length > _SYNC_MAX_WIRE_CHARS) return fail('Sync message from ' + peerLabel + ' is too large — connection closed.', 'oversized ciphertext');
    let inner;
    try { inner = await _syncDecrypt(await sess.encKey, sess.aadIn, msg); }
    catch(e) { return fail(peerLabel + ' sent a message this device could not decrypt — connection closed.', 'decrypt failed'); }
    if (sess.failed) return;
    dispatch(inner);
  };
  // Serialise: proofs and decryption are async, and the state that follows a
  // proof must not be handled (and dropped) before the proof lands.
  conn.on('data', (msg) => {
    sess.inbox = sess.inbox.then(() => handle(msg)).catch(e => {
      console.warn('[Sync] handle', e);
      fail('Sync hit an internal error — connection closed.', 'internal');
    });
  });

  conn.on('close', () => {
    clearTimer();
    if (_pendingInboundConn === conn) { _pendingInboundConn = null; syncHideIncomingBanner(); }
    // PeerJS emits 'close' synchronously from close(). When this connection
    // was replaced (Connect to a different code, accepting a new inbound
    // link, the simultaneous-dial tie-break or a handshake failure, which all
    // clear _conn first) the current _conn is not this one; tearing it down
    // and scheduling a reconnect here restarted the fresh handshake every 2 s.
    if (_conn !== conn) return;
    _conn = null;
    // Don't stomp on a more-specific error message (e.g. "Code not found")
    // that we just set from _peer.on('error', 'peer-unavailable').
    if (_syncStatus !== 'error') _setSyncStatus('waiting');
    // Connection went down. If the user didn't disconnect intentionally,
    // schedule an auto-reconnect with backoff.
    if (_lastConnectCode) _scheduleSyncReconnect();
  });

  conn.on('error', (err) => {
    console.warn('[sync] conn error', err);
    clearTimer();
    if (_pendingInboundConn === conn) { _pendingInboundConn = null; syncHideIncomingBanner(); }
    if (_conn !== conn) return;
    _conn = null;
    if (_connectTimeoutId) { clearTimeout(_connectTimeoutId); _connectTimeoutId = null; }
    _setSyncStatus('error', _friendlySyncError(err));
    if (_lastConnectCode) _scheduleSyncReconnect();
  });

  // The acceptor waits for the dialer's hello from the moment it's wired; the
  // initiator arms its timer when the channel opens and hello goes out.
  if (!initiator) armTimeout();
  conn.on('open', onOpen);
  // PeerJS doesn't replay 'open' for listeners attached after it fired.
  if (conn.open) onOpen();
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve our stable peer id. Migrates the legacy double-STU form
 * (`stupind-stuXXXXXX`) to a fresh clean 6-char id, and clears any stored
 * room code (the pairing relationship is no longer reachable from this side
 * once our id rotates — re-pair by typing the other device's new code).
 */
function _resolvePeerId() {
  let saved = null;
  try { saved = localStorage.getItem(SYNC_PEER_KEY); } catch(e) {}

  if (!saved) {
    // One-time migration: pull v1 id, check if it's the buggy double-STU form,
    // and if so mint a new one. Otherwise keep the v1 id — it was valid.
    let legacy = null;
    try { legacy = localStorage.getItem(SYNC_PEER_KEY_V1); } catch(e) {}
    if (legacy && !_isLegacyPeerId(legacy)) {
      saved = legacy;
    } else if (legacy && _isLegacyPeerId(legacy)) {
      saved = _genPeerId();
      // Legacy pairing partner references the old id, so forget the room.
      try { localStorage.removeItem(SYNC_ROOM_KEY); } catch(e) {}
      console.info('[sync] migrated legacy peer id — re-pair required');
    } else {
      saved = _genPeerId();
    }
    try { localStorage.setItem(SYNC_PEER_KEY, saved); } catch(e) {}
  }
  return saved;
}

function _storedRoom(){
  try { return localStorage.getItem(SYNC_ROOM_KEY) || null; } catch(e) { return null; }
}

function _destroyPeer(){
  if (!_peer) return;
  const p = _peer;
  _peer = null;
  try { p.destroy(); } catch(e) { console.warn('[Sync] peer destroy', e); }
}

let _syncInitPromise = null;
let _idRetry = 0;
async function syncInit() {
  if (_peer) return;
  // Re-entry guard: parallel calls (e.g. rapid Connect clicks before the
  // first peer is constructed) would otherwise each instantiate Peer and
  // race for the broker id, leaving listeners orphaned.
  if (_syncInitPromise) return _syncInitPromise;
  _syncInitPromise = (async () => {
  _setSyncStatus('loading');

  if (!_syncCryptoOk()) { _setSyncStatus('error', 'Sync needs a secure (https) page to pair devices safely'); return; }
  let Peer;
  try { Peer = await _loadPeerJS(); }
  catch(e) { _setSyncStatus('error', 'PeerJS unavailable'); return; }
  if (_peer || !_syncEnabled) return;

  const myId = _resolvePeerId();
  _myRoomCode = _idToCode(myId);
  // A device that is paired with nothing and offers nothing gets a pairing
  // code straight away, so the panel has something to show the other device.
  if (!_loadSyncOffer() && !_pairCount()) _mintSyncOffer();

  _peer = new Peer(myId, {
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
      ]
    }
  });

  _peer.on('open', () => {
    _idRetry = 0;
    _setSyncStatus('waiting');
    // Auto-reconnect to the last room — only when we hold a key for it. A
    // room we can't prove ourselves to is forgotten rather than dialled.
    const lastRoom = _storedRoom();
    if (lastRoom && lastRoom !== _myRoomCode) {
      if (_getPairKey(_codeToId(lastRoom))) syncConnect(lastRoom);
      else {
        try { localStorage.removeItem(SYNC_ROOM_KEY); } catch(e) {}
        _setSyncStatus('unpaired');
      }
    }
  });

  _peer.on('connection', (conn) => {
    if(!_syncEnabled){ try{ conn.close(); }catch(e){} return; }
    // Back-off after failed handshakes: close without answering.
    if(_inboundBlocked()){ try{ conn.close(); }catch(e){} return; }
    if(_conn && _conn.open && _conn._syncReady){ try{ conn.close(); }catch(e){} return; }
    if(_pendingInboundConn){ try{ conn.close(); }catch(e){} return; }
    if(_conn && _conn.peer === conn.peer){
      // Both devices dialled each other at once (both auto-reconnect on
      // enable). Keep the one the lower id started, on both ends; otherwise
      // each side drops the connection the other kept.
      if(_myPeerId() < String(conn.peer)){ try{ conn.close(); }catch(e){} return; }
      const mine = _conn; _conn = null;
      try{ mine.close(); }catch(e){}
      // The dial we just abandoned still had its timeout armed.
      if(_connectTimeoutId){ clearTimeout(_connectTimeoutId); _connectTimeoutId = null; }
    }
    // Held pending until the peer proves a stored key (auto-accept, no
    // banner) or the active pairing code (Accept banner). Nothing else gets
    // a banner.
    _pendingInboundConn = conn;
    _wireConn(conn, { role: 'acceptor' });
  });

  _peer.on('error', (err) => {
    console.warn('[sync] peer error', err);
    const t = err && err.type;
    if (t === 'unavailable-id') {
      // Another session still holds this device's id on the broker (a tab
      // that just closed, or someone squatting it). Rotating to a fresh id —
      // the pre-v81 behaviour — silently broke every pairing, since the id is
      // what the other devices dial and key their pairing on. Wait and retry
      // instead; "Reset sync identity" stays the explicit escape hatch.
      _destroyPeer();
      _idRetry += 1;
      if (_idRetry <= 3) {
        const wait = 5000 * _idRetry;
        _setSyncStatus('error', "This device's sync id is busy on the broker (another Odta tab?) — retrying in " + Math.round(wait / 1000) + 's.');
        setTimeout(() => { if (_syncEnabled && !_peer) syncInit().then(() => renderSyncPanel()).catch(() => {}); }, wait);
      } else {
        _setSyncStatus('error', "This device's sync id is in use on the broker. Close other Odta tabs and tap Reconnect, or reset the sync identity for a new id (every device must then pair again).");
      }
      return;
    }
    if (t === 'peer-unavailable') {
      // Target we were trying to connect to doesn't exist on the broker.
      // Cancel the connect timeout and show a clean specific message.
      if (_connectTimeoutId) { clearTimeout(_connectTimeoutId); _connectTimeoutId = null; }
      _setSyncStatus('error', 'Code not found — device is offline or the code is mistyped');
      return;
    }
    if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed') {
      // Schedule an automatic reconnect with backoff. _lastConnectCode is set
      // by syncConnect; if absent the user never paired and we just surface
      // the error and wait for them to act.
      if(_lastConnectCode){
        _scheduleSyncReconnect();
      } else {
        _setSyncStatus('error', 'Lost connection to matchmaking server — check internet');
      }
      return;
    }
    if (t === 'browser-incompatible') {
      _setSyncStatus('error', 'Browser does not support WebRTC data channels');
      return;
    }
    _setSyncStatus('error', _friendlySyncError(err));
  });

  const thisPeer = _peer;
  _peer.on('disconnected', () => {
    // destroy() also emits 'disconnected'; a peer we replaced must neither
    // flip the status nor be asked to reconnect.
    if (_peer !== thisPeer) return;
    _setSyncStatus('waiting');
    try { thisPeer.reconnect(); } catch(e) { console.warn('[Sync] reconnect', e); }
  });
  renderSyncPanel();
  })();
  try { await _syncInitPromise; } finally { _syncInitPromise = null; }
}

// Schedule the next auto-reconnect attempt. Uses a fresh `setTimeout` so the
// existing _connectTimeoutId logic isn't disturbed. After the final backoff
// we hold at error and wait for the user — five failed attempts almost
// always means the broker, the user's WiFi, or the peer is gone.
function _scheduleSyncReconnect(){
  if(_reconnectTimerId){ clearTimeout(_reconnectTimerId); _reconnectTimerId = null; }
  if(!_lastConnectCode || !_syncEnabled){
    _setSyncStatus('error', 'Lost connection — Reconnect to retry');
    return;
  }
  // Never redial a device we can't prove ourselves to.
  if(!_getPairKey(_codeToId(_lastConnectCode))){
    _lastConnectCode = null;
    _setSyncStatus('unpaired');
    return;
  }
  if(_reconnectAttempt >= SYNC_RECONNECT_BACKOFFS_MS.length){
    _setSyncStatus('error', 'Reconnect failed after ' + SYNC_RECONNECT_BACKOFFS_MS.length + ' attempts — try Reconnect manually');
    return;
  }
  const wait = SYNC_RECONNECT_BACKOFFS_MS[_reconnectAttempt];
  _reconnectAttempt += 1;
  _setSyncStatus('error', 'Reconnecting in ' + Math.round(wait/1000) + 's (attempt ' + _reconnectAttempt + '/' + SYNC_RECONNECT_BACKOFFS_MS.length + ')');
  _reconnectTimerId = setTimeout(() => {
    _reconnectTimerId = null;
    if(!_syncEnabled || !_lastConnectCode) return;
    _setSyncStatus('connecting', 'Reconnecting (attempt ' + _reconnectAttempt + '/' + SYNC_RECONNECT_BACKOFFS_MS.length + ')…');
    try { syncConnect(_lastConnectCode); }
    catch(e){ console.warn('[Sync] reconnect failed', e); _scheduleSyncReconnect(); }
  }, wait);
}
// Manual "Reconnect now" — user clicked the button. Cancels any pending
// backoff and tries immediately. Resets the attempt counter so the user
// gets a full set of backoffs again if they ask for one.
function syncReconnectNow(){
  if(_reconnectTimerId){ clearTimeout(_reconnectTimerId); _reconnectTimerId = null; }
  _reconnectAttempt = 0;
  if(!_syncEnabled) return;
  if(!_peer){
    // The engine was torn down (busy id on the broker): bring it back; its
    // 'open' handler redials the stored room.
    _setSyncStatus('loading');
    syncInit().then(() => renderSyncPanel()).catch(e => console.warn('[Sync] init failed', e));
    return;
  }
  const target = _lastConnectCode || _storedRoom();
  if(!target) return;
  if(!_getPairKey(_codeToId(target))){ _lastConnectCode = null; _setSyncStatus('unpaired'); return; }
  _setSyncStatus('connecting', 'Reconnecting…');
  try { syncConnect(target); } catch(e){ console.warn('[Sync] reconnect failed', e); }
}

/**
 * Connect to another device. A full pairing code (room + secret) derives the
 * pair key for that id and installs it before dialling — the legitimate
 * re-pair path after a device reset, which is why it always replaces a stored
 * key. A bare 6-character room only reaches a device we already hold a key
 * for; it never creates or replaces one.
 */
function syncConnect(code, opts) {
  if (!_peer) { syncInit().then(() => { if (_peer) syncConnect(code, opts); }).catch(e => console.warn('[Sync] init failed', e)); return; }
  const parsed = _parseCode(code);
  if (!parsed.ok) {
    _setSyncStatus('error', parsed.message);
    return;
  }
  const targetId = _codeToId(parsed.room);
  if (targetId === _peer.id) {
    _setSyncStatus('error', "That's this device's own code");
    return;
  }
  if (!parsed.secret) {
    if (!_getPairKey(targetId)) {
      _setSyncStatus('error', 'Enter the full pairing code shown on the other device (18 characters after STU-). Older 6-character codes can no longer pair.');
      return;
    }
    _dialPeer(targetId);
    return;
  }
  _setSyncStatus('connecting', 'Deriving the pairing key…');
  _derivePairKey(parsed.secret, parsed.room).then(key => {
    if (!_peer || !_syncEnabled) return;
    _setPairKey(targetId, key);
    _dialPeer(targetId);
  }).catch(e => {
    console.warn('[Sync] key derivation failed', e);
    _setSyncStatus('error', 'Could not derive the pairing key — try again');
  });
}

/** Place an outbound dial; the pair key for `targetId` is already stored. */
function _dialPeer(targetId) {
  if (!_peer) return;
  // Remember the room (never the secret) so we can re-establish on
  // socket-closed without requiring the user to retype it. Cleared on
  // syncDisconnect and on a refused handshake.
  _lastConnectCode = _idToCode(targetId);
  _setSyncStatus('connecting');

  // If we have a stale dead connection, drop it before making a new one.
  if (_conn) { const old = _conn; _conn = null; try { old.close(); } catch(e) {} }

  const conn = _peer.connect(targetId, { reliable: true });

  // Two failure modes:
  //   (a) Target isn't registered on broker → _peer.on('error') fires
  //       `peer-unavailable` within ~1s (handled above; clears this timeout).
  //   (b) Target is registered but NAT traversal fails → no error ever fires,
  //       the data channel just never opens. 20s is generous for ICE gathering
  //       but still snappy enough to be usable feedback.
  if (_connectTimeoutId) clearTimeout(_connectTimeoutId);
  _connectTimeoutId = setTimeout(() => {
    _connectTimeoutId = null;
    if (conn && !conn.open) {
      if (_conn === conn) _conn = null;
      try { conn.close(); } catch(e) {}
      _setSyncStatus('error',
        'No response — the other device may be on a different network ' +
        '(cellular or restrictive firewall can block peer-to-peer). ' +
        'Try again on the same WiFi network.');
    }
  }, 20000);

  conn.on('open', () => {
    if (_connectTimeoutId) { clearTimeout(_connectTimeoutId); _connectTimeoutId = null; }
  });
  conn.on('error', () => {
    if (_connectTimeoutId) { clearTimeout(_connectTimeoutId); _connectTimeoutId = null; }
  });

  _wireConn(conn, { role: 'initiator' });
}

/** Mint a new pairing secret for this device. The id and existing pairs are untouched. */
function syncNewPairingCode() {
  if (!_syncEnabled || !_syncCryptoOk()) return;
  _mintSyncOffer();
  renderSyncPanel();
}

/** Reset the sync identity: new peer id, every pairing dropped. The escape hatch, not the everyday path. */
async function syncRegenerateCode() {
  const msg = "Reset this device's sync identity? It gets a new id, every device paired with it is unpaired, and the current pairing code stops working. You'll need to pair each device again. Continue?";
  if (typeof showAppConfirm === 'function'){
    if (!(await showAppConfirm(msg, { destructive: true, okLabel: 'Reset' }))) return;
  } else if (!confirm(msg)) return;
  if (_connectTimeoutId) { clearTimeout(_connectTimeoutId); _connectTimeoutId = null; }
  if (_reconnectTimerId) { clearTimeout(_reconnectTimerId); _reconnectTimerId = null; }
  _reconnectAttempt = 0;
  _lastConnectCode = null;
  if (_pendingInboundConn) { const p = _pendingInboundConn; _pendingInboundConn = null; try { p.close(); } catch(e) {} }
  syncHideIncomingBanner();
  try { localStorage.removeItem(SYNC_PEER_KEY); } catch(e) {}
  try { localStorage.removeItem(SYNC_ROOM_KEY); } catch(e) {}
  // Every pairing is keyed to the old id on the other side, so drop ours too.
  try { localStorage.removeItem(SYNC_PAIRS_KEY); } catch(e) {}
  _clearSyncOffer();
  if (_conn) { const old = _conn; _conn = null; try { old.close(); } catch(e) {} }
  _destroyPeer();
  _idRetry = 0;
  _setSyncStatus('loading');
  syncInit().then(() => renderSyncPanel()).catch(e => console.warn('[Sync] init failed', e));
}

function syncDisconnect() {
  if (_connectTimeoutId) { clearTimeout(_connectTimeoutId); _connectTimeoutId = null; }
  // Cancel any pending reconnect and forget the last target — disconnect is
  // an intentional teardown, not a transient failure.
  if (_reconnectTimerId) { clearTimeout(_reconnectTimerId); _reconnectTimerId = null; }
  _reconnectAttempt = 0;
  _lastConnectCode = null;
  if (_pendingInboundConn) { const p = _pendingInboundConn; _pendingInboundConn = null; try { p.close(); } catch(e) {} }
  syncHideIncomingBanner();
  if (_conn) { const old = _conn; _conn = null; try { old.close(); } catch(e) { console.warn('[Sync] conn close', e); } }
  _destroyPeer();
  try { localStorage.removeItem(SYNC_ROOM_KEY); } catch(e) { /* LS fire-and-forget */ }
  _setSyncStatus('off');
  _syncEnabled = false;
  renderSyncPanel();
}
if(typeof window !== 'undefined'){
  window.syncReconnectNow = syncReconnectNow;
}

// Graceful cleanup on tab close — tells PeerJS server to release our ID
window.addEventListener('beforeunload', () => {
  if (_conn) { try { _conn.close(); } catch(e) {} }
  if (_peer) { try { _peer.destroy(); } catch(e) {} }
});

// Called from saveState() — broadcast patch to connected peer (throttled)
let _broadcastTimer = null;
let _lastBroadcastAt = 0;
function syncBroadcast() {
  if(_syncApplying) return;
  // _syncReady gates on the proven handshake — local edits must not leak to a
  // peer that hasn't proved the pairing yet, and every patch goes out
  // encrypted through the link's sender.
  if (!_conn || !_conn.open || !_conn._syncReady) return;
  // Throttle: max 1 broadcast per 500ms to avoid flooding on rapid saves
  const now = Date.now();
  if (now - _lastBroadcastAt < 500) {
    clearTimeout(_broadcastTimer);
    _broadcastTimer = setTimeout(() => {
      _lastBroadcastAt = Date.now();
      _broadcastTimer = null;
      if (_conn && _conn.open && _conn._syncReady) _syncSend(_conn, { type: 'patch', payload: _packState() });
    }, 500);
    return;
  }
  _lastBroadcastAt = now;
  _syncSend(_conn, { type: 'patch', payload: _packState() });
}

// ── UI ───────────────────────────────────────────────────────────────────────

// "Reconnect now" appears whenever there is something to redial and we're in
// error or counting down a backoff, so the user can skip the wait without
// retyping the code. Also after the engine was torn down by a busy id.
function _renderSyncActionRow(){
  const row = document.getElementById('syncActionRow');
  if(!row) return;
  const canRetry = !!_lastConnectCode || (_syncEnabled && !_peer) || !!(_storedRoom() && _getPairKey(_codeToId(_storedRoom())));
  if(canRetry && (_syncStatus === 'error' || _reconnectTimerId)){
    row.innerHTML = '<button class="btn-primary btn-sm" data-action="syncReconnectNow">Reconnect now</button>';
  } else {
    row.innerHTML = '';
  }
}

function renderSyncPanel() {
  const panel = document.getElementById('syncPanel');
  if (!panel) return;

  if (!_syncEnabled) {
    panel.innerHTML = `
      <div class="sync-off-state">
        <p class="sync-desc">Sync tasks between your devices directly — no server stores your data. Devices pair with a one-time code and every message is end-to-end encrypted.</p>
        <p class="sync-desc">
          ℹ Best effort: works reliably on same WiFi; may fail on some cellular networks due to NAT restrictions.
        </p>
        <button class="btn-primary" data-action="syncEnable">Enable Sync</button>
      </div>`;
    return;
  }

  // Preserve a half-typed pairing code across re-renders (a status change or
  // an incoming patch must not blank the input mid-entry).
  const prevInput = document.getElementById('syncCodeInput');
  const prevCode = prevInput ? prevInput.value : '';
  const prevFocused = !!(prevInput && document.activeElement === prevInput);

  const safe = (s) => (typeof esc === 'function') ? esc(String(s)) : String(s);
  const pairingCode = _myPairingCode();
  const pairs = _pairCount();
  let codeBlock;
  if (pairingCode) {
    // The secret is shown here and only here, until a device has paired with it.
    codeBlock = `
      <div class="sync-my-code-block">
        <label>Your pairing code</label>
        <div class="sync-code sync-code--long" id="syncMyCode">${safe(pairingCode)}</div>
        <div class="sync-input-hint">Enter this code on your other device. It contains a secret: anyone who copies it can pair with this device until you generate a new one. It disappears from here once a device has paired with it.</div>
        <div class="sync-code-actions">
          <button class="btn-ghost btn-sm" data-action="syncCopyMyCode">Copy</button>
          <button class="btn-ghost btn-sm" data-action="syncNewPairingCode" title="Mint a new pairing code (the current one stops working; paired devices are kept)">Generate new pairing code</button>
          <button class="btn-ghost btn-sm" data-action="syncRegenerateCode" title="New device id — unpairs every device">Reset sync identity…</button>
        </div>
      </div>`;
  } else {
    const pairedLine = pairs
      ? 'Paired with ' + pairs + ' device' + (pairs === 1 ? '' : 's') + '. Paired devices reconnect on their own.'
      : 'Not paired with any device yet.';
    codeBlock = `
      <div class="sync-my-code-block">
        <label>This device</label>
        <div class="sync-code" id="syncMyCode">${safe(_myRoomCode || '…')}</div>
        <div class="sync-input-hint">${safe(pairedLine)} To pair another device, generate a pairing code and enter it there.</div>
        <div class="sync-code-actions">
          <button class="btn-primary btn-sm" data-action="syncNewPairingCode">Generate pairing code</button>
          <button class="btn-ghost btn-sm" data-action="syncRegenerateCode" title="New device id — unpairs every device">Reset sync identity…</button>
        </div>
      </div>`;
  }

  panel.innerHTML = `
    <div class="sync-active">
      <div class="sync-status-row">
        <span class="sync-dot sync-dot--${_syncStatus}" id="syncDot"></span>
        <span id="syncStatus"></span>
      </div>
      ${codeBlock}
      <div class="sync-connect-block">
        <label>Connect to device</label>
        <div class="sync-input-row">
          <input id="syncCodeInput" type="text" placeholder="STU-XXX-XXX-XXXX-XXXX-XXXX" maxlength="40"
                 autocomplete="off" autocapitalize="characters" spellcheck="false"
                 data-oninput="syncOnCodeInputFromInput"
                 data-onkeydown="syncConnectInputKey">
          <button class="btn-primary btn-sm" id="syncConnectBtn" data-action="syncConnectFromInput" disabled>Connect</button>
        </div>
        <div class="sync-input-hint" id="syncInputHint">Enter the pairing code shown on the other device (${SYNC_CODE_LEN} characters after <code>STU-</code>; dashes and case don't matter). A device paired before can be reached with its 6-character code alone.</div>
      </div>
      <div class="sync-action-row" id="syncActionRow"></div>
      <button class="btn-ghost btn-sm sync-disable" data-action="syncDisconnect">Disable sync</button>
    </div>`;

  const input = document.getElementById('syncCodeInput');
  if (input && prevCode) {
    input.value = prevCode;
    syncOnCodeInput(input);
    if (prevFocused) {
      try { input.focus(); const n = input.value.length; input.setSelectionRange(n, n); } catch(e) { /* noop */ }
    }
  }
  _renderSyncActionRow();
  _setSyncStatus(_syncStatus);
}

/** Live validation + auto-format while typing a pairing code (STU-XXX-XXX-YYYY-YYYY-YYYY). */
function syncOnCodeInput(el) {
  if (!el) return;
  let compact = String(el.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  // "STU" is the display prefix, re-added below; the formatter is a no-op on
  // the compact form, so a room that itself starts with S-T-U still parses.
  if (compact.startsWith('STU')) compact = compact.slice(3);
  compact = compact.slice(0, SYNC_CODE_LEN);
  let formatted = '';
  if (compact) {
    formatted = 'STU';
    let at = 0;
    for (const g of [3, 3, 4, 4, 4]) {
      if (at >= compact.length) break;
      formatted += '-' + compact.slice(at, at + g);
      at += g;
    }
  }
  // Only rewrite the field when formatting changed it — rewriting
  // unconditionally jumps the caret to the end on every keystroke.
  if (el.value !== formatted) el.value = formatted;
  const btn = document.getElementById('syncConnectBtn');
  const hint = document.getElementById('syncInputHint');
  const parsed = _parseCode(formatted);
  const n = compact.length;
  let ok = parsed.ok, text = '', err = false;
  if (!n) {
    text = 'Enter the pairing code shown on the other device (' + SYNC_CODE_LEN + ' characters after STU-; dashes and case don\'t matter).';
  } else if (n === SYNC_ROOM_LEN) {
    // A bare room only reaches a device we already hold a key for.
    if (_getPairKey(_codeToId(compact))) {
      text = 'Ready — a device paired before. Press Connect.';
    } else {
      ok = false;
      text = 'Keep typing — ' + n + '/' + SYNC_CODE_LEN + ' characters so far. A 6-character code only reaches a device that is already paired with this one.';
    }
  } else if (!ok) {
    text = n < SYNC_CODE_LEN ? ('Keep typing — ' + n + '/' + SYNC_CODE_LEN + ' characters so far.') : parsed.message;
    err = true;
  } else {
    text = 'Ready — press Connect.';
  }
  if (btn) btn.disabled = !ok;
  if (hint) {
    hint.textContent = text;
    hint.classList.toggle('sync-input-hint--err', err);
  }
}

function syncEnable() {
  _syncEnabled = true;
  renderSyncPanel();
  syncInit().then(() => renderSyncPanel()).catch(e => console.warn('[Sync] init failed', e));
}

function syncConnectFromInput() {
  const el = document.getElementById('syncCodeInput');
  const val = (el?.value || '').trim();
  const parsed = _parseCode(val);
  if (!parsed.ok) {
    _setSyncStatus('error', parsed.message);
    return;
  }
  if (!parsed.secret && !_getPairKey(_codeToId(parsed.room))) {
    _setSyncStatus('error', 'Enter the full pairing code shown on the other device (18 characters after STU-). Older 6-character codes can no longer pair.');
    return;
  }
  // The secret has done its job; don't leave it on screen.
  if (el) { el.value = ''; syncOnCodeInput(el); }
  syncConnect(val);
}
