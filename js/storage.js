// ========== PERSISTENCE ==========
// Internal keys keep stupind_* prefix so existing installs retain data through rebrands (stupind → OdTauLai → Odta).
const STORE_KEY     = (window.ODTAULAI_CONFIG && window.ODTAULAI_CONFIG.STORAGE_KEYS && window.ODTAULAI_CONFIG.STORAGE_KEYS.STATE) || 'stupind_state';
const ARCHIVE_KEY   = (window.ODTAULAI_CONFIG && window.ODTAULAI_CONFIG.STORAGE_KEYS && window.ODTAULAI_CONFIG.STORAGE_KEYS.ARCHIVE) || 'stupind_archive';
const SCHEMA_VERSION = 8;

/** P2P sync: permanent task deletion tombstones id → deleted-at (ms). Merged with max(ts). */
var syncTaskDels = {};
/** P2P sync: deleted list ids */
var syncListDels = {};
/** P2P sync: deleted goal ids */
var syncGoalDels = {};
/** Bump every save; used to merge session/config fields from remote when newer */
var stateEpoch = 0;
/** Per-tab nonce used to break ties when two tabs write at the same ms.
 * Stored as a sibling field on persisted state (stateNonce). Sync.js leaves
 * stateEpoch in Date.now() range so its clamp keeps working. */
const _STATE_TAB_NONCE = (typeof crypto !== 'undefined' && crypto.getRandomValues)
  ? (crypto.getRandomValues(new Uint16Array(1))[0])
  : ((Math.random() * 0xffff) | 0);
var stateNonce = 0;

// Main nav tabs — single source for persisted activeTab + ?tab= deep links (see app.js)
const VALID_MAIN_TABS = ['tasks','focus','tools','data','settings'];

// ── IndexedDB mirror (silent crash backup) ────────────────────────────────────
let _idb = null;
function _openIDB(){
  if(_idb) return Promise.resolve(_idb);
  return new Promise((res,rej)=>{
    const req = indexedDB.open((window.ODTAULAI_CONFIG && window.ODTAULAI_CONFIG.IDB && window.ODTAULAI_CONFIG.IDB.BACKUP_DB) || 'stupind_backup',1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('kv');
    req.onsuccess = e => { _idb = e.target.result; res(_idb); };
    req.onerror   = () => rej(req.error);
  });
}
function _idbSet(key,val){ _openIDB().then(db=>{ const tx=db.transaction('kv','readwrite'); tx.objectStore('kv').put(val,key); }).catch(()=>{}); }
function _idbGet(key){ return _openIDB().then(db=>new Promise((res,rej)=>{ const tx=db.transaction('kv','readonly'); const r=tx.objectStore('kv').get(key); r.onsuccess=()=>res(r.result??null); r.onerror=()=>rej(r.error); })).catch(()=>null); }

// ── Type coercions — repair individual bad values safely ──────────────────────
const _str  = (v,d='')     => (v!=null&&typeof v==='string') ? v : (v!=null?String(v):d);
const _int  = (v,d=0)      => { const n=parseInt(v); return isNaN(n)?d:n; };
const _bool = (v,d=false)  => typeof v==='boolean'?v:d;
const _arr  = (v)          => Array.isArray(v)?v:[];
const _obj  = (v,d={})     => (v&&typeof v==='object'&&!Array.isArray(v))?v:d;
const _enum = (v,allowed,d)=> allowed.includes(v)?v:d;

// Keys we emit on every repaired task (used to stash forward-compat / unknown
// top-level fields into `_ext` so a newer app version can add fields, an
// older build loads them, re-saves, and nothing is lost).
const TRANSIENT_TASK_KEYS = new Set(['_habitCycledInSession']);

// ── Task field repair — run on every task after migration ─────────────────────
// Ensures every field has the right type regardless of what was stored.
function _repairTask(t){
  if(!t||typeof t!=='object') return null;
  const id = _int(t.id, 0);
  if (id <= 0) return null;
  const out = {
    // Core identity
    id:           id,
    name:         _str(t.name, 'Untitled task'),
    parentId:     t.parentId!=null ? _int(t.parentId) : null,
    collapsed:    _bool(t.collapsed, false),
    created:      _str(t.created, ''),
    order:        _int(t.order, Date.now()),
    archived:     _bool(t.archived, false),
    // Status / priority
    status:       _enum(t.status,   ['open','progress','review','blocked','done'], 'open'),
    priority:     _enum(t.priority, ['urgent','high','normal','low','none'],       'none'),
    completedAt:  t.completedAt!=null ? _str(t.completedAt) : null,
    // Dates
    dueDate:      t.dueDate   ? _str(t.dueDate)   : null,
    startDate:    t.startDate ? _str(t.startDate) : null,
    // hiddenUntil: snooze/defer — task hidden from main views while > today.
    // Distinct from dueDate (deadline) and remindAt (notification trigger).
    hiddenUntil:  t.hiddenUntil ? _str(t.hiddenUntil) : null,
    remindAt:     t.remindAt  ? _str(t.remindAt)  : null,
    reminderFired:_bool(t.reminderFired, false),
    recur:        _enum(t.recur, ['daily','weekdays','weekly','monthly','every2d','after1d','after3d','after7d','after14d','after30d'], null) ?? (t.recur&&typeof t.recur==='string'?null:null),
    attachments:  _arr(t.attachments).filter(x => typeof x === 'string').slice(0, 32),
    // Text fields
    description:  _str(t.description, ''),
    url:          t.url ? _str(t.url) : null,
    completionNote: t.completionNote ? _str(t.completionNote) : null,
    // Numbers
    estimateMin:  _int(t.estimateMin, 0),
    totalSec:     _int(t.totalSec, 0),
    sessions:     _int(t.sessions, 0),
    // Per-session timer log (detail modal). Hoist from legacy _ext on load.
    sessionEntries: (function(){
      const raw = Array.isArray(t.sessionEntries) ? t.sessionEntries
        : (t._ext && Array.isArray(t._ext.sessionEntries) ? t._ext.sessionEntries : []);
      return raw.map(s => {
        if(!s || typeof s !== 'object') return null;
        const entry = {
          ts: _str(s.ts, ''),
          durationSec: Math.max(0, _int(s.durationSec, 0)),
          type: _str(s.type, 'work'),
        };
        if(s.phase != null) entry.phase = _str(s.phase, 'work');
        return entry.ts ? entry : null;
      }).filter(Boolean).slice(-200);
    })(),
    // Flags
    starred:      _bool(t.starred, false),
    // Arrays
    tags:         _arr(t.tags).filter(x=>typeof x==='string'),
    blockedBy:    _arr(t.blockedBy).map(x=>_int(x)).filter(x=>x>0),
    // C-9: linked / related tasks (separate from blockers — non-binding cross-references)
    relatedTo:    _arr(t.relatedTo).map(x=>_int(x)).filter(x=>x>0),
    // Legacy single checklist — kept for backwards compatibility. New code should
    // prefer task.checklists below; on first load, the legacy entries are
    // promoted into a default group named "Checklist".
    checklist:    _arr(t.checklist).map(c=>({
                    id:    _int(c.id, 0),
                    text:  _str(c.text, ''),
                    done:  _bool(c.done, false),
                    doneAt:c.doneAt ? _str(c.doneAt) : null,
                  })).filter(c=>c.text),
    // C-7: named checklists. Migration: if task has legacy `checklist[]` but no
    // `checklists[]`, the renderer will fold it into checklists on first save.
    checklists:   _arr(t.checklists).map(g=>({
                    id:    g.id != null ? _int(g.id, Date.now()) : (Date.now()+Math.random()),
                    name:  _str(g.name, 'Checklist'),
                    items: _arr(g.items).map(c=>({
                      id:    _int(c.id, 0),
                      text:  _str(c.text, ''),
                      done:  _bool(c.done, false),
                      doneAt:c.doneAt ? _str(c.doneAt) : null,
                    })).filter(c=>c.text),
                  })).filter(g=>g.name),
    notes:        _arr(t.notes).map(n=>({
                    id:        n.id||Date.now()+Math.random(),
                    text:      _str(n.text, ''),
                    createdAt: _str(n.createdAt, ''),
                  })).filter(n=>n.text),
    // C-2: per-task activity log — appended on each save when fields change
    activity:     _arr(t.activity).map(a=>({
                    at:    _str(a.at, ''),
                    field: _str(a.field, ''),
                    from:  a.from === undefined ? null : a.from,
                    to:    a.to === undefined ? null : a.to,
                  })).filter(a=>a.at && a.field).slice(-50),
    // v4+ task metadata
    type:         _enum(t.type, ['task','bug','idea','errand','waiting'], 'task'),
    effort:       _enum(t.effort, ['xs','s','m','l','xl'], null) ?? null,
    energyLevel:  _enum(t.energyLevel, ['high','low'], null) ?? null,
    // v5 values alignment — category id is user-extensible (custom classifications)
    category:     (function(){
      const c = t.category;
      if(c == null || c === '') return null;
      const s = String(c).trim();
      if(!s) return null;
      return s.length > 64 ? s.slice(0, 64) : s;
    })(),
    completions:  _arr(t.completions).map(x => {
      if(!x || typeof x !== 'object') return null;
      return { date: _str(x.date, ''), sec: _int(x.sec, 0) };
    }).filter(x => x && x.date),
    habitLastRecordedTotalSec: (typeof t.habitLastRecordedTotalSec === 'number' && t.habitLastRecordedTotalSec >= 0)
      ? Math.floor(t.habitLastRecordedTotalSec) : null,
    valuesAlignment: _arr(t.valuesAlignment).filter(x=>typeof x==='string'),
    valuesNote:   t.valuesNote ? _str(t.valuesNote) : null,
    // List membership
    listId:       t.listId!=null ? _int(t.listId) : null,
    // Sync metadata — CRITICAL: must be preserved across reloads so that
    // last-write-wins merging in sync.js compares correct timestamps instead
    // of treating every task as "just modified" after each page refresh.
    lastModified: (typeof t.lastModified === 'number' && t.lastModified > 0) ? t.lastModified : null,
  };
  const ext = { ..._obj(t._ext) };
  const known = new Set(Object.keys(out));
  for (const k of Object.keys(t)) {
    if (known.has(k) || k === '_ext' || TRANSIENT_TASK_KEYS.has(k)) continue;
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    ext[k] = t[k];
  }
  for (const k of Object.keys(ext)) {
    if (k in out) delete ext[k];
  }
  if (Object.keys(ext).length) out._ext = ext;
  return out;
}

// ── Migration runner ──────────────────────────────────────────────────────────
// Each step is isolated: a failure in one version never silently bumps the
// version past the failing step, so future loads get a chance to retry and
// newer-version fields are never "forgotten" because they landed in a skipped
// block. `reached` tracks the highest version successfully applied; `s.v` is
// set to that value at the end (it only advances, never rolls back).
function migrateState(s){
  if(!s||typeof s!=='object') return null;
  const v = _int(s.v, 1);
  let reached = v;

  const step = (target, fn) => {
    if(v >= target) return;           // already migrated in a previous run
    if(reached < target - 1) return;  // previous step didn't finish — don't skip over it
    try{ fn(); reached = target; }
    catch(e){ console.warn('[migration v'+target+']', e); }
  };

  step(2, () => {
    s.lists     = _arr(s.lists);
    s.listIdCtr = _int(s.listIdCtr, 0);
    s.activeListId = s.activeListId ?? null;
    if(Array.isArray(s.tasks)) s.tasks = s.tasks.map(t=>({listId:null,..._obj(t)}));
  });
  step(3, () => {
    s.collapsedSections = _obj(s.collapsedSections);
    s.taskGroupBy       = _str(s.taskGroupBy, 'none');
    if(Array.isArray(s.tasks)) s.tasks = s.tasks.map(t=>({recur:null,remindAt:null,reminderFired:false,..._obj(t)}));
  });
  step(4, () => {
    if(Array.isArray(s.tasks)) s.tasks = s.tasks.map(t=>({
      startDate:null,type:'task',effort:null,energyLevel:null,
      context:null,blockedBy:[],checklist:[],notes:[],url:null,completionNote:null,
      ..._obj(t)
    }));
  });
  step(5, () => {
    if(Array.isArray(s.tasks)) s.tasks = s.tasks.map(t=>({
      category:null,valuesAlignment:[],valuesNote:null,..._obj(t)
    }));
  });
  step(6, () => {
    if(Array.isArray(s.tasks)){
      s.tasks = s.tasks.map(t => {
        const o = _obj(t);
        const base = { completions: [], ...o };
        if(o.recur){
          base.habitLastRecordedTotalSec = _int(o.totalSec, 0);
        }
        return base;
      });
    }
  });

  // Steps must be declared in ascending order: the `step` helper refuses to run
  // a target when `reached < target - 1`, so an out-of-order step(8) before
  // step(7) made a v6 state skip step 8 entirely on the upgrade load (it only
  // self-healed on the *next* reload). Keep 7 before 8.
  step(7, () => {
    // The "archive" feature was removed in favour of direct delete + undo.
    // Archived tasks were the old recycle bin, so drop them permanently on
    // upgrade. Archiving always cascaded to descendants, so every member of an
    // archived subtree carries archived:true — filtering the flat list is safe.
    if(Array.isArray(s.tasks)) s.tasks = s.tasks.filter(t => !(t && t.archived === true));
  });

  step(8, () => {
    if(Array.isArray(s.tasks)){
      s.tasks = s.tasks.map(t => {
        const o = _obj(t);
        return { attachments: [], ...o };
      });
    }
    if(s.cfg && typeof s.cfg === 'object'){
      if(!s.cfg.calMode) s.cfg.calMode = 'month';
      if(!s.cfg.timerDock || typeof s.cfg.timerDock !== 'object') s.cfg.timerDock = {};
    }
  });

  // ── Field-level repair pass — runs on EVERY load regardless of version ──────
  // This is the safety net: even if a migration was skipped or data was
  // partially corrupted, every task comes out with correct types.
  if(Array.isArray(s.tasks)){
    s.tasks = s.tasks.map(_repairTask).filter(Boolean);
  }

  // Only advance the stored version to the highest step that actually ran.
  // This is what lets a flaky migration retry on the next load instead of
  // being permanently skipped.
  s.v = Math.max(v, reached);
  return s;
}

// ── State validation — sanity check after migration ───────────────────────────
function _validateState(s){
  if(!s||typeof s!=='object')         return false;
  if(!Array.isArray(s.tasks))         return false;
  if(typeof s.date !== 'string')      return false;
  return true;
}

/** Load id→ms tombstone maps from persisted state */
function _loadDelMap(obj){
  const out = {};
  if(!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for(const [k, v] of Object.entries(obj)){
    const id = parseInt(k, 10);
    if(!Number.isFinite(id)) continue;
    const n = typeof v === 'number' ? v : NaN;
    if(Number.isFinite(n) && n > 0) out[id] = n;
  }
  return out;
}

// Save — captures task mutations with per-task lastModified stamp for sync
let _prevTaskSnapshot = null; // used to detect which tasks changed since last save

// Deep-clone a task for the change-detection baseline. A shallow {...t} shares
// nested arrays/objects (checklist, completions, sessions, sessionEntries,
// tags, ...) with the live task, so an in-place mutation (e.g. a checklist
// toggle or completions.push) updates BOTH the live task and its own baseline.
// The diff below then sees no change and never bumps lastModified — silently
// losing the edit under last-write-wins sync. JSON round-trip matches the
// comparator's own JSON.stringify semantics exactly.
function _snapshotTask(t){
  try{ return JSON.parse(JSON.stringify(t)); }
  catch(_){ return { ...t }; }
}

function resetTaskSnapshotBaseline(){
  _prevTaskSnapshot = {};
  tasks.forEach(t => { _prevTaskSnapshot[t.id] = _snapshotTask(t); });
}

/** Persist after P2P merge — no lastModified bump, no sync broadcast, merge epoch/nonce. */
function persistAfterSyncMerge(remoteEpoch, remoteNonce){
  const _localEpoch = typeof stateEpoch === 'number' && stateEpoch > 0 ? stateEpoch : 0;
  const _remoteEpoch = typeof remoteEpoch === 'number' && remoteEpoch > 0 ? remoteEpoch : 0;
  const _localNonce = typeof stateNonce === 'number' ? stateNonce : 0;
  const _remoteNonce = typeof remoteNonce === 'number' ? remoteNonce : 0;
  if(_remoteEpoch > 0) stateEpoch = Math.max(_localEpoch, _remoteEpoch);
  if(_remoteEpoch > _localEpoch || (_remoteEpoch === _localEpoch && _remoteEpoch > 0 && _remoteNonce > _localNonce)){
    stateNonce = _remoteNonce;
  }
  resetTaskSnapshotBaseline();
  saveState('sync');
}

/** @param {'auto'|'unload'|'user'|'sync'} [reason] — only 'user' shows the save pill (throttled) */
function saveState(reason){
  if(!reason) reason = 'auto';
  const isSyncMerge = reason === 'sync';
  // H5: any user-attributed save means the in-memory state is live and must
  // not be overwritten by the async IDB recovery path in loadState().
  if(reason === 'user') window._stateDirty = true;
  if(typeof taskSortBy==='string'&&taskSortBy==='order') taskSortBy='manual';
  const _intelEmbedIds = [];
  if(!isSyncMerge){
  // Stamp lastModified on tasks that actually changed since the previous save.
  // This gives sync a reliable "newer wins" comparator without touching every
  // mutation site manually.
  const prev = _prevTaskSnapshot || {};
  tasks.forEach(t => {
    const p = prev[t.id];
    if (!p) {
      // Brand new task
      t.lastModified = t.lastModified || Date.now();
      _intelEmbedIds.push(t.id);
    } else {
      // Cheap comparator — any field difference = changed
      const fieldsToCompare = ['name','status','priority','dueDate','startDate','description','tags',
        'starred','archived','completedAt','effort','energyLevel','category',
        'valuesAlignment','parentId','listId','url','estimateMin','recur','remindAt','type','blockedBy',
        'relatedTo','attachments',
        'completions','habitLastRecordedTotalSec',
        'totalSec','sessions','sessionEntries','checklist','notes','_ext'];
      let changed = false;
      for (const f of fieldsToCompare){
        const a = JSON.stringify(t[f]);
        const b = JSON.stringify(p[f]);
        if (a !== b) { changed = true; break; }
      }
      if (changed){
        t.lastModified = Date.now();
        _intelEmbedIds.push(t.id);
      }
    }
  });
  }
  // Rebuild snapshot for next diff
  _prevTaskSnapshot = {};
  tasks.forEach(t => { _prevTaskSnapshot[t.id] = _snapshotTask(t); });

  let taskSnap = tasks.map(t=>({...t}));
  if(activeTaskId && taskStartedAt){
    const t = taskSnap.find(x=>x.id===activeTaskId);
    if(t) t.totalSec += Math.floor((Date.now()-taskStartedAt)/1000);
  }
  if(!isSyncMerge){
    stateEpoch = Date.now();
    stateNonce = _STATE_TAB_NONCE;
  }
  // Pomodoro live-state snapshot. Persisting these lets a tab-reload mid-focus
  // pick up where it left off (wall-clock based) instead of resetting to a
  // fresh 25:00 — losing minutes the user just earned. Mirrors the quick-timer
  // rehydration in _applyState. taskStartedAt is folded into the active task's
  // totalSec on save so it never compounds; on load it stays null until the
  // user resumes the timer.
  const _pomoLive = {
    running, finished,
    startedAt, pausedRemaining, remaining, totalDuration,
    pomoSavedAt: Date.now(),
  };
  const state = {
    v:SCHEMA_VERSION, date:todayKey(),
    cfg, goals, goalIdCtr,
    tasks:taskSnap, taskIdCtr, activeTaskId,
    timeLog,logIdCtr,
    totalPomos, totalBreaks, totalFocusSec, sessionHistory,
    pomosInCycle, phase,
    pomoLive: _pomoLive,
    intervals, intIdCtr,
    quickTimers, qtIdCtr,
    activeTab,
    lists, listIdCtr, activeListId, showAllLists,
    taskView, taskSortBy, smartView, smartViewsExpanded, taskGroupBy, theme, collapsedSections,
    taskFiltersSnapshot: (function(){
      const ts = gid('taskSearch'), st = gid('filterStatus'), pr = gid('filterPriority'), cat = gid('filterCategory'), sem = gid('taskSearchSemantic');
      return {
        search: ts ? ts.value : '',
        status: st ? st.value : 'all',
        priority: pr ? pr.value : 'all',
        category: cat ? cat.value : 'all',
        taskSearchSemantic: sem ? !!sem.checked : false,
      };
    })(),
    syncTaskDels: { ...syncTaskDels },
    syncListDels: { ...syncListDels },
    syncGoalDels: { ...syncGoalDels },
    stateEpoch,
    stateNonce,
  };
  let serialized;
  try {
    serialized = JSON.stringify(state);
  } catch (serErr) {
    // Circular reference, BigInt, or exotic value — skip LS cache but still
    // attempt IDB (structured clone is more forgiving than JSON.stringify).
    console.error('[storage] JSON.stringify failed — skipping localStorage, attempting IDB', serErr);
    _idbSet(STORE_KEY, state);
    return;
  }

  // ── IDB-first persistence (M2) ──────────────────────────────────────────────
  // IndexedDB is the primary store — its quota is orders of magnitude larger
  // than localStorage (hundreds of MB vs 5-10 MB).  We write here first so
  // even if the LS fast-path cache below hits QuotaExceededError, the user's
  // data is safe in IDB and will be recovered on the next loadState().
  _idbSet(STORE_KEY, serialized);

  // localStorage is kept as a synchronous fast-path cache and for cross-tab
  // `storage` event notifications.  Quota failures are non-fatal.
  try{
    localStorage.setItem(STORE_KEY, serialized);
    window._saveError = null;
    window._lastSaveAt = Date.now();
  }catch(e){
    // QuotaExceededError — warn user but their data IS safe in IDB.
    window._saveError = e.name || 'save-failed';
    // Suppress the banner for the rest of the session once dismissed. The
    // previous 2-second throttle only debounced creation, so the next
    // saveState (often within seconds) re-spawned it \u2014 read as broken.
    // _quotaBannerDismissed clears on a successful localStorage write below,
    // so the banner can re-appear if storage frees up and re-fills later.
    if(!window._quotaBannerDismissed && !document.getElementById('quotaWarning')){
      const w = document.createElement('div');
      w.id = 'quotaWarning';
      w.className = 'quota-warning';
      const warnIc = (window.icon && window.icon('alertTriangle', {size:14})) || '';
      const msg = document.createElement('span');msg.className='quota-warning-msg';
      if(warnIc){const tmp=document.createElement('span');tmp.innerHTML=warnIc;while(tmp.firstChild)msg.appendChild(tmp.firstChild)}
      // Reassuring tone \u2014 IndexedDB already absorbed the write, the localStorage
       // mirror just overflowed. Without this framing the banner reads like data
       // loss when nothing has actually been lost (#30 in UX audit).
      const msgTxt=document.createElement('span');msgTxt.textContent='Note: your data is safe \u2014 IndexedDB has it. The localStorage mirror is full; back up when convenient.';msg.appendChild(msgTxt);
      w.appendChild(msg);
      const dismissBtn=document.createElement('button');dismissBtn.type='button';dismissBtn.textContent='Dismiss';
      dismissBtn.onclick=function(){
        window._quotaBannerDismissed = true;
        const el = document.getElementById('quotaWarning'); if(el) el.remove();
      };
      w.appendChild(dismissBtn);
      const backupBtn=document.createElement('button');backupBtn.type='button';backupBtn.textContent='Backup now';
      backupBtn.onclick=function(){
        window._quotaBannerDismissed = true;
        exportData();
        const el = document.getElementById('quotaWarning'); if(el) el.remove();
      };
      w.appendChild(backupBtn);
      document.body.appendChild(w);
    }
  }
  // Clear the dismiss flag when localStorage succeeds again \u2014 lets the
  // banner re-appear if storage frees up and then re-fills later in the
  // session. Without this, a one-time dismissal silences quota warnings
  // until the user reloads.
  if(window._saveError === null && window._quotaBannerDismissed){
    window._quotaBannerDismissed = false;
  }
  if(!isSyncMerge && typeof syncBroadcast==='function') syncBroadcast();
  if(reason === 'user') showSaveIndicator();

  queueMicrotask(() => {
    _queueEmbedEnsure(_intelEmbedIds);
    // Probe storage usage every ~50 saves so the user gets a heads-up
    // *before* QuotaExceededError actually fires. The reactive banner
    // above only kicks in once writes are already failing.
    _maybeCheckStorageQuota();
  });
}

// ── Proactive storage quota probe ─────────────────────────────────────────
// We sample navigator.storage.estimate() on a low cadence (every ~50 saves)
// to avoid spamming the API. When usage crosses 80% of quota a warning
// banner appears with Export + Archive options. The banner is one-shot per
// session — once dismissed it won't re-appear unless usage worsens.
let _quotaProbeCounter = 0;
let _lastQuotaProbeAt = 0;
let _proactiveQuotaShownPct = 0;
function _maybeCheckStorageQuota(){
  if(typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.estimate) return;
  _quotaProbeCounter += 1;
  // Probe at most every 50 saves AND no more than once every 60s — saves
  // can fire rapidly during a sync burst and we don't need millisecond
  // precision on a long-cycle warning.
  if(_quotaProbeCounter % 50 !== 0) return;
  const now = Date.now();
  if(now - _lastQuotaProbeAt < 60_000) return;
  _lastQuotaProbeAt = now;
  navigator.storage.estimate().then(est => {
    if(!est || !est.quota || !est.usage) return;
    const pct = Math.round((est.usage / est.quota) * 100);
    // Only re-show if usage has *grown* past a new 5-pct bucket since the
    // last warning. Prevents reopening the banner the user just dismissed.
    if(pct < 80) return;
    if(pct < _proactiveQuotaShownPct + 5) return;
    _proactiveQuotaShownPct = pct;
    _renderProactiveQuotaBanner(pct, est.usage, est.quota);
  }).catch(() => { /* permission/api missing — silent */ });
}
function _renderProactiveQuotaBanner(pct, usage, quota){
  if(typeof document === 'undefined' || !document.body) return;
  const old = document.getElementById('proactiveQuotaBanner');
  if(old) old.remove();
  const fmt = bytes => {
    if(bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
    if(bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
    if(bytes >= 1e3) return Math.round(bytes / 1e3) + ' KB';
    return bytes + ' B';
  };
  const w = document.createElement('div');
  w.id = 'proactiveQuotaBanner';
  w.className = 'quota-warning quota-warning--proactive';
  const msg = document.createElement('span');
  msg.className = 'quota-warning-msg';
  msg.textContent = `⚠ Storage at ${pct}% (${fmt(usage)} of ${fmt(quota)}). Export a backup or clear old archived days before writes start failing.`;
  w.appendChild(msg);
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.textContent = 'Export backup';
  exportBtn.onclick = () => { try{ exportData(); }catch(e){} };
  w.appendChild(exportBtn);
  const archiveBtn = document.createElement('button');
  archiveBtn.type = 'button';
  archiveBtn.textContent = 'Open archive';
  archiveBtn.onclick = () => {
    if(typeof setTab === 'function') setTab('data');
    w.remove();
  };
  w.appendChild(archiveBtn);
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = 'Dismiss';
  dismiss.onclick = () => w.remove();
  w.appendChild(dismiss);
  document.body.appendChild(w);
}
if(typeof window !== 'undefined') window._maybeCheckStorageQuota = _maybeCheckStorageQuota;

let _embedEnsureIds=new Set();
let _embedEnsureT=null;
let _embedEnsureRunning=false;
async function _flushEmbedEnsure(){
  _embedEnsureT=null;
  if(_embedEnsureRunning) return; // another flush is mid-loop; new ids stay queued
  if(typeof embedStore === 'undefined' || !embedStore || !embedStore.ensure) return;
  const ids=[..._embedEnsureIds];
  _embedEnsureIds.clear();
  if(!ids.length){
    if(typeof scheduleIntelDupRefresh==='function') scheduleIntelDupRefresh();
    return;
  }
  // Process ensures one at a time with a yield between each. Firing them
  // concurrently (the old forEach pattern) doesn't actually parallelize the
  // work — the WASM embedding model is a single instance that serializes
  // calls internally — but it does pin the main thread for the entire
  // batch, which read as a UI freeze right after a bulk paste / multi-task
  // save. Yielding via setTimeout(0) lets the browser paint between items.
  _embedEnsureRunning = true;
  try {
    for(const id of ids){
      const t = typeof findTask === 'function' ? findTask(id) : null;
      if(!t) continue;
      try { await embedStore.ensure(t); } catch(_){}
      await new Promise(r => setTimeout(r, 0));
    }
  } finally {
    _embedEnsureRunning = false;
  }
  if(typeof scheduleIntelDupRefresh==='function') scheduleIntelDupRefresh();
  // If new ids landed during the run, drain them on the next tick.
  if(_embedEnsureIds.size && !_embedEnsureT){
    _embedEnsureT = setTimeout(_flushEmbedEnsure, 250);
  }
}
function _queueEmbedEnsure(ids){
  if(!ids||!ids.length) return;
  ids.forEach(id=>_embedEnsureIds.add(id));
  if(_embedEnsureT) return;
  _embedEnsureT=setTimeout(_flushEmbedEnsure,250);
}

// ── Apply validated+migrated state to live variables ─────────────────────────
function _applyState(s){
  try{
    s = migrateState(s);
    if(!_validateState(s)) return false;

    // Day rollover — archive yesterday's daily counters, but preserve
    // long-lived user data (tasks, lists, goals, cfg, etc.) across days.
    // Only the per-day metrics reset; archiveDay dedupes by date so it's
    // safe if this runs again on reload.
    if(s.date !== todayKey()){
      archiveDay(s);
      s.date          = todayKey();
      s.totalPomos    = 0;
      s.totalBreaks   = 0;
      s.totalFocusSec = 0;
      s.pomosInCycle  = 0;
      s.sessionHistory = [];
      s.timeLog       = [];
      // Fall through and apply the rest of the state normally.
    }

    // Config — repair individual values defensively
    if(s.cfg && typeof s.cfg==='object'){
      cfg = s.cfg;
      if(!cfg.timerSub) cfg.timerSub='pomo';
      if(!cfg.calMode) cfg.calMode='month';
      if(!cfg.timerDock || typeof cfg.timerDock!=='object') cfg.timerDock={};
      if(typeof cfg.hideHabitsInMainViews!=='boolean') cfg.hideHabitsInMainViews=true;
      if(typeof ensureClassificationConfig === 'function') ensureClassificationConfig(cfg);
      const hh=gid('hideHabitsInMain'); if(hh) hh.checked=!!cfg.hideHabitsInMainViews;
      const cw=gid('cfgWork'); if(cw) cw.value = _int(cfg.work,25);
      const cs=gid('cfgShort');if(cs) cs.value = _int(cfg.short,5);
      const cl=gid('cfgLong'); if(cl) cl.value = _int(cfg.long,15);
      const cc=gid('cfgCycle');if(cc) cc.value = _int(cfg.cycle,4);
      setToggle('togBreak', _bool(cfg.autoBreak,true));
      setToggle('togWork',  _bool(cfg.autoWork,false));
      setToggle('togSound', _bool(cfg.sound,true));
      setToggle('togLink',  _bool(cfg.linkTask,true));
      setToggle('togNotif', cfg.notif!==false);
      // Surface OS-level permission status next to the toggle so users can see
      // when iOS/denied state is the actual blocker, not their toggle setting.
      if(typeof renderNotifStatus === 'function') renderNotifStatus();
      setToggle('togSnpNote', cfg.askSessionNote!==false);
      // G-16: restore phase-preset dropdown selection
      const cp=gid('cfgPreset'); if(cp && typeof cfg.phasePreset==='string') cp.value=cfg.phasePreset;
      // G-7: restore focus-list-mode body class so the saved layout matches
      if(cfg.focusListMode){ try{ document.body.classList.add('app-focus-list'); }catch(_){}}
    } else if(typeof ensureClassificationConfig === 'function'){
      ensureClassificationConfig(cfg);
    }

    // Goals
    if(Array.isArray(s.goals)){
      goals     = s.goals.filter(g=>g&&typeof g==='object'&&g.text).map(g=>({
        ...g,
        lastModified: typeof g.lastModified === 'number' && g.lastModified > 0 ? g.lastModified : 0,
      }));
      goalIdCtr = _int(s.goalIdCtr, goals.length);
    }

    // Tasks — already repaired in migrateState
    if(Array.isArray(s.tasks)){
      tasks     = s.tasks;
      taskIdCtr = _int(s.taskIdCtr, 0);
      // Restore the active-task linkage if the saved id still resolves to a
      // real task. Without this, mobile tab-discard (common on iOS Safari /
      // low-RAM Android after minimizing) silently drops the tracking
      // indicator on reload — the user sees their "currently tracking" task
      // disappear even though the elapsed time was already folded into the
      // task's totalSec at save. taskStartedAt stays null because we don't
      // auto-resume the timer; the user resumes via Start/Resume which will
      // re-anchor it.
      const savedActive = (typeof s.activeTaskId === 'number' || typeof s.activeTaskId === 'string') ? s.activeTaskId : null;
      activeTaskId  = savedActive && tasks.some(t => t && t.id === savedActive) ? savedActive : null;
      taskStartedAt = null;
      // Seed the change-detection snapshot so the first post-load save
      // doesn't treat every existing task as "just modified" — which would
      // (a) spuriously bump every task's lastModified (breaking sync
      // last-write-wins across devices) and (b) re-embed every task for
      // semantic search on every page refresh.
      _prevTaskSnapshot = {};
      tasks.forEach(t => { _prevTaskSnapshot[t.id] = _snapshotTask(t); });
      if(typeof rebuildTaskIdIndex === 'function') rebuildTaskIdIndex();
      if(typeof repairOrphanedTaskParents === 'function') repairOrphanedTaskParents();
      if(typeof reseedChecklistAndNoteIdCtrs === 'function') reseedChecklistAndNoteIdCtrs();
    }

    // Lists
    if(Array.isArray(s.lists)){
      lists       = s.lists.filter(l=>l&&l.id&&l.name).map(l=>({
        id: l.id,
        name: l.name,
        color: l.color || '#1a8cff',
        description: typeof l.description==='string' ? l.description : '',
        lastModified: typeof l.lastModified === 'number' && l.lastModified > 0 ? l.lastModified : 0,
      }));
      listIdCtr   = _int(s.listIdCtr, 0);
      activeListId = s.activeListId ?? null;
      showAllLists = s.showAllLists === true;
    }

    // Scalars with enum validation
    const validViews = ['list','board','calendar'];
    // Sort/group use `due` to match index.html + tasks.js (legacy state may have dueDate)
    let sortIn = s.taskSortBy;
    if(sortIn === 'dueDate') sortIn = 'due';
    if(sortIn === 'order') sortIn = 'manual';
    let groupIn = s.taskGroupBy;
    if(groupIn === 'dueDate') groupIn = 'due';
    const validSorts = ['smart','manual','priority','due','name','created','recent','updated','time','impact'];
    const validSmart = ['all','today','week','overdue','unscheduled','starred','impact','habits','completed'];
    const validGroup = ['none','priority','status','due','list'];
    if(s.taskView   && validViews.includes(s.taskView))  taskView   = s.taskView;
    if(sortIn && validSorts.includes(sortIn)) taskSortBy = sortIn;
    if(s.smartView  && validSmart.includes(s.smartView)) smartView  = s.smartView;
    if(typeof s.smartViewsExpanded === 'boolean') smartViewsExpanded = s.smartViewsExpanded;
    if(groupIn && validGroup.includes(groupIn)) taskGroupBy = groupIn;
    if(s.theme      && ['dark','light'].includes(s.theme)) theme = s.theme;
    if(s.collapsedSections && typeof s.collapsedSections==='object') collapsedSections = s.collapsedSections;

    if(s.taskFiltersSnapshot && typeof s.taskFiltersSnapshot === 'object'){
      const fs = s.taskFiltersSnapshot;
      const vis = gid('taskSearch');
      if(vis && fs.search != null) vis.value = String(fs.search);
      const st = gid('filterStatus');
      if(st && fs.status && ['all','active','open','progress','review','blocked','done'].includes(fs.status)) st.value = fs.status;
      const pr = gid('filterPriority');
      if(pr && fs.priority && ['all','urgent','high','normal','low','none'].includes(fs.priority)) pr.value = fs.priority;
      const cat = gid('filterCategory');
      if(cat && fs.category) cat.value = fs.category;
      const sem = gid('taskSearchSemantic');
      if(sem && typeof fs.taskSearchSemantic === 'boolean') sem.checked = fs.taskSearchSemantic;
      taskFilters.search = (vis && vis.value ? vis.value : '').toLowerCase().trim();
      if(st) taskFilters.status = st.value;
      if(pr) taskFilters.priority = pr.value;
      if(cat) taskFilters.category = cat.value;
    }

    // Numerics
    if(Array.isArray(s.timeLog))     timeLog       = s.timeLog;
    if(s.totalPomos   !=null)        totalPomos    = _int(s.totalPomos,0);
    if(s.totalBreaks  !=null)        totalBreaks   = _int(s.totalBreaks,0);
    if(s.totalFocusSec!=null)        totalFocusSec = _int(s.totalFocusSec,0);
    if(Array.isArray(s.sessionHistory)) sessionHistory = s.sessionHistory;
    if(s.pomosInCycle !=null)        pomosInCycle  = _int(s.pomosInCycle,0);
    if(s.phase && ['work','short','long'].includes(s.phase)) phase = s.phase;

    // Pomodoro live-state rehydration. Without this, app.js's post-load
    // `setPhaseTime()` clobbers any saved progress back to a full phase.
    // We compute remaining from wall-clock for a running timer and let
    // app.js complete the rehydration (restart tick, fire completion if
    // the phase would have ended while the tab was closed).
    if(s.pomoLive && typeof s.pomoLive === 'object'){
      const p = s.pomoLive;
      const td = _int(p.totalDuration, 0);
      if(td > 0){
        totalDuration = td;
        if(p.running && typeof p.startedAt === 'number' && p.startedAt > 0){
          const pr = _int(p.pausedRemaining, td);
          const elapsed = Math.max(0, Math.floor((Date.now() - p.startedAt) / 1000));
          const rem = Math.max(0, pr - elapsed);
          pausedRemaining = pr;
          remaining = rem;
          startedAt = p.startedAt;
          running = rem > 0;
          finished = rem <= 0;
          // Distinguish "phase completed while tab was closed" (we owe the user
          // pip + log + auto-advance) from "phase completed normally before
          // save, then reload" (bookkeeping already in saved state). The flag
          // only fires the catch-up completion when the saved state was still
          // running at save time but would have ended since.
          window._timerNeedsCompletion = rem <= 0;
        } else {
          pausedRemaining = _int(p.pausedRemaining, td);
          remaining = _int(p.remaining, pausedRemaining);
          if(remaining < 0) remaining = 0;
          if(remaining > td) remaining = td;
          running = false;
          finished = !!p.finished && remaining <= 0;
          startedAt = 0;
          window._timerNeedsCompletion = false;
        }
        window._timerStateRehydrated = true;
      }
    }

    // Intervals + quick timers
    if(Array.isArray(s.intervals)){  intervals = s.intervals.map(iv=>({...iv, target: iv.target || 'pomo'})); intIdCtr = _int(s.intIdCtr,0); }
    if(Array.isArray(s.quickTimers)){
      quickTimers = s.quickTimers; qtIdCtr = _int(s.qtIdCtr,0);
      quickTimers.forEach(qt=>{
        if(qt.running && qt.startedAt){
          const elapsed = Math.floor((Date.now()-qt.startedAt)/1000);
          const rem     = Math.max(0, _int(qt.pausedRem,0)-elapsed);
          if(rem<=0){ qt.running=false; qt.finished=true; qt.remaining=0; qt.pausedRem=0; }
          else qt.remaining = rem;
        } else if(qt.running && !qt.startedAt){
          qt.running = false;
        }
      });
    }

    if(s.activeTab && VALID_MAIN_TABS.includes(s.activeTab)) activeTab = s.activeTab;

    syncTaskDels = _loadDelMap(s.syncTaskDels);
    syncListDels = _loadDelMap(s.syncListDels);
    syncGoalDels = _loadDelMap(s.syncGoalDels);
    if(typeof s.stateEpoch === 'number' && s.stateEpoch > 0) stateEpoch = s.stateEpoch;
    if(typeof s.stateNonce === 'number') stateNonce = s.stateNonce;

    return true;
  }catch(e){
    console.error('[storage] _applyState error:',e);
    return false;
  }
}

function _taskImportRelevanceMs(task){
  if(!task) return 0;
  if(typeof task.lastModified === 'number' && task.lastModified > 0) return task.lastModified;
  const c = task.created;
  if(!c) return 0;
  const p = Date.parse(String(c));
  return Number.isFinite(p) ? p : 0;
}

function _taskLwwMs(t){
  if(!t) return 0;
  if(typeof t.lastModified === 'number' && t.lastModified > 0) return t.lastModified;
  const ca = t.completedAt ? Date.parse(String(t.completedAt)) : NaN;
  if(Number.isFinite(ca)) return ca;
  return _taskImportRelevanceMs(t);
}

function _mergeTimeLogById(a, b){
  const m = new Map();
  for(const l of a || []){ if(l && l.id != null) m.set(l.id, l); }
  for(const l of b || []){ if(l && l.id != null) m.set(l.id, l); }
  return Array.from(m.values());
}

function _mergeIntervalsById(a, b){
  const m = new Map();
  const norm = x => ({...x, target: x.target || 'pomo'});
  for(const x of a || []){ if(x && x.id != null) m.set(x.id, norm(x)); }
  for(const x of b || []){ if(x && x.id != null) m.set(x.id, norm(x)); }
  return Array.from(m.values());
}

function _mergeSessionHistTail(a, b, maxLen){
  const cap = typeof maxLen === 'number' && maxLen > 0 ? maxLen : 400;
  const out = [...(a || []), ...(b || [])];
  return out.length > cap ? out.slice(-cap) : out;
}

function _mergeDelPair(loc, rem){
  const o = { ...loc };
  if(!rem || typeof rem !== 'object' || Array.isArray(rem)) return o;
  for(const [k, v] of Object.entries(rem)){
    const id = parseInt(k, 10);
    if(!Number.isFinite(id)) continue;
    const rv = typeof v === 'number' && v > 0 ? v : 0;
    if(o[id] == null) o[id] = rv;
    else o[id] = Math.max(o[id], rv);
  }
  return o;
}

/**
 * When another tab persists newer state and this tab has unsaved user edits,
 * merge by last-write-wins on entities (tasks/lists/goals) and union logs.
 */
function _mergeRemoteStateLww(raw){
  try{
    const r = migrateState(JSON.parse(JSON.stringify(raw)));
    if(!_validateState(r)) return false;

    // Merge deletion tombstones FIRST so the entity merges below can honour
    // them. Without this, a task/list/goal deleted in another tab resurrects
    // here whenever this tab has unsaved edits — and can then propagate the
    // zombie back out. Mirrors the P2P path in sync.js _mergeState.
    const mergedTaskDels = _mergeDelPair(typeof syncTaskDels === 'object' && syncTaskDels ? syncTaskDels : {}, r.syncTaskDels);
    const mergedListDels = _mergeDelPair(typeof syncListDels === 'object' && syncListDels ? syncListDels : {}, r.syncListDels);
    const mergedGoalDels = _mergeDelPair(typeof syncGoalDels === 'object' && syncGoalDels ? syncGoalDels : {}, r.syncGoalDels);

    const taskMap = new Map(tasks.map(t => [t.id, t]));
    // Drop local tasks a newer tombstone deletes.
    for(const [id, t] of [...taskMap.entries()]){
      const d = mergedTaskDels[id];
      if(d != null && d > _taskLwwMs(t)) taskMap.delete(id);
    }
    for(const rt of (r.tasks || [])){
      if(!rt) continue;
      const d = mergedTaskDels[rt.id];
      if(d != null && d > _taskLwwMs(rt)) continue; // incoming task is tombstoned
      const lt = taskMap.get(rt.id);
      if(!lt) taskMap.set(rt.id, rt);
      else if(_taskLwwMs(rt) > _taskLwwMs(lt)) taskMap.set(rt.id, rt);
    }
    tasks = Array.from(taskMap.values());
    taskIdCtr = Math.max(taskIdCtr, _int(r.taskIdCtr, 0));

    const listMap = new Map(lists.map(l => [l.id, l]));
    for(const [id, l] of [...listMap.entries()]){
      const d = mergedListDels[id];
      if(d != null && d > (l.lastModified || 0)) listMap.delete(id);
    }
    for(const rl of (r.lists || [])){
      if(!rl || rl.id == null) continue;
      const d = mergedListDels[rl.id];
      if(d != null && d > (rl.lastModified || 0)) continue;
      const ex = listMap.get(rl.id);
      if(!ex) listMap.set(rl.id, rl);
      else if((rl.lastModified || 0) > (ex.lastModified || 0)) listMap.set(rl.id, rl);
    }
    lists = Array.from(listMap.values());
    listIdCtr = Math.max(listIdCtr, _int(r.listIdCtr, 0));

    const goalMap = new Map(goals.map(g => [g.id, g]));
    for(const [id, g] of [...goalMap.entries()]){
      const d = mergedGoalDels[id];
      if(d != null && d > (g.lastModified || 0)) goalMap.delete(id);
    }
    for(const rg of (r.goals || [])){
      if(!rg || rg.id == null) continue;
      const d = mergedGoalDels[rg.id];
      if(d != null && d > (rg.lastModified || 0)) continue;
      const ex = goalMap.get(rg.id);
      if(!ex) goalMap.set(rg.id, rg);
      else if((rg.lastModified || 0) > (ex.lastModified || 0)) goalMap.set(rg.id, rg);
    }
    goals = Array.from(goalMap.values());
    goalIdCtr = Math.max(goalIdCtr, _int(r.goalIdCtr, 0));

    timeLog = _mergeTimeLogById(timeLog, r.timeLog);
    sessionHistory = _mergeSessionHistTail(sessionHistory, r.sessionHistory, 400);
    intervals = _mergeIntervalsById(intervals, r.intervals);

    syncTaskDels = mergedTaskDels;
    syncListDels = mergedListDels;
    syncGoalDels = mergedGoalDels;

    // LWW for stat counters and the cycle counter: take incoming only when remote
    // stateEpoch is newer. Math.max here would inflate counters and (worse) break
    // the long-break cadence when pomosInCycle gets stuck above cfg.cycle.
    const _localEpoch = typeof stateEpoch === 'number' && stateEpoch > 0 ? stateEpoch : 0;
    const _remoteEpoch = typeof r.stateEpoch === 'number' && r.stateEpoch > 0 ? r.stateEpoch : 0;
    const _localNonce = typeof stateNonce === 'number' ? stateNonce : 0;
    const _remoteNonce = typeof r.stateNonce === 'number' ? r.stateNonce : 0;
    const _takeRemote = _remoteEpoch > _localEpoch ||
      (_remoteEpoch === _localEpoch && _remoteEpoch > 0 && _remoteNonce > _localNonce);
    if(_takeRemote){
      totalPomos    = _int(r.totalPomos,    totalPomos);
      totalBreaks   = _int(r.totalBreaks,   totalBreaks);
      totalFocusSec = _int(r.totalFocusSec, totalFocusSec);
      pomosInCycle  = _int(r.pomosInCycle,  pomosInCycle);
    }
    // Id allocators must monotonically grow regardless of epoch — otherwise a tab
    // could re-allocate an id that already exists elsewhere.
    logIdCtr       = Math.max(logIdCtr, _int(r.logIdCtr, 0));
    intIdCtr       = Math.max(intIdCtr, _int(r.intIdCtr, 0));
    if(_remoteEpoch > 0)
      stateEpoch = Math.max(_localEpoch, _remoteEpoch);
    if(typeof rebuildTaskIdIndex === 'function') rebuildTaskIdIndex();
    if(typeof repairOrphanedTaskParents === 'function') repairOrphanedTaskParents();
    if(activeTaskId && typeof findTask === 'function' && !findTask(activeTaskId)) activeTaskId = null;
    return true;
  }catch(e){
    console.warn('[storage] _mergeRemoteStateLww', e);
    return false;
  }
}

function _onStorageFromOtherTab(e){
  if(e.key !== STORE_KEY || typeof e.newValue !== 'string') return;
  if(!e.newValue) return;
  let remote;
  try{ remote = JSON.parse(e.newValue); }
  catch(err){ return; }
  if(!remote || typeof remote !== 'object') return;
  const re = typeof remote.stateEpoch === 'number' && remote.stateEpoch > 0 ? remote.stateEpoch : 0;
  const le = typeof stateEpoch === 'number' && stateEpoch > 0 ? stateEpoch : 0;
  // Nonce tiebreaker — two tabs can publish the same Date.now() ms, and
  // without this the second write was silently skipped. Treat remote as
  // newer when epochs match AND remote nonce is higher.
  const rn = typeof remote.stateNonce === 'number' ? remote.stateNonce : 0;
  const ln = typeof stateNonce === 'number' ? stateNonce : 0;
  const dirty = !!window._stateDirty;
  if(!dirty && re <= le && !(re === le && re > 0 && rn > ln)) return;
  if(dirty && re <= 0) return;
  let ok;
  if(dirty) ok = _mergeRemoteStateLww(remote);
  else ok = _applyState(remote);
  if(!ok) return;
  if(typeof queueAutoSave === 'function') queueAutoSave();
  if(dirty && typeof showExportToast === 'function'){
    const now = Date.now();
    if(now - (window._lastCrossTabMergeToast | 0) > 20_000){
      window._lastCrossTabMergeToast = now;
      showExportToast('Merged updates from another tab');
    }
  }
  resetTaskSnapshotBaseline();
  if(typeof requestAnimationFrame === 'function'){
    requestAnimationFrame(() => {
      if(typeof renderAll === 'function') renderAll();
      if(typeof renderLog === 'function') renderLog();
      if(typeof renderStats === 'function') renderStats();
      if(typeof renderArchive === 'function') renderArchive();
      if(typeof renderGoalList === 'function') renderGoalList();
      if(typeof updateMiniTimer === 'function') updateMiniTimer();
    });
  } else {
    if(typeof renderAll === 'function') renderAll();
    if(typeof renderLog === 'function') renderLog();
    if(typeof renderStats === 'function') renderStats();
  }
}

// ── Load — with multi-layer fallback ─────────────────────────────────────────
// Priority: localStorage (sync fast-path cache) → IDB (primary store) → clean start.
// Under the IDB-first model (M2), saveState() always writes IDB first and
// localStorage second.  If LS has stale data or hit quota, IDB is
// authoritative and will restore via the async fallback below.
function loadState(){
  // Try localStorage first — synchronous, fast.
  try{
    const raw = localStorage.getItem(STORE_KEY);
    if(raw){
      const s = JSON.parse(raw);
      const ok = _applyState(s);
      if(ok) return true;
    }
  }catch(e){ console.warn('[storage] localStorage load failed:',e); }

  // Async IDB fallback — if localStorage was empty or corrupt.
  // H5: the promise below resolves *after* the app has already initialized with
  // defaults, which means the user may have typed a task or tweaked settings
  // in the meantime. We must NEVER blindly replace live state. Only restore
  // when every user-writeable store is still at its pristine default.
  const _idbInd = document.getElementById('saveInd');
  if(_idbInd){ _idbInd.textContent = 'restoring\u2026'; _idbInd.style.opacity = '1'; }
  _idbGet(STORE_KEY).then(raw=>{
    if(_idbInd){ _idbInd.textContent = 'saved'; _idbInd.style.opacity = ''; }
    if(!raw) return;
    try{
      if(!_isStatePristine()){
        const msg = 'Backup found in IndexedDB but local data has diverged \u2014 kept current data.';
        if(typeof showExportToast === 'function') showExportToast(msg);
        console.warn('[storage]', msg);
        return;
      }
      // Normally the IDB value is the same serialized string we write. But the
      // JSON.stringify-failure path stores the raw object via structured clone
      // (more forgiving than JSON for circular refs / exotic values), so a
      // blind JSON.parse here would throw on exactly the recovery it exists for.
      const s = (typeof raw === 'string') ? JSON.parse(raw) : raw;
      if(_applyState(s)){
        renderAll(); renderLog(); renderGoalList();
        renderIntList(); renderQuickTimers();
        applyTheme(); setTaskView(taskView); setSmartView(smartView);
        if(activeTab==='focus'&&typeof setTimerSub==='function') setTimerSub(cfg.timerSub||'pomo');
        if(typeof syncQaHintVisibility==='function') syncQaHintVisibility();
        console.info('[storage] Recovered from IDB backup');
        if(typeof showExportToast === 'function') showExportToast('Restored from backup');
      }
    }catch(e){ console.warn('[storage] IDB fallback failed:',e); }
  }).catch(()=>{
    if(_idbInd){ _idbInd.textContent = 'saved'; _idbInd.style.opacity = ''; }
  });

  return false;
}

/** True when the in-memory state is still the post-boot defaults — i.e. the
 *  user has not typed, edited, or saved anything since this session started.
 *  Combines an explicit dirty flag (set by any `saveState('user')`) with a
 *  belt-and-suspenders check against the user-writeable stores. */
function _isStatePristine(){
  try{
    if(window._stateDirty) return false;
    if(Array.isArray(tasks)      && tasks.length)      return false;
    if(Array.isArray(goals)      && goals.length)      return false;
    if(Array.isArray(timeLog)    && timeLog.length)    return false;
    if(Array.isArray(quickTimers)&& quickTimers.length)return false;
    return true;
  }catch(e){ return false; }
}

// ── Data export / import (manual backup) ─────────────────────────────────────
function _triggerExportDownload(raw, archive){
  const blob = new Blob([JSON.stringify({export:raw,archive,exportedAt:new Date().toISOString()},null,2)],{type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const fname = 'odtaulai-full-backup-'+todayKey()+'.json';
  a.download = fname;
  a.click(); URL.revokeObjectURL(a.href);
  if(typeof showExportToast === 'function') showExportToast('Exported full backup — '+fname);
}
function exportData(){
  // (M2) Prefer IDB as the authoritative source.  Fall back to localStorage
  // if IDB is unavailable (private browsing) or the read fails.
  _idbGet(STORE_KEY).then(idbRaw => {
    const raw = idbRaw || localStorage.getItem(STORE_KEY);
    const archive = localStorage.getItem(ARCHIVE_KEY);
    _triggerExportDownload(raw, archive);
  }).catch(() => {
    const raw = localStorage.getItem(STORE_KEY);
    const archive = localStorage.getItem(ARCHIVE_KEY);
    _triggerExportDownload(raw, archive);
  });
}

// Backups bigger than this aren't worth even trying — the JSON.parse runs
// synchronously on the main thread and chokes the tab. Real backups for
// even multi-year heavy use stay well under this; anything bigger is more
// likely a wrong-file mis-tap or a corrupted export.
const _IMPORT_MAX_BYTES = 20 * 1024 * 1024;
function importData(file){
  if(!file) return;
  if(typeof file.size === 'number' && file.size > _IMPORT_MAX_BYTES){
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    const max = (_IMPORT_MAX_BYTES / (1024 * 1024)).toFixed(0);
    alert('Backup file is ' + mb + ' MB — that exceeds the ' + max + ' MB cap. ' +
          'A real Odta backup is much smaller; check this is the right file, ' +
          'or split a giant archive into chunks before importing.');
    return;
  }
  const reader = new FileReader();
  reader.onload = async e=>{
    try{
      const wrapper = JSON.parse(e.target.result);
      // Support both raw state JSON and wrapped export format
      const raw  = wrapper.export || e.target.result;
      const arch = wrapper.archive;
      const s    = JSON.parse(raw);
      if(!s||!Array.isArray(s.tasks)) throw new Error('Invalid backup file');
      // Dry-run preview: show counts before replacing live state. Import was
      // a destructive wholesale-replace with a single alert at the end —
      // users had no way to confirm what would land, and one wrong file
      // wiped tasks silently. _summarizeImport returns the counts for both
      // sides so showImportConfirm can render a side-by-side delta.
      const summary = _summarizeImport(s, arch);
      const ok = (typeof showImportConfirm === 'function')
        ? await showImportConfirm(summary)
        : confirm(`Import ${summary.incoming.tasks} tasks (current: ${summary.current.tasks})?`);
      if(!ok) return;
      // Force re-apply regardless of date
      s.date = todayKey();
      if(_applyState(s)){
        if(arch) localStorage.setItem(ARCHIVE_KEY, arch);
        saveState('user');
        renderAll(); renderLog(); renderGoalList();
        renderIntList(); renderQuickTimers();
        applyTheme(); setTaskView(taskView); setSmartView(smartView);
        if(typeof showExportToast === 'function'){
          showExportToast('Restored '+s.tasks.length+' tasks from backup.');
        } else {
          alert('Data restored successfully — '+s.tasks.length+' tasks loaded.');
        }
      } else { alert('Backup file could not be applied.'); }
    }catch(err){ alert('Import failed: '+err.message); }
  };
  reader.readAsText(file);
}
// Build a {current, incoming} summary for the import confirm dialog. Counts
// only — the dialog shows a "tasks: 142 → 87" style preview without leaking
// any actual task content into the prompt.
function _summarizeImport(s, archiveBlob){
  const cur = {
    tasks:  Array.isArray(tasks) ? tasks.length : 0,
    lists:  (typeof lists !== 'undefined' && Array.isArray(lists)) ? lists.length : 0,
  };
  const inc = {
    tasks:  Array.isArray(s.tasks) ? s.tasks.length : 0,
    lists:  Array.isArray(s.lists) ? s.lists.length : 0,
  };
  let archDays = null;
  if(archiveBlob){
    try{ archDays = JSON.parse(archiveBlob).length || null; }catch(_){}
  }
  return { current: cur, incoming: inc, archiveDays: archDays };
}
if(typeof window !== 'undefined') window._summarizeImport = _summarizeImport;

// ════════════════════════════════════════════════════════════════════════════
// UNIFIED TASK EXPORT / IMPORT — single schema shared between CSV and JSON
// ════════════════════════════════════════════════════════════════════════════
// Both formats contain the same fields. CSV flattens nested arrays (tags as
// semicolon-separated strings, checklist as "done/total", notes as count).
// JSON preserves full fidelity. Import auto-detects format and merges by id.

// Authoritative field list — the single source of truth for both formats.
// Order matters: this is the CSV column order.
const TASK_EXPORT_FIELDS = [
  'id','name','parentId','listId',
  'status','priority','starred','archived',
  'dueDate','startDate','remindAt','completedAt','created',
  'category','effort','energyLevel','type',
  'estimateMin','totalSec','sessions',
  'tags','valuesAlignment','blockedBy',
  'checklistDone','checklistTotal','notesCount',
  'description','url','completionNote','valuesNote',
  'recur','reminderFired',
  'lastModified',
];

// Convert a task object → flat row suitable for CSV or JSON export
function _taskToExportRow(t){
  const checklist = Array.isArray(t.checklist) ? t.checklist : [];
  const notes = Array.isArray(t.notes) ? t.notes : [];
  return {
    id:              t.id ?? null,
    name:            t.name || '',
    parentId:        t.parentId ?? null,
    listId:          t.listId ?? null,
    status:          t.status || 'open',
    priority:        t.priority || 'none',
    starred:         !!t.starred,
    archived:        !!t.archived,
    dueDate:         t.dueDate || null,
    startDate:       t.startDate || null,
    remindAt:        t.remindAt || null,
    completedAt:     t.completedAt || null,
    created:         t.created || '',
    category:        t.category || null,
    effort:          t.effort || null,
    energyLevel:     t.energyLevel || null,
    type:            t.type || 'task',
    estimateMin:     t.estimateMin || 0,
    totalSec:        t.totalSec || 0,
    sessions:        t.sessions || 0,
    tags:            Array.isArray(t.tags) ? t.tags : [],
    valuesAlignment: Array.isArray(t.valuesAlignment) ? t.valuesAlignment : [],
    blockedBy:       Array.isArray(t.blockedBy) ? t.blockedBy : [],
    checklistDone:   checklist.filter(c=>c && c.done).length,
    checklistTotal:  checklist.length,
    notesCount:      notes.length,
    description:     t.description || '',
    url:             t.url || null,
    completionNote:  t.completionNote || null,
    valuesNote:      t.valuesNote || null,
    recur:           t.recur || null,
    reminderFired:   !!t.reminderFired,
    lastModified:    (typeof t.lastModified === 'number') ? t.lastModified : null,
    completions:     Array.isArray(t.completions) ? t.completions : [],
    habitLastRecordedTotalSec: (typeof t.habitLastRecordedTotalSec === 'number') ? t.habitLastRecordedTotalSec : null,
    // JSON-only rich fields (not in CSV columns but preserved in JSON export)
    _checklist:      checklist,
    _notes:          notes,
  };
}

// CSV helpers
function _csvEscape(v){
  if(v == null) return '';
  let s = String(v);
  // Neutralize spreadsheet formula injection (=, +, -, @, tab at cell start)
  if(/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  // Escape if contains comma, quote, newline, or leading/trailing whitespace
  if(/[",\n\r]/.test(s) || s !== s.trim()){
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function _csvJoinArray(arr){
  if(!Array.isArray(arr)) return '';
  // Use semicolon inside CSV cell for array values (comma is CSV separator)
  return arr.map(x => String(x).replace(/;/g, ',')).join(';');
}

function _csvSplitArray(s){
  if(!s || typeof s !== 'string') return [];
  return s.split(';').map(x => x.trim()).filter(x => x.length);
}

// ── Export tasks as CSV ───────────────────────────────────────────────────
function exportTasksCSV(){
  if(!Array.isArray(tasks) || tasks.length === 0){
    alert('No tasks to export');
    return;
  }
  const lines = [];
  lines.push(TASK_EXPORT_FIELDS.join(','));
  tasks.forEach(t => {
    const row = _taskToExportRow(t);
    const cells = TASK_EXPORT_FIELDS.map(f => {
      const v = row[f];
      if(Array.isArray(v)) return _csvEscape(_csvJoinArray(v));
      if(typeof v === 'boolean') return v ? '1' : '0';
      return _csvEscape(v);
    });
    lines.push(cells.join(','));
  });
  const csv = lines.join('\n');
  const blob = new Blob([csv], {type: 'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'odtaulai-tasks-'+todayKey()+'.csv';
  a.click();
  URL.revokeObjectURL(a.href);
  if(typeof showExportToast === 'function') showExportToast('Exported CSV — odtaulai-tasks-'+todayKey()+'.csv');
}

// ── Export tasks as JSON (full fidelity) ──────────────────────────────────
function exportTasksJSON(){
  if(!Array.isArray(tasks) || tasks.length === 0){
    alert('No tasks to export');
    return;
  }
  const payload = {
    kind: 'odtaulai-tasks',
    version: 1,
    exportedAt: new Date().toISOString(),
    taskCount: tasks.length,
    // Include the current lists so list membership survives the round trip
    lists: Array.isArray(lists) ? lists.map(l => ({id:l.id, name:l.name, color:l.color, description:l.description||''})) : [],
    tasks: tasks.map(t => {
      const row = _taskToExportRow(t);
      // In JSON, keep full arrays — drop the tabular-only derivations
      return {
        id: row.id, name: row.name, parentId: row.parentId, listId: row.listId,
        status: row.status, priority: row.priority, starred: row.starred, archived: row.archived,
        dueDate: row.dueDate, startDate: row.startDate, remindAt: row.remindAt,
        completedAt: row.completedAt, created: row.created,
        category: row.category, effort: row.effort, energyLevel: row.energyLevel,
        type: row.type,
        estimateMin: row.estimateMin, totalSec: row.totalSec, sessions: row.sessions,
        tags: row.tags, valuesAlignment: row.valuesAlignment, blockedBy: row.blockedBy,
        checklist: row._checklist, notes: row._notes,
        description: row.description, url: row.url,
        completionNote: row.completionNote, valuesNote: row.valuesNote,
        recur: row.recur, reminderFired: row.reminderFired,
        lastModified: row.lastModified,
      };
    }),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type: 'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const jname = 'odtaulai-tasks-'+todayKey()+'.json';
  a.download = jname;
  a.click();
  URL.revokeObjectURL(a.href);
  if(typeof showExportToast === 'function') showExportToast('Exported JSON — '+jname);
}

// ── G-23 Encrypted JSON backup (passphrase → PBKDF2 → AES-GCM) ────────────
// Pure SubtleCrypto. Wire format (JSON): {kind,version,kdf:{name,salt,iter,hash},
// cipher:{name,iv}, ciphertext, exportedAt}. Salt + IV are base64 random bytes.
const _ENC_KIND = 'odtaulai-encrypted';
const _ENC_VERSION = 1;
const _ENC_PBKDF2_ITER = 200000;
function _b64encode(bytes){
  let s = '';
  for(let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function _b64decode(b64){
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for(let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
async function _deriveBackupKey(passphrase, salt){
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: _ENC_PBKDF2_ITER, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
async function exportDataEncrypted(){
  if(!('crypto' in window) || !crypto.subtle){
    alert('Encrypted export requires SubtleCrypto — your browser does not support it.');
    return;
  }
  const passphrase = prompt('Backup passphrase (write it down — without it the backup is unrecoverable):');
  if(!passphrase) return;
  const confirm = prompt('Re-enter the passphrase to confirm:');
  if(confirm !== passphrase){
    alert('Passphrases did not match — aborted.');
    return;
  }
  // Reuse exportData's payload by calling it indirectly — easier: rebuild the
  // payload here so we don't trigger the file download twice.
  const payload = {
    kind: 'odtaulai-backup',
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    state: {
      v: SCHEMA_VERSION,
      tasks, lists, listIdCtr, taskIdCtr, activeListId, showAllLists,
      goals, goalIdCtr, logIdCtr, timeLog,
      sessionHistory, totalPomos, totalBreaks, totalFocusSec,
      collapsedSections, taskGroupBy, smartView, smartViewsExpanded, taskSortBy, taskView, taskFilters,
      cfg, theme, pomosInCycle, totalDuration, remaining, finished, phase,
      activeTab, syncTaskDels, syncListDels, syncGoalDels, stateEpoch, stateNonce,
    },
    archive: getArchives(),
  };
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const key  = await _deriveBackupKey(passphrase, salt);
  const ct   = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const wrap = {
    kind: _ENC_KIND,
    version: _ENC_VERSION,
    kdf:    { name: 'PBKDF2', salt: _b64encode(salt), iter: _ENC_PBKDF2_ITER, hash: 'SHA-256' },
    cipher: { name: 'AES-GCM', iv: _b64encode(iv) },
    ciphertext: _b64encode(new Uint8Array(ct)),
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(wrap)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const fname = 'odtaulai-encrypted-' + todayKey() + '.json';
  a.download = fname;
  a.click();
  URL.revokeObjectURL(a.href);
  if(typeof showExportToast === 'function') showExportToast('Encrypted backup downloaded — ' + fname);
}
async function importDataEncrypted(file){
  if(!file) return;
  if(!('crypto' in window) || !crypto.subtle){
    alert('Encrypted import requires SubtleCrypto — your browser does not support it.');
    return;
  }
  const text = await file.text();
  let wrap;
  try{ wrap = JSON.parse(text); }catch(e){ alert('Not a valid JSON file.'); return; }
  if(!wrap || wrap.kind !== _ENC_KIND){
    alert('This file is not an Odta encrypted backup. Use Restore (.json) for unencrypted backups.');
    return;
  }
  const passphrase = prompt('Passphrase to decrypt this backup:');
  if(!passphrase) return;
  try{
    const salt = _b64decode(wrap.kdf.salt);
    const iv   = _b64decode(wrap.cipher.iv);
    const ct   = _b64decode(wrap.ciphertext);
    const key  = await _deriveBackupKey(passphrase, salt);
    const pt   = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    const json = new TextDecoder().decode(pt);
    const payload = JSON.parse(json);
    // Hand off to the existing restore logic via a synthetic File.
    const f = new File([JSON.stringify(payload)], file.name.replace(/\.enc(\.json)?$/, '') + '-decrypted.json', { type: 'application/json' });
    if(typeof importData === 'function') importData(f);
  }catch(e){
    alert('Decryption failed — wrong passphrase or corrupted file.');
  }
}
window.exportDataEncrypted = exportDataEncrypted;
window.importDataEncrypted = importDataEncrypted;

// ── Export tasks-with-dates as iCal (.ics) — read-only feed for other apps ─
// Mirrors the parser in calfeeds.js: VCALENDAR/VEVENT/DTSTART. All-day events
// for date-only dueDates so Google/Apple Calendar render them correctly.
function _icsEscape(s){
  if(s == null) return '';
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}
function _icsFoldLine(line){
  // RFC 5545 §3.1: long lines should be folded at 75 octets with CRLF + space.
  if(line.length <= 75) return line;
  const parts = [];
  let i = 0;
  while(i < line.length){
    parts.push((i === 0 ? '' : ' ') + line.slice(i, i + 75));
    i += 75;
  }
  return parts.join('\r\n');
}
function exportTasksICS(){
  if(!Array.isArray(tasks) || tasks.length === 0){
    alert('No tasks to export');
    return;
  }
  const dated = tasks.filter(t => t && t.dueDate && !t.archived);
  if(!dated.length){
    alert('No tasks with a due date — nothing to export');
    return;
  }
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Odta//Tasks Export 1.0//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Odta Tasks',
    'X-WR-TIMEZONE:UTC',
  ];
  for(const t of dated){
    const dt = String(t.dueDate || '').replace(/-/g, '');
    if(!/^\d{8}$/.test(dt)) continue;
    const uid = 'odtaulai-task-' + t.id + '@odtaulai.local';
    const summary = t.priority && t.priority !== 'none'
      ? '[' + t.priority.toUpperCase() + '] ' + (t.name || 'Task')
      : (t.name || 'Task');
    const descParts = [];
    if(t.description) descParts.push(t.description);
    if(t.category) descParts.push('Life area: ' + t.category);
    if(Array.isArray(t.tags) && t.tags.length) descParts.push('Tags: ' + t.tags.join(', '));
    if(t.url) descParts.push('URL: ' + t.url);
    lines.push('BEGIN:VEVENT');
    lines.push(_icsFoldLine('UID:' + _icsEscape(uid)));
    lines.push('DTSTAMP:' + stamp);
    lines.push('DTSTART;VALUE=DATE:' + dt);
    lines.push('SUMMARY:' + _icsFoldLine(_icsEscape(summary)));
    if(descParts.length){
      lines.push('DESCRIPTION:' + _icsFoldLine(_icsEscape(descParts.join('\n'))));
    }
    if(t.status === 'done') lines.push('STATUS:COMPLETED');
    else if(t.status === 'progress') lines.push('STATUS:CONFIRMED');
    else lines.push('STATUS:TENTATIVE');
    lines.push('TRANSP:TRANSPARENT');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const fname = 'odtaulai-tasks-' + todayKey() + '.ics';
  a.download = fname;
  a.click();
  URL.revokeObjectURL(a.href);
  if(typeof showExportToast === 'function') showExportToast('Exported iCal — ' + fname);
}
window.exportTasksICS = exportTasksICS;

// ── CSV parser (handles quoted fields with embedded commas/newlines/quotes) ─
function _parseCSV(text){
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for(let i = 0; i < s.length; i++){
    const c = s[i];
    if(inQuotes){
      if(c === '"'){
        if(s[i+1] === '"'){ cell += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cell += c;
      }
    } else {
      if(c === '"' && cell === ''){
        inQuotes = true;
      } else if(c === ','){
        row.push(cell); cell = '';
      } else if(c === '\n'){
        row.push(cell); rows.push(row); row = []; cell = '';
      } else {
        cell += c;
      }
    }
  }
  // Flush final cell/row if non-empty
  if(cell !== '' || row.length){ row.push(cell); rows.push(row); }
  return rows;
}

// Convert a row (from CSV parse OR JSON object) → task shape.
// Handles both: CSV rows come in with array fields as semicolon-joined strings,
// JSON rows come in with array fields as actual arrays.
function _csvRowToTask(obj, existingTask){
  // Start from existing if we're updating, otherwise blank slate with defaults
  const base = existingTask ? {...existingTask} : {
    totalSec:0, sessions:0, tags:[], blockedBy:[], valuesAlignment:[],
    checklist:[], notes:[], completions:[],
  };
  const T = {...base};

  const bool = v => v === '1' || v === 'true' || v === true;
  const num  = v => { const n = parseInt(v,10); return isNaN(n) ? 0 : n; };
  const str  = v => (v == null || v === '') ? null : String(v);
  const strReq = v => (v == null) ? '' : String(v);
  // Array helper: accept array as-is, or split string by semicolon
  const asArr = v => Array.isArray(v) ? v.slice() : _csvSplitArray(v);

  if('name' in obj)            T.name = strReq(obj.name);
  if('parentId' in obj)        T.parentId = (obj.parentId === '' || obj.parentId == null) ? null : num(obj.parentId);
  if('listId' in obj)          T.listId = (obj.listId === '' || obj.listId == null) ? null : num(obj.listId);
  if('status' in obj)          T.status = obj.status || 'open';
  if('priority' in obj)        T.priority = obj.priority || 'none';
  if('starred' in obj)         T.starred = bool(obj.starred);
  if('archived' in obj)        T.archived = bool(obj.archived);
  if('dueDate' in obj)         T.dueDate = str(obj.dueDate);
  if('startDate' in obj)       T.startDate = str(obj.startDate);
  if('remindAt' in obj)        T.remindAt = str(obj.remindAt);
  if('completedAt' in obj)     T.completedAt = str(obj.completedAt);
  if('created' in obj)         T.created = obj.created || '';
  if('category' in obj)        T.category = str(obj.category);
  if('effort' in obj)          T.effort = str(obj.effort);
  if('energyLevel' in obj)     T.energyLevel = str(obj.energyLevel);
  if('type' in obj)            T.type = obj.type || 'task';
  if('estimateMin' in obj)     T.estimateMin = num(obj.estimateMin);
  if('totalSec' in obj)        T.totalSec = num(obj.totalSec);
  if('sessions' in obj)        T.sessions = num(obj.sessions);
  if('tags' in obj)            T.tags = asArr(obj.tags).map(String);
  if('valuesAlignment' in obj) T.valuesAlignment = asArr(obj.valuesAlignment).map(String);
  if('blockedBy' in obj)       T.blockedBy = asArr(obj.blockedBy).map(x => parseInt(x,10)).filter(x => x > 0);
  if('description' in obj)     T.description = obj.description || '';
  if('url' in obj)             T.url = str(obj.url);
  if('completionNote' in obj)  T.completionNote = str(obj.completionNote);
  if('valuesNote' in obj)      T.valuesNote = str(obj.valuesNote);
  if('recur' in obj)           T.recur = str(obj.recur);
  if('reminderFired' in obj)   T.reminderFired = bool(obj.reminderFired);
  if('lastModified' in obj){
    const lm = parseInt(obj.lastModified, 10);
    if(!isNaN(lm) && lm > 0) T.lastModified = lm;
  }
  // checklist and notes — preserve if passed as arrays (JSON imports); CSV has counts only
  if(Array.isArray(obj.checklist)) T.checklist = obj.checklist;
  if(Array.isArray(obj.notes))     T.notes     = obj.notes;
  if(Array.isArray(obj.completions)) T.completions = obj.completions;
  if('habitLastRecordedTotalSec' in obj){
    const h = parseInt(obj.habitLastRecordedTotalSec, 10);
    T.habitLastRecordedTotalSec = (!isNaN(h) && h >= 0) ? h : null;
  }
  return T;
}

// ── Import tasks — auto-detects CSV vs JSON, merges by id ──────────────────
// Returns {added, updated, skipped, errors[]}
function importTasks(file){
  if(!file){ return; }
  if(typeof file.size === 'number' && file.size > _IMPORT_MAX_BYTES){
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    const max = (_IMPORT_MAX_BYTES / (1024 * 1024)).toFixed(0);
    alert('Task file is ' + mb + ' MB — that exceeds the ' + max + ' MB cap.');
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    const text = e.target.result;
    let report;
    try {
      if(file.name.toLowerCase().endsWith('.json') || text.trim().startsWith('{')){
        report = _importTasksFromJSON(text);
      } else {
        report = _importTasksFromCSV(text);
      }
    } catch(err){
      alert('Import failed: ' + err.message);
      return;
    }
    // After successful import, re-repair and save, then re-render
    try {
      // Run every task back through _repairTask to normalise types.
      // _repairTask returns NEW object references, so the _taskById index
      // points at stale pre-repair instances until we rebuild it — without
      // that, findTask() returns ghost tasks that aren't in `tasks` and any
      // subsequent edit silently misses.
      tasks = tasks.map(_repairTask).filter(Boolean);
      if(typeof rebuildTaskIdIndex === 'function') rebuildTaskIdIndex();
      saveState('user');
      if(typeof renderTaskList === 'function') renderTaskList();
      if(typeof renderLists === 'function') renderLists();
    } catch(err){ console.warn('[import] post-save failed', err); }

    const parts = [];
    if(report.added)   parts.push(report.added + ' added');
    if(report.updated) parts.push(report.updated + ' updated');
    if(report.skipped) parts.push(report.skipped + ' skipped');
    const msg = 'Import complete: ' + (parts.join(', ') || 'no changes') +
                (report.errors.length ? '\n\nWarnings:\n• ' + report.errors.slice(0,5).join('\n• ') : '');
    alert(msg);
  };
  reader.readAsText(file);
}

function _importTasksFromJSON(text){
  const parsed = JSON.parse(text);
  if(!parsed || typeof parsed !== 'object') throw new Error('Not a valid JSON file');

  // Accept three shapes:
  //   1. { kind:'odtaulai-tasks' | 'stupind-tasks', tasks:[...] }  — native task export
  //   2. { tasks:[...] }                         — generic
  //   3. [...]                                   — bare array
  let incomingTasks;
  if(Array.isArray(parsed)) incomingTasks = parsed;
  else if(Array.isArray(parsed.tasks)) incomingTasks = parsed.tasks;
  else throw new Error('JSON does not contain a tasks array');

  // Import lists too if present (adds missing lists only, never overwrites)
  if(Array.isArray(parsed.lists)){
    parsed.lists.forEach(rl => {
      if(!rl || typeof rl !== 'object' || !rl.id) return;
      if(!lists.find(l => l.id === rl.id)){
        lists.push({
          id: rl.id,
          name: rl.name || 'Imported',
          color: rl.color || '#1a8cff',
          description: typeof rl.description==='string' ? rl.description : '',
        });
        if(rl.id > listIdCtr) listIdCtr = rl.id;
      }
    });
  }

  const report = { added: 0, updated: 0, skipped: 0, errors: [] };
  incomingTasks.forEach((incoming, idx) => {
    if(!incoming || typeof incoming !== 'object'){
      report.errors.push('Row ' + (idx+1) + ': not an object');
      report.skipped++;
      return;
    }
    _applyIncomingTask(incoming, report);
  });
  return report;
}

function _importTasksFromCSV(text){
  const rows = _parseCSV(text);
  if(rows.length < 2) throw new Error('CSV must have a header row and at least one data row');
  const headers = rows[0].map(h => h.trim());
  if(!headers.includes('name')) throw new Error('CSV missing required "name" column');

  const report = { added: 0, updated: 0, skipped: 0, errors: [] };
  for(let i = 1; i < rows.length; i++){
    const row = rows[i];
    if(!row || (row.length === 1 && row[0] === '')) continue; // blank line
    const obj = {};
    headers.forEach((h, j) => { obj[h] = row[j] != null ? row[j] : ''; });
    if(!obj.name || !obj.name.trim()){
      report.errors.push('Row ' + (i+1) + ': missing name');
      report.skipped++;
      continue;
    }
    _applyIncomingTask(obj, report);
  }
  return report;
}

// Apply a single incoming row (from CSV parse or JSON object) — decide add vs update vs skip
function _applyIncomingTask(incoming, report){
  const incomingId = parseInt(incoming.id, 10);
  if(!isNaN(incomingId) && incomingId > 0){
    const existing = tasks.find(t => t.id === incomingId);
    if(existing){
      // Update existing — lastModified wins when both present; else fall back to
      // created parse. If still indeterminate, keep local (avoid stale CSV clobber).
      const newTask = _csvRowToTask(incoming, existing);
      const exRel = _taskImportRelevanceMs(existing);
      const inRel = _taskImportRelevanceMs(newTask);
      if(exRel > 0 && inRel > 0 && inRel < exRel){
        report.skipped++;
        return;
      }
      if(exRel === 0 && inRel === 0){
        report.skipped++;
        return;
      }
      if(exRel > 0 && inRel === 0){
        report.skipped++;
        return;
      }
      Object.assign(existing, newTask);
      report.updated++;
    } else {
      // ID provided but not local — add as new with preserved id
      const newTask = _csvRowToTask(incoming, null);
      newTask.id = incomingId;
      tasks.push(newTask);
      if(typeof _taskIndexRegister === 'function') _taskIndexRegister(newTask);
      if(incomingId > taskIdCtr) taskIdCtr = incomingId;
      report.added++;
    }
  } else {
    // No id — always add as new with fresh id
    const newTask = _csvRowToTask(incoming, null);
    newTask.id = ++taskIdCtr;
    newTask.created = newTask.created || (typeof timeNowFull === 'function' ? timeNowFull() : new Date().toISOString());
    tasks.push(newTask);
    if(typeof _taskIndexRegister === 'function') _taskIndexRegister(newTask);
    report.added++;
  }
}


// ── Misc ──────────────────────────────────────────────────────────────────────
function setToggle(id,val){ const el=gid(id); if(!el)return; if(val)el.classList.add('on'); else el.classList.remove('on'); el.setAttribute('aria-checked',val?'true':'false'); }

// Cap payload per archived day so Past Days + quota stays bounded.
const _ARCHIVE_MAX_TIME_LOG = 500;
const _ARCHIVE_MAX_SESSION_HISTORY = 400;

/**
 * Build a yesterday-stamped state snapshot suitable for `archiveDay`.
 * Pure: does not touch globals or the DOM. Extracted so the rollover path
 * is testable without spinning up a full app context.
 *
 *   buildYesterdaySnapshot('2026-04-27', { totalPomos, ..., tasks, ... })
 *     → { date: '2026-04-27', totalPomos, totalBreaks, totalFocusSec, goals,
 *         tasks, timeLog, sessionHistory }
 */
function buildYesterdaySnapshot(date, state){
  const s = state || {};
  return {
    date:           date || null,
    totalPomos:     _int(s.totalPomos, 0),
    totalBreaks:    _int(s.totalBreaks, 0),
    totalFocusSec:  _int(s.totalFocusSec, 0),
    goals:          _arr(s.goals),
    tasks:          _arr(s.tasks),
    timeLog:        _arr(s.timeLog),
    sessionHistory: _arr(s.sessionHistory),
  };
}
if(typeof window !== 'undefined') window.buildYesterdaySnapshot = buildYesterdaySnapshot;

function archiveDay(state){
  try{
    const day = state && state.date;
    if(!day) return;
    const claimKey = ((window.ODTAULAI_CONFIG && window.ODTAULAI_CONFIG.STORAGE_KEYS && window.ODTAULAI_CONFIG.STORAGE_KEYS.ARCHIVED_PREFIX) || 'stupind_archived_') + day;
    try{
      if(localStorage.getItem(claimKey) === '1') return;
    }catch(_){}
    let archives = [];
    try{
      archives = JSON.parse(localStorage.getItem(ARCHIVE_KEY)||'[]');
    }catch(_){
      archives = [];
    }
    if(archives.find(a=>a.date===day)) {
      try{ localStorage.setItem(claimKey, '1'); }catch(_){}
      return;
    }
    const tl = _arr(state.timeLog);
    const sh = _arr(state.sessionHistory);
    archives.push({
      date:          day,
      totalPomos:    _int(state.totalPomos,0),
      totalBreaks:   _int(state.totalBreaks,0),
      totalFocusSec: _int(state.totalFocusSec,0),
      goals:  _arr(state.goals).map(g=>({text:g.text,done:g.done,doneAt:g.doneAt})),
      tasks:  _arr(state.tasks).map(t=>({
        id:t.id, name:t.name,
        totalSec:t.totalSec, sessions:t.sessions,
        parentId:t.parentId||null,
        status:t.status, priority:t.priority,
        category:t.category, effort:t.effort,
        type:t.type, energyLevel:t.energyLevel,
        dueDate:t.dueDate, completedAt:t.completedAt,
        valuesAlignment:t.valuesAlignment||[],
        tags:t.tags||[],
        checklistDone:(t.checklist||[]).filter(c=>c.done).length,
        checklistTotal:(t.checklist||[]).length,
        listId:t.listId,
      })),
      timeLog:        tl.length > _ARCHIVE_MAX_TIME_LOG ? tl.slice(-_ARCHIVE_MAX_TIME_LOG) : tl,
      sessionHistory: sh.length > _ARCHIVE_MAX_SESSION_HISTORY ? sh.slice(-_ARCHIVE_MAX_SESSION_HISTORY) : sh,
    });
    const seen = new Set();
    archives = archives.filter(a => {
      if(!a || !a.date) return false;
      if(seen.has(a.date)) return false;
      seen.add(a.date);
      return true;
    });
    while(archives.length>90) archives.shift();
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify(archives));
    try{ localStorage.setItem(claimKey, '1'); }catch(_){}
  }catch(e){ console.warn('[storage] archiveDay failed', e); }
}

let _autoSaveDebounce = null;
function queueAutoSave(){
  clearTimeout(_autoSaveDebounce);
  _autoSaveDebounce = setTimeout(() => {
    _autoSaveDebounce = null;
    saveState('auto');
  }, 450);
}

let _saveIndLast = 0;
function showSaveIndicator(){
  const el = gid('saveInd'); if(!el)return;
  const now = Date.now();
  if(now - _saveIndLast < 4000) return;
  _saveIndLast = now;
  el.classList.add('show');
  clearTimeout(el._saveIndT);
  el._saveIndT = setTimeout(()=>{ el.classList.remove('show'); }, 900);
}

// Auto-save every 10s, on tab hide, and on unload (no save pill). Routed
// through setManagedInterval so a bfcache restore (which clears the
// interval on pagehide) reinstates a single fresh tick instead of leaving
// the autosave loop dead.
if(typeof setManagedInterval === 'function'){
  const _autosaveTick = () => queueAutoSave();
  setManagedInterval('autosave', _autosaveTick, 10000);
  if(typeof onBfcacheRestore === 'function'){
    onBfcacheRestore(() => setManagedInterval('autosave', _autosaveTick, 10000));
  }
} else {
  setInterval(() => queueAutoSave(), 10000);
}
document.addEventListener('visibilitychange', ()=>{ if(document.hidden) queueAutoSave(); });
if(typeof window !== 'undefined'){
  window.resetTaskSnapshotBaseline = resetTaskSnapshotBaseline;
  window.persistAfterSyncMerge = persistAfterSyncMerge;
}
window.addEventListener('beforeunload', () => saveState('unload'));
if(typeof window !== 'undefined' && window.addEventListener){
  window.addEventListener('storage', _onStorageFromOtherTab);
}
