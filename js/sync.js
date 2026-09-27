// ========== P2P SYNC (WebRTC via PeerJS) ==========
// Devices sync directly — no server sees your data.
// PeerJS cloud only handles the initial handshake (SDP/ICE exchange).
// After that, data flows device-to-device via RTCDataChannel.

// Peer ID format: `stupind-<6 alphanumeric>` (never includes "stu" as suffix).
// Displayed as `STU-XXX-XXX` where the first "STU" is branding only.
// A legacy v1 bug produced 9-char ids starting with "stu" (the brand accidentally
// embedded in the id), rendered as "STU-STU-XXXXXX". We migrate those on boot.
const SYNC_PEER_KEY    = (window.ODTAULAI_CONFIG && window.ODTAULAI_CONFIG.STORAGE_KEYS && window.ODTAULAI_CONFIG.STORAGE_KEYS.SYNC_PEER) || 'stupind_peer_id_v2'; // cleaned format
const SYNC_PEER_KEY_V1 = (window.ODTAULAI_CONFIG && window.ODTAULAI_CONFIG.STORAGE_KEYS && window.ODTAULAI_CONFIG.STORAGE_KEYS.SYNC_PEER_V1) || 'stupind_peer_id';    // legacy — detected & migrated
const SYNC_ROOM_KEY    = (window.ODTAULAI_CONFIG && window.ODTAULAI_CONFIG.STORAGE_KEYS && window.ODTAULAI_CONFIG.STORAGE_KEYS.SYNC_ROOM) || 'stupind_sync_room';
const SYNC_VERSION     = 1;
const CODE_ALPHABET    = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Crockford-ish, no 0/O/1/I

let _peer        = null;   // PeerJS instance
let _conn        = null;   // active DataConnection
let _syncEnabled = false;
let _syncStatus  = 'off';  // 'off' | 'waiting' | 'connected' | 'error'
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

function _genCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return code.slice(0,3) + '-' + code.slice(3); // e.g. "AB3-C9D"
}

function _genPeerId() {
  // 6 random chars → stable peer id. No "stu" baked in.
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return 'stupind-' + s.toLowerCase();
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
    'unavailable-id':       'Code conflict — generating a new one.',
  };
  if(t && map[t]) return map[t];
  if(err && err.message) return String(err.message);
  return 'Connection failed';
}

function _setSyncStatus(status, msg) {
  _syncStatus = status;
  const el = document.getElementById('syncStatus');
  const dot = document.getElementById('syncDot');
  if (!el) return;
  // Surface the connected peer's code so a user with 3+ devices can tell
  // *which* one they're paired with (#11 in UX audit).
  const peerCode = (status === 'connected' && _conn && _conn.peer) ? _idToCode(_conn.peer) : null;
  const labels = {
    off:       '○ Sync off',
    loading:   '◌ Loading…',
    waiting:   '◌ Waiting for peer…',
    connecting:'◌ Connecting…',
    connected: peerCode ? ('● Synced with ' + peerCode) : '● Synced',
    error:     '✕ ' + (msg || 'Error'),
  };
  el.textContent = labels[status] || status;
  if (dot) dot.className = 'sync-dot sync-dot--' + status;
}

/** Normalize input: uppercase, strip whitespace/dashes, tolerate legacy "STU…" prefix. */
function _normalizeCode(code) {
  const raw = String(code || '').toUpperCase().replace(/[\s-]/g, '');
  // Legacy codes were displayed as "STU-STU-XXXXXX" — 9 letters after stripping
  // dashes and starting with "STU". Drop the accidental STU prefix so we land on
  // the actual 6-char id suffix.
  if (raw.length === 9 && raw.startsWith('STU')) return raw.slice(3);
  return raw;
}

function _codeToId(code) {
  const suffix = _normalizeCode(code);
  return 'stupind-' + suffix.toLowerCase();
}

function _idToCode(id) {
  const raw = String(id || '').replace(/^stupind-/, '').toUpperCase();
  // Display legacy 9-char ids (starting with STU) as clean "STU-XXX-XXX" too —
  // the embedded STU is branding noise, not an address component.
  const suffix = (raw.length === 9 && raw.startsWith('STU')) ? raw.slice(3) : raw;
  if (suffix.length === 6) return 'STU-' + suffix.slice(0,3) + '-' + suffix.slice(3);
  // Any other length: best-effort symmetric split (shouldn't happen post-migration)
  const half = Math.ceil(suffix.length / 2);
  return 'STU-' + suffix.slice(0, half) + '-' + suffix.slice(half);
}

/** True if the code parses to a 6-char suffix (the only shape we should ever accept). */
function _isValidCode(code) {
  const n = _normalizeCode(code);
  return n.length === 6 && [...n].every(c => CODE_ALPHABET.includes(c));
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
    try { _conn.send({ type: 'patch', payload: _packState() }); }
    catch(e){ console.warn('[Sync] ack patch', e); }
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
// free, and an initiator counted ANY non-hello message as "the other user
// accepted" and answered with its whole state. So while a paired device was
// offline, whoever registered its id got the full vault on this device's next
// auto-reconnect by sending {type:'ping'}, and could push tombstones back.
//
// The first pairing is still consent: the acceptor's user clicks Accept. That
// click now mints a 256-bit key, sent once over the DTLS-encrypted channel and
// stored by both devices against the other's peer id. Every later connection
// proves possession in both directions with an HMAC over the other side's
// fresh nonce. Until that proof (or the Accept click) nothing but
// hello / auth / pair is processed: no state, no patch, no ping. A reconnect
// that already holds a key never takes a new one, so a squatter can't re-pair
// itself in; only a code the user types again may replace a key.
const SYNC_PAIRS_KEY = (window.ODTAULAI_CONFIG && window.ODTAULAI_CONFIG.STORAGE_KEYS && window.ODTAULAI_CONFIG.STORAGE_KEYS.SYNC_PAIRS) || 'stupind_sync_pairs';
const SYNC_PROTO = 2;
const SYNC_AUTH_WAIT_MS = 5000;   // acceptor: how long a device that says it's paired gets to prove it
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
function _randHex(nBytes){
  const a = new Uint8Array(nBytes);
  crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}
function _syncCryptoOk(){
  return typeof crypto !== 'undefined' && !!crypto.subtle && typeof crypto.getRandomValues === 'function';
}
/** HMAC-SHA256(key, parts.join('|')) as hex. `role` in parts stops reflection. */
async function _syncMac(keyHex, parts){
  const raw = new Uint8Array(keyHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(parts.join('|')));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
}
function _macEq(a, b){
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function _myPeerId(){ return (_peer && _peer.id) || ''; }

function syncHideIncomingBanner(){
  const b = document.getElementById('syncIncomingBar');
  if(b) b.remove();
}

/** kind: 'new' (never paired) | 'unverified' (we hold a key for this id but it didn't prove it). */
function syncShowIncomingBanner(peerLabel, kind){
  syncHideIncomingBanner();
  const bar = document.createElement('div');
  bar.id = 'syncIncomingBar';
  bar.className = 'sync-incoming-bar';
  const safePeer = (typeof esc === 'function') ? esc(String(peerLabel || 'unknown')) : String(peerLabel || 'unknown');
  const msg = kind === 'unverified'
    ? '<strong>Re-pair request</strong> from <code>'+safePeer+'</code>. It could not prove it is the device you paired before. Accept only if you reset or reinstalled that device.'
    : '<strong>Incoming sync</strong> from <code>'+safePeer+'</code>. Accept only if this is your device.';
  bar.innerHTML = '<div class="sync-incoming-inner">'+msg+'</div>'
    +'<div class="sync-incoming-actions">'
    +'<button type="button" class="btn-primary btn-sm" id="syncAcceptInbound">Accept</button>'
    +'<button type="button" class="btn-ghost btn-sm" id="syncRejectInbound">Reject</button></div>';
  document.body.appendChild(bar);
  document.getElementById('syncAcceptInbound').onclick = () => syncAcceptInbound();
  document.getElementById('syncRejectInbound').onclick = () => syncRejectInbound();
}

/** The user clicked Accept: mint a fresh key for this device and pair. */
function syncAcceptInbound(){
  const conn = _pendingInboundConn;
  if(!conn) return;
  _pendingInboundConn = null;
  syncHideIncomingBanner();
  if (conn._authTimer) { clearTimeout(conn._authTimer); conn._authTimer = null; }
  if(_conn && _conn !== conn){ try{ _conn.close(); }catch(e){} }
  _conn = conn;
  _lastConnectCode = _idToCode(conn.peer);
  const key = _randHex(32);
  _setPairKey(conn.peer, key);
  try { conn.send({ type: 'pair', key }); } catch(e) { console.warn('[Sync] send pair', e); }
  _syncMarkReady(conn);
}

function syncRejectInbound(){
  const conn = _pendingInboundConn;
  _pendingInboundConn = null;
  syncHideIncomingBanner();
  if(conn){ if (conn._authTimer) clearTimeout(conn._authTimer); try{ conn.close(); }catch(e){} }
}

/** Proof accepted (or Accept clicked): unlock the channel and exchange state once. */
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
  try { conn.send({ type: 'state', payload: _packState() }); } catch(e) { console.warn('[Sync] send state', e); }
}

/**
 * Wire a DataConnection for the handshake. role 'initiator' = we dialled
 * (opts.manual: the user typed this code just now, so a 'pair' may replace a
 * stored key); role 'acceptor' = an inbound connection, which shows the Accept
 * banner unless the peer proves it already holds our key.
 */
function _wireConn(conn, opts) {
  const role = (opts && opts.role) || 'initiator';
  const manual = !!(opts && opts.manual);
  if (role === 'initiator') _conn = conn;
  conn._myNonce = _randHex(16);
  conn._peerNonce = null;
  conn._sentAuth = false;
  let chain = Promise.resolve();

  const fail = (msg) => {
    _setSyncStatus('error', msg);
    if (role === 'initiator') _lastConnectCode = null; // don't auto-retry into the same refusal
    try { conn.close(); } catch(e) {}
  };

  const sendAuth = async () => {
    const key = _getPairKey(conn.peer);
    if (!key || !conn._peerNonce || conn._sentAuth) return;
    conn._sentAuth = true;
    const mac = await _syncMac(key, ['odta-sync', role === 'initiator' ? 'i' : 'a', _myPeerId(), conn.peer, conn._peerNonce]);
    try { conn.send({ type: 'auth', mac }); } catch(e) { console.warn('[Sync] send auth', e); }
  };

  const verifyAuth = async (mac) => {
    const key = _getPairKey(conn.peer);
    if (!key || typeof mac !== 'string') return false;
    const want = await _syncMac(key, ['odta-sync', role === 'initiator' ? 'a' : 'i', conn.peer, _myPeerId(), conn._myNonce]);
    return _macEq(mac, want);
  };

  const showBanner = () => {
    if (conn._syncReady || _pendingInboundConn !== conn || conn._bannerShown) return;
    conn._bannerShown = true;
    if (conn._authTimer) { clearTimeout(conn._authTimer); conn._authTimer = null; }
    syncShowIncomingBanner(_idToCode(conn.peer), _getPairKey(conn.peer) ? 'unverified' : 'new');
  };

  const onOpen = () => {
    // Our own dial opened: reset the backoff. (Not for inbound: a stranger
    // dialling in must not cancel a pending reconnect to the paired device.)
    if (role === 'initiator') {
      if(_reconnectTimerId){ clearTimeout(_reconnectTimerId); _reconnectTimerId = null; }
      _reconnectAttempt = 0;
    }
    try { conn.send({ type: 'hello', v: SYNC_PROTO, nonce: conn._myNonce, paired: !!_getPairKey(conn.peer) }); }
    catch(e) { console.warn('[Sync] send hello', e); }
    if (role === 'initiator') _setSyncStatus('connecting', 'Waiting for the other device to accept…');
  };
  conn.on('open', onOpen);
  // PeerJS doesn't replay 'open' for listeners attached after it fired.
  if (conn.open) onOpen();

  const handle = async (msg) => {
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    if (msg.type === 'hello') {
      if (msg.v !== SYNC_PROTO || typeof msg.nonce !== 'string' || !_HEX32.test(msg.nonce)) {
        // A pre-v79 device can't authenticate. As acceptor we can still pair
        // it by Accept (it treats our 'pair' as acceptance); as initiator we
        // would wait forever for a proof it can't give.
        if (role === 'initiator') fail('The other device runs an older Odta. Update it, then connect again');
        else showBanner();
        return;
      }
      if (conn._peerNonce) return;
      conn._peerNonce = msg.nonce;
      // The acceptor proves itself only to a caller that says it holds a key:
      // no reason to sign nonces for strangers.
      if (role === 'initiator' || msg.paired) await sendAuth();
      if (role === 'acceptor' && !conn._syncReady) {
        if (!msg.paired || !_getPairKey(conn.peer)) showBanner();
        else conn._authTimer = setTimeout(showBanner, SYNC_AUTH_WAIT_MS);
      }
      return;
    }
    if (msg.type === 'auth') {
      if (conn._syncReady) return;
      if (!(await verifyAuth(msg.mac))) {
        if (role === 'initiator') fail('Could not verify ' + _idToCode(conn.peer) + '. It may not be your device. Enter its code again to re-pair.');
        else showBanner();
        return;
      }
      if (role === 'acceptor') {
        if (_pendingInboundConn !== conn) return;
        _pendingInboundConn = null;
        if (conn._authTimer) { clearTimeout(conn._authTimer); conn._authTimer = null; }
        syncHideIncomingBanner();
        if (_conn && _conn !== conn) { try { _conn.close(); } catch(e) {} }
        _conn = conn;
        _lastConnectCode = _idToCode(conn.peer);
        await sendAuth();
      }
      _syncMarkReady(conn);
      return;
    }
    if (msg.type === 'pair') {
      // Only the acceptor's user can mint a key, and only for a code we dialled.
      if (role !== 'initiator' || conn._syncReady) return;
      if (typeof msg.key !== 'string' || !_HEX64.test(msg.key)) return;
      if (_getPairKey(conn.peer) && !manual) {
        fail(_idToCode(conn.peer) + ' asked to pair again. If you reset that device, enter its code to re-pair.');
        return;
      }
      _setPairKey(conn.peer, msg.key);
      _syncMarkReady(conn);
      return;
    }
    if (!conn._syncReady) {
      // A v78 acceptor never says hello: its user's Accept just sends state.
      // Say so rather than wait forever on a proof it can't give.
      if (role === 'initiator' && (msg.type === 'state' || msg.type === 'patch')) {
        fail("The other device didn't pair securely. If it runs an older Odta, update it, then connect again");
      }
      return;
    }
    if (msg.type === 'state') {
      _mergeState(msg.payload, { isInitialState: true });
    } else if (msg.type === 'patch') {
      _mergeState(msg.payload);
    } else if (msg.type === 'ping') {
      try { conn.send({ type: 'pong' }); } catch(e) { console.warn('[Sync] send pong', e); }
    }
  };
  // Serialise: auth verification is async, and the state that follows a
  // proof must not be handled (and dropped) before the proof lands.
  conn.on('data', (msg) => {
    chain = chain.then(() => handle(msg)).catch(e => console.warn('[Sync] handle', e));
  });

  conn.on('close', () => {
    if (conn._authTimer) { clearTimeout(conn._authTimer); conn._authTimer = null; }
    if (_pendingInboundConn === conn) { _pendingInboundConn = null; syncHideIncomingBanner(); }
    // PeerJS emits 'close' synchronously from close(). When this connection
    // was replaced (Connect to a different code, accepting a new inbound
    // link, or the simultaneous-dial tie-break, which clears _conn first) the
    // current _conn is not this one; tearing it down and scheduling a
    // reconnect here restarted the fresh handshake every 2 s.
    if (_conn !== conn) return;
    _conn = null;
    // Don't stomp on a more-specific error message (e.g. "Code not found")
    // that we just set from _peer.on('error', 'peer-unavailable').
    if (_syncStatus !== 'error' && _syncStatus !== 'connected') _setSyncStatus('waiting');
    // Connection went down. If the user didn't disconnect intentionally,
    // schedule an auto-reconnect with backoff.
    if (_lastConnectCode) _scheduleSyncReconnect();
  });

  conn.on('error', (err) => {
    console.warn('[sync] conn error', err);
    if (_pendingInboundConn === conn) { _pendingInboundConn = null; syncHideIncomingBanner(); }
    if (_conn !== conn) return;
    _conn = null;
    if (_connectTimeoutId) { clearTimeout(_connectTimeoutId); _connectTimeoutId = null; }
    _setSyncStatus('error', _friendlySyncError(err));
    if (_lastConnectCode) _scheduleSyncReconnect();
  });
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

let _syncInitPromise = null;
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

  const myId = _resolvePeerId();
  _myRoomCode = _idToCode(myId);

  const codeEl = document.getElementById('syncMyCode');
  if (codeEl) codeEl.textContent = _myRoomCode;

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
    _setSyncStatus('waiting');
    // Auto-reconnect to last room if we have one
    const lastRoom = localStorage.getItem(SYNC_ROOM_KEY);
    if (lastRoom && lastRoom !== _myRoomCode) {
      syncConnect(lastRoom);
    }
  });

  _peer.on('connection', (conn) => {
    if(!_syncEnabled){ try{ conn.close(); }catch(e){} return; }
    if(_conn && _conn.open && _conn._syncReady){ try{ conn.close(); }catch(e){} return; }
    if(_pendingInboundConn){ try{ conn.close(); }catch(e){} return; }
    if(_conn && _conn.peer === conn.peer){
      // Both devices dialled each other at once (both auto-reconnect on
      // enable). Keep the one the lower id started, on both ends; otherwise
      // each side drops the connection the other kept.
      if(_myPeerId() < String(conn.peer)){ try{ conn.close(); }catch(e){} return; }
      const mine = _conn; _conn = null;
      try{ mine.close(); }catch(e){}
    }
    // Held pending until the peer proves it holds our key (auto-accept, no
    // banner) or our user clicks Accept on the banner _wireConn raises.
    _pendingInboundConn = conn;
    _wireConn(conn, { role: 'acceptor' });
  });

  _peer.on('error', (err) => {
    console.warn('[sync] peer error', err);
    const t = err && err.type;
    if (t === 'unavailable-id') {
      // Our own id is already registered — mint a new one.
      try { localStorage.removeItem(SYNC_PEER_KEY); } catch(e) {}
      _peer = null;
      syncInit();
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

  _peer.on('disconnected', () => {
    _setSyncStatus('waiting');
    try { _peer.reconnect(); } catch(e) { console.warn('[Sync] reconnect', e); }
  });
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
  if(_lastConnectCode){
    _setSyncStatus('connecting', 'Reconnecting…');
    try { syncConnect(_lastConnectCode); } catch(e){ console.warn('[Sync] reconnect failed', e); }
  }
}

function syncConnect(code, opts) {
  if (!_peer) { syncInit().then(() => { if (_peer) syncConnect(code, opts); }).catch(e => console.warn('[Sync] init failed', e)); return; }
  if (!_isValidCode(code)) {
    _setSyncStatus('error', 'Invalid code — expected 6 letters/digits after STU-');
    return;
  }
  const targetId = _codeToId(code);
  if (targetId === _peer.id) {
    _setSyncStatus('error', "That's this device's own code");
    return;
  }
  // Remember the code so we can re-establish on socket-closed without
  // requiring the user to retype it. Cleared on syncDisconnect.
  _lastConnectCode = code;
  _setSyncStatus('connecting');

  // If we have a stale dead connection, drop it before making a new one.
  if (_conn) { try { _conn.close(); } catch(e) {} _conn = null; }

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

  _wireConn(conn, { role: 'initiator', manual: !!(opts && opts.manual) });
}

/** Mint a fresh peer id (escape hatch if pairing is stuck on a bad code). */
async function syncRegenerateCode() {
  // Regenerating destroys the existing pairing — any device that stored this
  // code will be orphaned (#14 in UX audit). Confirm before nuking.
  const msg = 'Regenerating your code unpairs every device that knows the current code. They\'ll need the new code to reconnect. Continue?';
  if (typeof showAppConfirm === 'function'){
    if (!(await showAppConfirm(msg))) return;
  } else if (!confirm(msg)) return;
  try { localStorage.removeItem(SYNC_PEER_KEY); } catch(e) {}
  try { localStorage.removeItem(SYNC_ROOM_KEY); } catch(e) {}
  // Every pairing is keyed to the old id on the other side, so drop ours too.
  try { localStorage.removeItem(SYNC_PAIRS_KEY); } catch(e) {}
  if (_conn) { try { _conn.close(); } catch(e) {} _conn = null; }
  if (_peer) { try { _peer.destroy(); } catch(e) {} _peer = null; }
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
  if (_conn) { try { _conn.close(); } catch(e) { console.warn('[Sync] conn close', e); } _conn = null; }
  if (_peer) { try { _peer.destroy(); } catch(e) { console.warn('[Sync] peer destroy', e); } _peer = null; }
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
  // _syncReady gates on the accept handshake — local edits must not leak to a
  // peer whose user hasn't accepted the pairing yet.
  if (!_conn || !_conn.open || !_conn._syncReady) return;
  // Throttle: max 1 broadcast per 500ms to avoid flooding on rapid saves
  const now = Date.now();
  if (now - _lastBroadcastAt < 500) {
    clearTimeout(_broadcastTimer);
    _broadcastTimer = setTimeout(() => {
      _lastBroadcastAt = Date.now();
      _broadcastTimer = null;
      try { _conn.send({ type: 'patch', payload: _packState() }); } catch(e) { console.warn('[Sync] broadcast', e); }
    }, 500);
    return;
  }
  _lastBroadcastAt = now;
  try { _conn.send({ type: 'patch', payload: _packState() }); } catch(e) { console.warn('[Sync] broadcast', e); }
}

// ── UI ───────────────────────────────────────────────────────────────────────

function renderSyncPanel() {
  const panel = document.getElementById('syncPanel');
  if (!panel) return;

  if (!_syncEnabled) {
    panel.innerHTML = `
      <div class="sync-off-state">
        <p class="sync-desc">Sync tasks between your devices directly — no server stores your data.</p>
        <p class="sync-desc">
          ℹ Best effort: works reliably on same WiFi; may fail on some cellular networks due to NAT restrictions.
        </p>
        <button class="btn-primary" data-action="syncEnable">Enable Sync</button>
      </div>`;
    return;
  }

  panel.innerHTML = `
    <div class="sync-active">
      <div class="sync-status-row">
        <span class="sync-dot sync-dot--${_syncStatus}" id="syncDot"></span>
        <span id="syncStatus"></span>
      </div>
      <div class="sync-my-code-block">
        <label>Your code</label>
        <div class="sync-code" id="syncMyCode">${_myRoomCode || '…'}</div>
        <div class="sync-code-actions">
          <button class="btn-ghost btn-sm" data-action="syncCopyMyCode">Copy</button>
          <button class="btn-ghost btn-sm" data-action="syncRegenerateCode" title="Mint a new pairing code (unpairs this device)">Regenerate</button>
        </div>
      </div>
      <div class="sync-connect-block">
        <label>Connect to device</label>
        <div class="sync-input-row">
          <input id="syncCodeInput" type="text" placeholder="STU-XXX-XXX" maxlength="11"
                 autocomplete="off" autocapitalize="characters" spellcheck="false"
                 data-oninput="syncOnCodeInputFromInput"
                 data-onkeydown="syncConnectInputKey">
          <button class="btn-primary btn-sm" id="syncConnectBtn" data-action="syncConnectFromInput" disabled>Connect</button>
        </div>
        <div class="sync-input-hint" id="syncInputHint">Enter the 6-character code shown on the other device (e.g. <code>STU-AB3-C9D</code>).</div>
      </div>
      <div class="sync-action-row" id="syncActionRow"></div>
      <button class="btn-ghost btn-sm sync-disable" data-action="syncDisconnect">Disable sync</button>
    </div>`;
  // Show "Reconnect now" inline whenever we have a remembered target and
  // we're either in error or in connecting+backoff. Lets the user skip the
  // wait without having to retype the pairing code.
  const actionRow = document.getElementById('syncActionRow');
  if(actionRow){
    if(_lastConnectCode && (_syncStatus === 'error' || _reconnectTimerId)){
      actionRow.innerHTML = '<button class="btn-primary btn-sm" data-action="syncReconnectNow">Reconnect now</button>';
    } else {
      actionRow.innerHTML = '';
    }
  }

  _setSyncStatus(_syncStatus);
}

/** Live validation + auto-format while typing a pairing code. */
function syncOnCodeInput(el) {
  if (!el) return;
  // Strip anything that isn't a code letter or a dash, uppercase as we go.
  let raw = String(el.value || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
  // Collapse multiple dashes and trim leading/trailing
  raw = raw.replace(/-+/g, '-').replace(/^-|-$/g, '');
  // Live-format STU-XXX-XXX: re-insert dashes as the user types so paste
  // without dashes and bare-typed codes match the displayed format (#15
  // in UX audit). Strip all dashes, then reinsert at positions 3 and 6
  // of the body (after STU).
  const compact = raw.replace(/-/g, '');
  if (compact.startsWith('STU') && compact.length > 3) {
    const body = compact.slice(3);
    let formatted = 'STU';
    if (body.length > 0) formatted += '-' + body.slice(0, 3);
    if (body.length > 3) formatted += '-' + body.slice(3, 6);
    raw = formatted;
  } else if (!compact.startsWith('STU') && compact.length >= 3) {
    // User pasted bare body — treat as STU-prefix code.
    let formatted = 'STU';
    if (compact.length > 0) formatted += '-' + compact.slice(0, 3);
    if (compact.length > 3) formatted += '-' + compact.slice(3, 6);
    raw = formatted;
  }
  el.value = raw;
  const btn = document.getElementById('syncConnectBtn');
  const hint = document.getElementById('syncInputHint');
  const ok = _isValidCode(raw);
  if (btn) btn.disabled = !ok;
  if (hint) {
    if (!raw) {
      hint.textContent = 'Enter the 6-character code shown on the other device (e.g. STU-AB3-C9D).';
      hint.classList.remove('sync-input-hint--err');
    } else if (!ok) {
      const n = _normalizeCode(raw).length;
      hint.textContent = n < 6
        ? `Keep typing — ${n}/6 characters so far.`
        : 'Too long — pairing codes are 6 letters/digits after STU-.';
      hint.classList.add('sync-input-hint--err');
    } else {
      hint.textContent = 'Ready — press Connect.';
      hint.classList.remove('sync-input-hint--err');
    }
  }
}

function syncEnable() {
  _syncEnabled = true;
  renderSyncPanel();
  syncInit();
}

function syncConnectFromInput() {
  const val = (document.getElementById('syncCodeInput')?.value || '').trim();
  if (!_isValidCode(val)) {
    _setSyncStatus('error', 'Invalid code — expected 6 letters/digits after STU-');
    return;
  }
  syncConnect(val, { manual: true });
}
