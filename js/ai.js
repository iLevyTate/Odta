// ========== AMBIENT INTELLIGENCE (embeddings + optional generative Ask) ==========
// Preview/undo, Schwartz values UI, smart-add chips. Task mutations via executeIntelOp.

const INTEL_CFG_KEY = (window.ODTAULAI_CONFIG && window.ODTAULAI_CONFIG.STORAGE_KEYS && window.ODTAULAI_CONFIG.STORAGE_KEYS.INTEL_CFG) || 'stupind_intel_cfg';

// LIFE_CATS, CAT_ICON, SCHWARTZ, VALUE_KEYS — globals from intel-features.js

let _cfg = null;
let _pendingOps = [];
let _pendingOverflowOps = null;   // Deferred ops beyond the 50-cap of the current review batch (#7 UX audit).
let _pendingDestructive = 'none'; // 'none' | 'warn' | 'hard' — set by acceptProposedOps()
let _pendingSource = null;        // tag for UI ('ask', 'harmonize', …)
let _undoStack = [];
let _intelBusy = false;

function _loadCfg(){
  try{ _cfg = JSON.parse(localStorage.getItem(INTEL_CFG_KEY) || '{}'); }
  catch(e){ _cfg = {}; }
  _cfg.dominant = Array.isArray(_cfg.dominant) ? _cfg.dominant : [];
  return _cfg;
}
function _saveCfg(){ try{ localStorage.setItem(INTEL_CFG_KEY, JSON.stringify(_cfg)); }catch(e){} }

// Track the two model states independently so the header chip can show
// both without one stomping the other (embedding = ambient/always-on,
// generative = opt-in LLM for Ask mode).
let _embedChipState = 'idle';
let _embedChipMsg = '';
let _genChipState = 'idle';
let _genChipMsg = '';

function _composeChipState(){
  // Error wins. Then loading. Then ready. Otherwise idle.
  if(_embedChipState === 'error' || _genChipState === 'error'){
    const which = _genChipState === 'error' ? 'LLM' : 'Embedding';
    const raw = _genChipState === 'error' ? _genChipMsg : _embedChipMsg;
    return { state: 'error', msg: `${which}: ${raw || 'load failed'}` };
  }
  if(_embedChipState === 'loading' || _embedChipState === 'working' || _embedChipState === 'syncing' ||
     _genChipState === 'loading' || _genChipState === 'working' || _genChipState === 'syncing'){
    if(_genChipState === 'loading' || _genChipState === 'working' || _genChipState === 'syncing'){
      return { state: 'loading', msg: _genChipMsg || 'Loading LLM…' };
    }
    return { state: 'loading', msg: _embedChipMsg || 'Loading model…' };
  }
  if(_embedChipState === 'ready' || _genChipState === 'ready'){
    const embedOk = _embedChipState === 'ready';
    const genOk = _genChipState === 'ready';
    const genBk = genOk && typeof getGenDevice === 'function' ? _formatGenBackend(getGenDevice()) : '';
    const genSuffix = genBk ? ' · ' + genBk : '';
    let summary = 'Task understanding ready';
    if(embedOk && genOk) summary = 'Embeddings + LLM ready' + genSuffix;
    else if(genOk) summary = 'LLM ready' + genSuffix;
    return { state: 'ready', msg: summary };
  }
  return { state: 'idle', msg: 'Task understanding (on-device)' };
}

/** Human-readable backend for the generative pipeline (after load). */
function _formatGenBackend(dev){
  if(dev === 'webgpu') return 'WebGPU';
  if(dev === 'wasm') return 'WASM (CPU)';
  return '';
}

function _hideGenLoadRibbon(){
  const el = document.getElementById('genLoadRibbon');
  if(el) el.hidden = true;
}

/**
 * Fixed footer ribbon + Settings progress row while an LLM download/rehydrate runs.
 * @param {number} v 0–100
 * @param {{ status?:string, file?:string }|null} ev
 */
function _syncGenDownloadProgress(v, ev){
  const pct = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  const bar = document.getElementById('genProgressBar');
  const pctEl = document.getElementById('genProgressPct');
  const txt = document.getElementById('genProgressTxt');
  const statusEl = document.getElementById('genSettingsStatus');
  const status = ev && ev.status ? String(ev.status) : '';
  const file = ev && ev.file ? ' · ' + String(ev.file).split('/').pop() : '';
  const line = (status + file).trim().slice(0, 88) || 'Fetching ONNX shards…';
  // When WebGPU init stalls we fall back to CPU; surface that explicitly so the
  // 100%-but-still-working phase doesn't look frozen on "Initializing model…".
  const isWasmFallback = /wasm/i.test(status);
  const initLabel = isWasmFallback ? 'Switching to CPU (WASM)…' : 'Initializing model…';
  if(bar) bar.style.width = pct + '%';
  if(pctEl) pctEl.textContent = pct + '%';
  if(txt) txt.textContent = line;
  if(statusEl) statusEl.textContent = pct >= 100 ? initLabel : `Downloading weights · ${pct}%`;
  const chipLine = pct >= 100 ? (isWasmFallback ? 'CPU (WASM)…' : 'Initializing…') : (line.length > 48 ? line.slice(0, 45) + '…' : line);
  _genChipState = 'loading';
  _genChipMsg = pct >= 100 ? initLabel : pct + '% · ' + chipLine;
  const c = _composeChipState();
  _renderHeaderAIChip(c.state, c.msg);
  const ribbon = document.getElementById('genLoadRibbon');
  const ribbonBar = document.getElementById('genLoadRibbonBar');
  const ribbonTrack = document.getElementById('genLoadRibbonTrack');
  const ribbonTxt = document.getElementById('genLoadRibbonTxt');
  if(ribbon){
    ribbon.hidden = false;
    if(pct >= 100){
      // Download is done but pipeline init (WebGPU shader compile / WASM
      // instantiation) can take several seconds. Switch to an animated
      // indeterminate bar so the user knows work is still in progress.
      if(ribbonTrack) ribbonTrack.classList.add('gen-load-ribbon__track--indeterminate');
      if(ribbonBar) ribbonBar.style.width = '40%';
      if(ribbonTxt) ribbonTxt.textContent = 'On-device LLM · ' + initLabel;
    }else{
      if(ribbonTrack) ribbonTrack.classList.remove('gen-load-ribbon__track--indeterminate');
      if(ribbonBar) ribbonBar.style.width = pct + '%';
      if(ribbonTxt) ribbonTxt.textContent = `On-device LLM · ${pct}% — ${line}`;
    }
  }
}

function _showGenLoadRibbonIndeterminate(detail){
  const ribbon = document.getElementById('genLoadRibbon');
  const ribbonBar = document.getElementById('genLoadRibbonBar');
  const ribbonTrack = document.getElementById('genLoadRibbonTrack');
  const ribbonTxt = document.getElementById('genLoadRibbonTxt');
  if(!ribbon) return;
  ribbon.hidden = false;
  if(ribbonTrack) ribbonTrack.classList.add('gen-load-ribbon__track--indeterminate');
  if(ribbonBar) ribbonBar.style.width = '40%';
  if(ribbonTxt) ribbonTxt.textContent = detail || 'On-device LLM…';
}

/** Set the generative-LLM chip sub-state without affecting embedding state. */
function syncGenChip(state, msg){
  const wasReady = _genChipState === 'ready';
  _genChipState = state || 'idle';
  _genChipMsg = msg || '';
  if(_genChipState !== 'loading' && _genChipState !== 'working' && _genChipState !== 'syncing'){
    _hideGenLoadRibbon();
  }
  const c = _composeChipState();
  _renderHeaderAIChip(c.state, c.msg);
  // If the LLM just transitioned to ready and the Ask sheet is sitting in the
  // "need-model" empty state, refresh it so the inline Download button is
  // replaced with a normal idle prompt the user can submit immediately.
  // Avoids the "I downloaded the model… now what?" dead end.
  if(_genChipState === 'ready' && !wasReady && typeof document !== 'undefined'){
    const reply = document.getElementById('cmdkAskReply');
    if(reply && reply.querySelector('.cmdk-ask-enable')){
      reply.textContent = '';
      const ok = document.createElement('div');
      ok.className = 'cmdk-ask-done';
      ok.textContent = 'Local AI is ready — type your request and press Enter.';
      reply.appendChild(ok);
    }
  }
}

/** Header pill: model load / ready / error — visible on every tab */
function syncHeaderAIChip(state, msg){
  // Record embedding state (legacy callers pass embedding updates here), then
  // re-render the composed chip.
  _embedChipState = state || 'idle';
  _embedChipMsg = msg || '';
  const c = _composeChipState();
  _renderHeaderAIChip(c.state, c.msg);
}

function _renderHeaderAIChip(state, msg){
  const chip = document.getElementById('headerAIChip');
  if(!chip) return;
  chip.classList.remove('ai-chip--idle','ai-chip--syncing','ai-chip--ok','ai-chip--err');
  let cls = 'ai-chip--idle';
  if(state === 'loading' || state === 'working' || state === 'syncing') cls = 'ai-chip--syncing';
  else if(state === 'ready' || state === 'ok') cls = 'ai-chip--ok';
  else if(state === 'error') cls = 'ai-chip--err';
  chip.classList.add(cls);
  const busy = state === 'loading' || state === 'working' || state === 'syncing';
  chip.setAttribute('aria-busy', busy ? 'true' : 'false');
  // First-run badge: until the model has been downloaded at least once,
  // tag the chip with a small "setup" dot so users notice it's an action
  // rather than a passive status indicator. Cleared automatically as soon
  // as the model state advances past idle.
  const firstRun = state === 'idle' && (() => {
    try{
      if(typeof isGenDownloaded === 'function' && typeof getGenCfg === 'function'){
        const cfg = getGenCfg() || {};
        if(cfg.modelId && isGenDownloaded(cfg.modelId)) return false;
      }
    }catch(_){}
    // Embedding model: never downloaded either?
    try{ if(typeof isIntelReady === 'function' && isIntelReady()) return false; }catch(_){}
    return true;
  })();
  chip.classList.toggle('ai-chip--firstrun', firstRun);
  const label = chip.querySelector('.ai-chip-label');
  if(label){
    if(state === 'loading' || state === 'working' || state === 'syncing'){
      const m = (msg || '').trim();
      const pct = m.match(/^(\d+)%/);
      label.textContent = pct ? pct[1] + '%' : '…';
    }else if(state === 'ready' || state === 'ok') label.textContent = '✓';
    else if(state === 'error') label.textContent = '!';
    else label.textContent = 'AI';
  }
  let desc = 'Task understanding — ~33 MB one-time download. Tap to set up.';
  if(state === 'loading' || state === 'working' || state === 'syncing'){
    const m = (msg || '').trim();
    desc = m ? 'Loading model: ' + m.slice(0, 100) : 'Loading model…';
  }else if(state === 'ready' || state === 'ok'){
    desc = (msg && String(msg).trim()) ? String(msg).slice(0, 120) : 'Embeddings ready';
  }else if(state === 'error'){
    desc = (msg && String(msg).trim()) ? String(msg).slice(0, 100) + '. Tap to retry.' : 'Model load failed. Tap to retry.';
  }
  chip.setAttribute('aria-label', desc);
  const live = document.getElementById('aiChipLive');
  if(live) live.textContent = desc;
  if(state === 'error'){
    chip.title = (msg && String(msg).trim()) ? String(msg).slice(0, 72) + ' — tap to retry' : 'Model load failed — tap to retry';
  }else if(busy){
    chip.title = (msg && String(msg).length < 80) ? String(msg) : 'Loading embedding model…';
  }else if(state === 'ready' || state === 'ok'){
    chip.title = (msg && String(msg).length < 80) ? String(msg) : 'Task understanding — open Tools';
  }else{
    chip.title = 'Task understanding — ~33 MB one-time download (cached after). Tap to open setup.';
  }
}

/** Semantic search checkbox: disabled until embeddings are ready (avoids silent no-op). */

function syncSemanticSearchUi(){
  const cb = document.getElementById('taskSearchSemantic');
  const lab = cb && cb.closest('.task-search-semantic');
  if(!cb) return;
  const ready = typeof isIntelReady === 'function' && isIntelReady();
  if(!ready){
    const hadChecked = cb.checked;
    cb.disabled = true;
    cb.checked = false;
    window._taskSearchSemantic = false;
    if(hadChecked) window._semanticScores = null;
    if(lab){
      lab.title = 'Load the embedding model first (header AI chip or Tools tab)';
      lab.classList.add('task-search-semantic--disabled');
    }
    if(hadChecked && typeof updateTaskFilters === 'function') updateTaskFilters();
  }else{
    cb.disabled = false;
    if(lab){
      lab.title = 'Rank by meaning (requires model loaded)';
      lab.classList.remove('task-search-semantic--disabled');
    }
  }
}

function headerAIClick(){
  const chip = document.getElementById('headerAIChip');
  if(chip && chip.classList.contains('ai-chip--err')){
    if(_genChipState === 'error' && typeof openGenSettingsFromAsk === 'function'){
      openGenSettingsFromAsk();
      return;
    }
    if(_embedChipState === 'error' && typeof intelRetryLoad === 'function'){
      intelRetryLoad();
      return;
    }
  }
  if(typeof showTab === 'function') showTab('tools');
}

// ══════════════════════════════════════════════════════════════════════════════
// TASK MUTATIONS (used by pending ops + duplicate merge)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * On-device life-area classification: centroid + kNN. Async because embeddings load from IDB.
 * @returns {Promise<{type:string, id?:number, before?:object}|{type:'noop'}|null>}
 */
/**
 * Preview life-area classification without mutating the task (for pending-op cards).
 * @returns {Promise<{ nextCat:string, beforeCat:string|null, confidence:number } | { skip:true, beforeCat?:string|null } | null>}
 */
// region predictClassifyCategory-test-extract
async function predictClassifyCategory(taskId){
  const t = taskId != null ? findTask(taskId) : null;
  if(!t) return null;
  if(typeof isIntelReady !== 'function' || !isIntelReady()) return null;
  if(typeof embedStore === 'undefined' || !embedStore.ensure) return null;
  try{
    await embedStore.ensure(t);
    const rec = await embedStore.get(t.id);
    if(!rec || !rec.vec) return null;
    let centroids = null;
    if(typeof ensureCategoryCentroids === 'function'){
      try{ centroids = await ensureCategoryCentroids(); }catch(e){}
    }
    const store = (embedStore && typeof embedStore.all === 'function') ? await embedStore.all() : new Map();
    if(typeof predictMetadataFromVec !== 'function') return null;
    const meta = predictMetadataFromVec(rec.vec, {
      store,
      excludeId: t.id,
      categoryCentroidVecs: centroids || undefined,
      k: 5,
    });
    const nextCat = meta && meta.category;
    const beforeCat = t.category || null;
    if(!nextCat || nextCat === 'general' || (typeof isAssignableCategory === 'function' && !isAssignableCategory(nextCat))){
      return { skip: true, beforeCat };
    }
    if(nextCat === beforeCat) return { skip: true, beforeCat };
    let confidence = 0;
    const cKnn = meta._confidence && meta._confidence.category;
    if(cKnn && typeof cKnn.confidence === 'number') confidence = cKnn.confidence;
    else{
      const cCen = meta._confidence && meta._confidence.categoryCentroid;
      if(cCen && typeof cCen.sim === 'number') confidence = Math.max(0, Math.min(1, cCen.sim));
    }
    return { nextCat, beforeCat, confidence };
  }catch(e){
    console.warn('[predictClassifyCategory]', e);
    return null;
  }
}
// endregion predictClassifyCategory-test-extract

async function executeClassifyTaskOp(op){
  const a = op && op.args;
  const t = a && a.id != null ? findTask(a.id) : null;
  if(!t) return null;
  const pc = op && op._previewCategory;
  if(pc){
    if(pc.skip) return { type: 'noop' };
    if(pc.nextCat){
      if(typeof isAssignableCategory === 'function' && !isAssignableCategory(pc.nextCat)) return { type: 'noop' };
      if(pc.nextCat === (t.category || null)) return { type: 'noop' };
      const beforeCat = t.category;
      t.category = pc.nextCat;
      return { type: 'updated', id: t.id, before: { category: beforeCat } };
    }
    return { type: 'noop' };
  }
  if(typeof isIntelReady !== 'function' || !isIntelReady()) return { type: 'noop' };
  if(typeof embedStore === 'undefined' || !embedStore.ensure) return { type: 'noop' };
  try{
    await embedStore.ensure(t);
    const rec = await embedStore.get(t.id);
    if(!rec || !rec.vec) return { type: 'noop' };
    let centroids = null;
    if(typeof ensureCategoryCentroids === 'function'){
      try{ centroids = await ensureCategoryCentroids(); }catch(e){}
    }
    const store = (embedStore && typeof embedStore.all === 'function') ? await embedStore.all() : new Map();
    if(typeof predictMetadataFromVec !== 'function') return { type: 'noop' };
    const meta = predictMetadataFromVec(rec.vec, {
      store,
      excludeId: t.id,
      categoryCentroidVecs: centroids || undefined,
      k: 5,
    });
    const nextCat = meta && meta.category;
    if(!nextCat || nextCat === 'general' || (typeof isAssignableCategory === 'function' && !isAssignableCategory(nextCat))){
      return { type: 'noop' };
    }
    if(nextCat === (t.category || null)) return { type: 'noop' };
    const beforeCat = t.category;
    t.category = nextCat;
    return { type: 'updated', id: t.id, before: { category: beforeCat } };
  }catch(e){
    console.warn('[executeClassifyTaskOp]', e);
    return { type: 'noop' };
  }
}

function executeIntelOp(op){
  const a = op.args;
  let snap = null;
  switch(op.name){
    case 'CREATE_TASK':{
      const id = ++taskIdCtr;
      const nt = Object.assign({
        id, name: String(a.name || 'Untitled'),
        totalSec: 0, sessions: 0, created: timeNowFull(),
        parentId: a.parentId || null, collapsed: false,
      }, defaultTaskProps(), {
        priority: a.priority || 'none',
        category: a.category || null,
        dueDate: a.dueDate || null,
        remindAt: a.remindAt || null,
        description: a.description || '',
        tags: a.tags == null
          ? []
          : (Array.isArray(a.tags)
            ? a.tags.map(s => String(s).replace(/^#/, '').trim()).filter(Boolean)
            : String(a.tags).split(/[,\s]+/).map(s => s.replace(/^#/, '').trim()).filter(Boolean)),
        effort: a.effort || null,
        type: a.type || 'task',
        listId: a.listId || activeListId,
      });
      tasks.push(nt);
      if(typeof _taskIndexRegister === 'function') _taskIndexRegister(nt);
      snap = { type: 'created', id };
      break;
    }
    case 'UPDATE_TASK':{
      const t = findTask(a.id); if(!t) return null;
      snap = { type: 'updated', id: t.id, before: { ...t } };
      const allow = ['name','priority','status','dueDate','startDate','hiddenUntil','effort','energyLevel','category','description','url','estimateMin','starred','type','valuesAlignment','valuesNote','tags'];
      allow.forEach(f => { if(a[f] !== undefined) t[f] = a[f]; });
      if(t.status === 'done' && !t.completedAt) t.completedAt = stampCompletion();
      if(t.status !== 'done') t.completedAt = null;
      break;
    }
    case 'MARK_DONE':{
      const t = findTask(a.id); if(!t) return null;
      // Deep snapshot: completeHabitCycle mutates completions[] and checklist
      // items IN PLACE, so a shallow copy shares those references and the
      // "before" state gets mutated along with the live task (undo no-op).
      snap = { type: 'updated', id: t.id, before: JSON.parse(JSON.stringify(t)) };
      if(a.completionNote) t.completionNote = String(a.completionNote);
      if(t.recur && typeof completeHabitCycle === 'function'){
        completeHabitCycle(t);
      } else {
        t.status = 'done'; t.completedAt = stampCompletion();
      }
      break;
    }
    case 'REOPEN':{
      const t = findTask(a.id); if(!t) return null;
      snap = { type: 'updated', id: t.id, before: { ...t } };
      t.status = 'open'; t.completedAt = null;
      break;
    }
    case 'TOGGLE_STAR':{
      const t = findTask(a.id); if(!t) return null;
      snap = { type: 'updated', id: t.id, before: { ...t } };
      t.starred = !t.starred;
      break;
    }
    case 'DELETE_TASK':{
      const t = findTask(a.id); if(!t) return null;
      const desc = getTaskDescendantIds(t.id);
      // The cascade removes the whole subtree, so undo must restore the
      // whole subtree — snapshotting only the root permanently loses every
      // descendant the moment the user relies on the Undo toast.
      snap = { type: 'deleted', before: { ...t },
               subtree: tasks.filter(x => desc.includes(x.id)).map(x => ({ ...x })) };
      for(const rid of [t.id, ...desc]){ if(typeof _taskIndexRemove === 'function') _taskIndexRemove(rid); }
      tasks = tasks.filter(x => x.id !== t.id && !desc.includes(x.id));
      if(typeof rebuildTaskIdIndex === 'function') rebuildTaskIdIndex();
      break;
    }
    case 'DUPLICATE_TASK':{
      const src = findTask(a.id); if(!src) return null;
      const id = ++taskIdCtr;
      // Deep-clone the source: a shallow copy shares every nested array/object
      // (valuesAlignment, completions, checklists, _ext, …), so mutating one
      // task's habit log or checklist corrupts the other. History fields are
      // reset — a copy starts fresh. Attachments are dropped: blob records
      // are keyed by the SOURCE task id, so a shared id list means removing
      // an attachment from either task deletes the other's blob.
      const dup = Object.assign(JSON.parse(JSON.stringify(src)), {
        id, name: src.name + ' (copy)',
        totalSec: 0, sessions: 0, sessionEntries: [], created: timeNowFull(),
        completedAt: null, status: 'open', archived: false,
        blockedBy: [], notes: [], attachments: [],
        completions: [], habitLastRecordedTotalSec: null,
        reminderFired: false,
      });
      dup.checklist = (dup.checklist || []).map(c => ({ ...c, done: false, doneAt: null }));
      if(Array.isArray(dup.checklists)){
        dup.checklists.forEach(g => (g.items || []).forEach(c => { c.done = false; c.doneAt = null; }));
      }
      tasks.push(dup);
      if(typeof _taskIndexRegister === 'function') _taskIndexRegister(dup);
      snap = { type: 'created', id };
      break;
    }
    case 'MOVE_TASK':{
      const t = findTask(a.id); if(!t) return null;
      if(a.newParentId && getTaskDescendantIds(t.id).includes(a.newParentId)) return null;
      snap = { type: 'updated', id: t.id, before: { ...t } };
      t.parentId = a.newParentId || null;
      break;
    }
    case 'CHANGE_LIST':{
      const t = findTask(a.id); if(!t) return null;
      snap = { type: 'updated', id: t.id, before: { ...t } };
      t.listId = a.listId;
      break;
    }
    case 'ADD_NOTE':{
      const t = findTask(a.id); if(!t) return null;
      snap = { type: 'updated', id: t.id, before: { notes: [...(t.notes || [])] } };
      if(!t.notes) t.notes = [];
      t.notes.unshift({ id: Date.now() + Math.random(), text: '[Intel] ' + String(a.text || ''), createdAt: timeNow() });
      break;
    }
    case 'ADD_CHECKLIST':{
      const t = findTask(a.id); if(!t) return null;
      snap = { type: 'updated', id: t.id, before: { checklist: [...(t.checklist || [])] } };
      if(!t.checklist) t.checklist = [];
      t.checklist.push({ id: Date.now() + Math.random(), text: String(a.text || ''), done: false, doneAt: null });
      break;
    }
    case 'TOGGLE_CHECK':{
      const t = findTask(a.id); if(!t) return null;
      const it = (t.checklist || []).find(c => c.id === a.checkId);
      if(!it) return null;
      snap = { type: 'updated', id: t.id, before: { checklist: JSON.parse(JSON.stringify(t.checklist)) } };
      it.done = !it.done;
      it.doneAt = it.done ? timeNow() : null;
      break;
    }
    case 'REMOVE_CHECK':{
      const t = findTask(a.id); if(!t) return null;
      snap = { type: 'updated', id: t.id, before: { checklist: [...(t.checklist || [])] } };
      t.checklist = (t.checklist || []).filter(c => c.id !== a.checkId);
      break;
    }
    case 'ADD_TAG':{
      const t = findTask(a.id); if(!t) return null;
      snap = { type: 'updated', id: t.id, before: { tags: [...(t.tags || [])] } };
      if(!t.tags) t.tags = [];
      const tag = String(a.tag || '').trim();
      if(tag && !t.tags.includes(tag)) t.tags.push(tag);
      break;
    }
    case 'REMOVE_TAG':{
      const t = findTask(a.id); if(!t) return null;
      snap = { type: 'updated', id: t.id, before: { tags: [...(t.tags || [])] } };
      t.tags = (t.tags || []).filter(x => x !== a.tag);
      break;
    }
    case 'ADD_BLOCKER':{
      const t = findTask(a.id); if(!t || a.blockerId === a.id) return null;
      snap = { type: 'updated', id: t.id, before: { blockedBy: [...(t.blockedBy || [])] } };
      if(!t.blockedBy) t.blockedBy = [];
      if(!t.blockedBy.includes(a.blockerId)) t.blockedBy.push(a.blockerId);
      break;
    }
    case 'REMOVE_BLOCKER':{
      const t = findTask(a.id); if(!t) return null;
      snap = { type: 'updated', id: t.id, before: { blockedBy: [...(t.blockedBy || [])] } };
      t.blockedBy = (t.blockedBy || []).filter(x => x !== a.blockerId);
      break;
    }
    case 'SET_REMINDER':{
      const t = findTask(a.id); if(!t) return null;
      snap = { type: 'updated', id: t.id, before: { ...t } };
      t.remindAt = a.remindAt || null;
      t.reminderFired = false;
      break;
    }
    case 'SET_RECUR':{
      const t = findTask(a.id); if(!t) return null;
      snap = { type: 'updated', id: t.id, before: { ...t } };
      t.recur = a.recur || null;
      break;
    }
    case 'SNOOZE_TASK':{
      const t = findTask(a.id); if(!t) return null;
      snap = { type: 'updated', id: t.id, before: { ...t } };
      // Snooze hides until a date — the deadline (dueDate) and reminder
      // are intentionally untouched. Use RESCHEDULE for due-date moves.
      if(a.untilDate) t.hiddenUntil = a.untilDate;
      break;
    }
    case 'RESCHEDULE':{
      const t = findTask(a.id); if(!t) return null;
      snap = { type: 'updated', id: t.id, before: { ...t } };
      if(a.dueDate) t.dueDate = a.dueDate;
      if(a.remindAt != null) t.remindAt = a.remindAt;
      t.reminderFired = false;
      break;
    }
    case 'SPLIT_TASK':{
      const src = findTask(a.id);
      if(!src || !Array.isArray(a.parts) || a.parts.length < 2) return null;
      const names = a.parts.map(p => (p && p.name) ? String(p.name).trim() : '').filter(Boolean);
      if(names.length < 2) return null;
      const beforeName = src.name;
      const snaps = [{ type: 'updated', id: src.id, before: { name: beforeName } }];
      src.name = names[0];
      src.lastModified = Date.now();
      const parId = src.parentId != null ? src.parentId : null;
      let extBase = null;
      if(src._ext && typeof src._ext === 'object'){
        extBase = { ...src._ext };
        delete extBase.calFeedId;
        delete extBase.calEventUid;
      }
      for(let i = 1; i < names.length; i++){
        const idNew = ++taskIdCtr;
        const sib = Object.assign({}, src, {
          id: idNew, name: names[i], totalSec: 0, sessions: 0, created: timeNowFull(),
          completedAt: null, status: 'open', parentId: parId, archived: false, blockedBy: [],
          notes: [],
          checklist: [],
          tags: Array.isArray(src.tags) ? [...src.tags] : [],
          valuesAlignment: Array.isArray(src.valuesAlignment) ? [...src.valuesAlignment] : [],
          completions: [],
          lastModified: Date.now(),
          _ext: extBase,
        });
        tasks.push(sib);
        if(typeof _taskIndexRegister === 'function') _taskIndexRegister(sib);
        snaps.push({ type: 'created', id: idNew });
      }
      return { type: 'batch', snaps };
    }
    case 'CREATE_FROM_EVENT':{
      if(a.eventUid == null || a.feedId == null) return null;
      if(typeof createTaskFromCalEventCore !== 'function') return null;
      const idNew = createTaskFromCalEventCore(a.feedId, a.eventUid, a.eventDate);
      if(!idNew) return null;
      return { type: 'created', id: idNew };
    }
    case 'QUERY_TASKS':
    case 'GET_TASK_DETAIL':
    case 'GET_CALENDAR_EVENTS':
    case 'LIST_CATEGORIES':
    case 'LIST_LISTS':
      return { type: 'noop_read' };
    default: return null;
  }
  return snap;
}

function _pendingStableArrJson(arr){
  return JSON.stringify([...(arr || [])].map(String).sort());
}

function _pendingValsEqual(field, cur, next){
  if(cur === next) return true;
  if(Array.isArray(cur) && Array.isArray(next)){
    return _pendingStableArrJson(cur) === _pendingStableArrJson(next);
  }
  const c = cur == null || cur === '' ? null : cur;
  const n = next == null || next === '' ? null : next;
  return c === n;
}

function _humanizeFieldKey(k){
  const map = {
    priority: 'Priority',
    category: 'Life area',
    effort: 'Effort',
    energyLevel: 'Energy',
    tags: 'Tags',
    valuesAlignment: 'Values alignment',
    name: 'Name',
    status: 'Status',
    dueDate: 'Due date',
    startDate: 'Start date',
    description: 'Description',
    starred: 'Starred',
    listId: 'List',
  };
  if(map[k]) return map[k];
  return k.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
}

function _formatFieldDisplay(field, val){
  if(val == null || val === '') return '—';
  if(field === 'category'){
    const d = (typeof getCategoryDef === 'function') ? getCategoryDef(val) : null;
    return d ? d.label : String(val);
  }
  if(field === 'valuesAlignment' && Array.isArray(val)){
    return val.map(k => (SCHWARTZ[k] ? k.replace(/-/g, ' ') : k)).join(', ') || '—';
  }
  if(field === 'tags' && Array.isArray(val)){
    return val.length ? val.map(t => '#' + t).join(', ') : '—';
  }
  if(field === 'starred') return val ? 'Yes' : 'No';
  return String(val).slice(0, 120);
}

function _fieldConfidenceScore(fc, field){
  if(!fc || !fc[field]) return null;
  const o = fc[field];
  if(typeof o.confidence === 'number') return o.confidence;
  return null;
}

function _updateTaskFieldChanges(t, args, fieldConfidence){
  const skip = new Set(['id', 'valuesNote']);
  const out = [];
  if(!t){
    out.push({ field: '_missing', fromVal: null, toVal: null, confidence: null, note: 'Task not found' });
    return out;
  }
  Object.keys(args).forEach(k => {
    if(skip.has(k)) return;
    const v = args[k];
    const cur = t[k];
    if(_pendingValsEqual(k, cur, v)) return;
    let conf = _fieldConfidenceScore(fieldConfidence, k);
    const row = { field: k, fromVal: cur, toVal: v, confidence: conf, note: '' };
    out.push(row);
  });
  if(args.valuesNote && args.valuesAlignment){
    const row = out.find(x => x.field === 'valuesAlignment');
    if(row) row.note = String(args.valuesNote).slice(0, 200);
  }
  return out;
}

function _pendingConfPill(confidence){
  if(confidence == null || typeof confidence !== 'number') return '';
  const pct = Math.round(Math.max(0, Math.min(1, confidence)) * 100);
  return `<span class="pending-confidence-pill" title="Model vote confidence">${pct}%</span>`;
}

function _pendingIcon(name){
  return (window.icon && window.icon(name, { size: 14, cls: 'pending-simple-ic-svg' })) || '';
}

function _listNameById(listId){
  if(listId == null) return 'Inbox';
  const l = typeof lists !== 'undefined' ? lists.find(x => x.id === listId) : null;
  return l ? l.name : ('List #' + listId);
}

/** Single-line title from a task row (handles missing/non-string legacy data without throwing). */
function _intelFmtTaskTitle(task){
  if(!task || task.name == null) return '';
  return String(task.name).replace(/\s+/g, ' ').trim();
}

function _intelFmtArgName(args){
  if(!args || args.name == null) return '';
  return String(args.name).replace(/\s+/g, ' ').trim();
}

function _intelPreviewShortNameFromTaskArgs(t, a, max){
  const lim = typeof max === 'number' ? max : 56;
  const fromT = _intelFmtTaskTitle(t);
  if(fromT) return fromT.slice(0, lim);
  return _intelFmtArgName(a).slice(0, lim);
}

/**
 * @returns {{ kind:'update' } | { kind:'listMove', title:string, fromList:string, toList:string, icon:string, danger:boolean } | { kind:'simple', title:string, taskName:string, detail:string, icon:string, danger:boolean }}
 */
function _describeOpStructured(op){
  const a = op.args || {};
  const t = a.id ? findTask(a.id) : null;
  const taskName = _intelPreviewShortNameFromTaskArgs(t, a, 56);
  const parts = keys => keys.filter(k => a[k] != null).map(k => _humanizeFieldKey(k) + ': ' + _formatFieldDisplay(k, a[k])).join(' · ');

  switch(op.name){
    case 'UPDATE_TASK': return { kind: 'update' };
    case 'CREATE_TASK': return { kind: 'simple', title: 'Create task', taskName, detail: parts(['priority','category','dueDate','effort']), icon: 'plus', danger: false };
    case 'MARK_DONE': return { kind: 'simple', title: 'Mark done', taskName, detail: a.completionNote ? String(a.completionNote).slice(0, 72) : '', icon: 'check', danger: false };
    case 'REOPEN': return { kind: 'simple', title: 'Reopen', taskName, detail: '', icon: 'rotateCcw', danger: false };
    case 'TOGGLE_STAR': return { kind: 'simple', title: t?.starred ? 'Unstar' : 'Star', taskName, detail: '', icon: 'star', danger: false };
    case 'DELETE_TASK': return { kind: 'simple', title: 'Delete forever', taskName, detail: 'Permanent removal', icon: 'alertTriangle', danger: true };
    case 'DUPLICATE_TASK': return { kind: 'simple', title: 'Duplicate', taskName, detail: '', icon: 'copy', danger: false };
    case 'MOVE_TASK': return { kind: 'simple', title: 'Move in tree', taskName, detail: 'Parent #' + (a.newParentId || 'top'), icon: 'chevronRight', danger: false };
    case 'CHANGE_LIST': {
      const pv = op._preview && typeof op._preview === 'object' ? op._preview : {};
      const snapName = pv.taskName ? String(pv.taskName).trim().slice(0, 56) : '';
      return {
        kind: 'listMove',
        title: snapName || taskName || ('Task #' + a.id),
        fromList: pv.fromList ? String(pv.fromList) : _listNameById(t ? t.listId : null),
        toList: pv.toList ? String(pv.toList) : _listNameById(a.listId),
        icon: 'folder',
        danger: false,
      };
    }
    case 'ADD_NOTE': return { kind: 'simple', title: 'Add note', taskName, detail: String(a.text || '').slice(0, 72), icon: 'clipboard', danger: false };
    case 'ADD_CHECKLIST': return { kind: 'simple', title: 'Add checklist item', taskName, detail: String(a.text || '').slice(0, 72), icon: 'list', danger: false };
    case 'TOGGLE_CHECK': return { kind: 'simple', title: 'Toggle checklist item', taskName, detail: 'Item #' + a.checkId, icon: 'check', danger: false };
    case 'REMOVE_CHECK': return { kind: 'simple', title: 'Remove checklist item', taskName, detail: 'Item #' + a.checkId, icon: 'close', danger: false };
    case 'ADD_TAG': return { kind: 'simple', title: 'Add tag', taskName, detail: String(a.tag || ''), icon: 'plus', danger: false };
    case 'REMOVE_TAG': return { kind: 'simple', title: 'Remove tag', taskName, detail: String(a.tag || ''), icon: 'close', danger: false };
    case 'ADD_BLOCKER': {
      const b = findTask(a.blockerId);
      const bnm = _intelFmtTaskTitle(b).slice(0, 48);
      return { kind: 'simple', title: 'Add blocker', taskName, detail: bnm || ('#' + a.blockerId), icon: 'alertTriangle', danger: false };
    }
    case 'REMOVE_BLOCKER': return { kind: 'simple', title: 'Remove blocker', taskName, detail: 'Blocker #' + a.blockerId, icon: 'close', danger: false };
    case 'SET_REMINDER': return { kind: 'simple', title: 'Set reminder', taskName, detail: String(a.remindAt || ''), icon: 'timer', danger: false };
    case 'SET_RECUR': return { kind: 'simple', title: a.recur ? 'Set recurrence' : 'Clear recurrence', taskName, detail: a.recur ? String(a.recur) : '', icon: 'refresh', danger: false };
    case 'SNOOZE_TASK': return { kind: 'simple', title: 'Snooze', taskName, detail: a.untilDate ? `Until ${a.untilDate}` : '', icon: 'timer', danger: false };
    case 'RESCHEDULE': return { kind: 'simple', title: 'Reschedule', taskName, detail: [a.dueDate, a.remindAt].filter(Boolean).join(' · '), icon: 'refresh', danger: false };
    case 'SPLIT_TASK': {
      const nPart = (a.parts && a.parts.length) || 0;
      const first = (Array.isArray(a.parts) && a.parts[0] && a.parts[0].name) ? String(a.parts[0].name).trim() : '';
      const detail = nPart >= 2 && first
        ? `Rename to "${first.slice(0, 120)}" + ${nPart - 1} sibling(s)`
        : '';
      return { kind: 'simple', title: `Split into ${nPart} parts`, taskName, detail, icon: 'list', danger: false };
    }
    case 'CLASSIFY_TASK': {
      if(!t) return { kind: 'simple', title: 'Classify (life area)', taskName, detail: 'Task not found', icon: 'spark', danger: false };
      const pc = op._previewCategory;
      if(pc && pc.skip){
        const det = pc.reason === 'embed_unavailable'
          ? 'Couldn\'t classify (embeddings unavailable)'
          : 'No confident match — will skip';
        return { kind: 'simple', title: 'Classify (life area)', taskName, detail: det, icon: 'spark', danger: false };
      }
      if(pc && pc.nextCat){
        const d = (typeof getCategoryDef === 'function') ? getCategoryDef(pc.nextCat) : null;
        const label = d ? d.label : String(pc.nextCat);
        const pct = (typeof pc.confidence === 'number')
          ? Math.round(Math.max(0, Math.min(1, pc.confidence)) * 100)
          : '—';
        return { kind: 'simple', title: 'Classify (life area)', taskName, detail: `Propose: ${label} (${pct}%)`, icon: 'spark', danger: false };
      }
      return { kind: 'simple', title: 'Classify (life area)', taskName, detail: '', icon: 'spark', danger: false };
    }
    case 'CREATE_FROM_EVENT': return { kind: 'simple', title: 'Create task from event', taskName, detail: `feed ${a.feedId != null ? a.feedId : '—'}`, icon: 'plus', danger: false };
    default: return { kind: 'simple', title: op.name, taskName, detail: '', icon: 'gear', danger: false };
  }
}

function _pendingMasterCheckbox(idx){
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'pending-op-master';
  cb.setAttribute('data-op-idx', String(idx));
  cb.checked = true;
  return cb;
}

/** Mount a list-move preview: stacked title + route (full-width body; avoids grid squeeze hairlines). */
function _mountPendingListMoveCard(listEl, op, idx){
  const st = _describeOpStructured(op);
  if(st.kind !== 'listMove') return false;
  const card = document.createElement('div');
  card.className = 'pending-move-card';
  const lbl = document.createElement('label');
  lbl.className = 'pending-move-head';
  const icWrap = document.createElement('span');
  icWrap.className = 'pending-move-ic-wrap';
  icWrap.setAttribute('aria-hidden', 'true');
  if(st.icon) icWrap.innerHTML = _pendingIcon(st.icon);
  const body = document.createElement('div');
  body.className = 'pending-move-body';
  const titleEl = document.createElement('div');
  titleEl.className = 'pending-move-title';
  titleEl.textContent = st.title;
  const route = document.createElement('div');
  route.className = 'pending-move-route';
  const fromEl = document.createElement('span');
  fromEl.className = 'pending-field-val pending-field-from';
  fromEl.textContent = st.fromList;
  const arrow = document.createElement('span');
  arrow.className = 'pending-field-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '→';
  const toEl = document.createElement('span');
  toEl.className = 'pending-field-val pending-field-to';
  toEl.textContent = st.toList;
  route.append(fromEl, arrow, toEl);
  if(op._rationale){
    const pill = document.createElement('span');
    pill.className = 'pending-confidence-pill';
    pill.title = 'Embedding match';
    pill.textContent = String(op._rationale);
    route.appendChild(pill);
  }
  body.append(titleEl, route);
  lbl.setAttribute('aria-label', st.title + ': ' + st.fromList + ' → ' + st.toList);
  lbl.append(_pendingMasterCheckbox(idx), icWrap, body);
  card.appendChild(lbl);
  listEl.appendChild(card);
  return true;
}

function _renderPendingListMoveCard(op, idx){
  const st = _describeOpStructured(op);
  if(st.kind !== 'listMove') return '';
  const ic = st.icon ? _pendingIcon(st.icon) : '';
  const score = op._rationale
    ? `<span class="pending-confidence-pill" title="Embedding match">${esc(op._rationale)}</span>`
    : '';
  return `<div class="pending-move-card">
    <label class="pending-move-head">
      <input type="checkbox" class="pending-op-master" data-op-idx="${idx}" checked>
      <span class="pending-move-ic-wrap" aria-hidden="true">${ic}</span>
      <div class="pending-move-body">
        <div class="pending-move-title">${esc(st.title)}</div>
        <div class="pending-move-route">
          <span class="pending-field-val pending-field-from">${esc(st.fromList)}</span>
          <span class="pending-field-arrow" aria-hidden="true">→</span>
          <span class="pending-field-val pending-field-to">${esc(st.toList)}</span>
          ${score}
        </div>
      </div>
    </label>
  </div>`;
}

function _mountPendingSimpleCard(listEl, op, idx){
  const st = _describeOpStructured(op);
  if(st.kind === 'update' || st.kind === 'listMove') return false;
  const card = document.createElement('div');
  card.className = 'pending-simple-card' + (st.danger ? ' pending-simple-card--danger' : '');
  const lbl = document.createElement('label');
  lbl.className = 'pending-simple-row';
  const icWrap = document.createElement('span');
  icWrap.className = 'pending-simple-ic-wrap';
  icWrap.setAttribute('aria-hidden', 'true');
  if(st.icon) icWrap.innerHTML = _pendingIcon(st.icon);
  const textWrap = document.createElement('span');
  textWrap.className = 'pending-simple-text';
  const titleEl = document.createElement('span');
  titleEl.className = 'pending-simple-title';
  titleEl.textContent = st.title;
  textWrap.appendChild(titleEl);
  if(st.taskName){
    const target = document.createElement('span');
    target.className = 'pending-simple-target';
    target.textContent = '"' + st.taskName + '"';
    textWrap.appendChild(target);
  }
  if(st.detail){
    const det = document.createElement('span');
    det.className = 'pending-simple-detail';
    det.textContent = st.detail;
    textWrap.appendChild(det);
  }
  if(op._rationale){
    const rat = document.createElement('span');
    rat.className = 'pending-rationale';
    rat.title = 'Rationale';
    rat.textContent = String(op._rationale);
    textWrap.appendChild(rat);
  }
  lbl.append(_pendingMasterCheckbox(idx), icWrap, textWrap);
  card.appendChild(lbl);
  listEl.appendChild(card);
  return true;
}

function _renderPendingSimpleCard(op, idx){
  const st = _describeOpStructured(op);
  if(st.kind === 'update' || st.kind === 'listMove') return '';
  const ic = st.icon ? _pendingIcon(st.icon) : '';
  const rat = op._rationale ? `<span class="pending-rationale" title="Rationale">${esc(op._rationale)}</span>` : '';
  return `<div class="pending-simple-card${st.danger ? ' pending-simple-card--danger' : ''}">
    <label class="pending-simple-row">
      <input type="checkbox" class="pending-op-master" data-op-idx="${idx}" checked>
      <span class="pending-simple-ic-wrap" aria-hidden="true">${ic}</span>
      <span class="pending-simple-text">
        <span class="pending-simple-title">${esc(st.title)}</span>
        ${st.taskName ? `<span class="pending-simple-target">"${esc(st.taskName)}"</span>` : ''}
        ${st.detail ? `<span class="pending-simple-detail">${esc(st.detail)}</span>` : ''}
        ${rat}
      </span>
    </label>
  </div>`;
}

function _pendingListMoveSummary(ops){
  const moves = ops.filter(o => o && o.name === 'CHANGE_LIST');
  if(moves.length < 4) return '';
  const destCounts = new Map();
  moves.forEach(o => {
    const lid = o.args && o.args.listId;
    if(lid == null) return;
    destCounts.set(lid, (destCounts.get(lid) || 0) + 1);
  });
  const parts = [...destCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([lid, n]) => `${n} → ${_listNameById(lid)}`);
  const extra = destCounts.size > 5 ? ` · +${destCounts.size - 5} more lists` : '';
  return `<div class="pending-list-summary" role="note">${moves.length} list moves — ${parts.join(' · ')}${extra}</div>`;
}

function _mountPendingUpdateCard(listEl, op, idx){
  const t = findTask(op.args.id);
  const rawName = t && t.name ? String(t.name).trim() : '';
  const nm = rawName ? rawName.slice(0, 56) : ('Task #' + op.args.id);
  const changes = _updateTaskFieldChanges(t, op.args, op._fieldConfidence);
  if(!changes.length) return false;

  const card = document.createElement('div');
  card.className = 'pending-task-card';
  const head = document.createElement('div');
  head.className = 'pending-card-head';
  const headLbl = document.createElement('label');
  headLbl.className = 'pending-card-head-lbl';
  const titleEl = document.createElement('span');
  titleEl.className = 'pending-card-title';
  titleEl.textContent = nm;
  headLbl.append(_pendingMasterCheckbox(idx), titleEl);
  const badge = document.createElement('span');
  badge.className = 'pending-card-badge';
  badge.textContent = changes.length + ' field update' + (changes.length !== 1 ? 's' : '');
  head.append(headLbl, badge);
  card.appendChild(head);
  if(op._rationale){
    const rat = document.createElement('div');
    rat.className = 'pending-rationale pending-rationale--card';
    rat.title = 'Rationale';
    rat.textContent = String(op._rationale);
    card.appendChild(rat);
  }
  const changeList = document.createElement('div');
  changeList.className = 'pending-change-list';
  changes.forEach(ch => {
    if(ch.field === '_missing'){
      const row = document.createElement('div');
      row.className = 'pending-change-row pending-change-row--warn';
      const lblEl = document.createElement('span');
      lblEl.className = 'pending-field-lbl';
      lblEl.textContent = 'Issue';
      const val = document.createElement('span');
      val.className = 'pending-field-val';
      val.textContent = ch.note || '';
      row.append(lblEl, val);
      changeList.appendChild(row);
      return;
    }
    const row = document.createElement('label');
    row.className = 'pending-change-row';
    if(ch.note) row.title = ch.note;
    const fc = document.createElement('input');
    fc.type = 'checkbox';
    fc.className = 'pending-field-check';
    fc.setAttribute('data-op-idx', String(idx));
    fc.setAttribute('data-field', ch.field);
    fc.checked = true;
    const fieldLbl = document.createElement('span');
    fieldLbl.className = 'pending-field-lbl';
    fieldLbl.textContent = _humanizeFieldKey(ch.field);
    const vals = document.createElement('span');
    vals.className = 'pending-field-vals';
    const fromEl = document.createElement('span');
    fromEl.className = 'pending-field-val pending-field-from';
    fromEl.textContent = _formatFieldDisplay(ch.field, ch.fromVal);
    const arrow = document.createElement('span');
    arrow.className = 'pending-field-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '→';
    const toEl = document.createElement('span');
    toEl.className = 'pending-field-val pending-field-to';
    toEl.textContent = _formatFieldDisplay(ch.field, ch.toVal);
    vals.append(fromEl, arrow, toEl);
    row.append(fc, fieldLbl, vals);
    if(ch.confidence != null && typeof ch.confidence === 'number'){
      const pill = document.createElement('span');
      pill.className = 'pending-confidence-pill';
      pill.title = 'Model vote confidence';
      pill.textContent = Math.round(Math.max(0, Math.min(1, ch.confidence)) * 100) + '%';
      row.appendChild(pill);
    }
    changeList.appendChild(row);
  });
  card.appendChild(changeList);
  listEl.appendChild(card);
  return true;
}

function _renderPendingUpdateCard(op, idx){
  const t = findTask(op.args.id);
  const rawName = t && t.name ? String(t.name).trim() : '';
  const nm = rawName ? rawName.slice(0, 56) : ('Task #' + op.args.id);
  const changes = _updateTaskFieldChanges(t, op.args, op._fieldConfidence);
  if(!changes.length) return '';
  const rows = changes.map(ch => {
    if(ch.field === '_missing'){
      return `<div class="pending-change-row pending-change-row--warn">
        <span class="pending-field-lbl">Issue</span>
        <span class="pending-field-val">${esc(ch.note || '')}</span>
      </div>`;
    }
    const fromDisp = esc(_formatFieldDisplay(ch.field, ch.fromVal));
    const toDisp = esc(_formatFieldDisplay(ch.field, ch.toVal));
    const pill = _pendingConfPill(ch.confidence);
    const tip = ch.note ? esc(ch.note) : '';
    return `<label class="pending-change-row" ${tip ? `title="${tip}"` : ''}>
      <input type="checkbox" class="pending-field-check" data-op-idx="${idx}" data-field="${esc(ch.field)}" checked>
      <span class="pending-field-lbl">${esc(_humanizeFieldKey(ch.field))}</span>
      <span class="pending-field-vals"><span class="pending-field-val pending-field-from">${fromDisp}</span>
      <span class="pending-field-arrow" aria-hidden="true">→</span>
      <span class="pending-field-val pending-field-to">${toDisp}</span></span>
      ${pill}
    </label>`;
  }).join('');
  const rat = op._rationale ? `<div class="pending-rationale pending-rationale--card" title="Rationale">${esc(op._rationale)}</div>` : '';
  return `<div class="pending-task-card">
    <div class="pending-card-head">
      <label class="pending-card-head-lbl">
        <input type="checkbox" class="pending-op-master" data-op-idx="${idx}" checked>
        <span class="pending-card-title">${esc(nm)}</span>
      </label>
      <span class="pending-card-badge">${changes.length} field update${changes.length !== 1 ? 's' : ''}</span>
    </div>
    ${rat}
    <div class="pending-change-list">${rows}</div>
  </div>`;
}

function _pushUndo(label, snaps){
  _undoStack.unshift({ timestamp: Date.now(), label, snapshots: snaps });
  if(_undoStack.length > 10) _undoStack.pop();
}

function aiUndo(){
  const b = _undoStack.shift();
  if(!b){ _setIntelStatus('idle', 'Nothing to undo'); _renderUndoBtn(); return; }
  const flat = [];
  b.snapshots.forEach(s => {
    if(s.type === 'batch' && Array.isArray(s.snaps)) flat.push(...s.snaps);
    else flat.push(s);
  });
  flat.forEach(s => {
    if(!s || s.type === 'noop' || s.type === 'noop_read') return;
    if(s.type === 'created') tasks = tasks.filter(t => t.id !== s.id);
    else if(s.type === 'updated'){ const t = findTask(s.id); if(t) Object.assign(t, s.before); }
    else if(s.type === 'deleted'){
      tasks.push(s.before);
      if(Array.isArray(s.subtree)) tasks.push(...s.subtree);
    }
  });
  if(typeof rebuildTaskIdIndex === 'function') rebuildTaskIdIndex();
  saveState('user');
  if(typeof renderTaskList === 'function') renderTaskList();
  _renderUndoBtn();
  _setIntelStatus('ready', `Reverted ${flat.length} change${flat.length !== 1 ? 's' : ''}`);
}

function _intelIc(paths){
  return '<svg class="intel-action-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
}
const _IC = {
  bolt: _intelIc('<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>'),
  harmonize: _intelIc('<path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><path d="M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="3"/>'),
  folder: _intelIc('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
  duplicate: _intelIc('<rect x="8" y="8" width="13" height="13" rx="2" ry="2"/><path d="M4 16H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v1"/>'),
  refresh: _intelIc('<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/>'),
  undo: _intelIc('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>'),
  search: _intelIc('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
  spark: _intelIc('<path d="M12 3c.5 2.5 2 4 4.5 4.5-2.5.5-4 2-4.5 4.5-.5-2.5-2-4-4.5-4.5 2.5-.5 4-2 4.5-4.5z"/>'),
};

function _renderUndoBtn(){
  const btn = document.getElementById('intelUndoBtn');
  if(!btn) return;
  btn.hidden = !(_undoStack.length);
  btn.innerHTML = _IC.undo + '<span>Undo (' + _undoStack.length + ')</span>';
  if(_undoStack.length){
    const top = _undoStack[0];
    btn.title = 'Undo: ' + (top.label || 'last batch');
  } else {
    btn.title = '';
  }
}

function _mountPendingOpCard(listEl, op, idx){
  if(!op || !listEl) return false;
  if(op.name === 'UPDATE_TASK') return _mountPendingUpdateCard(listEl, op, idx);
  if(op.name === 'CHANGE_LIST') return _mountPendingListMoveCard(listEl, op, idx);
  return _mountPendingSimpleCard(listEl, op, idx);
}

/** True when the pending preview already has readable row copy (not empty shells). */
function _pendingListHasVisibleText(wrap){
  if(!wrap) return false;
  const nodes = wrap.querySelectorAll(
    '.pending-move-title, .pending-move-route, .pending-simple-title, .pending-card-title, .pending-field-lbl, .pending-field-val, .pending-route-vals'
  );
  for(let i = 0; i < nodes.length; i++){
    if(String(nodes[i].textContent || '').trim()) return true;
  }
  return false;
}

function _renderPendingOps(){
  const wrap = document.getElementById('intelPendingOps');
  if(!wrap) return;
  if(!_pendingOps.length){ wrap.innerHTML = ''; wrap.hidden = true; return; }
  wrap.hidden = false;

  const dangerIdx = [];
  _pendingOps.forEach((op, i) => { if(op && op.name === 'DELETE_TASK') dangerIdx.push(i); });
  const listMoveSummary = _pendingListMoveSummary(_pendingOps);

  const sourceBadge = _pendingSource ? `<span class="pending-source-badge" title="Proposed via ${esc(_pendingSource)}">via ${esc(_pendingSource)}</span>` : '';
  const massWarn = (_pendingDestructive === 'hard' && !dangerIdx.length) ? `
    <div class="pending-mass-warn" role="note">
      <strong>Heads up:</strong> this batch contains multiple destructive actions (delete / move across lists). Review carefully before applying — you can undo, but it affects many tasks at once.
    </div>` : '';

  wrap.innerHTML = `
    <div class="pending-hdr">
      <span class="pending-title">Proposed changes (${_pendingOps.length})${sourceBadge}</span>
      <button type="button" class="pending-toggle-all" data-action="intelToggleAllPending">Toggle all</button>
    </div>
    ${massWarn}
    ${listMoveSummary}
    <div class="pending-list"></div>
    <div class="pending-danger-mount"></div>
    <div class="pending-actions">
      <button type="button" class="btn-ghost btn-sm" data-action="intelRejectPending">Reject all</button>
      <button type="button" class="btn-primary btn-sm" data-action="intelApplyPending">Apply selected</button>
    </div>`;

  const listEl = wrap.querySelector('.pending-list');
  let rendered = 0;
  _pendingOps.forEach((op, i) => {
    if(!op || op.name === 'DELETE_TASK') return;
    if(_mountPendingOpCard(listEl, op, i)) rendered++;
  });
  if(!rendered){
    const hint = document.createElement('div');
    hint.className = 'pending-empty-hint';
    hint.setAttribute('role', 'note');
    hint.textContent = 'Preview rows could not be built for these proposals. Reject all and try the action again.';
    listEl.appendChild(hint);
  }

  if(dangerIdx.length){
    const dangerMount = wrap.querySelector('.pending-danger-mount');
    dangerMount.innerHTML = `
      <div class="pending-section-danger">
        <div class="pending-section-danger-hdr">
          <span class="pending-section-danger-ic" aria-hidden="true">${_pendingIcon('alertTriangle')}</span>
          <span class="pending-section-danger-title">Destructive actions</span>
        </div>
        <p class="pending-section-danger-copy">Permanent delete cannot be undone. Confirm to enable applying those rows.</p>
        <label class="pending-danger-ack-lbl">
          <input type="checkbox" id="pendingDangerAck" autocomplete="off">
          <span>I understand — allow permanent delete</span>
        </label>
        <div class="pending-danger-list"></div>
      </div>`;
    const dangerList = dangerMount.querySelector('.pending-danger-list');
    dangerIdx.forEach(i => { _mountPendingSimpleCard(dangerList, _pendingOps[i], i); });
  }

  _setIntelStatus('idle', 'Review proposed changes below');
}

function intelToggleAllPending(){
  const masters = document.querySelectorAll('#intelPendingOps .pending-op-master');
  if(!masters.length) return;
  const allOn = [...masters].every(c => c.checked);
  masters.forEach(c => { c.checked = !allOn; });
}

function intelRejectPending(){
  _pendingOps = [];
  _pendingDestructive = 'none';
  _pendingSource = null;
  _renderPendingOps();
  _setIntelStatus('ready', 'Ready');
}

/**
 * Seed the existing preview pipeline with externally-proposed ops. Respects
 * the same checkbox/undo machinery as harmonize/auto-organize. Never
 * auto-applies.
 *
 * @param {Array<{name:string,args:object}>} ops
 * @param {{ source?:string, destructiveLevel?:'none'|'warn'|'hard' }} [meta]
 */
async function acceptProposedOps(ops, meta){
  // Stash overflow so the user can actually continue from where the cap cut
  // them off — "re-run to continue" used to be a lie because the source ops
  // were lost (#7 in UX audit). The "Show next batch" button below replays
  // the deferred slice through the same review flow.
  let overflow = null;
  if(Array.isArray(ops) && ops.length > 50){
    console.warn('[ask] Proposed op list truncated from', ops.length, 'to first 50');
    overflow = ops.slice(50);
    if(typeof showActionToast === 'function'){
      const remaining = overflow.length;
      showActionToast(
        'Reviewing first 50 of ' + ops.length + ' proposed changes',
        'Show next ' + Math.min(50, remaining),
        () => { acceptProposedOps(overflow, meta); },
        8000
      );
    } else if(typeof showExportToast === 'function'){
      showExportToast('Reviewing first 50 of ' + ops.length + ' proposed changes — ' + overflow.length + ' more queued.');
    }
  }
  const list = Array.isArray(ops) ? ops.slice(0, 50) : [];
  // Park the deferred slice so an explicit follow-up trigger (or a future
  // "Continue" button) can pick it up without re-running the LLM/proposal.
  _pendingOverflowOps = overflow;
  const classifyIdx = [];
  list.forEach((op, i) => { if(op && op.name === 'CLASSIFY_TASK') classifyIdx.push(i); });
  await Promise.all(classifyIdx.map(async (i) => {
    const op = list[i];
    if(typeof predictClassifyCategory !== 'function') return;
    const id = op.args && op.args.id;
    try{
      const pred = await predictClassifyCategory(id);
      if(pred && pred.skip) op._previewCategory = { skip: true, beforeCat: pred.beforeCat };
      else if(pred && pred.nextCat) op._previewCategory = { nextCat: pred.nextCat, beforeCat: pred.beforeCat, confidence: pred.confidence };
      else if(pred == null) op._previewCategory = { skip: true, reason: 'embed_unavailable', beforeCat: (op.args && findTask(op.args.id)) ? (findTask(op.args.id).category || null) : null };
    }catch(_){
      op._previewCategory = { skip: true, reason: 'embed_unavailable' };
    }
  }));
  _pendingOps = list;
  _pendingDestructive = (meta && meta.destructiveLevel) || 'none';
  _pendingSource = (meta && meta.source) || null;
  _renderPendingOps();
  if(list.length && typeof showTab === 'function') showTab('tools');
  if(list.length){
    setTimeout(() => {
      const wrap = document.getElementById('intelPendingOps');
      if(wrap && typeof wrap.scrollIntoView === 'function') wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
    _setIntelStatus('idle', `Review ${list.length} proposed change${list.length !== 1 ? 's' : ''}`);
  } else {
    _setIntelStatus('ready', 'No changes proposed');
  }
}

async function intelReclassifyUncategorized(){
  if(typeof isIntelReady !== 'function' || !isIntelReady()){
    _setIntelStatus('error', 'Load embeddings first (Tools tab or header chip)');
    return;
  }
  if(typeof proposeReclassifyUncategorized !== 'function') return;
  const ops = await proposeReclassifyUncategorized();
  if(!ops.length){
    _setIntelStatus('ready', 'No uncategorized tasks or no confident life-area match');
    return;
  }
  await acceptProposedOps(ops, { source: 'reclassify', destructiveLevel: 'none' });
}

/**
 * When Apply should prompt for the hard bulk (delete / move) confirmation.
 * DELETE_TASK uses the checkbox ack in the panel instead of this dialog.
 */
function intelHardBulkConfirmNeeded(pendingOps, destructiveLevel){
  if(!Array.isArray(pendingOps) || !pendingOps.length) return false;
  const hasDelete = pendingOps.some(o => o && o.name === 'DELETE_TASK');
  if(hasDelete) return false;
  return destructiveLevel === 'hard';
}

/** Auto-apply / one-shot confirm: deletes or warn/hard bulk batches. */
function askDestructiveConfirmNeeded(ops, destructiveLevel){
  if(!Array.isArray(ops) || !ops.length) return false;
  if(ops.some(o => o && o.name === 'DELETE_TASK')) return true;
  return destructiveLevel === 'warn' || destructiveLevel === 'hard';
}

function _formatOpSummaryLabel(op){
  if(!op || !op.name) return '';
  const st = _describeOpStructured(op);
  if(st.kind === 'simple') return st.title + (st.taskName ? ': ' + st.taskName : '');
  if(st.kind === 'listMove') return st.title + ': ' + st.fromList + ' → ' + st.toList;
  if(st.kind === 'update'){
    const t = op.args && op.args.id ? findTask(op.args.id) : null;
    const nm = _intelPreviewShortNameFromTaskArgs(t, op.args || {}, 40);
    return 'Update ' + (nm || ('#' + op.args.id));
  }
  return op.name;
}

function summarizeOpsLabels(ops, max){
  max = max == null ? 5 : max;
  if(!Array.isArray(ops)) return [];
  return ops.slice(0, max).map(_formatOpSummaryLabel).filter(Boolean);
}

function _allSelectedOpsFromList(pendingOps){
  const selOps = [];
  for(let idx = 0; idx < pendingOps.length; idx++){
    const op = pendingOps[idx];
    if(!op || !op.name) continue;
    if(op.name !== 'UPDATE_TASK'){
      const next = { name: op.name, args: { ...op.args } };
      if(op._previewCategory) next._previewCategory = op._previewCategory;
      selOps.push(next);
      continue;
    }
    const nextArgs = { id: op.args.id };
    Object.keys(op.args || {}).forEach(f => {
      if(f === 'id') return;
      if(op.args[f] !== undefined) nextArgs[f] = op.args[f];
    });
    if(nextArgs.valuesAlignment !== undefined && op.args.valuesNote){
      nextArgs.valuesNote = op.args.valuesNote;
    }
    if(Object.keys(nextArgs).length <= 1) continue;
    selOps.push({ name: 'UPDATE_TASK', args: nextArgs });
  }
  return selOps;
}

function _selectedOpsFromPendingDom(pendingOps){
  const selOps = [];
  for(let idx = 0; idx < pendingOps.length; idx++){
    const master = document.querySelector('#intelPendingOps .pending-op-master[data-op-idx="' + idx + '"]');
    if(!master || !master.checked) continue;
    const op = pendingOps[idx];

    if(op.name !== 'UPDATE_TASK'){
      const next = { name: op.name, args: { ...op.args } };
      if(op._previewCategory) next._previewCategory = op._previewCategory;
      selOps.push(next);
      continue;
    }

    const nextArgs = { id: op.args.id };
    document.querySelectorAll('#intelPendingOps .pending-field-check[data-op-idx="' + idx + '"]').forEach(fc => {
      if(!fc.checked) return;
      const f = fc.getAttribute('data-field');
      if(!f || f === '_missing') return;
      if(op.args[f] !== undefined) nextArgs[f] = op.args[f];
    });
    if(nextArgs.valuesAlignment !== undefined && op.args.valuesNote){
      nextArgs.valuesNote = op.args.valuesNote;
    }
    if(Object.keys(nextArgs).length <= 1) continue;
    selOps.push({ name: 'UPDATE_TASK', args: nextArgs });
  }
  return selOps;
}

async function _enrichClassifyOps(list){
  const classifyIdx = [];
  list.forEach((op, i) => { if(op && op.name === 'CLASSIFY_TASK') classifyIdx.push(i); });
  await Promise.all(classifyIdx.map(async (i) => {
    const op = list[i];
    if(typeof predictClassifyCategory !== 'function') return;
    const id = op.args && op.args.id;
    try{
      const pred = await predictClassifyCategory(id);
      if(pred && pred.skip) op._previewCategory = { skip: true, beforeCat: pred.beforeCat };
      else if(pred && pred.nextCat) op._previewCategory = { nextCat: pred.nextCat, beforeCat: pred.beforeCat, confidence: pred.confidence };
      else if(pred == null) op._previewCategory = { skip: true, reason: 'embed_unavailable', beforeCat: (op.args && findTask(op.args.id)) ? (findTask(op.args.id).category || null) : null };
    }catch(_){
      op._previewCategory = { skip: true, reason: 'embed_unavailable' };
    }
  }));
}

/**
 * Headless apply path for Ask auto-apply and inline chat Apply.
 * Caller must run destructive confirms before setting confirmedDestructive.
 *
 * @returns {Promise<{ ok:boolean, applied:number, failures:string[], snaps:Array, labels:string[], cancelled?:boolean, reason?:string }>}
 */
async function applyOpsBatch(selOps, meta, opts){
  meta = meta || {};
  opts = opts || {};
  if(!Array.isArray(selOps) || !selOps.length){
    return { ok: false, applied: 0, failures: [], snaps: [], labels: [] };
  }

  const destructiveLevel = meta.destructiveLevel || 'none';
  const hasDelete = selOps.some(o => o && o.name === 'DELETE_TASK');

  if(hasDelete && !opts.confirmedDestructive){
    let ackOk = false;
    if(typeof document !== 'undefined'){
      const dangerAck = document.getElementById('pendingDangerAck');
      ackOk = !!(dangerAck && dangerAck.checked);
    }
    if(!ackOk){
      return { ok: false, applied: 0, failures: [], snaps: [], labels: [], cancelled: true, reason: 'DELETE_ACK' };
    }
  }

  const source = meta.source || null;
  const showToast = opts.showToast !== false;
  const clearPending = opts.clearPending !== false;

  await _enrichClassifyOps(selOps);

  const snaps = [];
  let applied = 0;
  const failures = [];
  for(const op of selOps){
    try{
      const s = op.name === 'CLASSIFY_TASK' && typeof executeClassifyTaskOp === 'function'
        ? await executeClassifyTaskOp(op)
        : executeIntelOp(op);
      if(s){
        if(s.type !== 'noop' && s.type !== 'noop_read') snaps.push(s);
        applied++;
      }else{
        let reason = 'unknown';
        if(op.args && op.args.id && !findTask(op.args.id)) reason = `task #${op.args.id} not found`;
        failures.push(`${op.name}: ${reason}`);
      }
    }catch(e){
      failures.push(`${op.name}: ${(e && e.message ? e.message : 'error').slice(0, 50)}`);
    }
  }

  const labels = summarizeOpsLabels(selOps, 8);

  if(snaps.length){
    const sourceTag = source ? ` via ${source}` : '';
    _pushUndo(`${applied} change${applied !== 1 ? 's' : ''}${sourceTag}`, snaps);
    saveState('user');
    if(typeof renderTaskList === 'function') renderTaskList();
    if(typeof renderBanner === 'function') renderBanner();
    if(typeof renderLists === 'function') renderLists();
    _renderUndoBtn();
    if(showToast && typeof showActionToast === 'function'){
      const label = `Applied ${applied} change${applied !== 1 ? 's' : ''}${source ? ' (' + source + ')' : ''}`;
      showActionToast(label, 'Undo', () => {
        if(typeof aiUndo === 'function') aiUndo();
      }, 6000);
    }
    const changedIds = new Set();
    snaps.forEach(s => {
      if(s.type === 'batch' && Array.isArray(s.snaps)) s.snaps.forEach(x => x.id && changedIds.add(x.id));
      else if(s.id) changedIds.add(s.id);
    });
    setTimeout(() => {
      if(typeof document === 'undefined') return;
      changedIds.forEach(id => {
        const row = document.querySelector('.task-item[data-task-id="' + id + '"]');
        if(row){
          row.classList.add('intel-modified');
          setTimeout(() => row.classList.remove('intel-modified'), 1500);
        }
      });
    }, 50);
  }

  if(failures.length && showToast){
    if(typeof showActionToast === 'function'){
      showActionToast(
        `${failures.length} change${failures.length !== 1 ? 's' : ''} could not be applied`,
        'Show why',
        () => {
          const detail = failures.slice(0, 10).join('\n') + (failures.length > 10 ? `\n…and ${failures.length - 10} more` : '');
          if(typeof showAppConfirm === 'function') showAppConfirm(detail);
          else if(typeof showExportToast === 'function') showExportToast(detail);
          else alert(detail);
        },
        8000
      );
    } else if(typeof showExportToast === 'function'){
      showExportToast(`${failures.length} failed — ${failures.slice(0, 2).join('; ')}${failures.length > 2 ? '…' : ''}`);
    }
  }

  if(clearPending){
    _pendingOps = [];
    _pendingDestructive = 'none';
    _pendingSource = null;
    _renderPendingOps();
  }

  if(typeof _setIntelStatus === 'function'){
    _setIntelStatus('ready', failures.length ? `Applied ${applied}, ${failures.length} failed` : `Applied ${applied}`);
  }

  return { ok: applied > 0 || !failures.length, applied, failures, snaps, labels };
}

async function intelApplyPending(){
  const hasDelete = _pendingOps.some(o => o.name === 'DELETE_TASK');
  const dangerAck = document.getElementById('pendingDangerAck');
  if(hasDelete && (!dangerAck || !dangerAck.checked)){
    _setIntelStatus('error', 'Confirm permanent delete below');
    return;
  }
  if(intelHardBulkConfirmNeeded(_pendingOps, _pendingDestructive)){
    const msg = 'Proposed changes include bulk destructive actions (delete/move to list). Apply anyway?';
    if(typeof showAppConfirm === 'function'){
      if(!(await showAppConfirm(msg))){ _setIntelStatus('ready', 'Cancelled'); return; }
    }else if(typeof window !== 'undefined' && typeof window.confirm === 'function'){
      if(!window.confirm(msg)){ _setIntelStatus('ready', 'Cancelled'); return; }
    }
  }

  const selOps = _selectedOpsFromPendingDom(_pendingOps);
  if(!selOps.length){ intelRejectPending(); return; }

  await applyOpsBatch(selOps, { source: _pendingSource, destructiveLevel: _pendingDestructive }, {
    confirmedDestructive: true,
    clearPending: true,
  });
}

function _setIntelStateClass(el, state){
  el.className = 'intel-status intel-status-chip intel-status--' + (
    state === 'ready' ? 'ok' : state === 'error' ? 'error' :
      state === 'working' ? 'syncing' : state === 'loading' ? 'syncing' : 'idle');
}

function _setIntelStatus(state, msg){
  const el = document.getElementById('intelStatus');
  if(el){
    el.textContent = msg;
    _setIntelStateClass(el, state);
  }
  syncHeaderAIChip(state, msg);
}


function _llmWithTimeout(promise, ms){
  if(!promise || typeof promise.then !== 'function') return Promise.resolve(null);
  const timeout = new Promise(resolve => setTimeout(() => resolve(null), ms));
  return Promise.race([
    promise.then(v => v == null ? null : v, () => null),
    timeout,
  ]);
}

/** Min per-field confidence across the fields actually being changed by this op. */
function _opMinFieldConfidence(op){
  const fc = op && op._fieldConfidence;
  if(!fc || !op.args) return 1;
  let min = 1;
  for(const k of Object.keys(op.args)){
    if(k === 'id') continue;
    const entry = fc[k];
    if(entry && typeof entry.confidence === 'number' && entry.confidence < min){
      min = entry.confidence;
    }
  }
  return min;
}

/**
 * Walk `ops` (UPDATE_TASK) and ask the LLM to prune low-confidence fields
 * plus attach a short rationale. Only runs when the LLM is loaded and when
 * at least one field on that op scored < `lowConfThreshold`. Hard-capped at
 * `maxRefines` calls so harmonize doesn't hang for a minute on a 500-task
 * workspace. Silently no-ops on any failure.
 */
async function _refineOpsWithLLM(ops, { lowConfThreshold = 0.7, maxRefines = 6, perCallMs = 12000 } = {}){
  if(typeof isGenReady !== 'function' || !isGenReady()) return 0;
  if(typeof genRefineTaskUpdate !== 'function') return 0;
  let refined = 0;
  let attempts = 0;
  for(const op of ops){
    if(op.name !== 'UPDATE_TASK') continue;
    if(attempts >= maxRefines) break;
    if(_opMinFieldConfidence(op) >= lowConfThreshold) continue;
    const t = findTask(op.args.id);
    if(!t) continue;
    const proposed = { ...op.args };
    delete proposed.id;
    const fieldConfMap = {};
    if(op._fieldConfidence){
      for(const k of Object.keys(proposed)){
        const e = op._fieldConfidence[k];
        fieldConfMap[k] = e && typeof e.confidence === 'number' ? Number(e.confidence.toFixed(2)) : null;
      }
    }
    attempts++;
    const res = await _llmWithTimeout(
      genRefineTaskUpdate({ name: t.name, description: t.description, tags: t.tags }, proposed, fieldConfMap),
      perCallMs,
    );
    if(!res) continue;
    // Prune fields the LLM dropped; keep `id` and `valuesNote` (tied to valuesAlignment).
    const nextArgs = { id: op.args.id };
    for(const [k, v] of Object.entries(res.accept || {})) nextArgs[k] = v;
    if(nextArgs.valuesAlignment && op.args.valuesNote) nextArgs.valuesNote = op.args.valuesNote;
    // An LLM that drops everything is a strong "no" — skip the op entirely.
    const kept = Object.keys(nextArgs).filter(k => k !== 'id');
    if(!kept.length){
      op._rejectedByLLM = true;
      op._rationale = res.rationale || 'LLM suggested no change';
      continue;
    }
    op.args = nextArgs;
    if(res.rationale) op._rationale = res.rationale;
    refined++;
  }
  return refined;
}

async function aiAlign(){
  if(typeof isIntelReady !== 'function' || !isIntelReady()){
    _setIntelStatus('error', 'Load the model first (AI chip or Tools)');
    return;
  }
  if(_intelBusy){ _setIntelStatus('error', 'Busy — try again'); return; }
  _loadCfg();
  if(_cfg.dominant.length < 2){ _setIntelStatus('error', 'Pick 2–3 values first'); return; }
  _intelBusy = true;
  _setIntelStatus('working', 'Aligning…');

  try{
    await ensureSchwartzEmbeddings();
    const active = tasks.filter(t => !t.archived && t.status !== 'done').slice(0, 200);
    const ops = [];
    for(const t of active){
      // Yield between iterations so the AI panel can repaint — alignValuesForTask
      // may call embedText on a cache miss, which blocks the main thread.
      await new Promise(r => setTimeout(r, 0));
      const vals = await alignValuesForTask(t.id);
      if(!vals.length) continue;
      const filtered = vals.filter(v => _cfg.dominant.includes(v));
      const use = filtered.length ? filtered : vals.slice(0, 2);
      if(!use.length) continue;
      const before = JSON.stringify([...(t.valuesAlignment || [])].map(String).sort());
      const after = JSON.stringify([...use].map(String).sort());
      if(before === after) continue;
      ops.push({
        name: 'UPDATE_TASK',
        args: {
          id: t.id,
          valuesAlignment: use,
          valuesNote: 'Cosine similarity vs Schwartz value descriptions',
        },
      });
    }
    if(!ops.length){
      _setIntelStatus('ready', 'No alignment suggestions');
      return;
    }
    await acceptProposedOps(ops, { source: 'align-values', destructiveLevel: 'none' });
  }catch(err){
    console.warn('[aiAlign]', err);
    _setIntelStatus('error', (err.message || String(err)).slice(0, 80));
    const msg = (err && err.message) ? String(err.message).slice(0, 120) : 'failed';
    if(typeof showActionToast === 'function'){
      showActionToast('Values alignment failed: ' + msg, 'Retry', () => aiAlign());
    }
  }finally{
    _intelBusy = false;
  }
}

function aiToggleValue(key){
  _loadCfg();
  const i = _cfg.dominant.indexOf(key);
  if(i >= 0) _cfg.dominant.splice(i, 1);
  else {
    if(_cfg.dominant.length >= 3){ _setIntelStatus('error', 'Max 3'); return; }
    _cfg.dominant.push(key);
  }
  _saveCfg();
  _renderValuesGrid();
  _syncAlignButton();
}

/** Surgically update the Align-values button after dominant selection changes. */
function _syncAlignButton(){
  const btn = document.getElementById('alignValuesBtn');
  if(!btn) return;
  const ready = isIntelReady();
  const ok = ready && _cfg.dominant.length >= 2;
  btn.disabled = !ok;
  const sub = btn.querySelector('.intel-action-btn-sub');
  if(sub){
    const failed = _embedChipState === 'error';
    sub.textContent = !ready ? (failed ? 'Model unavailable \u2014 tap Retry above' : 'Embedding model loading\u2026')
      : _cfg.dominant.length < 2 ? 'Pick 2\u20133 dominant values below'
      : 'Align to ' + _cfg.dominant.join(', ');
  }
}

function _renderBreakdown(){
  const el = document.getElementById('intelBreakdown');
  if(!el) return;
  const a = tasks.filter(t => t.status !== 'done' && !t.archived && t.category);
  const by = {};
  a.forEach(t => {
    if(!by[t.category]) by[t.category] = { count: 0, urgent: 0, high: 0 };
    by[t.category].count++;
    if(t.priority === 'urgent') by[t.category].urgent++;
    if(t.priority === 'high') by[t.category].high++;
  });
  const rows = Object.entries(by).sort((x, y) => y[1].count - x[1].count).map(([c, s]) => {
    const def = (typeof getCategoryDef === 'function') ? getCategoryDef(c) : null;
    const lbl = def ? def.label : c;
    const icn = def ? def.icon : (CAT_ICON[c] || 'pin');
    return `
    <div class="breakdown-row">
      <span class="breakdown-cat"><span class="breakdown-cat-ic">${(window.icon && window.icon(icn, {size:14})) || ''}</span> ${esc(lbl)}</span>
      <span class="breakdown-count">${s.count}</span>
      ${s.urgent ? `<span class="breakdown-badge urgent">${s.urgent}!</span>` : ''}
      ${s.high ? `<span class="breakdown-badge high">${s.high}↑</span>` : ''}
    </div>`;
  }).join('');
  el.innerHTML = rows || '<span class="text-12-muted">Run alignment to see</span>';
}

function _renderValuesGrid(){
  const el = document.getElementById('intelValuesGrid');
  if(!el) return;
  _loadCfg();
  el.innerHTML = VALUE_KEYS.map(key => {
    const v = SCHWARTZ[key];
    const sel = _cfg.dominant.includes(key);
    const rank = sel ? _cfg.dominant.indexOf(key) + 1 : null;
    return `<div class="schwartz-card ${sel ? 'selected' : ''}" data-action="aiToggleValue" data-arg="${key}">
      <div class="schwartz-card-top">
        <span class="schwartz-icon">${(window.icon && window.icon(v.icon, {size:16})) || ''}</span>
        <span class="schwartz-name">${key}</span>
        ${sel ? `<span class="schwartz-rank">#${rank}</span>` : ''}
      </div>
      <div class="schwartz-short">${esc(v.def)}</div>
    </div>`;
  }).join('');
}

function renderAIPanel(){
  const panel = document.getElementById('intelPanel');
  if(!panel) return;
  const livePending = document.getElementById('intelPendingOps');
  const keepPending = (livePending && _pendingOps.length > 0 && _pendingListHasVisibleText(livePending))
    ? livePending
    : null;
  if(keepPending) keepPending.remove();
  _loadCfg();
  const ready = typeof isIntelReady === 'function' && isIntelReady();
  const failed = !ready && _embedChipState === 'error';
  const dev = typeof getIntelDevice === 'function' ? getIntelDevice() : null;
  const statusKind = ready ? 'ok' : (failed ? 'error' : 'idle');
  // Distinguish "actively loading" from "idle, has never started" so users
  // who haven't clicked anything don't see "Loading model…" with 0%
  // activity and assume the app is broken (#4 in UX audit).
  const isLoading = _embedChipState === 'loading' || _embedChipState === 'working' || _embedChipState === 'syncing';
  const statusText = ready
    ? 'Ready · ' + (dev || 'CPU')
    : failed ? (_embedChipMsg ? String(_embedChipMsg).slice(0, 64) : 'Could not load model')
    : isLoading ? 'Loading model…'
    : '~33 MB · loads on first AI feature';
  const disabledSub = ready ? '' : failed ? 'Model unavailable — tap Retry above'
    : isLoading ? 'Embedding model loading…'
    : 'Embedding model will load on first AI feature';

  const embedModel = (typeof window !== 'undefined' && window.INTEL_EMBED_MODEL) || 'Xenova/bge-base-en-v1.5';
  panel.innerHTML = `
    <div class="intel-card">
      <div class="intel-card-head">
        <div class="intel-card-titles">
          <h3 class="intel-card-h3">Task understanding</h3>
          <span class="intel-card-badge">On device</span>
        </div>
        <div id="intelStatus" class="intel-status intel-status-chip intel-status--${statusKind}" role="status">
          ${statusText}
        </div>
      </div>
      <div class="intel-card-body">
        <div class="intel-desc intel-desc-short">
          <p class="intel-lead"><strong>Understand your tasks</strong> — runs on this device. <span class="intel-nogen">No cloud, no chat — embeddings only.</span></p>
          <div class="intel-feature-grid">
            <div class="intel-feature">
              <span class="intel-feature-ic" aria-hidden="true">${_IC.search}</span>
              <div class="intel-feature-txt"><strong>Semantic search</strong><span class="intel-feature-sub">Tasks tab — toggle next to search</span></div>
            </div>
            <div class="intel-feature">
              <span class="intel-feature-ic" aria-hidden="true">${_IC.spark}</span>
              <div class="intel-feature-txt"><strong>Smart-add</strong><span class="intel-feature-sub">Button beside the new-task field</span></div>
            </div>
            <div class="intel-feature">
              <span class="intel-feature-ic" aria-hidden="true">${_IC.harmonize}</span>
              <div class="intel-feature-txt"><strong>Bulk cleanup</strong><span class="intel-feature-sub">Preview changes before you apply</span></div>
            </div>
          </div>
          <details class="intel-details"><summary>How it works</summary>
            <p class="intel-details-body">An on-device embedding model (<strong>${embedModel}</strong>, ~33 MB) encodes each task’s meaning as a vector. Cosine similarity drives semantic search, duplicate detection, smart-add hints, list routing, similar tasks, and harmonize proposals. Your task text stays local.</p>
          </details>
        </div>
        <div id="intelProgressWrap" class="intel-progress-wrap" hidden>
          <div class="intel-progress-track"><div class="intel-progress-bar progress-bar" id="intelProgressBar"></div></div>
          <div class="intel-progress-info"><span id="intelProgressPct">0%</span> <span id="intelProgressTxt"></span></div>
        </div>
        <div class="intel-toolbar-row">
          <button class="intel-tool-btn intel-tool-btn--primary" type="button" data-action="intelRetryLoad" id="intelRetryBtn"${failed ? '' : ' hidden'}>${_IC.refresh}<span>Retry load</span></button>
          <button class="intel-tool-btn" type="button" id="intelUndoBtn" data-action="aiUndo" ${_undoStack.length ? '' : 'hidden'}>${_IC.undo}<span>Undo</span></button>
        </div>
        <div class="intel-action-grid">
          <button type="button" class="intel-action-btn intel-action-btn--primary" id="alignValuesBtn" data-action="aiAlign" ${!ready || _cfg.dominant.length < 2 ? 'disabled' : ''}>
            ${_IC.bolt}
            <span class="intel-action-btn-text"><span class="intel-action-btn-lbl">Align values only</span><span class="intel-action-btn-sub">${!ready ? disabledSub : _cfg.dominant.length < 2 ? 'Pick 2–3 dominant values below' : 'Align to ' + _cfg.dominant.join(', ')}</span></span>
          </button>
          <button type="button" class="intel-action-btn intel-action-btn--primary" data-action="intelHarmonizeFields" ${!ready ? 'disabled' : ''}
            title="Propose updates using values, life area, priority, effort, energy, and tags from embeddings and similar tasks. Review before apply.">
            ${_IC.harmonize}
            <span class="intel-action-btn-text"><span class="intel-action-btn-lbl">Harmonize all fields</span><span class="intel-action-btn-sub">Preview field updates from the embedding model</span></span>
          </button>
          <button type="button" class="intel-action-btn" data-action="intelAutoOrganize" ${!ready || (typeof lists === 'undefined' || lists.length < 2) ? 'disabled' : ''}
            title="Route tasks into the list whose name and description match best. Edit a list description to tune routing.">
            ${_IC.folder}
            <span class="intel-action-btn-text"><span class="intel-action-btn-lbl">Auto-organize into lists</span><span class="intel-action-btn-sub">${!ready ? disabledSub : (typeof lists === 'undefined' || lists.length < 2) ? 'Needs at least two lists' : 'Route across ' + lists.length + ' lists'}</span></span>
          </button>
          <button type="button" class="intel-action-btn" data-action="intelFindDuplicatesUI">
            ${_IC.duplicate}
            <span class="intel-action-btn-text"><span class="intel-action-btn-lbl">Find duplicates</span><span class="intel-action-btn-sub">Near-duplicate pairs by embedding similarity</span></span>
          </button>
          <button type="button" class="intel-action-btn" data-action="intelReembedAll">
            ${_IC.refresh}
            <span class="intel-action-btn-text"><span class="intel-action-btn-lbl">Re-embed all tasks</span><span class="intel-action-btn-sub">Refresh vectors after bulk edits</span></span>
          </button>
        </div>
        <div id="intelDupSection" class="intel-dup-section" hidden></div>
        <div id="intelPendingOps" class="pending-ops-wrap" hidden></div>
        <div class="intel-section-hdr">
          <span class="intel-section-title">Dominant values</span>
          <span class="intel-section-hint">Pick 2–3 to steer alignment</span>
        </div>
        <div class="schwartz-grid" id="intelValuesGrid"></div>
        <div class="intel-breakdown-section">
          <div class="intel-section-hdr">
            <span class="intel-section-title">Category breakdown</span>
          </div>
          <div id="intelBreakdown"></div>
        </div>
        <p class="intel-hint intel-hint-foot">
          Batches are undoable (last 10). Alignment proposes <code>UPDATE_TASK</code> previews — apply when ready.
        </p>
      </div>
    </div>`;

  _renderValuesGrid();
  _renderBreakdown();
  _renderUndoBtn();
  if(ready) syncHeaderAIChip('ready', `Ready via ${dev || 'CPU'}`);
  else if(failed) syncHeaderAIChip('error', _embedChipMsg || 'Load failed');
  else if(_embedChipState !== 'loading' && _embedChipState !== 'working' && _embedChipState !== 'syncing'){
    syncHeaderAIChip('loading', 'Loading model…');
  }
  syncSemanticSearchUi();
  // renderAIPanel replaces the whole Tools card — reattach a good preview or rebuild.
  const pendingSlot = document.getElementById('intelPendingOps');
  if(keepPending && pendingSlot){
    pendingSlot.replaceWith(keepPending);
    keepPending.hidden = false;
  }else if(_pendingOps.length){
    _renderPendingOps();
  }
}

/**
 * Aggregates Transformers.js v3 progress callbacks.
 * The callback fires per file (tokenizer.json, config.json, onnx/model_fp16.onnx…)
 * with events { status, name, file, loaded, total, progress }.
 * `progress` is already a percentage (0..100) per file — so showing it directly
 * makes the bar reset each time a new file starts. Aggregating by bytes across
 * files gives a single monotonic 0..100 for the whole model download.
 */
function _makeProgressAggregator(onUpdate){
  const files = new Map(); // file path -> {loaded, total, done}
  let lastEmittedPct = -1;
  return function(ev){
    if(!ev || typeof ev !== 'object') return;
    const file = ev.file || ev.name || '_';
    const entry = files.get(file) || {loaded: 0, total: 0, done: false};
    if(ev.status === 'progress'){
      if(Number.isFinite(ev.loaded)) entry.loaded = ev.loaded;
      if(Number.isFinite(ev.total) && ev.total > 0) entry.total = ev.total;
      // Fallback when byte counts missing: convert per-file percent into synthetic bytes.
      if((!entry.total || !entry.loaded) && Number.isFinite(ev.progress)){
        entry.total = 100;
        entry.loaded = Math.min(100, Math.max(0, ev.progress));
      }
    }else if(ev.status === 'done'){
      entry.done = true;
      if(entry.total > 0) entry.loaded = entry.total;
    }else if(ev.status === 'initiate' || ev.status === 'download'){
      // seed entry so the file counts toward the total as soon as we know it exists
    }
    files.set(file, entry);

    let sumLoaded = 0, sumTotal = 0;
    for(const v of files.values()){
      if(v.total > 0){ sumLoaded += v.loaded; sumTotal += v.total; }
    }
    // If we truly have no byte counts yet, fall back to count-of-files progress.
    let pct;
    if(sumTotal > 0){
      pct = Math.max(0, Math.min(100, Math.round((sumLoaded / sumTotal) * 100)));
    }else{
      const doneCount = [...files.values()].filter(v => v.done).length;
      pct = files.size ? Math.round((doneCount / files.size) * 100) : 0;
    }
    // Never go backwards once we've emitted a higher number — avoids visual jitter
    // when Transformers.js emits `initiate` for a new file mid-stream.
    if(pct < lastEmittedPct) pct = lastEmittedPct;
    lastEmittedPct = pct;
    onUpdate(pct, ev, entry);
  };
}

function intelRetryLoad(){
  if(typeof intelLoad !== 'function') return;
  const w = document.getElementById('intelProgressWrap');
  const bar = document.getElementById('intelProgressBar');
  const pct = document.getElementById('intelProgressPct');
  const txt = document.getElementById('intelProgressTxt');
  const btn = document.getElementById('intelRetryBtn');
  if(btn) btn.hidden = true;
  if(w) w.hidden = false;
  const onProgress = _makeProgressAggregator((v, ev) => {
    if(bar) bar.style.width = v + '%';
    if(pct) pct.textContent = v + '%';
    const status = ev && ev.status ? String(ev.status) : '';
    const file = ev && ev.file ? ' · ' + String(ev.file).split('/').pop() : '';
    if(txt) txt.textContent = (status + file).slice(0, 80);
    syncHeaderAIChip('loading', v + '%');
  });
  intelLoad(onProgress).then(() => {
    if(w) w.hidden = true;
    if(typeof ensureSchwartzEmbeddings === 'function'){
      ensureSchwartzEmbeddings().catch(() => {});
    }
    renderAIPanel();
    if(typeof maybeShowEnhanceBtn === 'function') maybeShowEnhanceBtn();
  }).catch(err => {
    // Surface the real reason on retry too — otherwise the user clicks
    // Retry, sees the same generic "Could not load model", and has no
    // information about whether the underlying cause changed.
    console.error('[intel] retry failed', err);
    if(w) w.hidden = true;
    if(btn) btn.hidden = false;
    const short = String((err && err.message) || err || '').slice(0, 120);
    _setIntelStatus('error', short || 'Could not load model');
    syncSemanticSearchUi();
  });
}


async function runMdBreakdown(){
  const body = document.getElementById('mdBreakdownBody');
  if(!body) return;
  if(typeof isGenReady !== 'function' || !isGenReady()){
    body.innerHTML = '<span class="intel-muted">Load the on-device LLM (Settings → Generative Ask) to break tasks down.</span>';
    return;
  }
  const id = typeof editingTaskId !== 'undefined' ? editingTaskId : null;
  const t = id != null && typeof findTask === 'function' ? findTask(id) : null;
  if(!t){
    body.innerHTML = '<span class="intel-muted">Open a task first.</span>';
    return;
  }

  body.dataset.loaded = '1';
  body.innerHTML = '<span class="intel-muted">Thinking through subtasks…</span>';

  try{
    const res = await _llmWithTimeout(
      genBreakdownTask({ name: t.name, description: t.description }, { maxSubtasks: 6 }),
      20000,
    );
    if(!res || !Array.isArray(res.subtasks) || !res.subtasks.length){
      body.innerHTML = '<span class="intel-muted">LLM didn\u2019t return usable subtasks. Try adding a short description and retry.</span>'
        + ' <button type="button" class="md-breakdown-btn" data-action="runMdBreakdown">Retry</button>';
      return;
    }
    window._mdBreakdownSuggestion = { taskId: t.id, subtasks: res.subtasks };
    const rows = res.subtasks.map((s, i) => `
      <label class="md-breakdown-row">
        <input type="checkbox" data-idx="${i}" checked>
        <span class="md-breakdown-name">${esc(s.name)}</span>
        ${s.effort ? `<span class="md-breakdown-effort">${esc(String(s.effort).toUpperCase())}</span>` : ''}
      </label>`).join('');
    body.innerHTML = `
      <div class="md-breakdown-list">${rows}</div>
      ${res.rationale ? `<div class="pending-rationale">${esc(res.rationale)}</div>` : ''}
      <div class="md-breakdown-actions">
        <button type="button" class="md-breakdown-btn" data-action="runMdBreakdown">Re-run</button>
        <button type="button" class="md-breakdown-btn md-breakdown-btn--primary" data-action="acceptMdBreakdown">Add as subtasks</button>
      </div>`;
  }catch(err){
    console.warn('[breakdown]', err);
    body.innerHTML = '<span class="intel-muted">Something went wrong. Try again.</span>'
      + ' <button type="button" class="md-breakdown-btn" data-action="runMdBreakdown">Retry</button>';
  }
}

function acceptMdBreakdown(){
  const sugg = window._mdBreakdownSuggestion;
  const body = document.getElementById('mdBreakdownBody');
  if(!sugg || !body) return;
  const parent = typeof findTask === 'function' ? findTask(sugg.taskId) : null;
  if(!parent){ body.innerHTML = '<span class="intel-muted">Parent task not found.</span>'; return; }

  const selected = Array.from(body.querySelectorAll('input[type="checkbox"][data-idx]'))
    .filter(cb => cb.checked)
    .map(cb => sugg.subtasks[parseInt(cb.dataset.idx, 10)])
    .filter(Boolean);
  if(!selected.length){ return; }

  const defaults = typeof defaultTaskProps === 'function' ? defaultTaskProps() : {};
  const nowStr = typeof timeNowFull === 'function' ? timeNowFull() : new Date().toISOString();
  const added = [];
  for(const s of selected){
    const id = (typeof taskIdCtr === 'number') ? (++taskIdCtr) : (Date.now() + Math.floor(Math.random() * 1000));
    const child = Object.assign(
      { id, name: s.name, totalSec: 0, sessions: 0, created: nowStr, parentId: parent.id, collapsed: false },
      defaults,
      { listId: parent.listId, effort: s.effort || null },
    );
    tasks.push(child);
    if(typeof _taskIndexRegister === 'function') _taskIndexRegister(child);
    added.push(child.id);
  }
  if(parent.collapsed) parent.collapsed = false;

  body.innerHTML = `<span class="intel-muted">Added ${added.length} subtask${added.length === 1 ? '' : 's'}.</span>`;
  window._mdBreakdownSuggestion = null;

  if(typeof renderTaskList === 'function') renderTaskList();
  if(typeof saveState === 'function') saveState('user');
}

async function intelFindDuplicatesUI(){
  if(!isIntelReady()){ _setIntelStatus('error', 'Model not ready'); return; }
  const sec = document.getElementById('intelDupSection');
  if(!sec) return;
  sec.hidden = false;
  sec.innerHTML = '<span class="text-12-muted">Scanning…</span>';
  try{
    const pairs = await findDuplicates(0.9);
    if(!pairs.length){
      sec.innerHTML = '<span class="text-12-muted">No near-duplicate pairs (≥0.9) found.</span>';
      window._dupSimMap = null;
      return;
    }
    window._dupSimMap = new Map();
    pairs.forEach(p => {
      window._dupSimMap.set(p.idA, Math.max(window._dupSimMap.get(p.idA) || 0, p.sim));
      window._dupSimMap.set(p.idB, Math.max(window._dupSimMap.get(p.idB) || 0, p.sim));
    });
    if(typeof renderTaskList === 'function') renderTaskList();

    const shown = pairs.slice(0, 30);
    sec.innerHTML = '<div class="intel-dup-hdr">Near duplicates</div>' + shown.map(p => {
      const sa = _intelFmtTaskTitle(p.taskA).slice(0, 32);
      const sb = _intelFmtTaskTitle(p.taskB).slice(0, 32);
      return `<div class="intel-dup-row">
        <span class="intel-dup-pair">${esc(sa)} ↔ ${esc(sb)}</span>
        <span class="intel-dup-sim">${p.sim.toFixed(2)}</span>
        <button type="button" class="btn-ghost btn-sm" data-action="intelMergeDuplicatePair" data-args='[${p.idA},${p.idB}]'>Delete 2nd</button>
      </div>`;
    }).join('');
  }catch(e){
    sec.innerHTML = '<span class="text-danger">Failed to scan</span>';
    const msg = (e && e.message) ? String(e.message).slice(0, 120) : 'failed';
    if(typeof showActionToast === 'function'){
      showActionToast('Find duplicates failed: ' + msg, 'Retry', () => intelFindDuplicatesUI());
    }
  }
}

function intelMergeDuplicatePair(idA, idB){
  const ta = findTask(idA), tb = findTask(idB);
  if(!ta || !tb) return;
  const na = _intelFmtTaskTitle(ta), nb = _intelFmtTaskTitle(tb);
  const first = na.length <= nb.length ? ta : tb;
  const second = first === ta ? tb : ta;
  const secondLbl = _intelFmtTaskTitle(second) || ('#' + second.id);
  _pendingOps = [
    { name: 'ADD_NOTE', args: { id: first.id, text: `Merged duplicate: ${secondLbl}` } },
    { name: 'DELETE_TASK', args: { id: second.id } },
  ];
  _renderPendingOps();
  _setIntelStatus('idle', 'Review merge (delete duplicate)');
}

async function intelHarmonizeFields(){
  if(typeof isIntelReady !== 'function' || !isIntelReady()){
    _setIntelStatus('error', 'Model not ready');
    return;
  }
  if(_intelBusy) return;
  _loadCfg();
  _intelBusy = true;
  _setIntelStatus('working', 'Scanning tasks (values, category, priority, tags…)…');
  try{
    const ops = await proposeHarmonizeUpdates({ dominant: _cfg.dominant, maxTasks: 200 });
    if(!ops.length){
      _setIntelStatus('ready', 'No changes suggested — fields already match the model');
      return;
    }
    await acceptProposedOps(ops, { source: 'harmonize', destructiveLevel: 'none' });
  }catch(err){
    console.warn('[harmonize]', err);
    _setIntelStatus('error', 'Harmonize failed');
    const msg = (err && err.message) ? String(err.message).slice(0, 120) : 'failed';
    if(typeof showActionToast === 'function'){
      showActionToast('Harmonize failed: ' + msg, 'Retry', () => intelHarmonizeFields());
    }
  }finally{
    _intelBusy = false;
  }
}

async function intelAutoOrganize(){
  if(!isIntelReady()){ _setIntelStatus('error', 'Model not ready'); return; }
  if(typeof lists === 'undefined' || lists.length < 2){
    _setIntelStatus('error', 'Need at least 2 lists');
    return;
  }
  const withDesc = lists.filter(l => (l.description || '').trim().length >= 4).length;
  if(withDesc === 0){
    const msg = 'None of your lists have descriptions yet — routing will use list names alone, which can be noisy.\n\n'
      + 'Tip: click the ✎ on a list chip to add a short description like "bills, taxes, budgets" for Finance.\n\n'
      + 'Continue anyway?';
    if(typeof showAppConfirm === 'function'){
      if(!(await showAppConfirm(msg))) return;
    }else if(!confirm(msg)) return;
  }
  _setIntelStatus('working', 'Scoring tasks against lists…');
  try{
    const proposals = await autoOrganizeIntoLists();
    if(!proposals.length){
      _setIntelStatus('ready', 'Every task is already in its best list');
      return;
    }
    const rawOps = proposals.map(p => {
      const t = findTask(p.id);
      const fromList = _listNameById(t ? t.listId : null);
      const toList = _listNameById(p.toListId);
      return {
        name: 'CHANGE_LIST',
        args: { id: p.id, listId: p.toListId },
        _rationale: Math.round(p.sim * 100) + '% match',
        _preview: {
          taskName: t ? String(t.name || '').trim() : '',
          fromList,
          toList,
        },
      };
    });
    let ops = rawOps;
    let destructiveLevel = rawOps.length >= 5 ? 'hard' : rawOps.length ? 'warn' : 'none';
    if(typeof validateOps === 'function'){
      const tasksById = new Map((tasks || []).map(t => [t.id, t]));
      const listsById = new Map((lists || []).map(l => [l.id, l]));
      const v = validateOps(rawOps, { tasksById, listsById });
      ops = v.valid;
      destructiveLevel = v.destructiveLevel;
    }
        if(typeof isGenReady === 'function' && isGenReady() && typeof genExplainMove === 'function'){
      _setIntelStatus('working', 'Explaining moves with LLM…');
      const listById = new Map(lists.map(l => [l.id, l]));
      const MAX = 8;
      for(let i = 0; i < Math.min(MAX, ops.length); i++){
        const op = ops[i];
        const t = findTask(op.args.id);
        const dest = listById.get(op.args.listId);
        if(!t || !dest) continue;
        const note = await _llmWithTimeout(genExplainMove({ name: t.name }, dest.name || ''), 8000);
        if(note) op._rationale = note;
      }
    }
    await acceptProposedOps(ops, { source: 'auto-organize', destructiveLevel });
  }catch(err){
    console.warn('[auto-organize]', err);
    _setIntelStatus('error', 'Auto-organize failed');
    const msg = (err && err.message) ? String(err.message).slice(0, 120) : 'failed';
    if(typeof showActionToast === 'function'){
      showActionToast('Auto-organize failed: ' + msg, 'Retry', () => intelAutoOrganize());
    }
  }
}

async function intelReembedAll(){
  if(!isIntelReady()) return;
  _setIntelStatus('working', 'Re-embedding…');
  const list = tasks.filter(t => !t.archived);
  let i = 0;
  const step = async () => {
    if(i >= list.length){
      _setIntelStatus('ready', `Re-embedded ${list.length} tasks`);
      if(typeof invalidateDupMap === 'function') invalidateDupMap();
      return;
    }
    try{
      await embedStore.ensure(list[i]);
    }catch(e){ console.warn(e); }
    i++;
    if(i % 3 === 0) _setIntelStatus('working', `Re-embedding… ${i}/${list.length}`);
    setTimeout(step, 0);
  };
  step();
}

window._smartAddPreview = null;

function maybeShowEnhanceBtn(){
  const btn = document.getElementById('taskEnhanceBtn');
  const inp = document.getElementById('taskInput');
  if(!btn || !inp) return;
  const len = inp.value.trim().length;
  const showable = (typeof isIntelReady === 'function' && isIntelReady()) && len >= 3;
  btn.hidden = !(showable);
  // LLM freeform parse button: only offered when a generative model is loaded.
  // Shown for longer inputs (≥8 chars) where nlparse + embeddings struggle.
  const parseBtn = document.getElementById('taskParseBtn');
  if(parseBtn){
    const llmOn = typeof isGenReady === 'function' && isGenReady();
    const canParse = llmOn && len >= 8;
    parseBtn.hidden = !(canParse);
  }
  if((len < 3 || window._smartAddPreview) && !btn.disabled){
    window._smartAddPreview = null;
    const prev = document.getElementById('smartAddPreview');
    if(prev){ prev.innerHTML = ''; prev.hidden = true; }
  }
}

document.addEventListener('visibilitychange', () => {
  if(document.hidden && window._smartAddPreview){
    window._smartAddPreview = null;
    const prev = document.getElementById('smartAddPreview');
    if(prev){ prev.innerHTML = ''; prev.hidden = true; }
  }
});

// Wrap a user-initiated AI feature so failures surface as a toast with the
// feature label and a Retry action, instead of vanishing into console.warn.
// Used by: smartAddEnhance, intelFindDuplicatesUI, intelHarmonizeFields,
// intelAutoOrganize. Background tasks (embed warmup, scheduled centroids)
// are intentionally NOT wrapped — those failures aren't user-initiated and
// would only spam the surface.
async function _aiFeatureGuard(label, fn){
  try{
    return await fn();
  }catch(err){
    console.warn('[ai:'+label+']', err);
    const msg = (err && err.message) ? String(err.message).slice(0, 120) : 'failed';
    if(typeof showActionToast === 'function'){
      showActionToast(label + ' failed: ' + msg, 'Retry', () => { _aiFeatureGuard(label, fn); });
    } else if(typeof showExportToast === 'function'){
      showExportToast(label + ' failed: ' + msg);
    }
    return null;
  }
}

async function _buildSmartAddSuggestions(raw){
  const cleaned = {};
  if(typeof predictMetadata === 'function'){
    const sugg = await predictMetadata(raw, 5);
    const PR = ['urgent','high','normal','low','none'];
    const EFF = ['xs','s','m','l','xl'];
    const EN = ['high','low'];
    if(sugg.priority && PR.includes(sugg.priority) && sugg.priority !== 'none') cleaned.priority = sugg.priority;
    if(sugg.category && typeof isAssignableCategory === 'function' && isAssignableCategory(sugg.category)) cleaned.category = sugg.category;
    if(sugg.effort && EFF.includes(sugg.effort)) cleaned.effort = sugg.effort;
    if(sugg.energyLevel && EN.includes(sugg.energyLevel)) cleaned.energyLevel = sugg.energyLevel;
    if(Array.isArray(sugg.tags)) cleaned.tags = sugg.tags.filter(t => typeof t === 'string' && t.length && t.length < 25).slice(0, 5);
    if(sugg.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(sugg.dueDate)) cleaned.dueDate = sugg.dueDate;
  }
  if(typeof predictListId === 'function'){
    try{
      const lid = await predictListId(raw, { minScore: 0.30, minMargin: 0 });
      if(lid != null) cleaned.listId = lid;
    }catch(_){ /* best-effort */ }
  }
  return cleaned;
}

function shouldApplySmartAdd(){
  if(window._smartAddPreview) return true;
  if(typeof matchMedia !== 'function' || !matchMedia('(max-width:640px)').matches) return false;
  return typeof isIntelReady === 'function' && isIntelReady();
}

function _focusListForRoutedTask(listId){
  if(listId == null || showAllLists || activeListId === listId) return;
  activeListId = listId;
  if(typeof syncFilterBar === 'function') syncFilterBar();
}

async function smartAddEnhance(){
  if(typeof isIntelReady !== 'function' || !isIntelReady()){
    _setIntelStatus('error', 'Model still loading — check the AI chip or open Tools');
    return;
  }
  if(_intelBusy) return;
  const inp = document.getElementById('taskInput');
  const btn = document.getElementById('taskEnhanceBtn');
  const prev = document.getElementById('smartAddPreview');
  const raw = (inp?.value || '').trim();
  if(!raw || raw.length < 3) return;

  _intelBusy = true;
  if(btn){
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.dataset.prevHtml = btn.innerHTML;
    btn.innerHTML = (window.icon && window.icon('harmonize', { size: 14, cls: 'is-spin' })) || '';
  }

  try{
    const cleaned = await _buildSmartAddSuggestions(raw);

    if(Object.keys(cleaned).length === 0){
      if(prev){
        prev.innerHTML = '<span class="smart-add-empty">No confident suggestions — add manually or keep typing</span>';
        prev.hidden = false;
      }
    } else {
      window._smartAddPreview = cleaned;
      _renderSmartAddChips(cleaned);
    }
  }catch(err){
    // User clicked Enhance; failure is feedback-worthy.
    console.warn('[smart-add]', err);
    const msg = (err && err.message) ? String(err.message).slice(0, 120) : 'failed';
    if(typeof showActionToast === 'function'){
      showActionToast('Enhance failed: ' + msg, 'Retry', () => smartAddEnhance());
    }
  }finally{
    _intelBusy = false;
    if(btn){
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      if(btn.dataset.prevHtml != null){
        btn.innerHTML = btn.dataset.prevHtml;
        delete btn.dataset.prevHtml;
      } else {
        btn.innerHTML = (window.icon && window.icon('sparkles')) || '';
      }
    }
  }
}


async function smartAddParseWithLLM(){
  if(_intelBusy) return;
  if(typeof isGenReady !== 'function' || !isGenReady()) return;
  if(typeof genParseFreeform !== 'function') return;

  const inp = document.getElementById('taskInput');
  const btn = document.getElementById('taskParseBtn');
  const prev = document.getElementById('smartAddPreview');
  const raw = (inp?.value || '').trim();
  if(!raw || raw.length < 8) return;

  _intelBusy = true;
  if(btn){
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.dataset.prevHtml = btn.innerHTML;
    btn.innerHTML = (window.icon && window.icon('harmonize', { size: 14, cls: 'is-spin' })) || '';
  }

  try{
    const parsed = await _llmWithTimeout(genParseFreeform(raw), 12000);
    if(!parsed || !parsed.name){
      if(prev){
        prev.innerHTML = '<span class="smart-add-empty">LLM couldn\u2019t parse that — try adding more context.</span>';
        prev.hidden = false;
      }
      return;
    }

    // Rewrite the input to the cleaner imperative name so parseQuickAdd
    // handles submit cleanly. Keep the cursor at end of the new name.
    if(parsed.name && parsed.name !== raw){
      inp.value = parsed.name;
      try{ inp.setSelectionRange(parsed.name.length, parsed.name.length); }catch(_){}
    }

    const PR = ['urgent','high','normal','low'];
    const EFF = ['xs','s','m','l','xl'];
    const cleaned = {};
    if(parsed.priority && PR.includes(parsed.priority)) cleaned.priority = parsed.priority;
    if(parsed.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(parsed.dueDate)) cleaned.dueDate = parsed.dueDate;
    if(parsed.effort && EFF.includes(parsed.effort)) cleaned.effort = parsed.effort;
    if(Array.isArray(parsed.tags) && parsed.tags.length) cleaned.tags = parsed.tags.slice(0, 5);

    if(Object.keys(cleaned).length === 0){
      window._smartAddPreview = null;
      if(prev){
        prev.innerHTML = parsed.rationale
          ? `<span class="smart-add-empty">${esc(parsed.rationale)}</span>`
          : '<span class="smart-add-empty">Parsed — press Enter to add.</span>';
        prev.hidden = false;
      }
    } else {
      window._smartAddPreview = cleaned;
      _renderSmartAddChips(cleaned);
      if(parsed.rationale && prev){
        prev.insertAdjacentHTML(
          'beforeend',
          `<div class="pending-rationale">${esc(parsed.rationale)}</div>`,
        );
      }
    }
  }catch(err){
    // User clicked the Parse-with-LLM button; surface the failure with a
    // Retry instead of leaving them staring at a "loading" state that
    // already cleared.
    console.warn('[smart-add:llm]', err);
    const msg = (err && err.message) ? String(err.message).slice(0, 120) : 'parse failed';
    if(typeof showActionToast === 'function'){
      showActionToast('Parse with LLM failed: ' + msg, 'Retry', () => smartAddParseWithLLM());
    }
  }finally{
    _intelBusy = false;
    if(btn){
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      if(btn.dataset.prevHtml != null){
        btn.innerHTML = btn.dataset.prevHtml;
        delete btn.dataset.prevHtml;
      } else {
        btn.innerHTML = (window.icon && window.icon('wand')) || '';
      }
    }
  }
}

function _renderSmartAddChips(s){
  const prev = document.getElementById('smartAddPreview');
  if(!prev) return;
  const effortTips = { xs:'Extra small — ~15 min', s:'Small — ~1 hr', m:'Medium — ~half day', l:'Large — ~full day', xl:'Extra large — multi-day' };
  const chips = [];
  if(s.priority) chips.push(`<span class="sa-chip sa-priority sa-p-${esc(s.priority)}" data-tip="Priority — tap to remove" data-action="smartAddRemove" data-arg="priority">priority: ${esc(s.priority)} ×</span>`);
  const ic = (n, size) => (window.icon && window.icon(n, {size: size||13})) || '';
  if(s.category){
    const cdef = (typeof getCategoryDef === 'function') ? getCategoryDef(s.category) : null;
    const catLbl = cdef ? cdef.label : s.category;
    const catIc = (cdef && cdef.icon) || CAT_ICON[s.category] || 'pin';
    chips.push(`<span class="sa-chip" data-tip="Life area — tap to remove" data-action="smartAddRemove" data-arg="category"><span class="sa-chip-ic">${ic(catIc)}</span> ${esc(catLbl)} ×</span>`);
  }
  if(s.listId != null){
    const listLbl = _listNameById(s.listId);
    chips.push(`<span class="sa-chip" data-tip="List — tap to remove" data-action="smartAddRemove" data-arg="listId"><span class="sa-chip-ic">${ic('list')}</span> ${esc(listLbl)} ×</span>`);
  }
  if(s.effort) chips.push(`<span class="sa-chip" data-tip="${escAttr(effortTips[s.effort] || 'Effort')} — tap to remove" data-action="smartAddRemove" data-arg="effort">effort: ${esc(String(s.effort).toUpperCase())} ×</span>`);
  if(s.energyLevel) chips.push(`<span class="sa-chip" data-tip="Energy — tap to remove" data-action="smartAddRemove" data-arg="energyLevel"><span class="sa-chip-ic">${ic(s.energyLevel === 'high' ? 'flame' : 'leaf')}</span> ${esc(s.energyLevel)} ×</span>`);
  if(s.dueDate) chips.push(`<span class="sa-chip" data-tip="Due date — tap to remove" data-action="smartAddRemove" data-arg="dueDate"><span class="sa-chip-ic">${ic('calendar')}</span> ${esc(s.dueDate)} ×</span>`);
  if(s.tags && s.tags.length) s.tags.forEach(tag => chips.push(`<span class="sa-chip" data-tip="Tag — tap to remove" data-sa-tag="${encodeURIComponent(tag)}">#${esc(tag)} ×</span>`));
  prev.innerHTML = `
    <span class="smart-add-hint">Suggestions — tap to remove, Enter to add:</span>
    <div class="sa-chips">${chips.join('')}</div>`;
  prev.hidden = false;
}

function smartAddRemove(field){
  if(!window._smartAddPreview) return;
  delete window._smartAddPreview[field];
  if(Object.keys(window._smartAddPreview).length === 0 ||
     (Object.keys(window._smartAddPreview).length === 1 && window._smartAddPreview.tags && !window._smartAddPreview.tags.length)){
    window._smartAddPreview = null;
    const prev = document.getElementById('smartAddPreview');
    if(prev){ prev.innerHTML = ''; prev.hidden = true; }
  } else {
    _renderSmartAddChips(window._smartAddPreview);
  }
}

function smartAddRemoveTag(tag){
  if(!window._smartAddPreview?.tags) return;
  window._smartAddPreview.tags = window._smartAddPreview.tags.filter(t => t !== tag);
  if(!window._smartAddPreview.tags.length) delete window._smartAddPreview.tags;
  if(Object.keys(window._smartAddPreview).length === 0){
    window._smartAddPreview = null;
    const prev = document.getElementById('smartAddPreview');
    if(prev){ prev.innerHTML = ''; prev.hidden = true; }
  } else {
    _renderSmartAddChips(window._smartAddPreview);
  }
}

async function applySmartAddAndSubmit(){
  const inp = gid('taskInput');
  const raw = (inp?.value || '').trim();
  if(!raw){ window._smartAddPreview = null; return; }
  let sugg = window._smartAddPreview ? { ...window._smartAddPreview } : {};
  if(!Object.keys(sugg).length && shouldApplySmartAdd()){
    sugg = await _buildSmartAddSuggestions(raw);
  }

  ensureDefaultList();
  let parsed;
  if(typeof parseQuickAddAsync === 'function'){
    parsed = await parseQuickAddAsync(raw);
  } else {
    parsed = parseQuickAdd(raw);
  }
  if(!parsed.name) return;

  const merged = Object.assign({}, defaultTaskProps(), sugg, parsed.props);

  const smartT = Object.assign({
    id: ++taskIdCtr, name: parsed.name,
    totalSec: 0, sessions: 0, created: timeNowFull(),
    parentId: null, collapsed: false,
  }, merged);
  tasks.push(smartT);
  if(typeof _taskIndexRegister === 'function') _taskIndexRegister(smartT);

  _focusListForRoutedTask(smartT.listId);

  inp.value = '';
  window._smartAddPreview = null;
  const prev = document.getElementById('smartAddPreview');
  if(prev){ prev.innerHTML = ''; prev.hidden = true; }
  const btn = document.getElementById('taskEnhanceBtn');
  if(btn) btn.hidden = true;
  if(typeof clearLiveParsePreview === 'function') clearLiveParsePreview();
  try{ inp.focus({ preventScroll: true }); }catch(_){ inp.focus(); }

  renderTaskList();
  if(typeof renderBanner === 'function') renderBanner();
  if(typeof renderLists === 'function') renderLists();
  if(typeof announceTaskAdd === 'function') announceTaskAdd(smartT.name);
  saveState('user');
}

function openWhatNext(){
  const o = document.getElementById('whatNextOverlay');
  if(!o) return;
  const timeSel = document.getElementById('whatNextTime');
  const enSel = document.getElementById('whatNextEnergy');
  const timeMin = timeSel ? parseInt(timeSel.value, 10) : 0;
  const energy = enSel ? enSel.value : '';
  const opts = {};
  if(timeMin > 0) opts.timeMin = timeMin;
  if(energy === 'high' || energy === 'low') opts.energy = energy;

  const ranked = rankWhatNext(tasks, opts).slice(0, 3);
  const calHint = (typeof getWhatNextCalConflictHint === 'function') ? getWhatNextCalConflictHint({ timeMin }) : '';
  const body = document.getElementById('whatNextBody');
  if(body){
    body.innerHTML = ranked.length
      ? ranked.map((x, i) => `
        <button type="button" class="what-next-item" data-action="openTaskDetailAndCloseWhatNext" data-arg="${x.t.id}">
          <span class="wn-name">${esc(x.t.name)}</span>
          <span class="wn-meta">${x.t.dueDate ? esc(x.t.dueDate) : 'no date'} · ${esc(x.t.priority || 'none')}</span>
          ${i === 0 && calHint ? `<span class="wn-cal-hint" role="note">${esc(calHint)}</span>` : ''}
          ${i === 0 ? '<span class="wn-why" id="wnWhy" hidden></span>' : ''}
        </button>`).join('')
      : '<span class="text-12-muted">Nothing queued — add tasks or clear filters.</span>';
  }
  // Stage 3: route through Modal utility so what-next shares the same
  // open/close mechanism as every other overlay (focus trap + prev-focus
  // restore + ESC handling). 'palette' variant: no body lock, no swipe.
  Modal.open('whatNextOverlay', { variant:'palette', onRequestClose:()=>closeWhatNext() });
  if(ranked.length >= 1 && typeof isGenReady === 'function' && isGenReady() && typeof genExplainRanking === 'function'){
    const top = ranked[0].t;
    const alts = ranked.slice(1).map(x => ({ name: x.t.name }));
    _llmWithTimeout(genExplainRanking({ name: top.name }, alts), 9000).then(note => {
      if(!note) return;
      const el = document.getElementById('wnWhy');
      if(el){ el.textContent = note; el.hidden = false; }
    }).catch(() => {});
  }
}

function closeWhatNext(){
  Modal.close('whatNextOverlay');
}

function toggleTaskSearchSemantic(){
  const cb = document.getElementById('taskSearchSemantic');
  if(!cb || cb.disabled) return;
  if(typeof isIntelReady === 'function' && !isIntelReady()) return;
  window._taskSearchSemantic = cb ? cb.checked : false;
  if(!window._taskSearchSemantic){
    window._semanticScores = null;
  }
  updateTaskFilters();
}

window.executeIntelOp = executeIntelOp;
window.executeClassifyTaskOp = executeClassifyTaskOp;
window.predictClassifyCategory = predictClassifyCategory;
window.renderAIPanel = renderAIPanel;
window.smartAddEnhance = smartAddEnhance;
window.smartAddParseWithLLM = smartAddParseWithLLM;
window.smartAddRemove = smartAddRemove;
window.smartAddRemoveTag = smartAddRemoveTag;
window.applySmartAddAndSubmit = applySmartAddAndSubmit;
window.shouldApplySmartAdd = shouldApplySmartAdd;
window.maybeShowEnhanceBtn = maybeShowEnhanceBtn;
window.aiAlign = aiAlign;
window.aiToggleValue = aiToggleValue;
window.aiUndo = aiUndo;
window.openWhatNext = openWhatNext;
window.closeWhatNext = closeWhatNext;
window.toggleTaskSearchSemantic = toggleTaskSearchSemantic;
window.runMdBreakdown = runMdBreakdown;
window.acceptMdBreakdown = acceptMdBreakdown;
window.intelFindDuplicatesUI = intelFindDuplicatesUI;
window.intelMergeDuplicatePair = intelMergeDuplicatePair;
window.intelReembedAll = intelReembedAll;
window.intelAutoOrganize = intelAutoOrganize;
window.intelHarmonizeFields = intelHarmonizeFields;
window.intelRetryLoad = intelRetryLoad;
window.intelApplyPending = intelApplyPending;
window.intelRejectPending = intelRejectPending;
window.intelToggleAllPending = intelToggleAllPending;
window.syncHeaderAIChip = syncHeaderAIChip;
window.syncSemanticSearchUi = syncSemanticSearchUi;
window.headerAIClick = headerAIClick;
window.acceptProposedOps = acceptProposedOps;
window.intelReclassifyUncategorized = intelReclassifyUncategorized;
window.intelHardBulkConfirmNeeded = intelHardBulkConfirmNeeded;
window.applyOpsBatch = applyOpsBatch;
window.askDestructiveConfirmNeeded = askDestructiveConfirmNeeded;
window.summarizeOpsLabels = summarizeOpsLabels;
window._allSelectedOpsFromList = _allSelectedOpsFromList;

let _askLoadError = null;

function renderGenSettings(){
  const host = document.getElementById('genAISettings');
  if(!host) return;
  const cfg = (typeof getGenCfg === 'function') ? getGenCfg() : { enabled:false, modelId:'', dtype:'q4', timeoutSec:30, downloadedIds:[] };
  const presets = (typeof getGenPresets === 'function') ? getGenPresets() : [];
  const ready = typeof isGenReady === 'function' && isGenReady();
  const loading = typeof isGenLoading === 'function' && isGenLoading();
  const dev = typeof getGenDevice === 'function' ? getGenDevice() : null;
  const devLbl = _formatGenBackend(dev) || (dev ? String(dev) : '');
  const ramHint = typeof window._mobileRamHint === 'function' ? window._mobileRamHint() : null;
  const cached = typeof isGenDownloaded === 'function' ? isGenDownloaded(cfg.modelId) : !!cfg.downloaded;
  const liveModel = typeof getGenModel === 'function' ? getGenModel() : null;
  const readyThisModel = ready && liveModel === cfg.modelId;
  const webgpuApi = typeof navigator !== 'undefined' && navigator.gpu && typeof navigator.gpu.requestAdapter === 'function';

  const preset = presets.find(p => p.id === cfg.modelId) || presets[0];
  const sizeMb = preset ? preset.sizeMb : 230;
  const lastErr = typeof getGenLastError === 'function' ? getGenLastError() : null;

  let statusText;
  if(!cfg.enabled) statusText = 'Disabled — toggle on to download & use.';
  else if(readyThisModel) statusText = `Ready on ${devLbl || 'device'} · ${preset ? preset.label : cfg.modelId}`;
  else if(loading) statusText = 'Fetching weights, then binding WebGPU or WASM…';
  else if(lastErr) statusText = 'Load failed — see details below.';
  else if(cached) statusText = 'Weights cached — click Load (or wait for auto-restore).';
  else statusText = `Not downloaded (~${sizeMb} MB one-time fetch).`;

  let actionLabel;
  if(!cfg.enabled) actionLabel = 'Enable above first';
  else if(loading) actionLabel = 'Loading…';
  else if(readyThisModel) actionLabel = 'Reload model';
  else if(cached) actionLabel = 'Pre-load model';
  else actionLabel = `Download model (~${sizeMb} MB)`;
  const actionDisabled = !cfg.enabled || loading;

  // Prefer the per-model cached error (hides stale errors after switching presets);
  // fall back to gen.js's last error for load failures that happen before we
  // had a chance to key them by model (e.g. alt-slug retry failures).
  const errForThisModel = (_askLoadError && _askLoadError.modelId === cfg.modelId)
    ? _askLoadError.message
    : (lastErr || '');

  const busy = loading || (typeof isGenGenerating === 'function' && isGenGenerating());
  const disableSelect = !cfg.enabled || busy;
  const historySize = (typeof getAskHistory === 'function') ? getAskHistory().length : 0;

  host.innerHTML = `
    <div class="gen-settings">
      <div class="srow srow--spread">
        <span class="sr-lbl sr-lbl--lg">Enable generative Ask (beta)</span>
        <div class="toggle ${cfg.enabled ? 'on' : ''}" id="genEnableToggle" data-action="toggleGenEnabled" role="switch" aria-checked="${cfg.enabled}"><div class="tknob"></div></div>
      </div>
      <p class="gen-settings-lead">
        Adds an <strong>Edit</strong> mode to the command palette (<kbd>Ctrl/⌘ + K</kbd>, then prefix <code>?</code>). A tiny instruct-tuned model runs <em>on this device</em>; nothing you type leaves the browser. Choose review-first or auto-apply below; destructive batches always confirm once.
      </p>
      ${cfg.enabled ? `
      <div class="gen-settings-row gen-settings-row--apply-mode">
        <span class="gen-settings-lbl">When AI proposes changes</span>
        <div class="gen-apply-mode-seg" role="group" aria-label="Apply mode default">
          <button type="button" class="gen-apply-mode-btn ${cfg.askApplyMode === 'review' ? 'gen-apply-mode-btn--active' : ''}" data-action="setGenAskApplyMode" data-arg="review" ${cfg.enabled ? '' : 'disabled'}>Review first</button>
          <button type="button" class="gen-apply-mode-btn ${cfg.askApplyMode === 'auto' ? 'gen-apply-mode-btn--active' : ''}" data-action="setGenAskApplyMode" data-arg="auto" ${cfg.enabled ? '' : 'disabled'}>Apply automatically</button>
        </div>
      </div>
      <p class="gen-settings-hint gen-settings-hint--tight">Auto-apply still asks once before deletes or bulk list moves. Undo is always available. Override per chat session in Cmd+K.</p>
      <div class="gen-settings-row">
        <label for="genModelSelect" class="gen-settings-lbl">Model</label>
        <select id="genModelSelect" data-onchange="selectGenModelFromSelect" ${disableSelect ? 'disabled' : ''} title="${busy ? 'Disabled while busy' : ''}">
          ${presets.map(p => {
            const pCached = typeof isGenDownloaded === 'function' && isGenDownloaded(p.id);
            const tag = pCached ? ' ✓ cached' : '';
            return `<option value="${esc(p.id)}" ${p.id === cfg.modelId ? 'selected' : ''}>${esc(p.label)} · ${p.sizeMb} MB${esc(tag)}</option>`;
          }).join('')}
        </select>
      </div>
      ${preset ? `<div class="gen-settings-note">${esc(preset.note)}</div>` : ''}
      ${cfg.enabled && !loading ? `<div class="gen-settings-note">${webgpuApi ? 'This browser exposes <strong>WebGPU</strong> — the LLM tries it first, then falls back to <strong>WASM</strong> if binding fails.' : 'No <code>navigator.gpu</code> — the LLM will run on <strong>WASM (CPU)</strong> only.'}</div>` : ''}
      ${ramHint === 'low' ? `<div class="gen-settings-warn">Your device reports low RAM. The 135M preset is recommended.</div>` : ''}
      ${ramHint === 'ios-unknown' && (preset && preset.sizeMb > 150) ? `<div class="gen-settings-warn">On iOS the WASM fallback uses extra RAM. If the tab reloads during generation, switch to the 135M preset.</div>` : ''}
      <div class="gen-settings-row">
        <label for="genTimeout" class="gen-settings-lbl" title="Max time allowed for generating a response">Max generation time (sec)</label>
        <input type="number" id="genTimeout" class="sinput" min="5" max="120" value="${cfg.timeoutSec}" data-onchange="setGenTimeoutFromInput" ${cfg.enabled ? '' : 'disabled'}>
      </div>
      <div class="gen-settings-status" id="genSettingsStatus">${esc(statusText)}</div>
      <div id="genProgressWrap" class="intel-progress-wrap" ${loading ? '' : 'hidden'}>
        <div class="intel-progress-track"><div class="intel-progress-bar progress-bar" id="genProgressBar"></div></div>
        <div class="intel-progress-info"><span id="genProgressPct">0%</span> <span id="genProgressTxt"></span></div>
      </div>
      ${errForThisModel ? `<div class="gen-settings-warn" id="genSettingsError" role="alert">${esc(errForThisModel)}</div>` : ''}
      <div class="gen-settings-actions">
        ${loading
          ? '<button type="button" class="btn-ghost btn-sm" data-action="genAbortLoad">Cancel download</button>'
          : `<button type="button" class="btn-primary btn-sm" id="genDownloadBtn" data-action="genDownloadClick" ${actionDisabled ? 'disabled' : ''}>
              ${esc(actionLabel)}
            </button>`}
        ${readyThisModel && !loading ? '<button type="button" class="btn-ghost btn-sm" data-action="genAbort">Abort generation</button>' : ''}
      </div>
      <div class="gen-settings-actions gen-settings-actions--secondary">
        <button type="button" class="btn-ghost btn-sm" data-action="genClearAskHistory" ${historySize ? '' : 'disabled'}>Clear Ask history (${historySize})</button>
        <button type="button" class="btn-ghost btn-sm" data-action="genClearCache">Clear LLM cache</button>
      </div>
      <p class="gen-settings-hint">
        Progress also appears in the <strong>footer bar</strong> and the header chip (percentage) while files download. After load, status shows <strong>WebGPU</strong> (GPU) or <strong>WASM (CPU)</strong> — whichever actually bound.
      </p>
      <p class="gen-settings-hint">
        Weights live in the browser HTTP cache. "Clear LLM cache" removes any caches we control; to force a full purge use the browser's own "Clear site data".
      </p>
      ` : ''}
    </div>`;

  // Keep the task-input promo chip in sync with gen state on every render
  // (toggle, model switch, download, error, clear — all route through here).
  if(typeof syncAskPromoChip === 'function') syncAskPromoChip();
}

function toggleGenEnabled(){
  if(typeof getGenCfg !== 'function') return;
  const cfg = getGenCfg();
  cfg.enabled = !cfg.enabled;
  saveGenCfg(cfg);
  if(!cfg.enabled){
    // Disabling must stop any in-flight generation and clear stale errors so
    // re-enabling later starts from a clean slate.
    _askLoadError = null;
    if(typeof clearGenLastError === 'function') clearGenLastError();
    if(typeof genAbort === 'function'){ try{ genAbort(); }catch(e){} }
    if(typeof genAbortLoad === 'function'){ try{ genAbortLoad(); }catch(e){} }
  } else if(typeof intelLoad === 'function' && typeof isIntelReady === 'function' && !isIntelReady()){
    // When enabling, warm up the embedding loader in the background so the
    // first Ask turn has semantic retrieval ready. Cheap no-op if loaded.
    intelLoad(() => {}).catch(e => console.warn('[ai] embedding warmup failed', e));
  }
  renderGenSettings();
}

function selectGenModel(id){
  const cfg = getGenCfg();
  const presets = getGenPresets();
  const p = presets.find(x => x.id === id);
  if(!p) return;
  if(cfg.modelId === p.id) return;
  cfg.modelId = p.id;
  cfg.dtype = p.dtype;
  // Do NOT clear the per-model download record — `isGenDownloaded(id)` is the
  // source of truth. Legacy `cfg.downloaded` is re-derived by _loadGenCfg().
  saveGenCfg(cfg);
  _askLoadError = null; // errors were about the previous model
  if(typeof clearGenLastError === 'function') clearGenLastError();
  renderGenSettings();
}

function setGenTimeout(v){
  const cfg = getGenCfg();
  const n = parseInt(v, 10);
  if(!Number.isFinite(n) || n < 5 || n > 120) return;
  cfg.timeoutSec = n;
  saveGenCfg(cfg);
}

function setGenAskApplyMode(mode){
  if(typeof getGenCfg !== 'function' || typeof saveGenCfg !== 'function') return;
  if(mode !== 'auto' && mode !== 'review') return;
  const cfg = getGenCfg();
  if(cfg.askApplyMode === mode) return;
  cfg.askApplyMode = mode;
  saveGenCfg(cfg);
  if(typeof _cmdkInitApplyModeFromCfg === 'function') _cmdkInitApplyModeFromCfg();
  renderGenSettings();
}

async function genDownloadClick(){
  if(typeof genLoad !== 'function') return;
  const cfg = getGenCfg();
  if(!cfg.enabled){ cfg.enabled = true; saveGenCfg(cfg); }
  _askLoadError = null;
  if(typeof clearGenLastError === 'function') clearGenLastError();

  const targetModelId = cfg.modelId;

  // Render once up-front so the Cancel button replaces the Download button
  // and the progress track appears immediately (not after the first chunk).
  renderGenSettings();

  const txt = () => document.getElementById('genProgressTxt');
  const initTxt = txt(); if(initTxt) initTxt.textContent = 'preparing…';
  syncGenChip('loading', '0% · preparing');
  _showGenLoadRibbonIndeterminate('Downloading LLM weight files…');

  // Safety net: force-hide the ribbon after 5 minutes even if genLoad hangs.
  const ribbonTimeout = setTimeout(() => {
    const r = document.getElementById('genLoadRibbon');
    if(r && !r.hidden){
      console.warn('[ai] download ribbon safety timeout — forcing hide');
      _hideGenLoadRibbon();
    }
  }, 5 * 60 * 1000);

  // Monotonic aggregator: HF emits per-file progress that would otherwise snap
  // back to 0% each time a new shard starts downloading.
  const onProgress = _makeProgressAggregator((v, ev) => {
    _syncGenDownloadProgress(v, ev);
  });

  try{
    await genLoad(targetModelId, cfg.dtype, onProgress);
    // gen.js.markGenDownloaded() was already called by genLoad for whichever
    // slug actually resolved (primary or alt), so we just mirror the legacy
    // boolean for any external readers still consulting it.
    const freshCfg = getGenCfg();
    freshCfg.downloaded = true;
    saveGenCfg(freshCfg);
    syncGenChip('ready', '');
    if(typeof syncAskPromoChip === 'function') syncAskPromoChip();
    // LLM-dependent surfaces (parse-with-LLM button) may need to appear now.
    if(typeof maybeShowEnhanceBtn === 'function') maybeShowEnhanceBtn();
  }catch(e){
    const msg = (e && e.message) ? e.message : 'Load failed';
    _askLoadError = { modelId: targetModelId, message: msg };
    syncGenChip('error', 'LLM load failed');
    if(typeof showExportToast === 'function'){
      const short = msg.length > 80 ? msg.slice(0, 77) + '…' : msg;
      showExportToast('LLM download failed: ' + short);
    }
  }finally{
    clearTimeout(ribbonTimeout);
    _hideGenLoadRibbon();
    renderGenSettings();
  }
}

/** Called from the Ask palette "Open Settings" fallback so the user lands
 *  directly on the LLM section (G6). */
function openGenSettingsFromAsk(){
  try{
    if(typeof showTab === 'function') showTab('settings');
    if(typeof closeCmdK === 'function') closeCmdK();
    const host = document.getElementById('genAISettings');
    if(!host) return;
    // Expand the Integrations accordion if it's collapsed.
    const details = host.closest('details');
    if(details && !details.open) details.open = true;
    requestAnimationFrame(() => {
      host.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const btn = document.getElementById('genDownloadBtn');
      if(btn && !btn.disabled) btn.focus();
    });
  }catch(e){ /* best-effort */ }
}

async function genClearAskHistory(){
  if(typeof clearAskHistory === 'function'){ clearAskHistory(); }
  renderGenSettings();
  _setIntelStatus('ready', 'Ask history cleared');
}

async function genClearCache(){
  if(typeof clearLLMCache !== 'function') return;
  // Clearing cached weights invalidates our per-model downloaded record — the
  // next Load will actually hit the network again.
  try{
    const cfg = getGenCfg();
    cfg.downloadedIds = [];
    cfg.downloaded = false;
    saveGenCfg(cfg);
  }catch(_){ /* best-effort */ }
  let removed = 0;
  try{ removed = await clearLLMCache(); }catch(e){}
  const msg = removed
    ? `Removed ${removed} cached LLM entr${removed === 1 ? 'y' : 'ies'}. For a full purge use "Clear site data".`
    : 'No app-owned LLM caches to remove. Weights may still be in the browser HTTP cache — use "Clear site data" to purge.';
  _setIntelStatus('ready', msg.slice(0, 120));
  renderGenSettings();
}

window.renderGenSettings = renderGenSettings;
window.toggleGenEnabled = toggleGenEnabled;
window.selectGenModel = selectGenModel;
window.setGenTimeout = setGenTimeout;
window.setGenAskApplyMode = setGenAskApplyMode;
window.genDownloadClick = genDownloadClick;
window.openGenSettingsFromAsk = openGenSettingsFromAsk;
window.genClearAskHistory = genClearAskHistory;
window.genClearCache = genClearCache;

/**
 * After reload, re-load LLM weights from HTTP cache if the user had enabled
 * gen + previously downloaded (so Ask shows "ready" without a manual click).
 * Failures are silent — Settings → Load still works.
 */
async function genAutoRehydrateIfCached(){
  if(typeof getGenCfg !== 'function' || typeof genLoad !== 'function') return;
  if(typeof isGenDownloaded !== 'function' || typeof isGenReady !== 'function') return;
  const cfg = getGenCfg();
  if(!cfg || !cfg.enabled) return;
  if(!isGenDownloaded(cfg.modelId)) return;
  if(isGenReady() && typeof getGenModel === 'function' && getGenModel() === cfg.modelId) return;

  // Safety net: force-hide the ribbon after 90s even if genLoad hangs
  // (e.g. stalled fetch, browser cache corruption, WebGPU driver timeout).
  const ribbonTimeout = setTimeout(() => {
    const r = document.getElementById('genLoadRibbon');
    if(r && !r.hidden){
      console.warn('[ai] rehydrate ribbon safety timeout — forcing hide');
      _hideGenLoadRibbon();
      if(typeof syncGenChip === 'function') syncGenChip('idle', '');
    }
  }, 90 * 1000);

  try{
    if(typeof syncGenChip === 'function'){
      syncGenChip('loading', '0% · rehydrating');
      _showGenLoadRibbonIndeterminate('Restoring LLM from browser cache…');
    }
    const dtype = cfg.dtype || 'q4';
    const onProgress = (typeof _makeProgressAggregator === 'function')
      ? _makeProgressAggregator((v, ev) => { _syncGenDownloadProgress(v, ev); })
      : () => {};
    await genLoad(cfg.modelId, dtype, onProgress);
    if(typeof syncGenChip === 'function') syncGenChip('ready', '');
    if(typeof syncAskPromoChip === 'function') syncAskPromoChip();
    if(typeof maybeShowEnhanceBtn === 'function') maybeShowEnhanceBtn();
  }catch(e){
    console.warn('[ai] LLM auto-rehydrate failed', e);
    if(typeof syncGenChip === 'function') syncGenChip('idle', '');
  }finally{
    clearTimeout(ribbonTimeout);
    _hideGenLoadRibbon();
    // Refresh Settings if it's open so its status text reflects the real
    // end-state ("Ready on …") instead of the stale "Initializing model…"
    // line that _syncGenDownloadProgress wrote directly into the DOM.
    if(typeof renderGenSettings === 'function') renderGenSettings();
  }
}

function _scheduleGenAutoRehydrate(){
  const run=()=>{ genAutoRehydrateIfCached().catch(e => console.warn('[ai] auto-rehydrate scheduler', e)); };
  if(typeof requestIdleCallback==='function') requestIdleCallback(run,{timeout:4000});
  else setTimeout(run, 500);
}
if(typeof document!=='undefined'){
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>{ setTimeout(_scheduleGenAutoRehydrate, 500); });
  else setTimeout(_scheduleGenAutoRehydrate, 500);
}
window.genAutoRehydrateIfCached = genAutoRehydrateIfCached;

// Visibility guard: catch any lingering ribbon when the tab regains focus.
// Covers edge cases where genLoad resolved while the tab was backgrounded
// and the DOM update was suppressed by the browser.
document.addEventListener('visibilitychange', function _ribbonVisGuard(){
  if(document.hidden) return;
  const r = document.getElementById('genLoadRibbon');
  if(!r || r.hidden) return;
  // If the gen module is no longer loading, the ribbon shouldn't be visible.
  if(typeof isGenLoading === 'function' && !isGenLoading()){
    console.warn('[ai] visibilitychange — ribbon was stale, hiding');
    _hideGenLoadRibbon();
    // Also sync the chip to a coherent state.
    if(typeof isGenReady === 'function' && isGenReady()){
      syncGenChip('ready', '');
    } else {
      syncGenChip('idle', '');
    }
  }
});

window.selectGenModelFromSelect = function(){ if(typeof selectGenModel==='function') selectGenModel(this.value); };
window.setGenTimeoutFromInput = function(){ if(typeof setGenTimeout==='function') setGenTimeout(this.value); };

document.addEventListener('click', function _smartAddTagDelegate(e){
  const prev = document.getElementById('smartAddPreview');
  if(!prev || !prev.contains(e.target)) return;
  const chip = e.target.closest('[data-sa-tag]');
  if(!chip) return;
  e.preventDefault();
  const enc = chip.getAttribute('data-sa-tag');
  if(enc == null) return;
  try{
    smartAddRemoveTag(decodeURIComponent(enc));
  }catch(_){}
});
