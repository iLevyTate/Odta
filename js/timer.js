// ========== CONFIG ==========
function updateConfig(){cfg.work=Math.max(1,parseInt(gid('cfgWork').value)||25);cfg.short=Math.max(1,parseInt(gid('cfgShort').value)||5);cfg.long=Math.max(1,parseInt(gid('cfgLong').value)||15);cfg.cycle=Math.max(2,parseInt(gid('cfgCycle').value)||4);if(getTimerState()==='idle'){setPhaseTime();renderTimerChrome()}saveState('user')}
function toggleOpt(id){const el=gid(id);el.classList.toggle('on');const on=el.classList.contains('on');el.setAttribute('aria-checked',on?'true':'false');if(id==='togBreak')cfg.autoBreak=on;if(id==='togWork')cfg.autoWork=on;if(id==='togSound'){cfg.sound=on;if(!cfg.sound){cancelScheduledAudio();if(typeof swScheduledIntervalNodes!=='undefined'&&swScheduledIntervalNodes.length&&typeof cancelSwIntervalChimes==='function')cancelSwIntervalChimes(swScheduledIntervalNodes);if(typeof quickTimers!=='undefined'&&Array.isArray(quickTimers))quickTimers.forEach(qt=>{if(qt&&typeof cancelQtAudio==='function')cancelQtAudio(qt)});}else if(running){schedulePhaseAudio()}}if(id==='togLink')cfg.linkTask=on;if(id==='togNotif'){cfg.notif=on;if(cfg.notif){reqNotifPerm().then(()=>{ if(typeof renderNotifStatus==='function') renderNotifStatus(); })}else{ if(typeof renderNotifStatus==='function') renderNotifStatus(); }}if(id==='togSnpNote')cfg.askSessionNote=on;saveState('user')}
// Settings is now a regular tab page. The legacy `settingsOpen` flag and
// `toggleSettings()` accordion are kept as no-ops for back-compat with any
// callers (Cmd+K, deep-links) until those are migrated.
let settingsOpen=true;
function toggleSettings(){
  // Ensure the live sub-managers are fresh whenever something asks to "open"
  // settings (e.g. from the command palette). The panel is always visible
  // when the Settings tab is active, so this is just a re-render hook.
  if(typeof renderClassificationSettings==='function') renderClassificationSettings();
  if(typeof renderListsManager==='function') renderListsManager();
}

// ========== STATE ==========
let cfg={work:25,short:5,long:15,cycle:4,autoBreak:true,autoWork:false,sound:true,linkTask:true,notif:true,timerSub:'pomo',hideHabitsInMainViews:true,askSessionNote:true,focusListMode:false,phasePreset:'classic',qaHintHidden:true,quickAddFields:['list','due'],cascadeCompletion:true,dueNotify:true};

/** Named Pomodoro phase presets — applies to cfg.work/short/cycle on selection. */
const PHASE_PRESETS = {
  classic:    { work: 25, short: 5,  long: 15, cycle: 4, label: 'Classic 25/5' },
  short:      { work: 15, short: 3,  long: 10, cycle: 4, label: 'Short 15/3' },
  longfocus:  { work: 52, short: 17, long: 30, cycle: 2, label: 'Long focus 52/17' },
  ultradian:  { work: 90, short: 20, long: 30, cycle: 1, label: 'Ultradian 90/20' },
  deepwork:   { work: 120, short: 30, long: 60, cycle: 1, label: 'Deep work 120/30' },
};
function applyPhasePreset(name){
  const p = PHASE_PRESETS[name];
  if(!p || running) return;
  cfg.work = p.work; cfg.short = p.short; cfg.long = p.long; cfg.cycle = p.cycle;
  cfg.phasePreset = name;
  const fields = [['cfgWork', p.work], ['cfgShort', p.short], ['cfgLong', p.long], ['cfgCycle', p.cycle]];
  fields.forEach(([id, v])=>{ const el = gid(id); if(el) el.value = String(v); });
  if(!finished){ setPhaseTime(); renderTimerChrome(); }
  saveState('user');
}
window.applyPhasePreset = applyPhasePreset;
let phase='work',pomosInCycle=0,totalPomos=0,totalBreaks=0,totalFocusSec=0;
let totalDuration=0,remaining=0,running=false,finished=false;
let startedAt=0,pausedRemaining=0,tickId=null;
let sessionHistory=[],intervals=[],intIdCtr=0,fireCounts={},lastFlash=null,lastTickSec=-1;
let tasks=[],taskIdCtr=0,activeTaskId=null,taskStartedAt=null,subtaskPromptParent=null;
/** Preserved across renderTaskList when filters change while adding a subtask */
let _subtaskFormDraftText='',_subtaskFormDraftParent=null;
let lists=[],listIdCtr=0,activeListId=null,showAllLists=false;
let taskFilters={search:'',status:'all',priority:'all',category:'all'};
let taskSortBy='smart',taskView='list',editingTaskId=null,smartView='all';
// UI preference: smart-view chip bar collapsed-by-default. Persisted with the
// rest of state via storage.js. Showing only the active chip by default keeps
// the task header compact; users can expand to switch via the "All views ▾"
// toggle (auto-collapses again after selecting a view).
let smartViewsExpanded=false;
let taskGroupBy='none',calMonth=null,theme='dark';
let collapsedSections={};
let timeLog=[],goals=[],goalIdCtr=0,logIdCtr=0;
let swRunning=false,swStartTime=0,swElapsed=0,swPausedEl=0,swTickId=null,swLapList=[];
let swFireCounts={},swScheduledIntervalNodes=[];
let quickTimers=[],qtIdCtr=0,qtGlobalTick=null,qtUiRefreshId=null;
let activeTab='tasks';

// Single source of truth for the Pomodoro timer state. Pause-state (the trickiest
// to detect) is "not running, not finished, but progress was made" — the IDLE/PAUSED
// distinction wasn't being made before, which caused updateConfig to silently
// reset paused timers.
function getTimerState(){
  if(running) return 'playing';
  if(finished) return 'finished';
  if(remaining < totalDuration) return 'paused';
  return 'idle';
}

// ========== PHASE ==========
function getPS(p){return p==='work'?cfg.work*60:p==='short'?cfg.short*60:cfg.long*60}
function getPC(p){return p==='work'?'var(--work)':p==='short'?'var(--short)':'var(--long)'}
function getPBg(p){return p==='work'?'var(--work-bg)':p==='short'?'var(--short-bg)':'var(--long-bg)'}
function getPBd(p){return p==='work'?'var(--work-border)':p==='short'?'var(--short-border)':'var(--long-border)'}
function getPL(p){return p==='work'?'Focus':p==='short'?'Short Break':'Long Break'}
function switchPhase(p){if(running)return;phase=p;finished=false;fireCounts={};setPhaseTime();renderTimerChrome()}
function setPhaseTime(){totalDuration=getPS(phase);remaining=totalDuration;pausedRemaining=totalDuration}
function renderTimerChrome(){
  gid('mainCard').style.background=getPBg(phase);gid('mainCard').style.borderColor=getPBd(phase);
  gid('ringFg').setAttribute('stroke',getPC(phase));gid('ringFg').setAttribute('stroke-dashoffset','0');
  gid('display').textContent=fmt(remaining);gid('display').style.color=getPC(phase);gid('display').className='ring-time';
  gid('phaseLabel').textContent=getPL(phase);gid('phaseLabel').style.color=getPC(phase);
  document.querySelectorAll('.tab').forEach(t=>t.className='tab');
  document.querySelectorAll('.tab')[phase==='work'?0:phase==='short'?1:2].classList.add('active',phase==='work'?'work':phase==='short'?'short':'long');
  renderPips();renderCtrls();updateTitle();updateMiniTimer();
}
function renderAll(){
  renderTimerChrome();
  renderStats();renderTaskList();renderGoalList();renderArchive();
}
function setTimerSub(sub){
  const allowed=['pomo','quick','sw','chimes'];
  if(!allowed.includes(sub)) sub='pomo';
  cfg.timerSub=sub;
  document.querySelectorAll('.timer-sub-panel[data-timer-sub]').forEach(el=>{
    el.hidden = !(el.getAttribute('data-timer-sub')===sub);
  });
  document.querySelectorAll('.timer-sub-btn').forEach(b=>{
    b.classList.toggle('active',b.getAttribute('data-sub')===sub);
  });
  if(typeof saveState==='function') saveState('auto');
}
window.setTimerSub=setTimerSub;
function renderPips(){const c=gid('pips');c.textContent='';for(let i=0;i<cfg.cycle;i++){const d=document.createElement('div');d.className='pip'+(i<pomosInCycle?' done':i===pomosInCycle&&phase==='work'?' current':'');d.title='Jump to pomo '+(i+1);d.onclick=(function(idx){return function(){jumpToPomo(idx)}})(i);c.appendChild(d)}}
function jumpToPomo(idx){if(running)return;if(idx<0||idx>=cfg.cycle)return;pomosInCycle=idx;renderPips();saveState('user')}
function _mkBtn(cls,label,handler){const b=document.createElement('button');b.className=cls;b.textContent=label;b.onclick=handler;return b}
function renderCtrls(){
  const c=gid('ctrls');c.textContent='';
  if(!running&&!finished&&remaining===totalDuration){c.appendChild(_mkBtn('btn btn-primary','Start',startTimer))}
  else if(running){c.appendChild(_mkBtn('btn btn-pause','Pause',pauseTimer));c.appendChild(_mkBtn('btn-skip','Skip ▸',skipPhase));c.appendChild(_mkBtn('btn-skip','↻ Phase',resetPhase));c.appendChild(_mkBtn('btn-danger','↻ Cycle',resetAll))}
  else if(finished){const nl=phase==='work'?(pomosInCycle>=cfg.cycle?'Long Break ▸':'Short Break ▸'):'Start Focus ▸';c.appendChild(_mkBtn('btn btn-primary',nl,advancePhase));c.appendChild(_mkBtn('btn-skip','↻ Phase',resetPhase));c.appendChild(_mkBtn('btn-danger','↻ Cycle',resetAll))}
  else{c.appendChild(_mkBtn('btn btn-primary','Resume',resumeTimer));c.appendChild(_mkBtn('btn-skip','Skip ▸',skipPhase));c.appendChild(_mkBtn('btn-skip','↻ Phase',resetPhase));c.appendChild(_mkBtn('btn-danger','↻ Cycle',resetAll))}
}

// Sync ring visual state with running status (for pulse animation)
function _syncRingState(){
  const wrap=document.querySelector('.ring-wrap');
  if(!wrap)return;
  wrap.classList.toggle('ring-running',running);
  ['work','short','long'].forEach(p=>wrap.classList.toggle(p,phase===p));
}

// ========== TIMER ==========
function startTimer(){if(totalDuration<=0)return;running=true;finished=false;startedAt=Date.now();pausedRemaining=remaining;fireCounts={};if(cfg.linkTask&&phase==='work'&&activeTaskId)taskStartedAt=Date.now();clearInterval(tickId);tickId=setInterval(tick,250);schedulePhaseAudio();startKeepalive();renderCtrls();_syncRingState();if(typeof _updateActiveTaskTickSchedule==='function')_updateActiveTaskTickSchedule();}
function pauseTimer(){running=false;const el=Math.floor((Date.now()-startedAt)/1000);pausedRemaining=Math.max(0,pausedRemaining-el);remaining=pausedRemaining;if(activeTaskId&&taskStartedAt){const t=findTask(activeTaskId);if(t){t.totalSec+=Math.floor((Date.now()-taskStartedAt)/1000);taskStartedAt=null}}cancelScheduledAudio();maybeStopKeepalive();renderCtrls();_syncRingState();renderTaskList();saveState('user');if(typeof _updateActiveTaskTickSchedule==='function')_updateActiveTaskTickSchedule();}
function resumeTimer(){running=true;startedAt=Date.now();if(cfg.linkTask&&phase==='work'&&activeTaskId)taskStartedAt=Date.now();clearInterval(tickId);tickId=setInterval(tick,250);schedulePhaseAudio();startKeepalive();renderCtrls();_syncRingState();if(typeof _updateActiveTaskTickSchedule==='function')_updateActiveTaskTickSchedule();}
function tick(){
  if(!running)return;
  const el=Math.floor((Date.now()-startedAt)/1000);remaining=Math.max(0,pausedRemaining-el);
  const totalEl=totalDuration-remaining,circ=553;
  gid('ringFg').setAttribute('stroke-dashoffset',String(circ-(remaining/totalDuration)*circ));
  const disp=gid('display');disp.textContent=fmt(remaining);disp.className='ring-time'+(remaining<=10&&remaining>0?' warn':'');
  intervals.forEach(iv=>{if(iv.intervalSec<=0)return;if((iv.target||'pomo')!=='pomo')return;const exp=Math.floor(totalEl/iv.intervalSec),prev=fireCounts[iv.id]||0;if(exp>prev&&totalEl>0){if(cfg.sound&&!audioScheduled)playChime(iv.chime);fireCounts[iv.id]=exp;flashInt(iv.id)}});
  if(remaining!==lastTickSec){lastTickSec=remaining;if(intervals.length)renderIntList();}
  renderBanner();updateTitle();updateMiniTimer();
  if(remaining<=0){running=false;finished=true;clearInterval(tickId);onPhaseComplete()}
}
function onPhaseComplete(){
  let completedTaskIdForNote = null;
  if(phase==='work'){pomosInCycle++;totalPomos++;totalFocusSec+=totalDuration;sessionHistory.push({type:'work'});
    const pips=gid('pips').children;if(pips[pomosInCycle-1])pips[pomosInCycle-1].classList.add('done','pop');
    if(activeTaskId&&taskStartedAt){const t=findTask(activeTaskId);if(t){
      const sessSec=Math.floor((Date.now()-taskStartedAt)/1000);
      t.totalSec+=sessSec;t.sessions++;taskStartedAt=null;
      // Per-session log on the task itself so the detail modal can show every
      // timer event distinctly, not just the rolling total + counter. Each
      // entry is small (4 fields) so storage growth is bounded by usage.
      if(!Array.isArray(t.sessionEntries)) t.sessionEntries=[];
      t.sessionEntries.push({ts:timeNowFull(),durationSec:sessSec,type:'work',phase:'work'});
      addLog(t.name,totalDuration,'work');completedTaskIdForNote=t.id;
    }}else addLog('Focus',totalDuration,'work')
  }else{totalBreaks++;sessionHistory.push({type:phase});addLog(getPL(phase),getPS(phase),phase)}
  if(completedTaskIdForNote && cfg.askSessionNote && typeof showSessionNotePrompt === 'function'){
    showSessionNotePrompt(completedTaskIdForNote);
  }
  // If the task detail modal happens to be open on the just-completed task,
  // refresh its tracking display so the new session shows up live.
  if(completedTaskIdForNote && typeof refreshOpenTaskModalIfMatches === 'function'){
    refreshOpenTaskModalIfMatches(completedTaskIdForNote);
  }
  // Scheduled audio already fired at the right moment; only play manually if scheduling failed
  if(cfg.sound&&!audioScheduled)(phase==='work'?playTransition:playBreakEnd)();
  audioScheduled=false;scheduledAudio=[];
  // System notification for backgrounded tabs
  notify(getPL(phase)+' Complete',phase==='work'?'Great work! Time for a break.':'Break over — back to focus.');
  // Show in-app summary toast after work phase completes
  if(phase==='work'&&typeof window.showPomodoroSummary==='function')window.showPomodoroSummary();
  gid('display').className='ring-time done';gid('display').textContent='00:00';gid('phaseLabel').textContent=getPL(phase)+' Complete';
  renderStats();renderCtrls();_syncRingState();renderTaskList();updateTitle();saveState('auto');
  _scheduleAutoAdvance();
}
// Single-pending-timer guard. Without this, rapid Skip → Skip queues two
// 1500ms autoAdvances; both fire startTimer 300ms later and the
// audioScheduled flag can double-fire the chime.
let _pendingAdvanceTimer = null;
let _pendingStartTimer = null;
function _scheduleAutoAdvance(){
  if(_pendingAdvanceTimer) clearTimeout(_pendingAdvanceTimer);
  if((phase==='work' && cfg.autoBreak) || (phase!=='work' && cfg.autoWork)){
    _pendingAdvanceTimer = setTimeout(() => {
      _pendingAdvanceTimer = null;
      if(finished) advancePhase();
    }, 1500);
  }
}
function _scheduleAutoStart(){
  if(_pendingStartTimer) clearTimeout(_pendingStartTimer);
  if((phase!=='work' && cfg.autoBreak) || (phase==='work' && cfg.autoWork)){
    _pendingStartTimer = setTimeout(() => { _pendingStartTimer = null; startTimer(); }, 300);
  }
}
function advancePhase(){
  if(phase==='work') phase = pomosInCycle>=cfg.cycle ? 'long' : 'short';
  else { if(phase==='long') pomosInCycle=0; phase='work'; }
  finished=false; fireCounts={};
  setPhaseTime(); renderAll();
  _scheduleAutoStart();
}
let _lastSkipAt = 0;
function skipPhase(){
  const wasRunning=running;running=false;clearInterval(tickId);cancelScheduledAudio();
  const el=wasRunning?Math.floor((Date.now()-startedAt)/1000):0;
  remaining=Math.max(0,pausedRemaining-el);
  const worked=totalDuration-remaining;
  // Rapid back-to-back skips during triage should not pile up audible chimes
  // and system notifications — squelch both when the user is mashing skip
  // within 4s (#14 in UX audit).
  const _silentSkip = (Date.now() - _lastSkipAt) < 4000;
  _lastSkipAt = Date.now();
  let _skippedTaskId=null;
  if(phase==='work'){
    if(worked>30)totalFocusSec+=worked;
    if(activeTaskId&&taskStartedAt){
      const t=findTask(activeTaskId);
      if(t){
        const sessSec=Math.floor((Date.now()-taskStartedAt)/1000);
        t.totalSec+=sessSec;t.sessions++;taskStartedAt=null;
        addLog(t.name,worked,'work');
        // Same per-session log as completion, marked partial so detail UI can
        // distinguish a finished pomodoro from a skip.
        if(sessSec>0){
          if(!Array.isArray(t.sessionEntries)) t.sessionEntries=[];
          t.sessionEntries.push({ts:timeNowFull(),durationSec:sessSec,type:'work-partial',phase:'work'});
        }
        _skippedTaskId=t.id;
      }
    }else if(worked>30){addLog('Focus (partial)',worked,'work')}
    if(worked>30){pomosInCycle++;totalPomos++;sessionHistory.push({type:'work'});const pips=gid('pips').children;if(pips[pomosInCycle-1])pips[pomosInCycle-1].classList.add('done','pop')}
  }else{
    totalBreaks++;sessionHistory.push({type:phase});addLog(getPL(phase),worked||getPS(phase),phase);
  }
  if(cfg.sound && !_silentSkip)(phase==='work'?playTransition:playBreakEnd)();
  if(!_silentSkip) notify(getPL(phase)+' Skipped','Moving to next phase.');
  finished=true;gid('display').className='ring-time done';gid('display').textContent='00:00';gid('phaseLabel').textContent=getPL(phase)+' Complete';
  renderStats();renderCtrls();renderTaskList();updateTitle();saveState('user');
  if(_skippedTaskId && typeof refreshOpenTaskModalIfMatches === 'function'){
    refreshOpenTaskModalIfMatches(_skippedTaskId);
  }
  // Offer the session note on a non-trivial skip too — natural complete
  // already prompts; the asymmetry surprises users who finished a real chunk
  // of work but happened to hit Skip (#27 in UX audit).
  if(phase==='work' && worked > 30 && _skippedTaskId && typeof showSessionNotePrompt === 'function'){
    try{ showSessionNotePrompt(_skippedTaskId, worked, 'work-partial'); }catch(_){}
  }
  _scheduleAutoAdvance();
}
async function resetAll(){
  // Mid-cycle "↻ Cycle" mis-taps used to silently wipe pomosInCycle with no
  // recovery — the red styling implied a destructive confirm. Skip the
  // prompt only when there's nothing meaningful to lose (cycle already at 0
  // AND not running AND not finished). Time already worked on the linked
  // task is preserved either way.
  const hasProgress = pomosInCycle > 0 || running || finished;
  if(hasProgress && typeof showAppConfirm === 'function'){
    const ok = await showAppConfirm('Reset cycle? Pip progress (' + pomosInCycle + '/' + cfg.cycle + ') will clear. Time already worked on the linked task is preserved.');
    if(!ok) return;
  }
  running=false;finished=false;clearInterval(tickId);cancelScheduledAudio();phase='work';pomosInCycle=0;fireCounts={};
  if(activeTaskId&&taskStartedAt){const t=findTask(activeTaskId);if(t){t.totalSec+=Math.floor((Date.now()-taskStartedAt)/1000);taskStartedAt=null}}
  setPhaseTime();renderAll();saveState('user');
}
// Reset only the current phase (work, short, long) back to its full duration
// without disturbing the cycle position, the running phase, or other phases'
// progress. Time already worked this phase is folded back into the linked
// active task so it isn't lost.
function resetPhase(){
  running=false;finished=false;clearInterval(tickId);cancelScheduledAudio();fireCounts={};
  // Cancel any auto-advance / auto-start that was queued from a prior phase
  // complete — without this, a phase reset followed by user idle still flips
  // the timer 1.5s later, ignoring the explicit reset (#15 in UX audit).
  if(_pendingAdvanceTimer){ clearTimeout(_pendingAdvanceTimer); _pendingAdvanceTimer = null; }
  if(_pendingStartTimer){ clearTimeout(_pendingStartTimer); _pendingStartTimer = null; }
  if(activeTaskId&&taskStartedAt){const t=findTask(activeTaskId);if(t){t.totalSec+=Math.floor((Date.now()-taskStartedAt)/1000);taskStartedAt=null}}
  setPhaseTime();renderTimerChrome();renderCtrls();_syncRingState();saveState('user');
  if(typeof _updateActiveTaskTickSchedule==='function')_updateActiveTaskTickSchedule();
}
window.resetPhase=resetPhase;

// ========== STOPWATCH ==========
function swToggle(){
  if(swRunning){
    swRunning=false;swPausedEl+=Date.now()-swStartTime;
    gid('swStartBtn').textContent='Resume';gid('swStartBtn').className='btn btn-primary';
    cancelSwIntervalChimes(swScheduledIntervalNodes);
    maybeStopKeepalive();
  }else{
    swRunning=true;swStartTime=Date.now();
    clearInterval(swTickId);swTickId=setInterval(swTick,100);
    gid('swStartBtn').textContent='Pause';gid('swStartBtn').className='btn btn-pause';
    startKeepalive();
    scheduleSwIntervalChimes(Math.floor(swElapsed/1000),intervals,swFireCounts,swScheduledIntervalNodes);
  }
}
function swTick(){
  if(!swRunning)return;
  swElapsed=swPausedEl+Date.now()-swStartTime;
  const elSec=Math.floor(swElapsed/1000);
  gid('swDisplay').textContent=fmtHMS(elSec);
  // Fire 'sw'-target repeating chimes (fallback play + flash)
  let needsRender=false;
  intervals.forEach(iv=>{
    if(iv.intervalSec<=0)return;
    if((iv.target||'pomo')!=='sw')return;
    const exp=Math.floor(elSec/iv.intervalSec),prev=swFireCounts[iv.id]||0;
    if(exp>prev&&elSec>0){
      // Scheduled audio likely already played within the lookahead; only fall back if no nodes are pending
      if(cfg.sound&&swScheduledIntervalNodes.length===0)playChime(iv.chime);
      swFireCounts[iv.id]=exp;flashInt(iv.id);needsRender=true;
    }
  });
  if(needsRender&&typeof renderIntList==='function')renderIntList();
}
function swLap(){if(swElapsed<=0)return;const s=Math.floor(swElapsed/1000),d=document.createElement('div');d.className='sw-lap';const s1=document.createElement('span');s1.textContent='Lap '+(swLapList.length+1);const s2=document.createElement('span');s2.textContent=fmtHMS(s);d.appendChild(s1);d.appendChild(s2);gid('swLaps').prepend(d);swLapList.push(s)}
function swReset(){
  swRunning=false;swElapsed=0;swPausedEl=0;swLapList=[];swFireCounts={};
  cancelSwIntervalChimes(swScheduledIntervalNodes);
  clearInterval(swTickId);
  gid('swDisplay').textContent='00:00:00';gid('swStartBtn').textContent='Start';gid('swStartBtn').className='btn btn-primary';gid('swLaps').textContent='';
  maybeStopKeepalive();
}

// ========== QUICK TIMERS ==========
// Hard cap on total quick timers. Each one carries scheduled audio nodes,
// per-timer fire-count maps, a render row, and a slice of the global tick.
// 30 is well past the practical ceiling and keeps the panel responsive.
const QT_MAX = 30;
// Auto-prune the oldest finished quick timer when the cap would be exceeded
// by a new addition. Returns the count pruned (used for the toast message).
function _pruneFinishedQuickTimers(){
  if(quickTimers.length < QT_MAX) return 0;
  const finished = quickTimers.filter(qt => qt.finished);
  if(!finished.length) return 0;
  // Drop the oldest (lowest id == earliest creation) until back under cap.
  finished.sort((a,b) => a.id - b.id);
  let pruned = 0;
  while(quickTimers.length >= QT_MAX && finished.length){
    const drop = finished.shift();
    cancelQtAudio(drop);
    quickTimers = quickTimers.filter(qt => qt.id !== drop.id);
    pruned += 1;
  }
  return pruned;
}
function addQuickTimer(){
  const mins=parseInt(gid('qtMin').value)||0,secs=parseInt(gid('qtSec').value)||0,total=mins*60+secs;
  if(total<=0)return;
  // Respect the cap. If we can free room by pruning finished timers, do so
  // silently. Otherwise refuse with a toast — better than letting an
  // unbounded list quietly degrade the panel.
  if(quickTimers.length >= QT_MAX){
    const pruned = _pruneFinishedQuickTimers();
    if(quickTimers.length >= QT_MAX){
      if(typeof showExportToast === 'function'){
        showExportToast('Quick-timer cap reached (' + QT_MAX + '). Remove or finish one before adding another.');
      }
      return;
    } else if(pruned > 0 && typeof showExportToast === 'function'){
      showExportToast('Pruned ' + pruned + ' finished timer' + (pruned === 1 ? '' : 's') + ' to make room.');
    }
  }
  const label=(gid('qtLabel').value||'').trim()||'Timer '+fmt(total);
  const sound=gid('qtSound').value;
  quickTimers.push({id:++qtIdCtr,label,totalSec:total,remaining:total,running:false,startedAt:0,pausedRem:total,sound,finished:false,_fireCounts:{}});
  gid('qtLabel').value='';renderQuickTimers();saveState('user')
}

function addQuickPreset(mins,secs,label){
  const total=mins*60+secs;
  // Mirror addQuickTimer's cap behavior — preset clicks shouldn't be a
  // back-door past QT_MAX (#18 in UX audit).
  if(quickTimers.length >= QT_MAX){
    const pruned = pruneFinishedQuickTimers();
    if(quickTimers.length >= QT_MAX){
      if(typeof showExportToast === 'function'){
        showExportToast('Quick-timer cap reached (' + QT_MAX + '). Remove or finish one before adding another.');
      }
      return;
    } else if(pruned > 0 && typeof showExportToast === 'function'){
      showExportToast('Pruned ' + pruned + ' finished timer' + (pruned === 1 ? '' : 's') + ' to make room.');
    }
  }
  quickTimers.push({id:++qtIdCtr,label,totalSec:total,remaining:total,running:false,startedAt:0,pausedRem:total,sound:'bell',finished:false,_fireCounts:{}});
  renderQuickTimers();saveState('user')
}

function toggleQuickTimer(id){
  const qt=quickTimers.find(t=>t.id===id);
  if(!qt)return;
  if(qt.finished){
    qt.remaining=qt.totalSec;qt.pausedRem=qt.totalSec;qt.finished=false;qt.running=true;qt.startedAt=Date.now();qt._fireCounts={};
    reqNotifPerm();scheduleQtAudio(qt);startKeepalive();
  }else if(qt.running){
    const el=Math.floor((Date.now()-qt.startedAt)/1000);
    qt.pausedRem=Math.max(0,qt.pausedRem-el);qt.remaining=qt.pausedRem;qt.running=false;
    cancelQtAudio(qt);maybeStopKeepalive();
  }else{
    qt.running=true;qt.startedAt=Date.now();
    reqNotifPerm();scheduleQtAudio(qt);startKeepalive();
  }
  ensureQuickTick();renderQuickTimers();saveState('user')
}

// Only stop keepalive if nothing is running
function maybeStopKeepalive(){
  if(running)return;
  if(quickTimers.some(qt=>qt.running))return;
  if(swRunning)return;
  stopKeepalive();
}

function resetQuickTimer(id){
  const qt=quickTimers.find(t=>t.id===id);
  if(!qt)return;
  cancelQtAudio(qt);
  qt.running=false;qt.finished=false;qt.remaining=qt.totalSec;qt.pausedRem=qt.totalSec;qt.flashUntil=0;qt._fireCounts={};
  // If this was the last thing keeping audio/keepalive alive, let it go —
  // otherwise the silent oscillator + wake lock keep burning battery (#17).
  maybeStopKeepalive();
  renderQuickTimers();saveState('user')
}

function removeQuickTimer(id){
  const qt=quickTimers.find(t=>t.id===id);if(qt)cancelQtAudio(qt);
  quickTimers=quickTimers.filter(t=>t.id!==id);
  renderQuickTimers();saveState('user')
}

function scheduleQtAudio(qt){
  cancelQtAudio(qt);
  if(!cfg.sound)return;
  const delay=qt.remaining;
  if(delay<=0)return;
  try{
    const x=getAudioCtx(),base=x.currentTime+delay,c=CH[qt.sound]||CH.bell;
    qt._nodes=[];
    c.freq.forEach((f,i)=>{
      const o=x.createOscillator(),g=x.createGain(),t=base+i*.05;
      o.type=c.type;o.frequency.setValueAtTime(f,t);
      g.gain.setValueAtTime(.25,t);g.gain.exponentialRampToValueAtTime(.001,t+c.decay);
      o.connect(g);g.connect(x.destination);
      o.start(t);o.stop(t+c.decay+.1);
      qt._nodes.push(o);
    });
    qt._audioScheduled=true;
    // Pre-schedule 'quick'-target repeating-chime intervals during this run.
    // Capped at a 90-minute look-ahead so a long timer with a short interval
    // doesn't allocate hundreds of oscillators up front. The _bgQuickTick /
    // ensureQuickTick path catches up any chimes past the horizon by firing
    // them via playChime() at runtime. This bounds the AudioContext node
    // count regardless of timer duration.
    qt._intervalNodes=qt._intervalNodes||[];
    const totalEl=qt.totalSec-qt.remaining;
    const QT_AUDIO_HORIZON_SEC = 5400; // 90 minutes
    intervals.forEach(iv=>{
      if(iv.intervalSec<=0)return;
      if((iv.target||'pomo')!=='quick')return;
      const alreadyFired=(qt._fireCounts&&qt._fireCounts[iv.id])||0;
      const ic=CH[iv.chime]||CH.bell;
      const horizon = Math.min(qt.remaining, QT_AUDIO_HORIZON_SEC);
      for(let n=alreadyFired+1;n*iv.intervalSec<qt.totalSec;n++){
        const d=n*iv.intervalSec-totalEl;
        if(d<=0||d>=qt.remaining)continue;
        if(d>=horizon)break;
        const ibase=x.currentTime+d;
        ic.freq.forEach((f,i)=>{
          const o=x.createOscillator(),g=x.createGain(),t=ibase+i*.05;
          o.type=ic.type;o.frequency.setValueAtTime(f,t);
          g.gain.setValueAtTime(.25,t);g.gain.exponentialRampToValueAtTime(.001,t+ic.decay);
          o.connect(g);g.connect(x.destination);
          o.start(t);o.stop(t+ic.decay+.1);
          qt._intervalNodes.push(o);
        });
      }
    });
  }catch(e){}
}

function cancelQtAudio(qt){
  if(qt._nodes){qt._nodes.forEach(o=>{try{o.stop(0)}catch(e){}});qt._nodes=[]}
  if(qt._intervalNodes){qt._intervalNodes.forEach(o=>{try{o.stop(0)}catch(e){}});qt._intervalNodes=[]}
  qt._audioScheduled=false;
}

function ensureQuickUiRefresh(){
  if(qtUiRefreshId!=null)return;
  qtUiRefreshId=setInterval(()=>{
    if(quickTimers.some(qt=>qt.running))renderQuickTimers();
    if(!quickTimers.some(qt=>qt.running)){
      clearInterval(qtUiRefreshId);
      qtUiRefreshId=null;
    }
  },1000);
}

function ensureQuickTick(){
  if(!quickTimers.some(qt=>qt.running))return;
  ensureQuickUiRefresh();
  if(qtGlobalTick)return;
  qtGlobalTick=setInterval(()=>{
    let anyRunning=false,needsRender=false;
    quickTimers.forEach(qt=>{
      if(!qt.running)return;
      anyRunning=true;
      const el=Math.floor((Date.now()-qt.startedAt)/1000);
      const newRem=Math.max(0,qt.pausedRem-el);
      if(newRem!==qt.remaining){qt.remaining=newRem;needsRender=true}
      // Fire 'quick'-target repeating chimes (fallback play + flash)
      if(newRem>0){
        const totalEl=qt.totalSec-newRem;
        if(!qt._fireCounts)qt._fireCounts={};
        intervals.forEach(iv=>{
          if(iv.intervalSec<=0)return;
          if((iv.target||'pomo')!=='quick')return;
          const exp=Math.floor(totalEl/iv.intervalSec),prev=qt._fireCounts[iv.id]||0;
          if(exp>prev&&totalEl>0){
            if(cfg.sound&&!qt._audioScheduled)playChime(iv.chime);
            qt._fireCounts[iv.id]=exp;flashInt(iv.id);needsRender=true;
          }
        });
      }
      if(newRem<=0&&!qt.finished){
        qt.running=false;qt.finished=true;qt.pausedRem=0;
        // Scheduled audio already played; fall back to manual play only if scheduling failed
        if(cfg.sound&&!qt._audioScheduled)playChime(qt.sound);
        qt._audioScheduled=false;qt._nodes=[];
        notify('Timer done',qt.label);
        qt.flashUntil=Date.now()+2000;
        addLog(qt.label,qt.totalSec,'quick');
        needsRender=true;saveState('auto');
      }
    });
    if(!anyRunning){clearInterval(qtGlobalTick);qtGlobalTick=null}
    if(needsRender)renderQuickTimers();
  },500)
}

function renderQuickTimers(){
  const list=gid('qtList');
  gid('qtCount').textContent=quickTimers.length+' timer'+(quickTimers.length!==1?'s':'');
  list.querySelectorAll('.qt-item').forEach(e=>e.remove());
  if(!quickTimers.length){gid('qtEmpty').hidden = false;return}
  gid('qtEmpty').hidden = true;
  quickTimers.forEach(qt=>{
    let rem=qt.remaining;
    if(qt.running){const el=Math.floor((Date.now()-qt.startedAt)/1000);rem=Math.max(0,qt.pausedRem-el)}
    const pct=qt.totalSec>0?((qt.totalSec-rem)/qt.totalSec)*100:0;
    const flash=qt.flashUntil&&Date.now()<qt.flashUntil;
    const d=document.createElement('div');
    d.className='qt-item'+(qt.finished?' done':qt.running?' running':'')+(flash?' flash':'');
    const btnClass=qt.finished?'qt-restart':qt.running?'qt-pause':'qt-play';
    const btnIcon=qt.finished?'↻':qt.running?'⏸':'▶';
    const timeClass='qt-time'+(qt.finished?' done':qt.running?' running':'')+(rem<=10&&qt.running&&rem>0?' warn':'');
    const barClass='qt-bar'+(qt.finished?' done':'');
    const togBtn=document.createElement('button');togBtn.className='qt-btn '+btnClass;togBtn.title=qt.finished?'Restart':qt.running?'Pause':'Start';togBtn.textContent=btnIcon;togBtn.onclick=function(){toggleQuickTimer(qt.id)};
    const info=document.createElement('div');info.className='qt-info';
    const lbl=document.createElement('div');lbl.className='qt-label';lbl.textContent=qt.label;info.appendChild(lbl);
    const tm=document.createElement('div');tm.className=timeClass;tm.textContent=fmtHMS(rem);info.appendChild(tm);
    const prog=document.createElement('div');prog.className='qt-progress';const bar=document.createElement('div');bar.className=barClass;bar.style.width=pct+'%';prog.appendChild(bar);info.appendChild(prog);
    const acts=document.createElement('div');acts.className='qt-actions';
    const rstBtn=document.createElement('button');rstBtn.className='qt-act';rstBtn.title='Reset';rstBtn.textContent='↺';rstBtn.onclick=function(){resetQuickTimer(qt.id)};acts.appendChild(rstBtn);
    const rmBtn=document.createElement('button');rmBtn.className='qt-act';rmBtn.title='Remove';rmBtn.textContent='×';rmBtn.onclick=function(){removeQuickTimer(qt.id)};acts.appendChild(rmBtn);
    d.appendChild(togBtn);d.appendChild(info);d.appendChild(acts);
    list.appendChild(d)
  })
}

// ========== INTERVALS ==========
function _rescheduleAffectedChimes(target){
  if(target==='pomo'){
    if(running)schedulePhaseAudio();
  }else if(target==='quick'){
    quickTimers.forEach(qt=>{if(qt.running){cancelQtAudio(qt);scheduleQtAudio(qt)}});
  }else if(target==='sw'){
    cancelSwIntervalChimes(swScheduledIntervalNodes);
    if(swRunning)scheduleSwIntervalChimes(Math.floor(swElapsed/1000),intervals,swFireCounts,swScheduledIntervalNodes);
  }
}
function addInterval(){const m=parseInt(gid('intMin').value)||0,s=parseInt(gid('intSec').value)||0,sec=m*60+s;if(sec<=0)return;const tgt=gid('intTarget')?gid('intTarget').value:'pomo';intervals.push({id:++intIdCtr,intervalSec:sec,label:gid('intLabel').value||'Every '+fmt(sec),chime:gid('intChime').value,target:tgt});gid('intLabel').value='';gid('intMin').value='5';gid('intSec').value='0';renderIntList();_rescheduleAffectedChimes(tgt);saveState('user')}
function removeInterval(id){const iv=intervals.find(i=>i.id===id),tgt=iv?(iv.target||'pomo'):null;intervals=intervals.filter(i=>i.id!==id);delete fireCounts[id];delete swFireCounts[id];quickTimers.forEach(qt=>{if(qt._fireCounts)delete qt._fireCounts[id]});renderIntList();if(tgt)_rescheduleAffectedChimes(tgt);saveState('user')}
function flashInt(id){lastFlash=id;setTimeout(()=>{if(lastFlash===id){lastFlash=null;renderIntList()}},600);renderIntList()}
function _intFireState(iv){
  const tgt=iv.target||'pomo';
  if(tgt==='pomo'){
    const fires=fireCounts[iv.id]||0;
    const totalEl=totalDuration-remaining;
    const next=running?(fires+1)*iv.intervalSec-totalEl:0;
    return {fires,next,active:running||finished};
  }
  if(tgt==='sw'){
    const fires=swFireCounts[iv.id]||0;
    const totalEl=Math.floor(swElapsed/1000);
    const next=swRunning?(fires+1)*iv.intervalSec-totalEl:0;
    return {fires,next,active:swRunning||swElapsed>0};
  }
  // quick: aggregate across all quick timers (they share the interval definition)
  let fires=0,nextMin=Infinity,anyRunning=false;
  quickTimers.forEach(qt=>{
    const f=(qt._fireCounts&&qt._fireCounts[iv.id])||0;
    fires+=f;
    if(qt.running){
      anyRunning=true;
      const el=Math.floor((Date.now()-qt.startedAt)/1000);
      const totalEl=qt.totalSec-Math.max(0,qt.pausedRem-el);
      const n=(f+1)*iv.intervalSec-totalEl;
      if(n>0&&n<nextMin)nextMin=n;
    }
  });
  return {fires,next:anyRunning&&nextMin!==Infinity?nextMin:0,active:anyRunning};
}
function renderIntList(){
  const list=gid('intList');
  gid('intCount').textContent=intervals.length+' set';
  list.querySelectorAll('.iitem').forEach(e=>e.remove());
  if(!intervals.length){gid('intEmpty').hidden = false;return}
  gid('intEmpty').hidden = true;
  intervals.forEach(iv=>{
    const tgt=iv.target||'pomo';
    const {fires,next,active}=_intFireState(iv);
    const fl=lastFlash===iv.id;
    const d=document.createElement('div');d.className='iitem'+(fl?' flash':'');
    const dot=document.createElement('div');dot.className='idot'+(fl?' flash':fires>0?' active':'');d.appendChild(dot);
    const info=document.createElement('div');info.className='iinfo';
    const nm=document.createElement('div');nm.className='iname';nm.textContent=iv.label;info.appendChild(nm);
    const meta=document.createElement('div');meta.className='imeta';
    meta.textContent='⟳ every '+fmt(iv.intervalSec)+' · '+CHL[iv.chime]+' · '+(TARG_LBL[tgt]||tgt);
    info.appendChild(meta);
    d.appendChild(info);
    if(active){
      const st=document.createElement('div');st.className='istat';
      const fc=document.createElement('div');fc.className='ifires'+(fl?' flash':'');fc.textContent=fires+'×';st.appendChild(fc);
      if(next>0){const nx=document.createElement('div');nx.className='inext';nx.textContent='next '+fmt(next);st.appendChild(nx)}
      d.appendChild(st);
    }
    const rm=document.createElement('button');rm.className='irm';rm.textContent='×';rm.onclick=function(){removeInterval(iv.id)};d.appendChild(rm);
    list.appendChild(d);
  });
}

// ========== BACKGROUND WORKER SUPPORT ==========
// Called from the inline Web Worker (audio.js) every 1s — drives quick-timer
// logic when the main-thread setInterval is throttled by the browser.
function _bgQuickTick(){
  let anyRunning=false,needsRender=false;
  quickTimers.forEach(qt=>{
    if(!qt.running)return;
    anyRunning=true;
    const el=Math.floor((Date.now()-qt.startedAt)/1000);
    const newRem=Math.max(0,qt.pausedRem-el);
    if(newRem!==qt.remaining){qt.remaining=newRem;needsRender=true}
    if(newRem>0){
      const totalEl=qt.totalSec-newRem;
      if(!qt._fireCounts)qt._fireCounts={};
      intervals.forEach(iv=>{
        if(iv.intervalSec<=0)return;
        if((iv.target||'pomo')!=='quick')return;
        const exp=Math.floor(totalEl/iv.intervalSec),prev=qt._fireCounts[iv.id]||0;
        if(exp>prev&&totalEl>0){
          if(cfg.sound&&!qt._audioScheduled)playChime(iv.chime);
          qt._fireCounts[iv.id]=exp;flashInt(iv.id);needsRender=true;
        }
      });
    }
    if(newRem<=0&&!qt.finished){
      qt.running=false;qt.finished=true;qt.pausedRem=0;
      if(cfg.sound&&!qt._audioScheduled)playChime(qt.sound);
      qt._audioScheduled=false;qt._nodes=[];
      notify('Timer done',qt.label);
      qt.flashUntil=Date.now()+2000;
      addLog(qt.label,qt.totalSec,'quick');
      needsRender=true;saveState('auto');
    }
  });
  if(needsRender&&!document.hidden)renderQuickTimers();
}
window._bgQuickTick=_bgQuickTick;

/**
 * Reconcile timer state after waking from a backgrounded/suspended tab.
 * If a Pomodoro phase should have completed while the page was hidden,
 * calling tick() once will catch up (because tick is wall-clock based,
 * not delta based). If the timer finished while hidden, we fire the
 * completion flow now.
 */
function _reconcileTimerAfterWake(){
  if(running){
    try{tick()}catch(e){}
  }
}
window._reconcileTimerAfterWake=_reconcileTimerAfterWake;

// Expose tick and swTick so the background Worker in audio.js can call them
window.tick=tick;
window.swTick=swTick;


