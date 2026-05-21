// ── Global error safety net ─────────────────────────────────────────────────
// Catches unhandled exceptions and promise rejections so they never vanish
// silently.  Logs to console (no user-facing toast to avoid spam).
window.onerror = function(msg, src, line, col, err) {
  console.error('[OdTauLai] Uncaught error:', msg, 'at', src, line + ':' + col, err);
  return false; // allow default browser handling too
};
window.addEventListener('unhandledrejection', function(e) {
  console.error('[OdTauLai] Unhandled promise rejection:', e.reason);
});
// Capture-phase listener for resource load failures (broken images, script 404s, etc.)
window.addEventListener('error', function(e) {
  if (e.target && e.target !== window && e.target.tagName) {
    console.warn('[OdTauLai] Resource load error:', e.target.tagName, e.target.src || e.target.href || '');
  }
}, true);

// ── App version — see js/version.js (ODTAULAI_RELEASE) ─────────────────────
const R = window.ODTAULAI_RELEASE || {};
const APP_VERSION = R.version || 'v26';
const APP_BUILD_DATE = R.buildDate || '2026-04-21';

// ── Persistent storage — protects task data from "Clear browsing history" ──
// Chrome/Edge/Firefox: survives normal clears when granted
// Safari: still subject to 7-day inactivity purge unless PWA is installed
(async () => {
  if ('storage' in navigator && 'persist' in navigator.storage) {
    try {
      const already = await navigator.storage.persisted();
      if (!already) {
        const granted = await navigator.storage.persist();
        window._storagePersistent = granted;
      } else {
        window._storagePersistent = true;
      }
    } catch(e) { window._storagePersistent = false; }
  }
})();

// ── Storage quota monitoring — warn user when approaching limit ─────────────
async function checkStorageQuota(){
  if(!('storage' in navigator)||!navigator.storage.estimate) return null;
  try {
    const est = await navigator.storage.estimate();
    const usedMB = Math.round((est.usage||0)/1024/1024*10)/10;
    const quotaMB = Math.round((est.quota||0)/1024/1024);
    const pct = est.quota ? Math.round((est.usage/est.quota)*100) : 0;
    return { usedMB, quotaMB, pct, persistent: !!window._storagePersistent };
  } catch(e) { return null; }
}

/** Proactive storage-pressure check. Shows a toast when usage > 80%. */
let _storageWarningShown = false;
async function _checkStoragePressure(){
  const info = await checkStorageQuota();
  if(!info) return;
  if(info.pct > 80 && !_storageWarningShown){
    _storageWarningShown = true;
    const msg = `⚠️ Storage ${info.pct}% full (${info.usedMB} MB / ${info.quotaMB} MB). Consider exporting a backup via Settings → Export.`;
    if(typeof showExportToast === 'function') showExportToast(msg);
    console.warn('[app] Storage pressure:', info);
  } else if(info.pct <= 70){
    // Reset the flag so warning re-fires if usage climbs again after a cleanup
    _storageWarningShown = false;
  }
}

// ── Online/offline status indicator ─────────────────────────────────────────
function updateOnlineStatus(){
  const el = document.getElementById('onlineStatus');
  if(!el) return;
  if(navigator.onLine){
    el.hidden = true;
  } else {
    el.hidden = false;
    el.textContent = '● Offline — tasks work, sync paused';
  }
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
setTimeout(updateOnlineStatus, 500);

// ── Service worker update detection ──────────────────────────────────────────
// When a new version is deployed, notify user with an "Update available" banner
// instead of silently waiting for them to close all tabs.
if ('serviceWorker' in navigator && !window.location.protocol.startsWith('file')) {
  navigator.serviceWorker.ready.then(reg => {
    // Check for updates every 30 min while app is open
    const _swUpdateMs = (window.ODTAULAI_CONFIG && window.ODTAULAI_CONFIG.SW_UPDATE_CHECK_MS) || 30 * 60 * 1000;
    const _swUpdateTick = () => { try{ reg.update(); }catch(e){} };
    if(typeof setManagedInterval === 'function'){
      setManagedInterval('sw-update', _swUpdateTick, _swUpdateMs);
      if(typeof onBfcacheRestore === 'function'){
        onBfcacheRestore(() => setManagedInterval('sw-update', _swUpdateTick, _swUpdateMs));
      }
    } else {
      setInterval(_swUpdateTick, _swUpdateMs);
    }

    // Listen for a new service worker waiting to take over
    const showUpdateBanner = () => {
      if(document.getElementById('updateBanner')) return; // already shown
      const banner = document.createElement('div');
      banner.id = 'updateBanner';
      banner.className = 'update-banner';
      const sparkIc = (window.icon && window.icon('sparkles', {size:14})) || '';
      const msg = document.createElement('span');msg.className='update-banner-msg';
      if(sparkIc){const tmp=document.createElement('span');tmp.innerHTML=sparkIc;while(tmp.firstChild)msg.appendChild(tmp.firstChild)}
      const txt=document.createElement('span');txt.textContent='New version available';msg.appendChild(txt);
      banner.appendChild(msg);
      const reloadBtn=document.createElement('button');reloadBtn.textContent='Reload to update';reloadBtn.onclick=function(){applyUpdate()};banner.appendChild(reloadBtn);
      const laterBtn=document.createElement('button');laterBtn.className='update-dismiss';laterBtn.textContent='Later';laterBtn.onclick=function(){dismissUpdate()};banner.appendChild(laterBtn);
      document.body.appendChild(banner);
    };
    window.applyUpdate = () => {
      // If the user is mid-edit inside the task modal, the in-progress field
      // values live only in DOM inputs — saveState reads the committed task
      // object. Commit those edits first so a reload doesn't drop them.
      try {
        if(_isTaskModalOpen() && typeof saveTaskDetail === 'function' && typeof editingTaskId !== 'undefined' && editingTaskId != null){
          saveTaskDetail();
        }
      } catch(e) { console.warn('[app] applyUpdate commit-modal', e); }
      // Flush any pending state before reload so user doesn't lose recent changes
      try { if(typeof saveState === 'function') saveState('unload'); } catch(e) {}
      if(reg.waiting) reg.waiting.postMessage({type:'SKIP_WAITING'});
      // Wait for controllerchange then reload
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if(!reloaded){ reloaded = true; location.reload(); }
      });
      // Safety net — force reload after 1.5s even if controllerchange misses
      setTimeout(() => { if(!reloaded){ reloaded = true; location.reload(); } }, 1500);
    };
    window.dismissUpdate = () => {
      const b = document.getElementById('updateBanner'); if(b) b.remove();
    };

    if(reg.waiting){ showUpdateBanner(); return; }
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      if(!newWorker) return;
      newWorker.addEventListener('statechange', () => {
        if(newWorker.state === 'installed' && navigator.serviceWorker.controller){
          showUpdateBanner();
        }
      });
    });
  }).catch(() => {});

  // ── Handle notification click routing from the Service Worker ──
  // When the user taps a SW notification, the SW postMessages us with
  // the notification's data payload so we can navigate to the right task.
  navigator.serviceWorker.addEventListener('message', e => {
    if(e.data?.type !== 'NOTIFICATION_CLICK') return;
    const d = e.data.data || {};
    if(d.action === 'openTask' && d.taskId != null){
      if(typeof showTab === 'function') showTab('tasks');
      if(typeof openTaskDetail === 'function') openTaskDetail(d.taskId);
    } else if(d.action === 'openTimer'){
      if(typeof showTab === 'function') showTab('focus');
    }
  });
}
// ========== ARCHIVE ==========
function getArchives(){try{return JSON.parse(localStorage.getItem(ARCHIVE_KEY)||'[]')}catch(e){return[]}}

function renderArchive(){
  const archives=getArchives();
  const list=gid('archiveList');
  gid('archiveCount').textContent=archives.length+' day'+(archives.length!==1?'s':'');
  list.textContent='';
  if(!archives.length){const e=document.createElement('div');e.className='iempty';e.textContent='History will appear here after each day';list.appendChild(e);return}
  // Most recent first
  archives.slice().reverse().forEach((a,idx)=>{
    const doneG=a.goals?a.goals.filter(g=>g.done).length:0;
    const totalG=a.goals?a.goals.length:0;
    const d=document.createElement('button');d.type='button';d.className='hist-day';d.setAttribute('aria-expanded','false');
    d.onclick=function(){this.classList.toggle('open');this.setAttribute('aria-expanded',this.classList.contains('open')?'true':'false')};
    d.innerHTML=`<div class="hist-day-hdr"><span class="hist-day-date">${prettyDate(a.date)}</span><div class="hist-day-stats"><div class="hist-day-stat"><span class="text-work">${a.totalPomos||0}</span> sessions</div><div class="hist-day-stat"><span class="text-long">${fmtShort(a.totalFocusSec||0)}</span></div>${totalG?`<div class="hist-day-stat"><span class="text-short">${doneG}/${totalG}</span> goals</div>`:''}</div></div>`
      +`<div class="hist-day-detail">`
      +(a.goals&&a.goals.length?`<div class="hist-day-section"><div class="hist-day-section-title">Goals</div>${a.goals.map(g=>`<div class="hist-goal">${g.done?'✓':'○'} ${esc(g.text)}${g.doneAt?' <span class="text-4">('+esc(String(g.doneAt))+')</span>':''}</div>`).join('')}</div>`:'')
      +(a.tasks&&a.tasks.length?`<div class="hist-day-section"><div class="hist-day-section-title">Tasks</div>${a.tasks.map(t=>`<div class="hist-task">${esc(t.name)}: ${fmtHMS(t.totalSec||0)} (${t.sessions||0} sessions)</div>`).join('')}</div>`:'')
      +(a.timeLog&&a.timeLog.length?`<div class="hist-day-section"><div class="hist-day-section-title">Session Log</div>${a.timeLog.slice().reverse().slice(0,20).map(l=>`<div class="hist-log">${esc(l.time)} — ${esc(l.name)} (${fmtShort(l.durSec)})</div>`).join('')}</div>`:'')
      +`</div>`;
    list.appendChild(d)
  })
}

async function clearArchive(){if(!(await showAppConfirm('Clear all past day history? This cannot be undone.')))return;localStorage.removeItem(ARCHIVE_KEY);renderArchive()}

function exportAllCSV(){
  const archives=getArchives();
  if(!archives.length){alert('No history to export');return}
  let csv='Date,Sessions,Focus Time (min),Breaks,Goals Done,Goals Total,Tasks\n';
  archives.forEach(a=>{
    const doneG=a.goals?a.goals.filter(g=>g.done).length:0;
    const totalG=a.goals?a.goals.length:0;
    const taskNames=(a.tasks||[]).map(t=>{
      let n=String(t.name||'').replace(/"/g,'""');
      if(/^[=+\-@\t\r]/.test(n)) n = "'" + n;
      return n;
    }).join('; ');
    csv+=`"${a.date}",${a.totalPomos||0},${Math.floor((a.totalFocusSec||0)/60)},${a.totalBreaks||0},${doneG},${totalG},"${taskNames}"\n`;
  });
  const blob=new Blob([csv],{type:'text/csv'});
  const el=document.createElement('a');el.href=URL.createObjectURL(blob);el.download='odtaulai-history.csv';el.click();URL.revokeObjectURL(el.href)
}

// ========== EXPORT ==========
function buildTaskTreeReport(bullet,parentId,depth){
  let out='';
  getTaskChildren(parentId).forEach(t=>{
    const indent=bullet.startsWith('-')?'  '.repeat(depth):'    '.repeat(depth);
    const own=getTaskElapsed(t),rolled=getRolledUpTime(t.id);
    const kids=hasChildren(t.id);
    const timeStr=kids?fmtHMS(rolled)+(own>0?' (own '+fmtShort(own)+')':''):fmtHMS(own);
    out+=indent+bullet+t.name+': '+timeStr+' ('+t.sessions+' session'+(t.sessions!==1?'s':'')+')'+'\n';
    out+=buildTaskTreeReport(bullet,t.id,depth+1);
  });
  return out;
}

function buildReport(format){
  // Human-readable daily report — txt or md. For data export, use exportTasksCSV/JSON instead.
  const date=dateStr();const fm=Math.floor(totalFocusSec/60);const focusStr=fm>=60?Math.floor(fm/60)+'h '+fm%60+'m':fm+'m';
  const doneGoals=goals.filter(g=>g.done),missedGoals=goals.filter(g=>!g.done);
  const goalPct=goals.length?Math.round((doneGoals.length/goals.length)*100):0;
  const isMd=format==='md';const hr=isMd?'---':'────────────────────────────────────────';const h1=s=>isMd?'# '+s:s;const h2=s=>isMd?'## '+s:'  '+s;const check=done=>isMd?(done?'- [x] ':'- [ ] '):(done?'  [✓] ':'  [ ] ');const bullet=isMd?'- ':'  • ';
  let r=h1('Daily Report — '+date)+'\n'+hr+'\n\n';
  r+=h2('Summary')+'\n'+bullet+'Sessions: '+totalPomos+'\n'+bullet+'Focus time: '+focusStr+'\n'+bullet+'Breaks: '+totalBreaks+'\n'+bullet+'Goals: '+doneGoals.length+'/'+goals.length+' ('+goalPct+'%)\n\n';
  if(goals.length){r+=h2('Goals')+'\n';doneGoals.forEach(g=>{r+=check(true)+g.text+(g.doneAt?' ('+g.doneAt+')':'')+'\n'});missedGoals.forEach(g=>{r+=check(false)+g.text+'\n'});r+='\n'}
  if(tasks.length){r+=h2('Time by Task')+'\n'+buildTaskTreeReport(bullet,null,0)+'\n'}
  if(timeLog.length){r+=h2('Session Log')+'\n';timeLog.slice().reverse().forEach(l=>{r+=bullet+l.time+' | '+(l.type==='work'?'FOCUS':l.type==='short'?'SHORT BREAK':l.type==='quick'?'QUICK':'LONG BREAK')+' | '+l.name+' | '+fmtShort(l.durSec)+'\n'});r+='\n'}
  r+=hr+'\nGenerated at '+timeNow()+' by OdTauLai\n';return r
}
function exportFile(format){
  // Daily report only supports txt/md now; csv is routed to the unified task CSV
  if(format==='csv'){ return exportTasksCSV(); }
  const content=buildReport(format);
  const ext=format==='md'?'md':'txt';
  const blob=new Blob([content],{type:'text/plain'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='odtaulai-'+todayKey()+'.'+ext;a.click();URL.revokeObjectURL(a.href);
}
function exportClipboard(){const content=buildReport('txt');navigator.clipboard.writeText(content).then(()=>{const btn=gid('exportClipBtn')||document.querySelector('.export-clip');if(!btn)return;const orig=btn.textContent;btn.textContent='Copied!';btn.style.color='#2ecc71';btn.style.borderColor='#1a4a2a';setTimeout(()=>{btn.textContent=orig;btn.style.color='';btn.style.borderColor=''},1500)}).catch(()=>{const ta=document.createElement('textarea');ta.value=content;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta)})}

// One-shot purge of legacy generative-AI keys (v48 dropped the on-device LLM).
// Wrapped because private-browsing / quota-exceeded modes throw on access.
try {
  if (!localStorage.getItem('odtaulai_v48_migrated')) {
    localStorage.removeItem('stupind_gen_cfg');
    localStorage.removeItem('stupind_gen_history');
    localStorage.setItem('odtaulai_v48_migrated', '1');
  }
} catch (_) {}

// ========== Delegated handler wrappers ==========
// Named functions for the cases the migration script left behind: multi-
// statement bodies, conditionals, this.value/this.files lookups, and modal
// backdrop dismiss. Replaces the corresponding inline onclick="..." handlers
// in index.html. All defined as window.X so the document-level dispatcher
// in js/event-delegation.js can resolve them by name.
window.taskInputLiveUpdate = function(){
  if(typeof maybeShowEnhanceBtn === 'function') maybeShowEnhanceBtn();
  if(typeof updateLiveParsePreview === 'function') updateLiveParsePreview();
};
window.addTaskOrApplyPreview = function(){
  if(window._smartAddPreview && typeof applySmartAddAndSubmit === 'function') applySmartAddAndSubmit();
  else if(typeof addTask === 'function') addTask();
};
window.setTaskViewMobile = function(view){
  if(typeof setTaskView === 'function') setTaskView(view);
  if(typeof updateMobileViewToggle === 'function') updateMobileViewToggle();
};
window.qtLabelEnterKey = function(e){
  if(e && e.key === 'Enter' && typeof addQuickTimer === 'function') addQuickTimer();
};
window.intervalChimePreview = function(){
  const v = gid('intChime'); if(v && typeof playChime === 'function') playChime(v.value);
};
window.applyPhasePresetFromSelect = function(e){
  if(typeof applyPhasePreset === 'function') applyPhasePreset(e && e.target ? e.target.value : '');
};
window.refreshSystemInfoQuota = function(){
  if(typeof checkStorageQuota !== 'function' || typeof renderSystemInfo !== 'function') return;
  checkStorageQuota().then(renderSystemInfo).catch(() => {});
};
function _fileInputDispatch(fn, e){
  const input = e && e.target;
  if(!input || !input.files || !input.files[0] || typeof fn !== 'function') return;
  fn(input.files[0]);
  input.value = '';
}
window.importTasksFromInput          = function(e){ _fileInputDispatch(window.importTasks, e); };
window.importDataFromInput           = function(e){ _fileInputDispatch(window.importData, e); };
window.importDataEncryptedFromInput  = function(e){ _fileInputDispatch(window.importDataEncrypted, e); };
function _backdropClose(closeFn){
  return function(e){ if(e && e.target === this && typeof closeFn === 'function') closeFn(); };
}
window.closeWhatNextOnBackdrop        = _backdropClose(() => closeWhatNext());
window.closeCmdKOnBackdrop            = _backdropClose(() => closeCmdK());
window.closeBulkImportModalOnBackdrop = _backdropClose(() => closeBulkImportModal());
window.closeAppConfirmOnBackdrop      = _backdropClose(() => closeAppConfirm(false));
window.closeAppPromptOnBackdrop       = _backdropClose(() => closeAppPrompt(null));
window.closeTaskDetailOnBackdrop      = _backdropClose(() => closeTaskDetail());
window.appPromptInputKey = function(e){
  if(e && e.key === 'Enter' && typeof submitAppPrompt === 'function'){
    e.preventDefault();
    submitAppPrompt();
  }
};
window.openTaskDetailAndCloseWhatNext = function(id){
  if(typeof openTaskDetail === 'function') openTaskDetail(Number(id));
  if(typeof closeWhatNext === 'function') closeWhatNext();
};
window.checklistAddOnEnter = function(e){
  if(!e || e.key !== 'Enter') return;
  const taskId = Number(this.dataset.taskId);
  if(typeof addChecklistItem === 'function') addChecklistItem(taskId, this.value);
  this.value = '';
};
window.checklistAddFromButton = function(){
  const inp = document.getElementById('clInput');
  if(!inp) return;
  const taskId = Number(this.dataset.taskId);
  if(typeof addChecklistItem === 'function') addChecklistItem(taskId, inp.value);
  inp.value = '';
};
window.taskNoteAddFromButton = function(){
  const inp = document.getElementById('noteInput');
  if(!inp) return;
  const taskId = Number(this.dataset.taskId);
  if(typeof addTaskNote === 'function') addTaskNote(taskId, inp.value);
  inp.value = '';
};
window.taskBlockerAddFromSelect = function(){
  const sel = document.getElementById('blockerSel');
  if(!sel) return;
  const taskId = Number(this.dataset.taskId);
  if(typeof addBlockedBy === 'function') addBlockedBy(taskId, sel.value);
};
window.classificationSetLabelFromInput = function(){
  const idx = Number(this.dataset.idx);
  if(typeof classificationSetLabel === 'function') classificationSetLabel(idx, this.value);
};
window.classificationSetIconFromSelect = function(){
  const idx = Number(this.dataset.idx);
  if(typeof classificationSetIcon === 'function') classificationSetIcon(idx, this.value);
};
window.classificationSetColorFromSelect = function(){
  const idx = Number(this.dataset.idx);
  if(typeof classificationSetColor === 'function') classificationSetColor(idx, this.value);
};
window.classificationSetFocusFromTextarea = function(){
  const idx = Number(this.dataset.idx);
  if(typeof classificationSetFocus === 'function') classificationSetFocus(idx, this.value);
};
window.classificationSetCoreValuesFromTextarea = function(){
  const idx = Number(this.dataset.idx);
  if(typeof classificationSetCoreValues === 'function') classificationSetCoreValues(idx, this.value);
};
window.classificationSetExamplesFromTextarea = function(){
  const idx = Number(this.dataset.idx);
  if(typeof classificationSetExamples === 'function') classificationSetExamples(idx, this.value);
};
window.syncCopyMyCode = function(){
  const el = document.getElementById('syncMyCode');
  const txt = el ? (el.textContent || '') : '';
  if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).catch(() => {});
};
window.syncOnCodeInputFromInput = function(){
  if(typeof syncOnCodeInput === 'function') syncOnCodeInput(this);
};
window.syncConnectInputKey = function(e){
  if(e && e.key === 'Enter' && typeof syncConnectFromInput === 'function') syncConnectFromInput();
};
window.calFeedModeFromButton = function(){
  if(typeof calFeedMode === 'function') calFeedMode(this, this.dataset.mode);
};
window.hideWorkerInstructions = function(){
  const el = document.getElementById('workerInstructions');
  if(el) el.hidden = true;
};

// ========== INIT ==========
loadState();
if(typeof setHeaderDate==='function') setHeaderDate();
if(typeof ensureClassificationConfig==='function') ensureClassificationConfig(cfg);
ensureDefaultList();
setTimeout(() => {
  if(typeof embedStore !== 'undefined' && embedStore.cleanOrphans){
    embedStore.cleanOrphans().catch(() => {});
  }
}, 200);
// Manifest shortcuts use ?tab= — override saved tab when opening from a shortcut/link (after list bootstrap)
(function applyTabFromUrl(){
  try{
    const u = new URL(window.location.href);
    const t = u.searchParams.get('tab');
    if(t && VALID_MAIN_TABS.includes(t)){
      activeTab = t;
      u.searchParams.delete('tab');
      const q = u.searchParams.toString();
      history.replaceState(null, '', u.pathname + (q ? '?' + q : '') + u.hash);
      try { saveState('auto'); } catch(e) {}
    }
  } catch(e) {}
})();

// Quick-add launch: ?quickadd=1 → focus the task input + scroll into view + flash.
// Used by the manifest "Quick Add" shortcut and by the OS-level widget surface.
(function applyQuickAddLaunch(){
  try{
    const u = new URL(window.location.href);
    if(u.searchParams.get('quickadd') !== '1') return;
    activeTab = 'tasks';
    const after = () => {
      const inp = document.getElementById('taskInput');
      if(!inp) return;
      try{
        if(typeof showTab === 'function') showTab('tasks');
        inp.focus();
        inp.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Brief visual flash so the user sees where focus landed.
        inp.classList.add('quickadd-flash');
        setTimeout(() => inp.classList.remove('quickadd-flash'), 1500);
      }catch(_){}
    };
    if(document.readyState === 'complete') setTimeout(after, 200);
    else window.addEventListener('DOMContentLoaded', () => setTimeout(after, 200));
    u.searchParams.delete('quickadd');
    history.replaceState(null, '', u.pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : '') + u.hash);
  }catch(_){}
})();

// G-21: Web Share Target — receives shares FROM other apps via the OS share sheet.
// Manifest declares share_target.action=./?share=1 with method=GET, and the OS
// appends share_title / share_text / share_url. We treat presence of ANY of
// those as a share (some browsers may drop the literal `share=1` when merging),
// then prefill the new-task input and show a banner so the user knows it landed.
(function applyShareTarget(){
  try{
    const u = new URL(window.location.href);
    const title = u.searchParams.get('share_title') || u.searchParams.get('title') || '';
    const text  = u.searchParams.get('share_text')  || u.searchParams.get('text')  || '';
    const url   = u.searchParams.get('share_url')   || u.searchParams.get('url')   || '';
    const flag  = u.searchParams.get('share') === '1';
    const parts = [title, text, url].filter(Boolean);
    if(!parts.length && !flag) return;
    activeTab = 'tasks';
    const after = () => {
      const inp = document.getElementById('taskInput');
      if(!inp) return;
      try{
        if(typeof showTab === 'function') showTab('tasks');
        inp.value = parts.join(' — ');
        inp.focus();
        try{ inp.setSelectionRange(inp.value.length, inp.value.length); }catch(_){}
        inp.scrollIntoView({ behavior: 'smooth', block: 'center' });
        inp.classList.add('quickadd-flash');
        setTimeout(() => inp.classList.remove('quickadd-flash'), 1500);
        // Trigger the smart-add suggestion bar if present so the user can
        // refine before submitting.
        if(typeof maybeShowEnhanceBtn === 'function') maybeShowEnhanceBtn();
      }catch(_){}
      // Visible confirmation banner.
      let banner = document.getElementById('shareInBanner');
      if(!banner){
        banner = document.createElement('div');
        banner.id = 'shareInBanner';
        banner.className = 'share-in-banner';
        banner.setAttribute('role', 'status');
        banner.setAttribute('aria-live', 'polite');
        document.body.appendChild(banner);
      }
      banner.replaceChildren();
      const lead = document.createElement('span');
      lead.textContent = 'Imported from share — review then press Enter or “+ Add”.';
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'share-in-x';
      dismiss.textContent = '✕';
      dismiss.setAttribute('aria-label', 'Dismiss');
      dismiss.onclick = () => banner.remove();
      banner.append(lead, dismiss);
      banner.hidden = false;
      setTimeout(() => { if(banner.parentNode) banner.remove(); }, 8000);
    };
    if(document.readyState === 'complete') setTimeout(after, 200);
    else window.addEventListener('DOMContentLoaded', () => setTimeout(after, 200));
    ['share','share_title','share_text','share_url','title','text','url'].forEach(k => u.searchParams.delete(k));
    history.replaceState(null, '', u.pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : '') + u.hash);
  }catch(_){}
})();

// G-22: File handlers — when launched via "Open with OdTauLai" the OS sends
// a launchQueue entry with the file. We support .json (full backup / tasks)
// and .ics (calendar feed paste).
(function applyFileHandlers(){
  if(!('launchQueue' in window) || !window.launchQueue || typeof window.launchQueue.setConsumer !== 'function') return;
  try{
    window.launchQueue.setConsumer(async (params) => {
      if(!params || !params.files || !params.files.length) return;
      for(const fh of params.files){
        try{
          const file = await fh.getFile();
          const name = (file && file.name || '').toLowerCase();
          const text = await file.text();
          if(name.endsWith('.ics')){
            // Paste-as-calendar: hand to addCalFeed if available
            if(typeof addCalFeed === 'function'){
              addCalFeed({ label: file.name.replace(/\.ics$/i,''), content: text, color: '#3d8bcc' });
              if(typeof showExportToast === 'function') showExportToast('Calendar feed added: ' + file.name);
            }
          } else if(name.endsWith('.json')){
            // Try as full backup first; fall back to tasks-only import.
            if(typeof importData === 'function'){
              try{ importData(file); }catch(_){
                if(typeof importTasks === 'function') importTasks(file);
              }
            }
          }
        }catch(e){ console.warn('[file_handlers]', e); }
      }
    });
  }catch(_){}
})();
// Only initialise a fresh phase when storage didn't restore one.
// _timerStateRehydrated is set by _applyState when valid pomoLive is found —
// otherwise setPhaseTime resets remaining/totalDuration to a full phase and
// wipes any in-progress focus session the user just reloaded into.
if(!window._timerStateRehydrated) setPhaseTime();
if(typeof restoreTaskToolbarPrefs==='function') restoreTaskToolbarPrefs();
if(typeof refreshClassificationUi==='function') refreshClassificationUi();
renderAll();
renderLog();
renderGoalList();
renderIntList();
renderQuickTimers();
ensureQuickTick();
// Restore task toolbar UI
if(gid('taskSortSel'))gid('taskSortSel').value=taskSortBy;
if(gid('groupBySel'))gid('groupBySel').value=taskGroupBy;
if(typeof updateFiltersSummary==='function') updateFiltersSummary();
applyTheme();
setTaskView(taskView);
setSmartView(smartView);
if(typeof hydrateIcons==='function') hydrateIcons();
updateMiniTimer();

// Pomodoro post-rehydrate reconciliation. If the timer was running at save
// time, either resume the tick interval (and re-schedule phase-end audio) or,
// if the phase would have completed while the tab was closed, fire the
// completion flow now so the user sees the correct end state rather than a
// frozen mid-phase display.
if(window._timerStateRehydrated){
  try{
    if(running && remaining > 0){
      clearInterval(tickId);
      tickId = setInterval(tick, 250);
      if(typeof schedulePhaseAudio === 'function' && cfg.sound) schedulePhaseAudio();
      if(typeof startKeepalive === 'function') startKeepalive();
      if(typeof _syncRingState === 'function') _syncRingState();
      if(typeof renderCtrls === 'function') renderCtrls();
    } else if(window._timerNeedsCompletion && typeof onPhaseComplete === 'function'){
      // Phase ended while away — run the completion flow once. running was
      // already cleared in _applyState; onPhaseComplete handles the rest
      // (pip update, log entry, optional auto-advance).
      running = false;
      remaining = 0;
      try{ onPhaseComplete(); }catch(e){ console.warn('[app] onPhaseComplete on rehydrate', e); }
      window._timerNeedsCompletion = false;
    } else {
      // Paused mid-phase — just refresh the display so the ring and digits
      // show the correct remaining time instead of a stale full phase.
      if(typeof renderTimerChrome === 'function') renderTimerChrome();
    }
  }catch(e){ console.warn('[app] timer rehydrate reconcile', e); }
}
// Apply saved active tab without scroll
document.querySelectorAll('[data-tab]').forEach(el=>{el.hidden = !(el.dataset.tab===activeTab)});
document.querySelectorAll('.nav-tab').forEach(el=>{const on=el.dataset.navtab===activeTab;el.classList.toggle('active',on);el.setAttribute('aria-selected',on?'true':'false')});
// Nav-tab clicks are routed by the document-level dispatcher in
// js/event-delegation.js via data-action="showTab" data-arg="<tab>".
if(activeTab==='focus'&&typeof setTimerSub==='function') setTimerSub(cfg.timerSub||'pomo');
if(typeof syncQaHintVisibility==='function') syncQaHintVisibility();
if(activeTab==='settings'){
  if(typeof renderClassificationSettings==='function') renderClassificationSettings();
  if(typeof renderListsManager==='function') renderListsManager();
}

// PWA status — standalone / file / SW; install UI lives in pwa.js (refreshPWAInstallUI)
(function(){
  const status=gid('pwaStatus');if(!status)return;
  const isStandalone=window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone===true;
  const okIc = (window.icon && window.icon('checkCircle', {size:13})) || '';
  const warnIc = (window.icon && window.icon('alertTriangle', {size:13})) || '';
  if(isStandalone){status.innerHTML=okIc+' Running as app';return}
  if(location.protocol==='file:'){
    // Clarify the implication: file:// works as a portable snapshot but the
    // browser refuses to register a service worker over that scheme, so
    // there's no offline cache regardless of browser support. Don't blame
    // the browser — point at the protocol.
    status.innerHTML = warnIc + ' Served via file:// — Install + offline cache require HTTP(S).';
    return;
  }
  if(!('serviceWorker' in navigator)){status.textContent='Browser does not support PWA';return}
  setTimeout(()=>{
    if(window._swRegistered===false){ status.textContent='Offline cache unavailable in this browser'; return; }
    if(typeof window.refreshPWAInstallUI==='function') window.refreshPWAInstallUI();
  },500)
})();

// Day rollover — detect the boundary in memory so a tab left open past midnight
// still archives yesterday's counters. (Previously we read localStorage, but
// the 10s auto-save overwrites s.date to today before this check runs, which
// swallowed the rollover for continuously-open tabs.)
let _lastKnownDate = (typeof todayKey === 'function') ? todayKey() : null;
// When rollover wants to fire but the user is mid-edit in the task modal,
// we defer up to MAX_DEFER_MS so:
//   (a) the "Crossed midnight" toast doesn't slide over their typing,
//   (b) the renderAll sweep doesn't tear down the list while a row in it
//       is the modal's anchor, and
//   (c) any timer-bound side effects (pauseTimer, day-counter reset) wait
//       until the user closes the modal.
// Past the cap we proceed anyway — bookkeeping has to happen at some
// point. _pendingRolloverSince timestamps the first deferred attempt so
// the cap is measured from the actual midnight boundary, not from "now".
const _ROLLOVER_MODAL_MAX_DEFER_MS = 30 * 60 * 1000; // 30 minutes
let _pendingRolloverSince = 0;
let _rolloverNagShown = false;
function _isTaskModalOpen(){
  const m = (typeof document !== 'undefined') ? document.getElementById('taskModal') : null;
  return !!(m && m.classList && m.classList.contains('open'));
}
// region planDayRollover-test-extract
/**
 * Pure decision logic for day rollover. Returns the action to take and the
 * next values for deferral state. Extracted from _handleDayRollover so the
 * branches can be unit-tested without DOM, storage, or timer side effects.
 *
 * @param {string|null} today      Current day key (e.g. '2026-05-21')
 * @param {string|null} lastKnown  Last day we observed
 * @param {boolean} isModalOpen    Is a task modal mid-edit right now?
 * @param {number} pendingSince    When this rollover first deferred (epoch ms), 0 if none
 * @param {boolean} nagShown       Have we already nagged for this deferred rollover?
 * @param {number} now             Current epoch ms (injected for testability)
 * @param {number} maxDeferMs      Max defer window before nagging
 * @returns {{
 *   action: 'noop'|'defer'|'nag'|'rollover',
 *   nextPendingSince: number,
 *   nextNagShown: boolean
 * }}
 */
function planDayRollover(today, lastKnown, isModalOpen, pendingSince, nagShown, now, maxDeferMs){
  // Same day, missing inputs, or first boot — we're in sync; clear pending.
  if(!today || !lastKnown || today === lastKnown){
    return { action: 'noop', nextPendingSince: 0, nextNagShown: false };
  }
  // Different day with modal mid-edit: defer the rollover so we don't fold
  // in-progress edits into yesterday's archive. Past the cap, nag once.
  if(isModalOpen){
    const since = pendingSince || now;
    const deferredFor = now - since;
    if(deferredFor >= maxDeferMs && !nagShown){
      return { action: 'nag', nextPendingSince: since, nextNagShown: true };
    }
    return { action: 'defer', nextPendingSince: since, nextNagShown: nagShown };
  }
  // Different day, modal closed — safe to roll the day over.
  return { action: 'rollover', nextPendingSince: 0, nextNagShown: false };
}
// endregion planDayRollover-test-extract
function _handleDayRollover(){
  try{
    const today = (typeof todayKey === 'function') ? todayKey() : null;
    const plan = planDayRollover(
      today,
      _lastKnownDate,
      _isTaskModalOpen(),
      _pendingRolloverSince,
      _rolloverNagShown,
      Date.now(),
      _ROLLOVER_MODAL_MAX_DEFER_MS,
    );
    _pendingRolloverSince = plan.nextPendingSince;
    _rolloverNagShown = plan.nextNagShown;
    if(plan.action === 'noop' || plan.action === 'defer') return;
    if(plan.action === 'nag'){
      // Past the cap. Don't silently force-archive mid-edit — that risks
      // folding the user's current edits into yesterday's snapshot. Nag
      // once and keep waiting; the modal-close hook will run the
      // rollover the moment the user finishes.
      if(typeof showActionToast === 'function'){
        showActionToast('Day has changed — close this task to archive yesterday', 'OK', () => {}, 8000);
      } else {
        console.warn('[app] day rollover deferred past cap; waiting on open modal');
      }
      return;
    }
    // action === 'rollover'
    // If a Pomodoro is mid-flight when the calendar flips over, the existing
    // tick() will land its phase completion on today and split the session
    // across two archive entries. Pause first so pauseTimer's accounting
    // folds elapsed time into yesterday's totals and the linked task, then
    // archive a coherent yesterday.
    const wasRunning = (typeof running !== 'undefined') && running;
    if(wasRunning && typeof pauseTimer === 'function'){
      try{ pauseTimer(); }catch(e){ console.warn('[app] pauseTimer at rollover', e); }
    }
    const yesterday = (typeof buildYesterdaySnapshot === 'function')
      ? buildYesterdaySnapshot(_lastKnownDate, { totalPomos, totalBreaks, totalFocusSec, goals, tasks, timeLog, sessionHistory })
      : { date: _lastKnownDate, totalPomos, totalBreaks, totalFocusSec, goals, tasks, timeLog, sessionHistory };
    try{
      const k = ((window.ODTAULAI_CONFIG && window.ODTAULAI_CONFIG.STORAGE_KEYS && window.ODTAULAI_CONFIG.STORAGE_KEYS.ARCHIVED_PREFIX) || 'stupind_archived_') + _lastKnownDate;
      if(typeof localStorage === 'undefined' || localStorage.getItem(k) !== '1'){
        archiveDay(yesterday);
      }
    }catch(e){ console.warn('[app] archiveDay at rollover', e); }
    totalPomos=0; totalBreaks=0; totalFocusSec=0;
    sessionHistory=[]; timeLog=[];
    // Note: pomosInCycle deliberately NOT reset — preserving the user's
    // cycle position across midnight is the right call for someone who was
    // mid-pomo-3-of-4 at 23:59. Day-bounded counters reset; cycle does not.
    _lastKnownDate = today;
    if(typeof saveState==='function') saveState('auto');
    if(typeof renderAll==='function') renderAll();
    if(typeof renderLog==='function') renderLog();
    if(typeof renderStats==='function') renderStats();
    if(typeof renderArchive==='function') renderArchive();
    if(wasRunning && typeof showExportToast === 'function'){
      showExportToast('Crossed midnight — yesterday archived. Cycle progress preserved; press Resume to continue.');
    }
  }catch(e){ console.warn('[app] day rollover', e); }
}
// Check every minute while the tab is alive…
if(typeof setManagedInterval === 'function'){
  setManagedInterval('day-rollover', _handleDayRollover, 60 * 1000);
  if(typeof onBfcacheRestore === 'function'){
    onBfcacheRestore(() => setManagedInterval('day-rollover', _handleDayRollover, 60 * 1000));
  }
} else {
  setInterval(_handleDayRollover, 60 * 1000);
}
// …and again whenever the tab regains focus (backgrounded phones/laptops
// often suspend setInterval for hours, so this covers the common case).
document.addEventListener('visibilitychange', () => {
  if(!document.hidden){
    _handleDayRollover();
    _checkStoragePressure();
  }
});

// Init sync panel UI (renders the "Enable Sync" state by default)
if(typeof renderSyncPanel==='function') renderSyncPanel();

if(typeof renderAIPanel==='function') renderAIPanel();
// Bottom-sheet swipe-to-dismiss on the task detail modal (mobile only).
if(typeof _initTaskModalSwipeDismiss==='function') _initTaskModalSwipeDismiss();
// Drag-drop reorder via Sortable.js — replaces the broken native HTML5 drag
// path on touch devices. Single binding on #taskList; survives renders.
if(typeof _initTaskListSortable==='function') _initTaskListSortable();
// Settings → Quick-add fields picker. Render at init so the checkboxes
// reflect the user's saved cfg.quickAddFields the first time they open
// Settings (rather than on first re-render).
if(typeof renderQaFieldsCfg==='function') renderQaFieldsCfg();

// Init calendar feeds panel + auto-refresh on boot
if(typeof renderCalFeedsPanel==='function') renderCalFeedsPanel();
if(typeof autoSyncCalFeedsOnBoot==='function') autoSyncCalFeedsOnBoot();

// ── Render System Info in Settings (version, storage persistence, quota) ───
async function renderSystemInfo(info){
  const el = document.getElementById('systemInfo');
  if(!el) return;
  const data = info || await checkStorageQuota();
  const okIc = (window.icon && window.icon('checkCircle', {size:13})) || '';
  const warnIc = (window.icon && window.icon('alertTriangle', {size:13})) || '';
  const storageLine = data
    ? `${data.persistent ? `<span class="sys-info-ok">${okIc} Protected</span>` : `<span class="sys-info-warn">${warnIc} Not protected — task data may be cleared by "Clear browsing history"</span>`} · Using ${data.usedMB} MB / ${data.quotaMB} MB (${data.pct}%)`
    : 'Storage info unavailable in this browser';
  const onlineLine = navigator.onLine
    ? `<span class="sys-info-ok">${okIc} Online</span>`
    : `<span class="sys-info-warn">${warnIc} Offline — tasks work, sync paused</span>`;
  const lastSaved = window._lastSaveAt
    ? new Date(window._lastSaveAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
    : '—';
  el.innerHTML = `
    <div><strong>Version:</strong> ${APP_VERSION} (built ${APP_BUILD_DATE})</div>
    <div><strong>Last saved:</strong> ${lastSaved}</div>
    <div><strong>Network:</strong> ${onlineLine}</div>
    <div><strong>Storage:</strong> ${storageLine}</div>
    <div><strong>Intelligence:</strong> ${typeof isIntelReady === 'function' && isIntelReady()
      ? `<span class="sys-info-ok">${okIc} Embeddings ready (${typeof getIntelDevice === 'function' ? getIntelDevice() || 'runtime' : ''})</span>`
      : '<span class="text-3">Loads in background (WebGPU ~110 MB, WASM ~33 MB, cached offline)</span>'}</div>`;
}
// Initial render + re-render when online status changes
setTimeout(() => { renderSystemInfo(); _checkStoragePressure(); }, 400);
window.addEventListener('online',  () => renderSystemInfo());
window.addEventListener('offline', () => renderSystemInfo());

// Ambient intelligence — automatically load the small embedding model
// (~33 MB, WebGPU or WASM) on first idle so users get semantic features
// without flipping a toggle. requestIdleCallback yields to user interaction
// during boot; setTimeout fallback covers browsers without rIC.
function _bootIntelLoad(){
  if(typeof intelLoad !== 'function') return;
  const w = document.getElementById('intelProgressWrap');
  const bar = document.getElementById('intelProgressBar');
  const pct = document.getElementById('intelProgressPct');
  const txt = document.getElementById('intelProgressTxt');
  const retry = document.getElementById('intelRetryBtn');
  if(w) w.hidden = false;
  const onProgress = (typeof _makeProgressAggregator === 'function')
    ? _makeProgressAggregator((v, ev) => {
        if(bar) bar.style.width = v + '%';
        if(pct) pct.textContent = v + '%';
        const status = ev && ev.status ? String(ev.status) : '';
        const file = ev && ev.file ? ' · ' + String(ev.file).split('/').pop() : '';
        if(txt) txt.textContent = (status + file).slice(0, 80);
        if(typeof syncHeaderAIChip === 'function') syncHeaderAIChip('loading', v + '%');
      })
    : (p => { /* fallback (shouldn't happen) */
        const v = p && p.progress != null ? Math.round(p.progress) : 0;
        if(bar) bar.style.width = v + '%';
        if(pct) pct.textContent = v + '%';
        if(typeof syncHeaderAIChip === 'function') syncHeaderAIChip('loading', v + '%');
      });
  intelLoad(onProgress).then(async () => {
    if(w) w.hidden = true;
    if(retry) retry.hidden = true;
    if(typeof embedStore !== 'undefined' && embedStore.migrateEmbedRuntimeIfNeeded){
      try{
        const mig = await embedStore.migrateEmbedRuntimeIfNeeded();
        if(mig && mig.didPurge){
          const ban = document.getElementById('embedReindexBanner');
          if(ban){
            ban.hidden = false;
            ban.setAttribute('role', 'status');
            ban.setAttribute('aria-live', 'polite');
            ban.textContent = 'Re-indexing tasks…';
          }
          await embedStore.reindexAllOpenTasks((done, total) => {
            const b = document.getElementById('embedReindexBanner');
            if(b) b.textContent = 'Re-indexing tasks (' + done + ' of ' + total + ')…';
          });
          const b2 = document.getElementById('embedReindexBanner');
          if(b2){
            b2.textContent = 'Re-indexing complete.';
            setTimeout(() => { if(b2) b2.hidden = true; }, 4000);
          }
        }
      }catch(e){ console.warn('[app] embed migration', e); }
    }
    if(typeof ensureCategoryCentroids === 'function'){
      try{ await ensureCategoryCentroids(); }catch(e){ console.warn('[app] category centroids', e); }
    }
    if(typeof ensureSchwartzEmbeddings === 'function'){
      ensureSchwartzEmbeddings().catch(e => console.warn('[app] schwartz embeddings', e));
    }
    if(typeof renderAIPanel === 'function') renderAIPanel();
    if(typeof maybeShowEnhanceBtn === 'function') maybeShowEnhanceBtn();
    if(typeof scheduleIntelDupRefresh === 'function') scheduleIntelDupRefresh();
  }).catch(() => {
    if(w) w.hidden = true;
    if(retry) retry.hidden = false;
    if(typeof syncHeaderAIChip === 'function') syncHeaderAIChip('error', 'Load failed');
    if(typeof showExportToast === 'function') showExportToast('Embedding model failed to load — semantic features unavailable');
    if(typeof renderAIPanel === 'function') renderAIPanel();
    else if(typeof syncSemanticSearchUi === 'function') syncSemanticSearchUi();
  });
}
if(typeof requestIdleCallback === 'function'){
  requestIdleCallback(_bootIntelLoad, { timeout: 3000 });
} else {
  setTimeout(_bootIntelLoad, 1000);
}

/** Desktop palette shortcut label only — mobile shows just the icon via CSS. */
(function syncCmdKKbdText(){
  const kbd = document.querySelector('#cmdKBtn .cmdk-btn-kbd');
  if (!kbd) return;
  if (!/(Mac|iPhone|iPod|iPad)/i.test(navigator.platform || '')) {
    kbd.textContent = 'Ctrl+K';
  } else {
    kbd.textContent = '⌘K';
  }
})();
