// ========== GOALS ==========
// The goals UI was removed; goals state still flows through storage/sync
// so existing user data is preserved, but no UI surface adds new goals.
function toggleGoal(id){const g=goals.find(x=>x.id===id);if(g){g.done=!g.done;g.doneAt=g.done?timeNow():null;g.lastModified=Date.now()}renderGoalList();saveState('user')}
function removeGoal(id){
  if(typeof syncGoalDels==='object'&&syncGoalDels)syncGoalDels[id]=Date.now();
  goals=goals.filter(g=>g.id!==id);
  renderGoalList();
  saveState('user');
}
function renderGoalList(){
  const list=gid('goalList');if(!list)return; // panel removed — skip everything
  const cnt=gid('goalCount');if(cnt)cnt.textContent=goals.filter(g=>g.done).length+' / '+goals.length;
  list.querySelectorAll('.goal-item').forEach(e=>e.remove());
  const empty=gid('goalEmpty'),prog=gid('goalProgress');
  if(!goals.length){if(empty)empty.hidden = false;if(prog)prog.hidden = true;return}
  if(empty)empty.hidden = true;if(prog)prog.hidden = false;
  const pct=goals.length?Math.round((goals.filter(g=>g.done).length/goals.length)*100):0;
  const bar=gid('goalBar'),pctEl=gid('goalPct');
  if(bar)bar.style.width=pct+'%';if(pctEl)pctEl.textContent=pct+'%';
  [...goals.filter(g=>!g.done),...goals.filter(g=>g.done)].forEach(g=>{
    const d=document.createElement('div');d.className='goal-item'+(g.done?' checked':'');
    const chk=document.createElement('button');chk.className='goal-check'+(g.done?' on':'');chk.textContent=g.done?'✓':'';chk.onclick=function(){toggleGoal(g.id)};d.appendChild(chk);
    const txt=document.createElement('span');txt.className='goal-text';txt.textContent=g.text;d.appendChild(txt);
    if(g.doneAt){const gt=document.createElement('span');gt.className='goal-time';gt.textContent=g.doneAt;d.appendChild(gt)}
    const rm=document.createElement('button');rm.className='goal-rm';rm.textContent='×';rm.onclick=function(){removeGoal(g.id)};d.appendChild(rm);
    list.appendChild(d)
  })
}

// ========== CLICKUP-STYLE TASKS ==========
// Safe stopPropagation helper. Functions like removeTask/toggleStar are
// invoked both from row-click handlers (where stopPropagation matters so the
// row-click → openTaskDetail doesn't fire) AND from the command palette /
// keyboard shortcuts (where there is no DOM event to stop). The legacy
// `event && event.stopPropagation()` pattern relied on the browser-global
// `event` which is unreliable across contexts. Each row handler now takes the
// dispatcher-passed event as its last argument; this helper accepts an event
// or undefined and stops propagation only when called from a real DOM click.
function _stopEvt(ev){
  if(ev && typeof ev.stopPropagation === 'function'){ ev.stopPropagation(); return; }
  // Fallback for older call sites that still rely on the implicit global.
  try{ if(typeof event !== 'undefined' && event && typeof event.stopPropagation === 'function') event.stopPropagation(); }catch(_){}
}
// Status definitions (colors match CSS)
const STATUSES={
  open:{label:'Open',cls:'status-open'},
  progress:{label:'In Progress',cls:'status-progress'},
  review:{label:'Review',cls:'status-review'},
  blocked:{label:'Blocked',cls:'status-blocked'},
  done:{label:'Done',cls:'status-done'}
};
const STATUS_ORDER=['open','progress','review','blocked','done'];
const PRIORITIES={
  urgent:{label:'Urgent',icon:'⚑',cls:'priority-urgent'},
  high:{label:'High',icon:'⚑',cls:'priority-high'},
  normal:{label:'Normal',icon:'⚑',cls:'priority-normal'},
  low:{label:'Low',icon:'⚑',cls:'priority-low'},
  none:{label:'None',icon:'⚐',cls:'priority-none'}
};
const PRIORITY_ORDER={urgent:0,high:1,normal:2,low:3,none:4};

// ===== Pareto / Impact scoring =====
// Derives a single "impact" score per task from existing signals only —
// no new fields, no persisted state. The 80/20 idea: high-leverage items
// (impact ÷ effort) rise to the top. All inputs already live on the task.
const _PARETO_PRIORITY_W = {urgent:4, high:3, normal:1.5, low:0.5, none:0.5};
const _PARETO_EFFORT_MULT = {xs:1.35, s:1.15, m:1.0, l:0.85, xl:0.7};

function computeImpactScore(t, ctx){
  if(!t || t.archived || t.status==='done') return 0;
  const today = ctx && ctx.today ? ctx.today : todayISO();
  const blockersMap = ctx && ctx.blockersMap ? ctx.blockersMap : null;

  const priorityW = _PARETO_PRIORITY_W[t.priority||'none'] ?? 0.5;

  let dueW = 0;
  if(t.dueDate){
    if(t.dueDate < today) dueW = 3;                 // overdue
    else if(t.dueDate === today) dueW = 2.2;        // today
    else{
      // Linear falloff over the next 7 days
      const d1 = new Date(today+'T00:00:00');
      const d2 = new Date(t.dueDate+'T00:00:00');
      const days = Math.round((d2-d1)/86400000);
      if(days <= 7) dueW = Math.max(0, 1.6 - days*0.18);
    }
  }

  // Unblocking: how many *active* tasks are blocked by this one.
  // Unblocking 1+ others is leverage; cap the contribution.
  let unblocksW = 0;
  if(blockersMap){
    const n = blockersMap.get(t.id) || 0;
    if(n > 0) unblocksW = Math.min(2, 0.8 + 0.4*n);
  }

  // Values alignment: small boost for each dominant value tagged (cap 3).
  const vals = Array.isArray(t.valuesAlignment) ? t.valuesAlignment.length : 0;
  const valuesW = Math.min(vals, 3) * 0.35;

  const starW = t.starred ? 0.6 : 0;

  const raw = priorityW + dueW + unblocksW + valuesW + starW;
  const mult = _PARETO_EFFORT_MULT[t.effort] ?? 1.0;
  return raw * mult;
}

// Per-render cache so sort + filter + badge all agree on the same top set.
let _paretoTopSet = new Set();
let _paretoScoreMap = new Map();
// Disclosure metadata for the Impact smart view — exposes whether the 20-cap
// kicked in so the UI can hint "Showing top 20 of N" instead of silently
// chopping the list (#24 in UX audit).
let _paretoMeta = { capped: false, theoretical: 0, shown: 0 };

function refreshParetoTopSet(){
  _paretoTopSet = new Set();
  _paretoScoreMap = new Map();
  _paretoMeta = { capped: false, theoretical: 0, shown: 0 };
  const today = todayISO();
  // Build blockersMap: id -> count of active tasks that list `id` in blockedBy
  const blockersMap = new Map();
  for(const x of tasks){
    if(x.archived || x.status==='done') continue;
    const bb = Array.isArray(x.blockedBy) ? x.blockedBy : [];
    for(const id of bb) blockersMap.set(id, (blockersMap.get(id)||0) + 1);
  }
  const ctx = {today, blockersMap};
  const pool = [];
  for(const t of tasks){
    if(t.archived || t.status==='done') continue;
    const s = computeImpactScore(t, ctx);
    _paretoScoreMap.set(t.id, s);
    pool.push(t);
  }
  if(pool.length === 0) return;
  pool.sort((a,b)=>(_paretoScoreMap.get(b.id)||0)-(_paretoScoreMap.get(a.id)||0));
  // Top 20% with absolute floor 1, soft cap 20 — chip needs to stay meaningful
  // on huge lists. We surface theoretical vs shown so the UI can tell the user
  // when the cap is hiding rows.
  const theoretical = Math.max(1, Math.ceil(pool.length*0.2));
  const cut = Math.min(20, theoretical);
  _paretoMeta = { capped: theoretical > cut, theoretical, shown: cut };
  for(let i=0; i<cut; i++) _paretoTopSet.add(pool[i].id);
}
if(typeof window !== 'undefined') window.getParetoMeta = () => Object.assign({}, _paretoMeta);

function isParetoTop(id){return _paretoTopSet.has(id)}

// Create a recurring task from a one-click empty-state template. Mirrors the
// shape of addTask() (push + index + save + render) without going through the
// quick-add parser, so the template's recur value is the canonical source.
function addHabitFromTemplate(name, recur){
  if(!name || !recur) return;
  ensureDefaultList();
  const t = Object.assign(
    { id: ++taskIdCtr, name, totalSec:0, sessions:0, created: timeNowFull(), parentId:null, collapsed:false },
    defaultTaskProps(),
    { recur, dueDate: todayISO() }
  );
  tasks.push(t);
  if(typeof _taskIndexRegister === 'function') _taskIndexRegister(t);
  if(typeof saveState === 'function') saveState('user');
  if(typeof renderTaskList === 'function') renderTaskList();
  if(typeof openTaskDetail === 'function') openTaskDetail(t.id);
}
window.addHabitFromTemplate = addHabitFromTemplate;

function defaultTaskProps(){return{
  status:'open',priority:'none',tags:[],dueDate:null,startDate:null,
  estimateMin:0,description:'',starred:false,completedAt:null,
  listId:activeListId,archived:false,
  recur:null,order:Date.now(),
  remindAt:null,reminderFired:false,
  type:'task',effort:null,energyLevel:null,
  blockedBy:[],checklist:[],notes:[],url:null,completionNote:null,
  // v5 — values alignment
  category:null,        // life area id (customizable in Settings)
  valuesAlignment:[],   // which user values this task serves e.g. ['security','benevolence']
  valuesNote:null,      // Short note from values alignment
  completions:[],      // recurring habit log: { date, sec }
  habitLastRecordedTotalSec:null, // baseline for per-completion delta (see completeHabitCycle)
  attachments:[],      // attachment ids in IndexedDB (see attachments.js)
}}

let _dupRefreshTimer = null;
function scheduleIntelDupRefresh(){
  if(_dupRefreshTimer) return;
  _dupRefreshTimer = setTimeout(async () => {
    _dupRefreshTimer = null;
    if(typeof computeDuplicateScores !== 'function' || typeof isIntelReady !== 'function' || !isIntelReady()) return;
    try{
      window._dupSimMap = await computeDuplicateScores();
      if(typeof renderTaskList === 'function') renderTaskList();
    }catch(e){ console.warn('[tasks] duplicate score refresh failed', e); }
  }, 2000);
}
window.scheduleIntelDupRefresh = scheduleIntelDupRefresh;
window.invalidateDupMap = function(){ window._dupSimMap = null; };

// Parse natural language tokens from input: @priority, #tag, !star, ~recur, today/tomorrow/mon-sun
function parseQuickAdd(raw){
  let text=raw;
  const props={};
  // Priority @urgent @high @normal @low
  const prMatch=text.match(/\s@(urgent|high|normal|low)\b/i);
  if(prMatch){props.priority=prMatch[1].toLowerCase();text=text.replace(prMatch[0],'')}
  // Tags #tag  (multiple) — allow hyphens/underscores/dots, not only \w
  const tagRe=/\s#([^\s#]+)/g;const tags=[];let m;
  while((m=tagRe.exec(text))!==null)tags.push(m[1]);
  if(tags.length){props.tags=tags;text=text.replace(/\s#[^\s#]+/g,'')}
  // Star !star !pin
  if(/\s!(star|pin)\b/i.test(text)){props.starred=true;text=text.replace(/\s!(star|pin)\b/i,'')}
  // Recurrence ~daily ~weekdays ~weekly ~monthly ~every2d ~habit
  const rcMatch=text.match(/\s~(daily|weekdays|weekly|monthly|every2d|habit)\b/i);
  if(rcMatch){
    const k=rcMatch[1].toLowerCase();
    props.recur=(k==='habit')?'daily':k;
    text=text.replace(rcMatch[0],'');
  }
  // Type %bug %idea %errand %waiting %task
  const tyMatch=text.match(/\s%(task|bug|idea|errand|waiting)\b/i);
  if(tyMatch){props.type=tyMatch[1].toLowerCase();text=text.replace(tyMatch[0],'')}
  // Bare recurrence phrases (no ~ sigil). The empty-state copy and quick-add
  // syntax hints promise these "just work" — wire them so the promise isn't
  // a lie (#1 in the UX audit). These run BEFORE the bare day-name strip so
  // "every weekday" doesn't get half-swallowed by the day branch.
  if(!props.recur){
    const bareRecur=[
      [/\bevery\s+weekday(s)?\b/i,'weekdays'],
      [/\bevery\s+day\b/i,'daily'],
      [/\bevery\s+week\b/i,'weekly'],
      [/\bevery\s+month\b/i,'monthly'],
      [/\bevery\s+other\s+day\b/i,'every2d'],
      [/\bevery\s+2\s+days?\b/i,'every2d'],
      [/(^|\s)weekdays\b/i,'weekdays'],
      [/(^|\s)daily\b/i,'daily'],
      [/(^|\s)weekly\b/i,'weekly'],
      [/(^|\s)monthly\b/i,'monthly'],
    ];
    for(const [re,kind] of bareRecur){
      const mm=text.match(re);
      if(mm){props.recur=kind;text=text.replace(mm[0],mm[0].startsWith(' ')?' ':'');break}
    }
  }
  // Due date: today, tomorrow, mon-sun, next week. Possessive forms like
  // "tomorrow's review" and "monday's meeting" must NOT be parsed as dates —
  // the (?!['’]) lookahead excludes them (#2 in UX audit).
  const days={sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6};
  const todayISOs=todayISO();
  const lower=' '+text.toLowerCase()+' ';
  if(/\btoday\b(?!['’])/i.test(lower)){props.dueDate=todayISOs;text=text.replace(/\btoday\b(?!['’])/i,'')}
  else if(/\btomorrow\b(?!['’])|\btmrw\b(?!['’])/i.test(lower)){
    const d=new Date();d.setDate(d.getDate()+1);
    props.dueDate=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    text=text.replace(/\btomorrow\b(?!['’])|\btmrw\b(?!['’])/i,'');
  }else if(/\bnext week\b/i.test(lower)){
    const d=new Date();d.setDate(d.getDate()+7);
    props.dueDate=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    text=text.replace(/\bnext week\b/i,'');
  }else if(/\bin\s+(\d+)\s+days?\b/i.test(lower)){
    const m=lower.match(/\bin\s+(\d+)\s+days?\b/i);
    if(m){
      const n=parseInt(m[1],10)||0;
      const d=new Date();d.setDate(d.getDate()+n);
      props.dueDate=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
      text=text.replace(/\bin\s+\d+\s+days?\b/i,'');
    }
  }else if(/\beod\b/i.test(lower)){
    props.dueDate=todayISOs;
    text=text.replace(/\beod\b/i,'');
  }else{
    const dayMatch=text.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|tues|thurs|sun|mon|tue|wed|thu|fri|sat)\b(?!['’])/i);
    if(dayMatch){
      const target=days[dayMatch[1].toLowerCase().slice(0,3)];
      const d=new Date();const today=d.getDay();
      let diff=(target-today+7)%7;if(diff===0)diff=7;
      d.setDate(d.getDate()+diff);
      props.dueDate=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
      text=text.replace(dayMatch[0],'');
    }
  }
  return{name:text.replace(/\s+/g,' ').trim(),props};
}

async function addTask(){
  const inp=gid('taskInput'),raw=inp.value.trim();if(!raw)return;
  if(/\r?\n/.test(raw)){
    const { items, skippedLong } = parseBulkTaskPaste(raw);
    if(items.length >= 2){
      openBulkImportModal(items, skippedLong);
      inp.value='';
      return;
    }
  }
  ensureDefaultList();
  let name, props;
  if(typeof parseQuickAddAsync === 'function'){
    const parsed = await parseQuickAddAsync(raw);
    name = parsed.name;
    props = parsed.props;
  } else {
    const p = parseQuickAdd(raw);
    name = p.name;
    props = p.props;
  }
  if(!name){ name = raw; props = {}; }
  // Merge in any explicit field values the user set via the configurable
  // "More options" panel. Quick-add tokens in `props` take precedence so
  // typing "@urgent" still wins over a panel-set priority — explicit text
  // input is the most recent intent.
  const panelVals=(typeof window!=='undefined'&&window._quickAddValues)?window._quickAddValues:null;
  const entryKind=panelVals&&panelVals.entryKind;
  const panelClean=panelVals?{...panelVals}:null;
  if(panelClean) delete panelClean.entryKind;
  const _newT=Object.assign({
    id:++taskIdCtr,name,totalSec:0,sessions:0,created:timeNowFull(),
    parentId:null,collapsed:false
  },defaultTaskProps(),panelClean||{},props);
  if(entryKind==='habit'&&!props.recur) _newT.recur=_newT.recur||'daily';
  if(entryKind==='task'&&!props.recur) _newT.recur=null;
  tasks.push(_newT);
  _taskIndexRegister(_newT);
  inp.value='';
  // Brain-dump mode: keep focus in the input so the mobile keyboard stays up
  // and the next task can be typed immediately. Without this, every Enter
  // dismisses the keyboard on iOS/Android.
  try{ inp.focus({preventScroll:true}); }catch(_){ inp.focus(); }
  // Clear any live parse-preview chips left over from this entry.
  if(typeof clearLiveParsePreview==='function') clearLiveParsePreview();
  maybeShowSwipeTip();
  if(typeof cfg==='object'&&cfg&&!cfg.qaHintHidden){
    cfg.qaHintTaskCount=(cfg.qaHintTaskCount||0)+1;
    if(cfg.qaHintTaskCount>=3) cfg.qaHintHidden=true;
  }
  if(typeof syncQaHintVisibility==='function') syncQaHintVisibility();
  // Reset configurable quick-add panel selections once the task lands so the
  // next one starts blank. Panel stays open so a brain-dump session can keep
  // reusing the same field set if desired — but the user re-applies values
  // explicitly each time.
  if(typeof window!=='undefined'){window._quickAddValues=null}
  if(typeof renderQuickAddPanel==='function') renderQuickAddPanel();
  // Hint to renderTaskItem: animate this card on the upcoming render and
  // scroll it into view. The flag self-clears in the renderer.
  window._lastAddedTaskId=_newT.id;
  renderTaskList();
  // a11y: announce the add to screen readers via the polite live region.
  if(typeof announceTaskAdd==='function') announceTaskAdd(_newT.name);
  // Undo affordance: a 5-second window to recover from an accidental Enter.
  // Mirrors Gmail's "Undo Send". Captures the new ID up-front so the closure
  // doesn't go stale if the user adds another task before the undo fires.
  if(typeof showActionToast==='function'){
    const _undoId = _newT.id;
    showActionToast('Task added', 'Undo', () => {
      const idx = tasks.findIndex(x => x.id === _undoId);
      if(idx >= 0){
        tasks.splice(idx, 1);
        if(typeof _taskIndexRemove === 'function') _taskIndexRemove(_undoId);
        renderTaskList();
        saveState('user');
        if(typeof announce === 'function') announce('Task removed');
      }
    }, 5000);
  }
  saveState('user')
}

function showQaHint(){
  const h=gid('qa-hint'),r=gid('qa-hint-reveal');
  if(h) h.hidden = false;
  if(r) r.hidden = true;
  if(typeof cfg==='object'&&cfg){cfg.qaHintHidden=false;saveState('user')}
}
function syncQaHintVisibility(){
  const h=gid('qa-hint'),r=gid('qa-hint-reveal');
  if(!h) return;
  if(typeof cfg==='object'&&cfg&&cfg.qaHintHidden){
    h.hidden = true;
    if(r) r.hidden = false;
  }else{
    h.hidden = false;
    if(r) r.hidden = true;
  }
}
window.showQaHint=showQaHint;
window.syncQaHintVisibility=syncQaHintVisibility;

/**
 * Keyboard handler for the task input. Centralized here so the inline HTML
 * stays small and the behavior is testable.
 *
 *   Enter         → addTask() (or applySmartAddAndSubmit when preview exists)
 *   Escape        → clear the input (a quick discard of an aborted thought)
 *   Cmd/Ctrl+Enter → reserved for "add and open detail" — see follow-up
 */
function onTaskInputKey(event){
  if(event.key==='Enter' && !event.isComposing){
    if(window._smartAddPreview) applySmartAddAndSubmit();
    else addTask();
    return;
  }
  if(event.key==='Escape'){
    const inp=event.target;
    if(inp && inp.value){
      event.preventDefault();
      inp.value='';
      if(typeof clearLiveParsePreview==='function') clearLiveParsePreview();
      if(typeof maybeShowEnhanceBtn==='function') maybeShowEnhanceBtn();
    }
  }
}
window.onTaskInputKey=onTaskInputKey;

/**
 * Live parse-token preview. Runs the synchronous parseQuickAdd against the
 * current input text and renders chips for every token it matched
 * (priority, tags, star, recurrence, due-date). Gives users visible
 * confirmation that "@urgnet" (a typo) didn't match while "@urgent" did.
 *
 * All chip text is set via textContent to avoid any XSS surface — chip
 * structure is built with createElement, never innerHTML.
 */
function _qpcChip(cls, text, title){
  const s = document.createElement('span');
  s.className = 'qpc qpc--' + cls;
  if(title) s.title = title;
  s.textContent = text;
  return s;
}
function updateLiveParsePreview(){
  const inp=gid('taskInput');
  const host=gid('qaParseChips');
  if(!inp||!host) return;
  const raw=inp.value;
  if(!raw||raw.length<2){ clearLiveParsePreview(); return; }
  const {props,name}=parseQuickAdd(raw);
  // Build offline so we can decide whether to show the row at all.
  const chips=[];
  if(props.priority){
    const cls = ({urgent:'danger',high:'warning',normal:'accent',low:'muted'})[props.priority] || 'accent';
    chips.push(_qpcChip(cls, '@'+props.priority, 'Priority'));
  }
  if(props.tags && props.tags.length){
    props.tags.forEach(t => chips.push(_qpcChip('tag', '#'+t, 'Tag')));
  }
  if(props.starred) chips.push(_qpcChip('star', '★', 'Pinned to top'));
  if(props.recur)   chips.push(_qpcChip('recur', '↻ '+props.recur, 'Repeats'));
  if(props.type)    chips.push(_qpcChip('tag', '%'+props.type, 'Type'));
  if(props.dueDate){
    let label=props.dueDate;
    if(typeof prettyDate==='function'){ try{ label=prettyDate(props.dueDate); }catch(_){} }
    chips.push(_qpcChip('due', label, 'Due date'));
  }
  if(!chips.length){ clearLiveParsePreview(); return; }
  // Build via DOM, not innerHTML — keeps user-controlled text safe even though
  // parseQuickAdd already strips/normalizes its outputs.
  host.replaceChildren();
  if(name && name !== raw){
    const n = document.createElement('span');
    n.className = 'qpc-name';
    n.title = 'Task title (after token strip)';
    n.textContent = name;
    host.appendChild(n);
  }
  const list = document.createElement('span');
  list.className = 'qpc-list';
  chips.forEach(c => list.appendChild(c));
  host.appendChild(list);
  host.hidden = false;
}
function clearLiveParsePreview(){
  const host=gid('qaParseChips');
  if(!host) return;
  host.replaceChildren();
  host.hidden=true;
}
window.updateLiveParsePreview=updateLiveParsePreview;
window.clearLiveParsePreview=clearLiveParsePreview;

const SWIPE_TIP_KEY = (window.ODTAULAI_CONFIG && window.ODTAULAI_CONFIG.STORAGE_KEYS && window.ODTAULAI_CONFIG.STORAGE_KEYS.SWIPE_TIP_DISMISSED) || 'odtaulai_swipe_tip_dismissed';
function maybeShowSwipeTip(){
  try{
    if(localStorage.getItem(SWIPE_TIP_KEY)==='1') return;
    const tip=document.getElementById('swipeTipBanner');
    if(tip) tip.hidden = false;
  }catch(e){}
}
function dismissSwipeTip(){
  try{ localStorage.setItem(SWIPE_TIP_KEY,'1'); }catch(e){}
  const tip=document.getElementById('swipeTipBanner');
  if(tip) tip.hidden = true;
}

const BULK_LINE_MAX = 200;
// AbortController for the bulk-import confirm flow. Created fresh on every
// openBulkImportModal() and aborted by closeBulkImportModal() so a user who
// dismisses the modal mid-process (Escape / backdrop / Cancel) does not
// silently end up with the half-import committed. confirmBulkImport snapshots
// this signal at the start of the flow so a later modal-open with a fresh
// controller can't "un-abort" the in-flight call.
let _bulkImportAbort = null;
function parseBulkTaskPaste(raw){
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const bulletRe = /^\s*(?:[-*•·]|[\d]+[.)])\s+/;
  const items = [];
  let skippedLong = 0;
  for(const line of lines){
    const cleaned = line.replace(bulletRe, '').trim();
    if(!cleaned) continue;
    if(cleaned.length > BULK_LINE_MAX){ skippedLong++; continue; }
    items.push(cleaned);
  }
  return { items, skippedLong };
}

function taskInputPaste(e){
  const text = e.clipboardData && e.clipboardData.getData('text/plain');
  if(!text || !/\r?\n/.test(text)) return;
  const { items, skippedLong } = parseBulkTaskPaste(text);
  if(items.length < 2) return;
  e.preventDefault();
  // Kick off the chrono CDN import in parallel with the modal opening so the
  // first parseQuickAddAsync inside confirmBulkImport doesn't block on a
  // cold dynamic import. Fire-and-forget — failures are non-fatal.
  if(typeof loadChrono === 'function'){ try { loadChrono().catch(()=>{}); } catch(_){} }
  openBulkImportModal(items, skippedLong);
}

/** Last routing mode applied — per-row preview re-renders only on mode switch. */
let _bulkAppliedRoutingMode = null;

function openBulkImportModal(items, skippedLong){
  const ov = gid('bulkImportModal');
  const ta = gid('bulkImportTextarea');
  const hint = gid('bulkImportHint');
  if(!ov || !ta) return;
  // Fresh controller per open. Any prior in-flight import keeps its own
  // captured signal — we don't reach in and abort it here, because that
  // would interrupt a confirm() the user explicitly initiated.
  _bulkImportAbort = new AbortController();
  _bulkAppliedRoutingMode = null;
  ta.value = items.join('\n');
  let hintHtml = 'Each line becomes one task. Quick-add tokens work per line (<code>@urgent</code>, <code>#tag</code>, <code>tomorrow</code>, etc.).';
  if(skippedLong > 0){
    hintHtml = '<strong class="bulk-import-warn">' + skippedLong + ' line(s) skipped</strong> (over ' + BULK_LINE_MAX + ' characters). ' + hintHtml;
  }
  if(hint) hint.innerHTML = hintHtml;
  _updateBulkImportButtonState();
  _syncBulkRoutingControls();
  ta.oninput = () => { _updateBulkImportButtonState(); _onBulkRoutingTextareaChanged(); };
  // Pre-warm the chrono CDN module while the user is reviewing — without this
  // the first parseQuickAddAsync call inside confirmBulkImport blocks on the
  // dynamic import (1-3s cold), which read as a UI freeze for users pasting
  // a batch and immediately clicking Add.
  if(typeof loadChrono === 'function'){ try { loadChrono().catch(()=>{}); } catch(_){} }
  // Modal utility owns focus trap + prev-focus restore + body lock.
  // onRequestClose ensures ESC routes through closeBulkImportModal so the
  // "discard unsaved routing edits?" confirmation runs before tear-down.
  Modal.open('bulkImportModal', {
    variant: 'dialog',
    focus: '#bulkImportTextarea',
    skipInitialFocus: true,
    onRequestClose: ()=>closeBulkImportModal()
  });
}

function _updateBulkImportButtonState(){
  const ta = gid('bulkImportTextarea');
  const btn = gid('bulkImportConfirm');
  const title = gid('bulkImportTitle');
  if(!ta || !btn) return;
  const n = ta.value.split(/\r?\n/).map(l => l.trim()).filter(Boolean).length;
  btn.disabled = n === 0;
  btn.textContent = n ? 'Add ' + n + ' task' + (n !== 1 ? 's' : '') : 'Add tasks';
  if(title) title.textContent = n ? 'Import ' + n + ' task' + (n !== 1 ? 's' : '') : 'Import tasks';
}

/** True if the per-task preview has any row the user manually edited. */
function _bulkImportHasUserEdits(){
  const ul = gid('bulkRoutePerRows');
  if(!ul) return false;
  return !!ul.querySelector('select[data-user-touched="1"]');
}

async function closeBulkImportModal(){
  const ov = gid('bulkImportModal');
  // If the user spent time picking list/category per task, confirm before
  // dropping that work on the floor. The check runs only when the modal is
  // actually open (otherwise we're being called from the cleanup paths
  // inside confirmBulkImport, which already persisted everything).
  if(ov && ov.classList.contains('open') && _bulkImportHasUserEdits() && typeof showAppConfirm === 'function'){
    const n = gid('bulkRoutePerRows').querySelectorAll('select[data-user-touched="1"]').length;
    const ok = await showAppConfirm('Discard ' + n + ' routing edit' + (n === 1 ? '' : 's') + '? They will not be saved.');
    if(!ok) return;
  }
  const ta = gid('bulkImportTextarea');
  if(ta) ta.oninput = null;
  // Cancel any confirmBulkImport that's still running. Dismissing the modal
  // is the user saying "stop" — without this they'd close the modal and a
  // few seconds later watch tasks they didn't expect appear in their list.
  if(_bulkImportAbort){
    try { _bulkImportAbort.abort(); } catch(_){}
    _bulkImportAbort = null;
  }
  _setBulkProgress(null);
  // Modal.close removes .open, closes focus trap (restores prev focus),
  // and releases body lock.
  Modal.close('bulkImportModal');
}

/**
 * Wire up the routing fieldset every time the modal opens. Three modes:
 *   - "ai":    embeddings pick list + category per task (current behaviour).
 *   - "batch": one list + category, applied to every imported task.
 *   - "per":   preview rows below the textarea; each row carries its own
 *              list + category dropdown, pre-filled with AI suggestions
 *              when intel is ready.
 *
 * If embeddings aren't loaded, "ai" + "per" modes are disabled (they need
 * predictListId / predictMetadata to be useful) and the radio is forced
 * to "batch" so the toggle never lies about what's possible.
 */
function _syncBulkRoutingControls(){
  const fs = gid('bulkRouteFieldset');
  if(!fs) return;
  const ta = gid('bulkImportTextarea');
  const lineCount = ta ? ta.value.split(/\r?\n/).map(l => l.trim()).filter(Boolean).length : 0;
  fs.hidden = lineCount === 0;
  if(fs.hidden) return;

  _populateBulkRoutingDropdowns();

  const intelOk = (typeof isIntelReady === 'function') && isIntelReady();
  const aiRadio    = gid('bulkRouteModeAi');
  const aiHint     = gid('bulkRouteAiHint');
  // AI mode requires embeddings — disable when intel can't predict. Per-task
  // mode stays available without intel: the dropdowns still work, you just
  // don't get pre-filled suggestions. "Same for all" is always available.
  if(aiRadio)  aiRadio.disabled  = !intelOk;
  if(aiHint){
    aiHint.textContent = intelOk
      ? 'AI picks list + category per task'
      : 'AI picks list + category per task (load the embedding model to enable)';
  }
  // If the previously-selected mode is now disabled, fall back to batch.
  const selected = _bulkRoutingMode();
  if(selected === 'ai' && !intelOk){
    const batchRadio = gid('bulkRouteModeBatch');
    if(batchRadio) batchRadio.checked = true;
  }

  // Hook radios — re-render the visible panel on every change.
  for(const r of fs.querySelectorAll('input[name="bulkRouteMode"]')){
    r.onchange = () => _applyBulkRoutingMode();
  }
  _applyBulkRoutingMode();
}

/** Sentinel select value for "let AI pick this field at commit time". */
const BULK_AI_PICK = '__AI__';

function _populateBulkRoutingDropdowns(){
  const intelOk = (typeof isIntelReady === 'function') && isIntelReady();
  const batchList = gid('bulkRouteBatchList');
  const batchCat  = gid('bulkRouteBatchCat');
  if(batchList){
    const cur = batchList.value;
    batchList.innerHTML = '';
    const opts = [['', '(Active list)']];
    if(intelOk) opts.push([BULK_AI_PICK, '✦ AI pick (per task)']);
    for(const l of (Array.isArray(lists) ? lists : [])){
      if(l && l.id != null) opts.push([String(l.id), l.name || '(unnamed)']);
    }
    for(const [v, label] of opts){
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      batchList.appendChild(o);
    }
    if(cur && opts.some(o => o[0] === cur)) batchList.value = cur;
  }
  if(batchCat){
    const cur = batchCat.value;
    batchCat.innerHTML = '';
    const opts = [['', '— None —']];
    if(intelOk) opts.push([BULK_AI_PICK, '✦ AI pick (per task)']);
    const cats = (typeof getActiveCategories === 'function') ? (getActiveCategories() || []) : [];
    for(const c of cats){
      if(c && c.id) opts.push([c.id, c.label || c.id]);
    }
    for(const [v, label] of opts){
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      batchCat.appendChild(o);
    }
    if(cur && opts.some(o => o[0] === cur)) batchCat.value = cur;
  }
}

function _bulkRoutingMode(){
  const fs = gid('bulkRouteFieldset');
  if(!fs) return 'ai';
  const checked = fs.querySelector('input[name="bulkRouteMode"]:checked');
  return checked ? checked.value : 'ai';
}

/** Show the panel matching the selected mode; render per-task rows on demand. */
function _applyBulkRoutingMode(){
  const mode = _bulkRoutingMode();
  const batchPanel = gid('bulkRouteBatchPanel');
  const perRows    = gid('bulkRoutePerRows');
  if(batchPanel) batchPanel.hidden = mode !== 'batch';
  if(perRows){
    perRows.hidden = mode !== 'per';
    // Only build the preview when entering "per" — not on every sync call.
    // Re-rendering on each textarea keystroke (via _syncBulkRoutingControls)
    // wiped manual dropdown picks and re-fired N parallel embedding calls.
    if(mode === 'per' && _bulkAppliedRoutingMode !== 'per') _renderBulkPerTaskRows();
  }
  _bulkAppliedRoutingMode = mode;
}

/**
 * Re-render per-task rows when the textarea content changes. Only fires a
 * full re-render when the line count actually shifts (lines added/removed)
 * — otherwise we'd wipe a user's manual dropdown edits on every keystroke.
 * Text edits that don't change line count leave the per-row name labels
 * slightly stale; that's a deliberate trade-off for keeping user choices.
 */
function _onBulkRoutingTextareaChanged(){
  const ta = gid('bulkImportTextarea');
  const ul = gid('bulkRoutePerRows');
  const fs = gid('bulkRouteFieldset');
  const lineCount = ta ? ta.value.split(/\r?\n/).map(l => l.trim()).filter(Boolean).length : 0;
  if(fs) fs.hidden = lineCount === 0;
  if(_bulkRoutingMode() !== 'per' || !ta || !ul) return;
  const rowCount  = ul.querySelectorAll('li.bulk-route-row').length;
  if(lineCount !== rowCount) _renderBulkPerTaskRows();
}

/**
 * Render one editable row per parsed line. List + category selects are
 * pre-populated with AI suggestions (best-effort, async) when intel is
 * ready — the row is rendered immediately with empty selects so a slow
 * embedding pass never blocks the visible preview.
 */
function _renderBulkPerTaskRows(){
  const ul = gid('bulkRoutePerRows');
  const ta = gid('bulkImportTextarea');
  if(!ul || !ta) return;
  const lines = ta.value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  // Build options once — DOM cloning is faster than rebuilding selects in a loop.
  const listOpts = [['', '(Active list)']];
  for(const l of (Array.isArray(lists) ? lists : [])){
    if(l && l.id != null) listOpts.push([String(l.id), l.name || '(unnamed)']);
  }
  const cats = (typeof getActiveCategories === 'function') ? (getActiveCategories() || []) : [];
  const catOpts = [['', '— None —']];
  for(const c of cats){
    if(c && c.id) catOpts.push([c.id, c.label || c.id]);
  }
  const intelOk = (typeof isIntelReady === 'function') && isIntelReady();
  // Insert the "AI pick" sentinel right after the default option so a user
  // who sees their per-row prediction can still flip to "let AI decide for
  // this one" — useful e.g. if they paste 50 tasks and only want manual
  // control for the few that didn't get a good pre-fill.
  const listOptsForRow = intelOk
    ? [listOpts[0], [BULK_AI_PICK, '✦ AI pick'], ...listOpts.slice(1)]
    : listOpts;
  const catOptsForRow = intelOk
    ? [catOpts[0],  [BULK_AI_PICK, '✦ AI pick'], ...catOpts.slice(1)]
    : catOpts;
  ul.innerHTML = '';
  const rows = [];
  for(let i = 0; i < lines.length; i++){
    const li = document.createElement('li');
    li.className = 'bulk-route-row';
    li.dataset.idx = String(i);

    const name = document.createElement('span');
    name.className = 'bulk-route-row-name';
    name.textContent = lines[i];
    name.title = lines[i];

    const listSel = document.createElement('select');
    listSel.className = 'bulk-route-select';
    listSel.setAttribute('aria-label', 'List for task ' + (i + 1));
    listSel.dataset.role = 'list';
    for(const [v, label] of listOptsForRow){
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      listSel.appendChild(o);
    }
    const catSel = document.createElement('select');
    catSel.className = 'bulk-route-select';
    catSel.setAttribute('aria-label', 'Category for task ' + (i + 1));
    catSel.dataset.role = 'category';
    for(const [v, label] of catOptsForRow){
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      catSel.appendChild(o);
    }

    listSel.addEventListener('change', () => { listSel.dataset.userTouched = '1'; });
    catSel.addEventListener('change',  () => { catSel.dataset.userTouched  = '1'; });

    li.appendChild(name);
    li.appendChild(listSel);
    li.appendChild(catSel);
    ul.appendChild(li);
    rows.push({ name: lines[i], listSel, catSel });
  }

  // Async AI suggestion pre-fill. Each suggestion only writes if the user
  // hasn't already touched the select for that row — manual edits always
  // win. Failures are swallowed (best-effort UX, not a correctness path).
  // `intelOk` is hoisted from earlier in this function — when false, the
  // dropdowns still render (manual routing works without AI) but we skip
  // the prediction pass entirely.
  // Run one row at a time — ORT WASM rejects concurrent inference on the
  // same session ("Session already started") and N parallel rows froze UI.
  if(!intelOk) return;
  void (async () => {
    for(const row of rows){
      try{
        if(typeof predictListId === 'function'){
          const lid = await predictListId(row.name, { minScore: 0.30, minMargin: 0 });
          if(lid != null && !row.listSel.dataset.userTouched){
            const want = String(lid);
            if([...row.listSel.options].some(o => o.value === want)) row.listSel.value = want;
          }
        }
        if(typeof predictMetadata === 'function'){
          const meta = await predictMetadata(row.name, 5);
          if(meta && meta.category && !row.catSel.dataset.userTouched){
            if([...row.catSel.options].some(o => o.value === meta.category)) row.catSel.value = meta.category;
          }
        }
      }catch(_){ /* per-row prediction is best-effort */ }
      await new Promise(r => setTimeout(r, 0));
    }
  })();
}

/**
 * Resolve the routing choice for a given task index. Returns a structured
 * override per field:
 *
 *   { type: 'none' }            — leave field unset (use defaults / enrichment)
 *   { type: 'set', value }      — apply this explicit value
 *   { type: 'ai' }              — call the predictor at commit time for this task
 *
 * "ai" lets a user mix model + manual within a single batch — e.g. force
 * every task into the Work list but let AI pick categories.
 */
function _bulkRoutingFor(idx){
  const mode = _bulkRoutingMode();
  const fromSelect = (sel, coerce) => {
    if(!sel) return { type: 'none' };
    const v = sel.value;
    if(!v) return { type: 'none' };
    if(v === BULK_AI_PICK) return { type: 'ai' };
    return { type: 'set', value: coerce ? coerce(v) : v };
  };
  if(mode === 'batch'){
    return {
      list:     fromSelect(gid('bulkRouteBatchList'), v => Number(v)),
      category: fromSelect(gid('bulkRouteBatchCat')),
    };
  }
  if(mode === 'per'){
    const ul = gid('bulkRoutePerRows');
    const row = ul && ul.querySelector('li.bulk-route-row[data-idx="' + idx + '"]');
    if(!row) return { list: { type: 'none' }, category: { type: 'none' } };
    return {
      list:     fromSelect(row.querySelector('select[data-role="list"]'),     v => Number(v)),
      category: fromSelect(row.querySelector('select[data-role="category"]')),
    };
  }
  // "ai" mode — fall through to _bulkEnrichOne predictions, no override.
  return { list: { type: 'none' }, category: { type: 'none' } };
}

/**
 * Enrich a single bulk-imported task with predicted metadata via on-device
 * embeddings. Returns an object of fields to merge onto the task. kNN over
 * existing tasks produces category, priority, effort, energy, tags; list +
 * due date come from predictListId / predictDueDate helpers.
 */
async function _bulkEnrichOne(name){
  const out = {};
  if(typeof isIntelReady !== 'function' || !isIntelReady() || typeof predictMetadata !== 'function') return out;
  try{
    const pred = await predictMetadata(name, 5);
    if(pred){
      if(pred.category) out.category = pred.category;
      if(pred.priority && pred.priority !== 'normal') out.priority = pred.priority;
      if(pred.effort) out.effort = pred.effort;
      if(pred.energyLevel) out.energyLevel = pred.energyLevel;
      if(Array.isArray(pred.tags) && pred.tags.length) out.tags = pred.tags;
    }
    if(typeof predictListId === 'function'){
      try{
        const lid = await predictListId(name, { minScore: 0.30, minMargin: 0 });
        if(lid != null) out.listId = lid;
      }catch(_){ /* skip */ }
    }
    if(typeof predictDueDate === 'function'){
      try{
        const dd = await predictDueDate(name, 5);
        if(dd) out.dueDate = dd;
      }catch(_){ /* skip */ }
    }
  }catch(_){ /* enrichment is best-effort */ }
  return out;
}

function _setBulkProgress(text){
  const el = gid('bulkImportProgress');
  if(!el) return;
  if(!text){ el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = text;
}

async function confirmBulkImport(){
  const ta = gid('bulkImportTextarea');
  if(!ta) return;
  const lines = ta.value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if(!lines.length) return;
  ensureDefaultList();
  // "ai"    → run _bulkEnrichOne per task, no manual override
  // "batch" → use user-picked list + category for every task
  // "per"   → use the per-row dropdowns (already seeded with AI suggestions)
  // We still run enrichment in "batch"/"per" so non-routing fields
  // (priority, effort, energy, tags, due date) still benefit from kNN.
  const mode = _bulkRoutingMode();
  const autoOn = mode === 'ai';
  // Disable the confirm button while enrichment runs so the user can't
  // double-fire and so they SEE that work is happening.
  const btn = gid('bulkImportConfirm');
  if(btn) btn.disabled = true;
  // Snapshot the signal at start so a later openBulkImportModal() (which
  // installs a fresh controller) can't make us look "un-aborted" mid-loop.
  const signal = _bulkImportAbort ? _bulkImportAbort.signal : null;
  const aborted = () => !!(signal && signal.aborted);
  // try/finally guarantees the button is re-enabled and the progress label
  // is cleared even if a parse or enrichment step throws — without this a
  // single bad line could leave the modal in a permanently disabled state.
  let built = [];
  let persisted = false;
  try {
    // Parse pass runs in parallel: each parseQuickAddAsync awaits a shared
    // chrono module (memoized in nlparse.js) and a small synchronous regex
    // pass. Running them sequentially with await chained the cold CDN load
    // and ~N microtask hops onto the same frame, which read as a freeze
    // when a user pasted a batch. Promise.all lets the browser interleave
    // them and yields to paint between microtasks.
    const parseFn = typeof parseQuickAddAsync === 'function' ? parseQuickAddAsync : null;
    if(parseFn){
      const parsed = await Promise.all(lines.map(line =>
        parseFn(line).catch(() => ({ name: line, props: {} }))
      ));
      if(aborted()) return;
      built = parsed.map((p, i) => {
        const name = (p && p.name) ? p.name : lines[i];
        const props = (p && p.props) ? p.props : {};
        return { name, props };
      });
    } else {
      built = lines.map(line => {
        const p = parseQuickAdd(line);
        return { name: p.name || line, props: p.props || {} };
      });
    }
    // Enrichment pass — runs when intel is available AND the user picked
    // "ai" mode. In "batch"/"per" modes we skip enrichment because the
    // user is explicitly taking control of routing; running enrichment
    // anyway would silently set priority/effort/tags from kNN, which
    // feels like a bait-and-switch for "I'll handle it" users.
    // Quick-add tokens (props) win over predicted metadata so explicit
    // "@urgent" beats a model guess.
    // Each _bulkEnrichOne runs on-device embeddings on the main thread, so
    // we yield to the event loop between items. Without this, a batch of
    // ~10 items locks the UI for several seconds while the WASM model runs
    // back-to-back — the symptom users reported as a freeze.
    if(autoOn){
      const total = built.length;
      for(let i = 0; i < total; i++){
        if(aborted()) return;
        _setBulkProgress('Auto-organizing ' + (i + 1) + ' / ' + total + '…');
        // Yield so the progress text actually paints between items.
        await new Promise(r => setTimeout(r, 0));
        if(aborted()) return;
        try {
          const enriched = await _bulkEnrichOne(built[i].name);
          // Predicted fields go in FIRST, explicit quick-add tokens overlay on top.
          built[i].props = Object.assign({}, enriched, built[i].props);
        } catch(e){ console.warn('[bulk-import] enrich failed for line', i, e); }
      }
      _setBulkProgress(null);
    }
    if(aborted()) return;
    // Routing override pass — in "batch"/"per" mode apply the user's
    // explicit list + category choices. Each field can be:
    //   none → don't touch what enrichment / quick-add set
    //   set  → apply the chosen value (wins over anything else)
    //   ai   → call the predictor for this specific task and field
    // The "ai" branch lets users mix model + manual within one batch
    // (e.g. AI categories, manual list).
    if(mode === 'batch' || mode === 'per'){
      const total = built.length;
      const needsAi = (r) => r.list.type === 'ai' || r.category.type === 'ai';
      for(let i = 0; i < total; i++){
        if(aborted()) return;
        const route = _bulkRoutingFor(i);
        if(needsAi(route)){
          _setBulkProgress('Predicting routing ' + (i + 1) + ' / ' + total + '…');
          await new Promise(r => setTimeout(r, 0));
          if(aborted()) return;
        }
        if(route.list.type === 'set'){
          built[i].props.listId = route.list.value;
        } else if(route.list.type === 'ai' && typeof predictListId === 'function'){
          try {
            const lid = await predictListId(built[i].name, { minScore: 0.30, minMargin: 0 });
            if(lid != null) built[i].props.listId = lid;
          } catch(_){ /* best-effort */ }
        }
        if(route.category.type === 'set'){
          built[i].props.category = route.category.value;
        } else if(route.category.type === 'ai' && typeof predictMetadata === 'function'){
          try {
            const meta = await predictMetadata(built[i].name, 5);
            if(meta && meta.category) built[i].props.category = meta.category;
          } catch(_){ /* best-effort */ }
        }
      }
      _setBulkProgress(null);
    }
    // Persist phase — single render + save at the end.
    for(const b of built){
      const _bt = Object.assign({
        id:++taskIdCtr, name:b.name, totalSec:0, sessions:0, created:timeNowFull(),
        parentId:null, collapsed:false
      }, defaultTaskProps(), b.props);
      tasks.push(_bt);
      _taskIndexRegister(_bt);
    }
    persisted = true;
  } finally {
    if(btn) btn.disabled = false;
    _setBulkProgress(null);
  }
  // If the modal was dismissed before the persist phase ran, exit silently —
  // no half-finished batch lands in the list and no toast suggests work
  // happened. closeBulkImportModal already restored focus and reset state.
  if(!persisted) return;
  closeBulkImportModal();
  const inp = gid('taskInput');
  if(inp) inp.value = '';
  maybeShowSwipeTip();
  renderTaskList();
  saveState('user');
  if(typeof maybeShowEnhanceBtn === 'function') maybeShowEnhanceBtn();
  if(typeof scheduleIntelDupRefresh === 'function') scheduleIntelDupRefresh();
}

window._syncBulkRoutingControls = _syncBulkRoutingControls;
window._bulkRoutingMode = _bulkRoutingMode;
window._bulkRoutingFor = _bulkRoutingFor;

window.closeBulkImportModal = closeBulkImportModal;
window.confirmBulkImport = confirmBulkImport;

const _taskById=new Map();
function _taskIndexRegister(t){
  if(t&&t.id!=null) _taskById.set(t.id,t);
}
function _taskIndexRemove(id){
  if(id!=null) _taskById.delete(id);
}
function rebuildTaskIdIndex(){
  _taskById.clear();
  if(Array.isArray(tasks)) tasks.forEach(_taskIndexRegister);
}
window.rebuildTaskIdIndex=rebuildTaskIdIndex;

function findTask(id){
  if(id==null) return undefined;
  let hit=_taskById.get(id);
  if(hit!==undefined) return hit;
  if(typeof id==='string'&&/^-?\d+$/.test(id)){
    const n=parseInt(id,10);
    hit=_taskById.get(n);
    if(hit!==undefined) return hit;
  }
  return tasks.find(t=>t.id===id);
}

// Tree helpers
function getTaskChildren(parentId){return tasks.filter(t=>(t.parentId||null)===parentId)}
// Whether a child task may render as part of a parent subtree the user has
// already expanded into. The parent passed the smart-view filter; the child
// may not have, but it should still appear so the user sees the complete
// tree. One hard exception remains so users can't accidentally surface
// items they explicitly removed from view:
//   - hiddenUntil-snoozed children stay hidden unless we're in snooze view.
function _subtaskAllowedUnderShownParent(t){
  if(!t) return false;
  const today = (typeof todayISO === 'function') ? todayISO() : null;
  if(today && t.hiddenUntil && t.hiddenUntil > today
     && smartView !== 'snoozed'
     && smartView !== 'completed') return false;
  return true;
}
function hasChildren(taskId){return tasks.some(t=>t.parentId===taskId)}
function getTaskDescendantIds(taskId){
  const result=[],seen=new Set(),queue=[taskId];
  while(queue.length){
    const id=queue.shift();
    for(const t of tasks){
      if(t.parentId!==id) continue;
      const cid=t.id;
      if(seen.has(cid)) continue;
      seen.add(cid);
      result.push(cid);
      queue.push(cid);
    }
  }
  return result;
}
function getRolledUpTime(taskId){
  const t=findTask(taskId);if(!t)return 0;
  let total=getTaskElapsed(t);
  getTaskDescendantIds(taskId).forEach(id=>{const d=findTask(id);if(d)total+=getTaskElapsed(d)});
  return total;
}
function getTaskSessionEntries(t){
  if(!t) return [];
  if(Array.isArray(t.sessionEntries)) return t.sessionEntries;
  if(t._ext && Array.isArray(t._ext.sessionEntries)) return t._ext.sessionEntries;
  return [];
}
if(typeof window !== 'undefined') window.getTaskSessionEntries = getTaskSessionEntries;

function getRolledUpSessions(taskId){
  const t=findTask(taskId);if(!t)return 0;
  const countFromEntries = (task) => getTaskSessionEntries(task).length;
  let total = countFromEntries(t) || (t.sessions || 0);
  getTaskDescendantIds(taskId).forEach(id=>{
    const d=findTask(id);
    if(d) total += countFromEntries(d) || (d.sessions || 0);
  });
  return total;
}
const _TASK_PATH_MAX=64;
function getTaskPath(taskId){
  const path=[],seen=new Set();
  let cur=findTask(taskId),depth=0;
  while(cur&&depth<_TASK_PATH_MAX){
    if(seen.has(cur.id)) break;
    seen.add(cur.id);
    path.unshift(cur.name);
    cur=cur.parentId?findTask(cur.parentId):null;
    depth++;
  }
  return path;
}

// ── Manual reorder & indent ("Reorder mode") ────────────────────────────────
// Move a task up/down among its siblings or change its nesting depth without
// dragging. Sibling order is the manual-sort `t.order` field; indent/outdent
// re-point `t.parentId`. All paths force manual sort so the change is visible
// and persist immediately.
let taskReorderMode=false;
function isReorderMode(){return taskReorderMode}
function toggleReorderMode(on){
  taskReorderMode=(typeof on==='boolean')?on:!taskReorderMode;
  if(typeof document!=='undefined') document.body.classList.toggle('reorder-mode',taskReorderMode);
  const tgl=gid('reorderModeToggle');
  if(tgl){tgl.classList.toggle('active',taskReorderMode);tgl.setAttribute('aria-pressed',taskReorderMode?'true':'false');}
  // Close the View sheet so the list (now showing the arrange controls) is
  // visible — the toggle lives inside that sheet.
  if(typeof closeSheet==='function') closeSheet('viewSheet');
  renderTaskList();
}
function _forceManualSort(){
  if(taskSortBy!=='manual'){
    taskSortBy='manual';
    const sel=gid('taskSortSel');if(sel)sel.value='manual';
  }
}
// Non-archived siblings in display order, renumbered to clean 0,10,20… so the
// swap/insert math below is unambiguous even for tasks predating manual sort.
function _normalizeSiblingOrder(parentId){
  const sibs=sortTasks(getTaskChildren(parentId||null).filter(s=>!s.archived));
  sibs.forEach((s,i)=>{s.order=i*10});
  return sibs;
}
function _moveTask(id,dir){
  const t=findTask(id);if(!t)return;
  _forceManualSort();
  const sibs=_normalizeSiblingOrder(t.parentId||null);
  const idx=sibs.findIndex(s=>s.id===id);
  const j=idx+dir;
  if(idx<0||j<0||j>=sibs.length)return;
  const other=sibs[j];
  const tmp=t.order;t.order=other.order;other.order=tmp;
  if(typeof haptic==='function')haptic(10);
  window._refocusTaskId=id;
  saveState('user');renderTaskList();
}
function moveTaskUp(id){_moveTask(id,-1)}
function moveTaskDown(id){_moveTask(id,1)}
function indentTask(id){
  const t=findTask(id);if(!t)return;
  _forceManualSort();
  const sibs=_normalizeSiblingOrder(t.parentId||null);
  const idx=sibs.findIndex(s=>s.id===id);
  if(idx<=0)return; // no preceding sibling to nest under
  const newParent=sibs[idx-1];
  t.parentId=newParent.id;
  newParent.collapsed=false; // reveal the freshly-nested child
  const kids=getTaskChildren(newParent.id).filter(s=>s.id!==id);
  const maxOrder=kids.reduce((m,s)=>Math.max(m,s.order||0),-10);
  t.order=maxOrder+10;
  if(typeof haptic==='function')haptic(10);
  window._refocusTaskId=id;
  saveState('user');renderTaskList();
}
function outdentTask(id){
  const t=findTask(id);if(!t||t.parentId==null)return;
  _forceManualSort();
  const parent=findTask(t.parentId);if(!parent)return;
  const grandparentId=parent.parentId||null;
  // Renumber the grandparent's current children so `parent` has a clean order,
  // then drop `t` just after it (the +5 gap keeps t between parent and the
  // next sibling without colliding with the 0,10,20… grid).
  _normalizeSiblingOrder(grandparentId);
  const pOrder=parent.order||0;
  t.parentId=grandparentId;
  t.order=pOrder+5;
  if(typeof haptic==='function')haptic(10);
  window._refocusTaskId=id;
  saveState('user');renderTaskList();
}
if(typeof window!=='undefined'){
  window.isReorderMode=isReorderMode;
  window.toggleReorderMode=toggleReorderMode;
  window.moveTaskUp=moveTaskUp;
  window.moveTaskDown=moveTaskDown;
  window.indentTask=indentTask;
  window.outdentTask=outdentTask;
}

/** Non-archived tasks pointing at a missing or archived parent become roots (sync/import repair). */
function repairOrphanedTaskParents(){
  if(!Array.isArray(tasks)) return 0;
  let n=0;
  for(const t of tasks){
    if(t.archived||t.parentId==null) continue;
    // Self-loop: corrupt imports can produce t.parentId === t.id.
    if(t.parentId===t.id){
      console.warn('[tasks] Orphan repair: cleared self-loop parent for task',t.id);
      t.parentId=null; n++; continue;
    }
    const p=findTask(t.parentId);
    if(!p||p.archived){
      console.warn('[tasks] Orphan repair: cleared parent for task',t.id);
      t.parentId=null;
      n++;
      continue;
    }
    // Walk up the parent chain to detect longer cycles (A → B → A).
    const seen=new Set([t.id]);
    let cur=p, depth=0;
    while(cur && cur.parentId!=null && depth<256){
      if(seen.has(cur.parentId)){
        console.warn('[tasks] Orphan repair: broke parent cycle at task',t.id);
        t.parentId=null; n++;
        break;
      }
      seen.add(cur.id);
      cur=findTask(cur.parentId);
      depth++;
    }
  }
  return n;
}
window.repairOrphanedTaskParents=repairOrphanedTaskParents;
function getTaskElapsed(t){let s=t.totalSec;if(activeTaskId===t.id&&taskStartedAt)s+=Math.floor((Date.now()-taskStartedAt)/1000);return s}

// Due date helpers
/** Local calendar day YYYY-MM-DD — same as `todayKey()` in utils.js */
function todayISO(){
  if (typeof todayKey === 'function') return todayKey();
  const d = new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
/**
 * @returns {{ label: string, cls: 'overdue'|'today'|'soon'|'future'|null, relDays: number|null }}
 */
function describeDue(dateStr){
  if(!dateStr) return { label: '', cls: null, relDays: null };
  const today = todayISO();
  const t0 = new Date(today + 'T00:00:00');
  const due = new Date(String(dateStr) + 'T00:00:00');
  if (isNaN(due.getTime())) return { label: String(dateStr), cls: null, relDays: null };
  const relDays = Math.round((due - t0) / 86400000);
  const y0 = t0.getFullYear();
  const yDue = due.getFullYear();

  if (relDays < 0) {
    const a = Math.abs(relDays);
    const label = a === 1 ? 'Yesterday' : 'Overdue ' + a + 'd';
    return { label, cls: 'overdue', relDays };
  }
  if (relDays === 0) return { label: 'Today', cls: 'today', relDays: 0 };

  const tNext = new Date(t0);
  tNext.setDate(tNext.getDate() + 1);
  const tNextISO = tNext.getFullYear() + '-' + String(tNext.getMonth() + 1).padStart(2, '0') + '-' + String(tNext.getDate()).padStart(2, '0');
  if (String(dateStr) === tNextISO) return { label: 'Tomorrow', cls: 'soon', relDays: 1 };

  if (relDays >= 2 && relDays <= 6) {
    return { label: due.toLocaleDateString(undefined, { weekday: 'short' }), cls: 'soon', relDays };
  }
  if (relDays === 7) {
    return { label: due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), cls: 'soon', relDays };
  }

  const label = yDue === y0
    ? due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : due.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return { label, cls: 'future', relDays };
}

function getDueClass(dateStr) {
  if (!dateStr) return null;
  return describeDue(dateStr).cls;
}
function fmtDue(dateStr) {
  if (!dateStr) return '';
  return describeDue(dateStr).label;
}

// Subtask UI (nested)
function addSubtaskPrompt(parentId, ev){
  _stopEvt(ev);
  if(subtaskPromptParent!=null&&subtaskPromptParent!==parentId) _subtaskFormDraftText='';
  subtaskPromptParent=parentId;
  _subtaskFormDraftParent=parentId;
  const p=findTask(parentId);if(p&&p.collapsed)p.collapsed=false;
  renderTaskList();
  setTimeout(()=>{const i=document.querySelector('.task-sub-input[data-parent="'+parentId+'"]');if(i)i.focus()},20);
}
function addSubtask(parentId){
  const input=document.querySelector('.task-sub-input[data-parent="'+parentId+'"]');
  if(!input)return;
  const name=input.value.trim();
  if(!name){
    subtaskPromptParent=null;
    _subtaskFormDraftText='';
    _subtaskFormDraftParent=null;
    renderTaskList();
    return;
  }
  const parent=findTask(parentId);if(!parent)return;
  const _st=Object.assign({
    id:++taskIdCtr,name,totalSec:0,sessions:0,created:timeNowFull(),
    parentId,collapsed:false
  },defaultTaskProps(),{listId:parent.listId});
  tasks.push(_st);
  _taskIndexRegister(_st);
  subtaskPromptParent=null;
  _subtaskFormDraftText='';
  _subtaskFormDraftParent=null;
  renderTaskList();saveState('user')
}
function cancelSubtaskPrompt(){
  subtaskPromptParent=null;
  _subtaskFormDraftText='';
  _subtaskFormDraftParent=null;
  renderTaskList();
}
function toggleCollapse(taskId, ev){_stopEvt(ev);const t=findTask(taskId);if(!t)return;t.collapsed=!t.collapsed;renderTaskList();saveState('user')}

// Time tracking
function toggleTask(id, ev){
  _stopEvt(ev);
  if(activeTaskId===id){const t=findTask(id);if(t&&taskStartedAt){t.totalSec+=Math.floor((Date.now()-taskStartedAt)/1000);taskStartedAt=null}activeTaskId=null}
  else{if(activeTaskId&&taskStartedAt){const ot=findTask(activeTaskId);if(ot)ot.totalSec+=Math.floor((Date.now()-taskStartedAt)/1000)}activeTaskId=id;taskStartedAt=Date.now();
    // Auto-set status to In Progress when starting time
    const t=findTask(id);if(t&&t.status==='open')t.status='progress';
  }
  renderTaskList();renderBanner();saveState('user');
  if(typeof window._updateActiveTaskTickSchedule==='function')window._updateActiveTaskTickSchedule();
}

async function removeTask(id, ev){
  _stopEvt(ev);
  const task=findTask(id);if(!task)return;
  // Delete is permanent — the Undo toast (and Cmd+Z ring) is the safety net, so
  // an accidental × is fully recoverable for 5s. Deleting a subtree is
  // higher-stakes, so still confirm when there are children.
  const descendants=getTaskDescendantIds(id);
  if(descendants.length>0&&!(await showAppConfirm('Delete "'+task.name+'" and '+descendants.length+' subtask'+(descendants.length!==1?'s':'')+'?')))return;
  const toRemove=[id,...descendants];
  // Remember whether the delete stopped an active timer — undo restores the
  // link. The accumulated burst is folded into totalSec (captured in the
  // snapshot below) before clearing, so it survives the undo.
  const _activeIdBeforeDelete = toRemove.includes(activeTaskId) ? activeTaskId : null;
  if(toRemove.includes(activeTaskId)){
    if(taskStartedAt){const t=findTask(activeTaskId);if(t)t.totalSec+=Math.floor((Date.now()-taskStartedAt)/1000)}
    activeTaskId=null;taskStartedAt=null;
    if(typeof window!=='undefined'&&typeof window._updateActiveTaskTickSchedule==='function')window._updateActiveTaskTickSchedule();
  }
  // Snapshot removed objects + original positions so undo re-inserts them
  // exactly where they were (ascending index preserves order).
  const _removedSnaps=[];
  tasks.forEach((t,idx)=>{ if(toRemove.includes(t.id)) _removedSnaps.push({idx, task:{...t}}); });
  for(const rid of toRemove) _taskIndexRemove(rid);
  if(typeof deleteAttachmentsForTask === 'function'){
    for(const rid of toRemove) deleteAttachmentsForTask(rid).catch(()=>{});
  }
  tasks=tasks.filter(t=>!toRemove.includes(t.id));
  if(typeof syncTaskDels==='object'&&syncTaskDels){
    const ts = Date.now();
    for(const rid of toRemove) syncTaskDels[rid]=ts;
  }
  if(typeof embedStore !== 'undefined' && embedStore && embedStore.purge){
    embedStore.purge(toRemove).catch(()=>{});
  }
  if(typeof showActionToast==='function'){
    const _name=task.name;
    const _label = descendants.length > 0
      ? `Deleted "${task.name}" + ${descendants.length} subtask${descendants.length===1?'':'s'}`
      : 'Task deleted';
    showActionToast(_label, 'Undo', () => {
      _removedSnaps.slice().sort((a,b)=>a.idx-b.idx).forEach(({idx, task:snap}) => {
        tasks.splice(Math.min(idx, tasks.length), 0, {...snap});
      });
      if(typeof rebuildTaskIdIndex==='function') rebuildTaskIdIndex();
      if(typeof syncTaskDels==='object'&&syncTaskDels){ for(const rid of toRemove) delete syncTaskDels[rid]; }
      if(_activeIdBeforeDelete != null && activeTaskId == null){
        activeTaskId = _activeIdBeforeDelete;
        taskStartedAt = Date.now();
        if(typeof window!=='undefined' && typeof window._updateActiveTaskTickSchedule==='function') window._updateActiveTaskTickSchedule();
      }
      renderTaskList();
      renderBanner();
      saveState('user');
      if(typeof announce === 'function') announce('Restored: ' + _name);
    }, 5000);
  }
  window._preserveTaskScroll = true;
  renderTaskList();renderBanner();saveState('user')
}

/**
 * Snooze (defer) a task: hide it from main views until the given date.
 * Distinct from rescheduling — does NOT touch dueDate or remindAt.
 */
function snoozeTask(id, untilISO, ev){
  _stopEvt(ev);
  const t=findTask(id); if(!t) return;
  if(typeof untilISO !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(untilISO)) return;
  if(untilISO <= todayISO()) { t.hiddenUntil=null; }
  else { t.hiddenUntil=untilISO; }
  t.lastModified=Date.now();
  renderTaskList(); saveState('user');
}

/**
 * Snooze N days from today. Convenience wrapper for swipe / palette actions.
 */
function snoozeTaskForDays(id, days){
  const n=parseInt(days,10);
  if(!Number.isFinite(n) || n<=0) return;
  const d=new Date();
  d.setDate(d.getDate()+n);
  const iso=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  snoozeTask(id, iso);
}

function unsnoozeTask(id, ev){
  _stopEvt(ev);
  const t=findTask(id); if(!t) return;
  t.hiddenUntil=null;
  t.lastModified=Date.now();
  renderTaskList(); saveState('user');
}

// Tags / Categories
function setFilterCategory(catId) {
  const sel = document.getElementById('filterCategory');
  if (sel) {
    sel.value = catId;
    updateTaskFilters();
    if (typeof refreshClassificationUi === 'function') {
      refreshClassificationUi();
    }
  }
}
window.setFilterCategory = setFilterCategory;

/** Toggle a task-tag filter via the search box (tag:foo operator). */
function setFilterTag(tag){
  const inp = gid('taskSearch');
  if(!inp || !tag) return;
  const want = String(tag).trim().toLowerCase();
  if(!want) return;
  const parsed = parseTaskSearchQuery(inp.value);
  const tags = parsed.ops.tag || [];
  if(tags.includes(want)){
    inp.value = inp.value.replace(new RegExp('(?:^|\\s)(?:tag:)?#?' + want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'), ' ').replace(/\s+/g, ' ').trim();
  } else {
    inp.value = (inp.value.trim() + ' tag:' + want).trim();
  }
  updateTaskFilters();
  if(typeof refreshClassificationUi === 'function') refreshClassificationUi();
}
window.setFilterTag = setFilterTag;

function _collectTaskTags(){
  const seen = new Set();
  const out = [];
  (tasks || []).forEach(t => {
    if(!t || t.archived) return;
    (t.tags || []).forEach(raw => {
      const tg = String(raw || '').trim().toLowerCase();
      if(!tg || seen.has(tg)) return;
      seen.add(tg);
      out.push(tg);
    });
  });
  out.sort((a, b) => a.localeCompare(b));
  return out;
}
if(typeof window !== 'undefined') window._collectTaskTags = _collectTaskTags;

// Smart Views
function setSmartView(v){
  smartView=v;
  document.querySelectorAll('.sv-chip').forEach(el=>{el.classList.toggle('active',el.dataset.view===v)});
  // Sync collapsed/expanded class to the user preference. By default the bar
  // is collapsed-to-active so the task header stays compact; users can opt
  // into the always-expanded layout with the `All views ▾` toggle.
  _applySmartViewsCollapsed(!smartViewsExpanded);
  renderTaskList();saveState('user')
}

/**
 * Apply or remove the collapsed-state class to the smart-views bar and sync
 * the toggle button's aria-expanded attribute. Pure DOM — does not persist.
 */
function _applySmartViewsCollapsed(collapsed){
  const root = gid('smartViews');
  if(root) root.classList.toggle('smart-views--collapsed', !!collapsed);
  const toggle = gid('svToggle');
  if(toggle){
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.title = collapsed ? 'Show all views' : 'Hide other views';
    const arrow = toggle.querySelector('.sv-toggle-arrow');
    if(arrow) arrow.textContent = collapsed ? '▾' : '▴';
  }
}

function toggleSmartViews(){
  smartViewsExpanded = !smartViewsExpanded;
  _applySmartViewsCollapsed(!smartViewsExpanded);
  if(typeof saveState === 'function') saveState('user');
}
window.toggleSmartViews = toggleSmartViews;

// Star toggle
function toggleStar(id, ev){
  _stopEvt(ev);
  const t=findTask(id);if(!t)return;
  t.starred=!t.starred;
  // Star toggles can shift this card to/from the top of the list — animate.
  const list=gid('taskList');
  window._preserveTaskScroll = true;
  if(list&&typeof flipReorder==='function')flipReorder(list,()=>renderTaskList());
  else renderTaskList();
  saveState('user')
}

// Subtask completion progress
function getSubtaskProgress(taskId){
  const descIds=getTaskDescendantIds(taskId);
  if(!descIds.length)return null;
  const total=descIds.length;
  const done=descIds.filter(id=>{const t=findTask(id);return t&&t.status==='done'}).length;
  return{done,total,pct:Math.round(done/total*100)};
}

// Quick date buttons
function setQuickDate(offset){
  if(offset==='clear'){gid('mdDue').value='';return}
  const d=new Date();d.setDate(d.getDate()+offset);
  gid('mdDue').value=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}

// Quick snooze buttons (G-3) — mirrors setQuickDate but writes to mdSnoozeUntil
function setQuickSnooze(offset){
  const el=gid('mdSnoozeUntil'); if(!el) return;
  if(offset==='clear'){ el.value=''; return; }
  const d=new Date(); d.setDate(d.getDate()+parseInt(offset,10));
  el.value=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
window.setQuickSnooze=setQuickSnooze;

// ========== REMINDERS ==========
function setQuickReminder(offset,hour){
  if(offset==='clear'){gid('mdRemindAt').value='';return}
  let d;
  if(offset==='due'){
    const due=gid('mdDue').value;
    if(!due){alert('Set a due date first');return}
    d=new Date(due+'T00:00:00');
  }else{
    d=new Date();d.setDate(d.getDate()+offset);
  }
  d.setHours(hour,0,0,0);
  const yr=d.getFullYear(),mo=String(d.getMonth()+1).padStart(2,'0'),da=String(d.getDate()).padStart(2,'0');
  const hh=String(d.getHours()).padStart(2,'0'),mm=String(d.getMinutes()).padStart(2,'0');
  gid('mdRemindAt').value=yr+'-'+mo+'-'+da+'T'+hh+':'+mm;
}

function checkReminders(){
  const now=Date.now();
  let fired=false;
  const dueNotify = !(typeof cfg !== 'undefined' && cfg && cfg.dueNotify === false);
  tasks.forEach(t=>{
    if(t.reminderFired||t.archived||t.status==='done')return;
    // Either an explicit remindAt, or — opt-out via cfg.dueNotify — the
    // dueDate at midday acts as the implicit reminder time. Other apps treat
    // a due date as a reminder by default; without this, a user sets a due
    // date and never hears about it.
    let reminderSrc = null;
    let remindTime = null;
    if(t.remindAt){
      const rt = new Date(t.remindAt).getTime();
      if(Number.isFinite(rt)){ remindTime = rt; reminderSrc = 'remindAt'; }
      else { console.warn('[tasks] Invalid remindAt on task', t.id); return; }
    } else if(dueNotify && t.dueDate){
      // Fire at 09:00 local on the due date — the same heuristic users see in
      // Apple Reminders / Things when no specific time was set.
      const rt = new Date(String(t.dueDate) + 'T09:00:00').getTime();
      if(Number.isFinite(rt)){ remindTime = rt; reminderSrc = 'dueDate'; }
      else return;
    } else {
      return;
    }
    if(now>=remindTime){
      t.reminderFired=true;fired=true;
      const late=(now-remindTime)>5*60*1000;
      const title=(late?'Missed: ':(reminderSrc === 'dueDate' ? 'Due now: ' : 'Task reminder: '))+t.name;
      let body = t.dueDate ? ('Due ' + fmtDue(t.dueDate)) : 'No due date';
      if(t.category && typeof getCategoryDef === 'function'){
        const catDef = getCategoryDef(t.category);
        if(catDef && catDef.label) body = 'Life area: ' + catDef.label + ' · ' + body;
      }
      if('Notification' in window&&Notification.permission==='granted'){
        try{
          if(typeof notify === 'function'){
            notify(title, body, {
              tag: 'task-'+t.id,
              requireInteraction: true,
              data: { action: 'openTask', taskId: t.id, category: t.category || null },
            });
          } else {
            const n=new Notification(title,{
              body:t.dueDate?'Due '+fmtDue(t.dueDate):'No due date',
              tag:'task-'+t.id,requireInteraction:true
            });
            n.onclick=function(){window.focus();showTab('tasks');openTaskDetail(t.id);n.close()};
          }
        }catch(e){ console.warn('[tasks] Notification failed for task', t.id, e); }
      }else if(cfg.sound){playChime('bell')}
    }
  });
  if(fired)saveState('auto')
}

// Nudge the user once when they create a remindAt / dueDate but the browser
// notification permission is still 'default' — otherwise the reminder will
// fire silently and feel broken. Stores a one-shot flag in localStorage so
// the toast doesn't pester them every task. The Settings → Notifications CTA
// remains the canonical place to grant the permission.
function _maybeNudgeNotifPerm(){
  try{
    if(typeof Notification === 'undefined') return;
    if(Notification.permission !== 'default') return;
    if(typeof cfg !== 'undefined' && cfg && cfg.notif === false) return;
    const k = 'stupind_reminder_perm_nudged';
    if(localStorage.getItem(k) === '1') return;
    localStorage.setItem(k, '1');
    if(typeof showActionToast !== 'function') return;
    showActionToast('Reminders need notification permission', 'Enable', async () => {
      if(typeof reqNotifPerm === 'function'){
        const r = await reqNotifPerm();
        if(typeof renderNotifStatus === 'function') renderNotifStatus();
        if(r !== 'granted' && typeof showExportToast === 'function'){
          showExportToast('Permission ' + r + ' — enable later in Settings → Notifications.');
        }
      }
    }, 8000);
  }catch(_){}
}
window._maybeNudgeNotifPerm = _maybeNudgeNotifPerm;
// Check reminders every 30s. Managed so a bfcache restore reinstates the
// loop cleanly and a hot-reload doesn't pile up duplicate tickers.
if(typeof setManagedInterval === 'function'){
  setManagedInterval('reminders', checkReminders, 30000);
  if(typeof onBfcacheRestore === 'function'){
    onBfcacheRestore(() => setManagedInterval('reminders', checkReminders, 30000));
  }
} else {
  setInterval(checkReminders, 30000);
}
// And once on load
setTimeout(checkReminders, 1000);

// Recurring tasks — advance due date for habit-in-place completions
function advanceRecurringDate(dateStr,recurType){
  // C-5: "afterNd" variants schedule N days from TODAY (the completion date)
  // rather than from the previous due date. This is the "after I finish" model
  // — keep finishing late from compounding indefinitely into the future.
  const afterMatch = typeof recurType === 'string' ? recurType.match(/^after(\d+)d$/) : null;
  if(afterMatch){
    const days = parseInt(afterMatch[1], 10) || 1;
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() + days);
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  }
  const d=dateStr?new Date(dateStr+'T12:00:00'):new Date();
  if(recurType==='daily')d.setDate(d.getDate()+1);
  else if(recurType==='every2d')d.setDate(d.getDate()+2);
  else if(recurType==='weekdays'){
    d.setDate(d.getDate()+1);
    while(d.getDay()===0||d.getDay()===6)d.setDate(d.getDate()+1);
  }
  else if(recurType==='weekly')d.setDate(d.getDate()+7);
  else if(recurType==='monthly'){
    const day=d.getDate();
    d.setMonth(d.getMonth()+1);
    const last=new Date(d.getFullYear(),d.getMonth()+1,0).getDate();
    d.setDate(Math.min(day,last));
  }
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}

// spawnRecurringClone removed in v32 — use completeHabitCycle (single card + completions[])

/** Log one habit cycle: time since last log, stay open, next due. */
function completeHabitCycle(t){
  if(!t||!t.recur)return;
  if(!Array.isArray(t.completions))t.completions=[];
  const base=(typeof t.habitLastRecordedTotalSec==='number'&&t.habitLastRecordedTotalSec>=0)
    ?t.habitLastRecordedTotalSec:0;
  const nowSec=getTaskElapsed(t);
  const delta=Math.max(0,nowSec-base);
  t.completions.push({date:todayISO(),sec:delta});
  t.habitLastRecordedTotalSec=nowSec;
  t.status='open';
  t.completedAt=null;
  t.dueDate=advanceRecurringDate(t.dueDate||todayISO(),t.recur);
  t._habitCycledInSession = true;
  if(Array.isArray(t.checklist)){
    for(const c of t.checklist){
      if(c){ c.done=false; c.doneAt=null; }
    }
  }
}

function getHabitStreak(t){
  if(!t||!t.recur||!Array.isArray(t.completions)||!t.completions.length)return 0;
  const days=new Set(t.completions.map(c=>c&&c.date).filter(Boolean));
  const sorted=[...days].sort();
  if(!sorted.length)return 0;
  const d=new Date(sorted[sorted.length-1]+'T12:00:00');
  let streak=1;
  while(true){
    d.setDate(d.getDate()-1);
    const prev=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    if(days.has(prev))streak++;
    else break;
  }
  return streak;
}

function getHabitLoggedSecTotal(t){
  if(!t||!Array.isArray(t.completions))return 0;
  return t.completions.reduce((a,c)=>{
    const x=parseInt(c&&c.sec,10);
    return a+(isNaN(x)?0:x);
  },0);
}

// ── Parent/subtask completion cascade ────────────────────────────────────────
// Two rules, both opt-in via `cfg.cascadeCompletion` (default ON):
//   1. Marking a parent done auto-completes every open, non-recurring child
//      so the user doesn't have to walk the subtree by hand.
//   2. Marking the last open subtask done auto-completes the parent.
// Recurring tasks are skipped — they own their own completion cycle.
// Returns an array of {id, prev} snapshots of every task we mutated, so the
// undo path can restore the whole batch (not just the directly-clicked row).
function _cascadeOnDone(taskId){
  if(!(typeof cfg !== 'undefined' && cfg && cfg.cascadeCompletion !== false)) return [];
  const affected = [];
  const visit = (id) => {
    const kids = getTaskChildren(id);
    for(const k of kids){
      if(k.archived) continue;
      if(k.recur) continue;        // habits cycle separately
      if(k.status === 'done') continue;
      affected.push({ id: k.id, prev: { status: k.status, completedAt: k.completedAt } });
      k.status = 'done';
      k.completedAt = stampCompletion();
      visit(k.id);
    }
  };
  visit(taskId);
  return affected;
}
function _maybeAutoCompleteParent(childId){
  if(!(typeof cfg !== 'undefined' && cfg && cfg.cascadeCompletion !== false)) return [];
  const child = findTask(childId);
  if(!child || child.parentId == null) return [];
  const parent = findTask(child.parentId);
  if(!parent) return [];
  if(parent.archived || parent.status === 'done' || parent.recur) return [];
  // All non-archived siblings (including the just-completed child) must be done.
  const siblings = tasks.filter(t => t.parentId === parent.id && !t.archived);
  if(!siblings.length) return [];
  const allDone = siblings.every(t => t.status === 'done');
  if(!allDone) return [];
  const snap = [{ id: parent.id, prev: { status: parent.status, completedAt: parent.completedAt } }];
  parent.status = 'done';
  parent.completedAt = stampCompletion();
  // Recurse upward — completing a parent may complete its own parent.
  return snap.concat(_maybeAutoCompleteParent(parent.id));
}
function _restoreCascade(snapshots){
  if(!Array.isArray(snapshots)) return;
  for(const s of snapshots){
    const t = findTask(s.id);
    if(!t || !s.prev) continue;
    t.status = s.prev.status;
    t.completedAt = s.prev.completedAt;
  }
}

// Status/Priority quick-change
function cycleStatus(id, ev){
  _stopEvt(ev);
  const t=findTask(id);if(!t)return;
  const _wasActiveTimerTask = (activeTaskId === id);
  const idx=STATUS_ORDER.indexOf(t.status||'open');
  const next=STATUS_ORDER[(idx+1)%STATUS_ORDER.length];
  let cascade = [];
  if(next==='done'&&t.recur){completeHabitCycle(t)}
  else{
    t.status=next;
    if(t.status==='done'){
      t.completedAt=stampCompletion();
      if(activeTaskId===id){toggleTask(id)}
      // Mark all open children done too, then bubble up: if this completes
      // the last sibling, the parent auto-completes.
      cascade = cascade.concat(_cascadeOnDone(id), _maybeAutoCompleteParent(id));
    } else {
      t.completedAt=null;
    }
  }
  // Snapshot AFTER mutations so totalSec reflects the timer-folded state.
  const backup=JSON.parse(JSON.stringify(t));
  // Status cycle may move this card under a sticky group header — FLIP it.
  const list=gid('taskList');
  if(list&&typeof flipReorder==='function')flipReorder(list,()=>renderTaskList());
  else renderTaskList();
  saveState('user');
  if(typeof showActionToast==='function'){
    let cascadeNote = '';
    if(cascade.length){
      const names = cascade.map(c => { const x = findTask(c.id); return x && x.name ? x.name : null; }).filter(Boolean);
      if(names.length === 1) cascadeNote = ' (+ "' + names[0] + '")';
      else if(names.length === 2) cascadeNote = ' (+ "' + names[0] + '" and "' + names[1] + '")';
      else if(names.length > 2) cascadeNote = ' (+ "' + names[0] + '", "' + names[1] + '" and ' + (names.length - 2) + ' more)';
      else cascadeNote = ' (+' + cascade.length + ' linked)';
    }
    showActionToast('Status: '+STATUSES[t.status].label + cascadeNote, 'Undo', ()=>{
      const u=findTask(id);
      if(u){Object.assign(u,backup);}
      _restoreCascade(cascade);
      if(_wasActiveTimerTask && activeTaskId == null){
        activeTaskId = id;
        taskStartedAt = Date.now();
        if(typeof window!=='undefined' && typeof window._updateActiveTaskTickSchedule==='function') window._updateActiveTaskTickSchedule();
      }
      renderTaskList();renderBanner();saveState('user');
    }, 4000);
  }
}

function toggleTaskDoneQuick(id, ev){
  _stopEvt(ev);
  const t=findTask(id);if(!t)return;
  // Snapshot active-timer state BEFORE we mutate — completing a task that
  // owns the active timer stops the timer, and undo needs to restore both
  // the task fields AND the timer link (#6 in UX audit).
  const _wasActiveTimerTask = (activeTaskId === id);
  let cascade = [];
  if(t.status==='done'){t.status='open';t.completedAt=null}
  else{
    if(t.recur){
      completeHabitCycle(t);
      if(activeTaskId===id){/* keep timer running on same task */ }
    }else{
      t.status='done';t.completedAt=stampCompletion();
      if(activeTaskId===id){toggleTask(id)}
      // Cascade down to subtasks and bubble up if siblings are all done.
      cascade = cascade.concat(_cascadeOnDone(id), _maybeAutoCompleteParent(id));
    }
    haptic(15);
    // Dopamine: animate the row + a little sparkle
    setTimeout(()=>{
      const row=document.querySelector('.task-item[data-task-id="'+id+'"]');
      if(row){
        row.classList.add('just-done');
        const spark=document.createElement('span');spark.className='done-sparkle';
        spark.textContent='';const sparkSvg=(window.icon && window.icon('sparkles',{size:20}));if(sparkSvg){const tmp=document.createElement('span');tmp.innerHTML=sparkSvg;while(tmp.firstChild)spark.appendChild(tmp.firstChild)};
        const rect=row.getBoundingClientRect();
        spark.style.cssText='left:'+(rect.left+32)+'px;top:'+(rect.top+10)+'px;position:fixed;z-index:2000';
        document.body.appendChild(spark);
        setTimeout(()=>spark.remove(),700);
      }
    },10);
  }
  // Snapshot AFTER all mutations so the backup reflects totalSec that
  // toggleTask just folded in. Undo rolls back to this — preserving the
  // accrued seconds rather than losing them.
  const backup = JSON.parse(JSON.stringify(t));
  window._preserveTaskScroll = true;
  renderTaskList();saveState('user');
  if(typeof showActionToast==='function'){
    // Include the first cascade task name so the user sees *what* got
    // auto-completed alongside the click. With three or more, truncate to
    // "first, second, and N more". Pure count was misleading (#7 UX audit).
    let cascadeNote = '';
    if(cascade.length){
      const names = cascade.map(c => { const x = findTask(c.id); return x && x.name ? x.name : null; }).filter(Boolean);
      if(names.length === 1) cascadeNote = ' (+ "' + names[0] + '")';
      else if(names.length === 2) cascadeNote = ' (+ "' + names[0] + '" and "' + names[1] + '")';
      else if(names.length > 2) cascadeNote = ' (+ "' + names[0] + '", "' + names[1] + '" and ' + (names.length - 2) + ' more)';
      else cascadeNote = ' (+' + cascade.length + ' linked)';
    }
    showActionToast((t.status==='done'?'Task done':'Task reopened') + cascadeNote, 'Undo', ()=>{
      const u=findTask(id);
      if(u){Object.assign(u,backup);}
      _restoreCascade(cascade);
      // Reattach the active timer if the user was timing this task when they
      // accidentally marked it done. taskStartedAt resets to now so the
      // already-folded-in seconds are preserved instead of double-counted.
      if(_wasActiveTimerTask && activeTaskId == null){
        activeTaskId = id;
        taskStartedAt = Date.now();
        if(typeof window!=='undefined' && typeof window._updateActiveTaskTickSchedule==='function') window._updateActiveTaskTickSchedule();
      }
      renderTaskList();renderBanner();saveState('user');
    }, 4000);
  }
}

// Haptic helper — vibrate on supporting devices (iOS Safari + all Android)
function haptic(ms){
  if(navigator.vibrate)try{navigator.vibrate(ms||10)}catch(e){}
}

// Lists (Projects)
// Each list: { id, name, color, description } — description is optional but feeds
// Auto-organize (embeddings route tasks to the list whose name+description they
// match best). Example: description "bills, taxes, budgets, investments" routes
// "pay rent" or "review purchases" to Finance.
function ensureDefaultList(){
  if(lists.length===0){
    const t=Date.now();
    lists.push({id:++listIdCtr,name:'Personal',color:'#30d158',description:'Personal life — errands, home, hobbies, relationships, health, self-care.',lastModified:t});
    lists.push({id:++listIdCtr,name:'Work',color:'#6aa8ff',description:'Work and career — projects, meetings, deadlines, professional learning.',lastModified:t});
    activeListId=lists[0].id;
  }
  if(!activeListId&&lists.length)activeListId=lists[0].id;
  // Assign orphaned tasks to the active list
  const defList=activeListId||lists[0].id;
  tasks.forEach(t=>{if(!t.listId)t.listId=defList});
  lists.forEach(l=>{if(typeof l.description!=='string')l.description=''});
  repairOrphanedTaskParents();
}
const LIST_DESC_HINT='Short description (optional) — feeds Auto-organize so new tasks get routed here.\nExamples: "bills, taxes, budgets, investments" or "household chores, repairs, cleaning".';
async function addList(){
  const name=await showAppPrompt('List name:','');
  if(name===null||!String(name).trim())return;
  const descriptionRaw=await showAppPrompt(LIST_DESC_HINT,'',{multiline:true});
  if(descriptionRaw===null)return;
  const description=String(descriptionRaw).trim();
  const colors=['#30d158','#6aa8ff','#ff375f','#ff9f0a','#bf5af2','#7db3ff','#ff453a','#a78bfa'];
  const color=colors[lists.length%colors.length];
  lists.push({id:++listIdCtr,name:String(name).trim(),color,description,lastModified:Date.now()});
  activeListId=listIdCtr;
  if(typeof invalidateListVectorCache==='function')invalidateListVectorCache();
  renderLists();renderTaskList();saveState('user');
  if(typeof renderListsManager==='function') renderListsManager();
  if(typeof renderAIPanel==='function') renderAIPanel();
}
async function editList(id, ev){
  _stopEvt(ev);
  const l=lists.find(x=>x.id===id);if(!l)return;
  const name=await showAppPrompt('List name:',l.name);
  if(name===null)return;
  if(!String(name).trim()){alert('Name cannot be empty.');return}
  const descriptionRaw=await showAppPrompt(LIST_DESC_HINT,l.description||'',{multiline:true});
  if(descriptionRaw===null)return;
  l.name=String(name).trim();
  l.description=String(descriptionRaw).trim();
  l.lastModified=Date.now();
  if(typeof invalidateListVectorCache==='function')invalidateListVectorCache();
  renderLists();renderTaskList();saveState('user');
  if(typeof renderListsManager==='function') renderListsManager();
  if(typeof renderAIPanel==='function') renderAIPanel();
}
async function removeList(id, ev){
  _stopEvt(ev);
  if(lists.length<=1){
    if(typeof showExportToast==='function') showExportToast('You need at least one list.');
    else alert('You need at least one list.');
    return;
  }
  const list=lists.find(l=>l.id===id);if(!list)return;
  const taskCount=tasks.filter(t=>t.listId===id).length;
  if(!(await showAppConfirm('Delete list "'+list.name+'"?'+(taskCount>0?' '+taskCount+' task(s) will be moved to the first remaining list.':''))))return;
  if(typeof syncListDels==='object'&&syncListDels)syncListDels[id]=Date.now();
  lists=lists.filter(l=>l.id!==id);
  const fallbackId=lists[0].id;
  tasks.forEach(t=>{if(t.listId===id)t.listId=fallbackId});
  if(activeListId===id){
    activeListId=fallbackId;
    // If the user was in focus-on-list mode, the list they opted-in to
    // focus on is gone. Don't silently re-focus on a different list they
    // never chose — drop focus mode and let renderTaskList show everything.
    if(typeof cfg==='object'&&cfg&&cfg.focusListMode){
      cfg.focusListMode=false;
      try{ document.body.classList.remove('app-focus-list'); }catch(_){}
    }
  }
  if(typeof invalidateListVectorCache==='function')invalidateListVectorCache();
  renderLists();renderTaskList();saveState('user');
  if(typeof renderListsManager==='function') renderListsManager();
  if(typeof renderAIPanel==='function') renderAIPanel();
}
function switchList(id){activeListId=id;showAllLists=false;renderLists();renderTaskList();saveState('user')}
function viewAllLists(){showAllLists=true;renderLists();renderTaskList();saveState('user')}
function renderLists(){
  const bar=gid('listsBar');if(!bar)return;
  ensureDefaultList();
  bar.textContent='';
  bar.hidden = false;
  // Render a chip per list. Even with one list we render its chip so the user
  // can always see what list their tasks belong to and where the +List button
  // is. The ✕ delete control is suppressed when only one list exists so the
  // user can't strand themselves (removeList already guards against this, but
  // hiding the affordance is clearer).
  const onlyOne=lists.length<=1;
  // "All" chip — clears list scoping so tasks from every list show up.
  // Hidden when there's only one list (no scoping to clear).
  if(!onlyOne){
    const allChip=document.createElement('button');
    allChip.className='list-chip list-chip--all'+(showAllLists?' active':'');
    allChip.type='button';
    allChip.title='Show tasks from every list';
    allChip.onclick=function(){viewAllLists()};
    const allName=document.createTextNode('All');
    const allCnt=document.createElement('span');
    allCnt.className='lc-count';
    allCnt.textContent=String(tasks.filter(t=>!t.parentId&&!t.archived).length);
    allChip.replaceChildren(allName,allCnt);
    bar.appendChild(allChip);
  }
  lists.forEach(l=>{
    const count=tasks.filter(t=>t.listId===l.id&&(!t.parentId)).length;
    const chip=document.createElement('button');
    chip.className='list-chip'+(!showAllLists&&l.id===activeListId?' active':'');
    chip.onclick=function(){switchList(l.id)};
    chip.title=l.description?l.description+'\n\n(double-click or ✎ to edit)':'Double-click or ✎ to edit list';
    chip.ondblclick=function(e){if(e)e.stopPropagation();editList(l.id)};
    const dot=document.createElement('span');
    dot.className='lc-dot';
    dot.style.background=sanitizeListColor(l.color);
    const nameNode=document.createTextNode(l.name);
    const cnt=document.createElement('span');
    cnt.className='lc-count';
    cnt.textContent=String(count);
    const edit=document.createElement('span');
    edit.className='lc-edit';
    edit.title='Edit name + description';
    edit.textContent='✎';
    edit.onclick=function(e){if(e)e.stopPropagation();editList(l.id)};
    const kids=[dot,nameNode,cnt,edit];
    if(!onlyOne){
      const rm=document.createElement('span');
      rm.className='lc-rm';
      rm.textContent='✕';
      rm.title='Delete this list';
      rm.onclick=function(e){if(e)e.stopPropagation();removeList(l.id)};
      kids.push(rm);
    }
    chip.replaceChildren(...kids);
    bar.appendChild(chip)
  });
  const add=document.createElement('button');
  add.className='list-add';
  add.type='button';
  add.textContent='+ List';
  add.title='Add a new list (e.g. Research, School, Side Project) with an optional description that helps Auto-organize route tasks here.';
  add.onclick=addList;
  bar.appendChild(add);
  // G-7: focus-on-list toggle is meaningless with a single list — only show
  // it once there's actually something to scope to.
  if(!onlyOne){
    const focus=document.createElement('button');
    const focusOn=!!(typeof cfg==='object'&&cfg&&cfg.focusListMode);
    focus.className='list-focus-toggle'+(focusOn?' on':'');
    focus.type='button';
    focus.title=focusOn?'Exit focus-on-list mode':'Hide every list except the active one';
    focus.textContent=focusOn?'◉ Focus':'◎ Focus';
    focus.onclick=function(){ if(typeof toggleFocusListMode==='function') toggleFocusListMode(); };
    bar.appendChild(focus);
  }
}

/**
 * Settings → Lists manager. Renders one row per list (color · name · description
 * preview · Edit / Delete) plus an "+ Add list" button. Mirrors the chip-bar
 * controls so users who instinctively look in Settings (alongside Life areas)
 * can find list management there too.
 */
function renderListsManager(){
  const root=gid('listsManager');
  if(!root) return;
  ensureDefaultList();
  root.textContent='';
  const onlyOne=lists.length<=1;
  lists.forEach(l=>{
    const row=document.createElement('div');
    row.className='lists-mgr-row';
    const dot=document.createElement('span');
    dot.className='lists-mgr-dot';
    dot.style.background=sanitizeListColor(l.color);
    const meta=document.createElement('div');
    meta.className='lists-mgr-meta';
    const nm=document.createElement('div');
    nm.className='lists-mgr-name';
    nm.textContent=l.name;
    meta.appendChild(nm);
    const desc=document.createElement('div');
    desc.className='lists-mgr-desc';
    desc.textContent=l.description?l.description:'No description — add one to help Auto-organize route tasks here.';
    if(!l.description) desc.classList.add('lists-mgr-desc--empty');
    meta.appendChild(desc);
    const count=tasks.filter(t=>t.listId===l.id&&!t.archived&&!t.parentId).length;
    const cnt=document.createElement('span');
    cnt.className='lists-mgr-count';
    cnt.textContent=count+(count===1?' task':' tasks');
    const editBtn=document.createElement('button');
    editBtn.type='button';
    editBtn.className='btn-ghost btn-sm';
    editBtn.textContent='Edit';
    editBtn.onclick=function(){ editList(l.id); };
    const delBtn=document.createElement('button');
    delBtn.type='button';
    delBtn.className='btn-ghost btn-sm lists-mgr-del';
    delBtn.textContent='Delete';
    delBtn.disabled=onlyOne;
    delBtn.title=onlyOne?'You need at least one list':'Delete this list (its tasks move to the first remaining list)';
    delBtn.onclick=function(){ removeList(l.id); };
    row.replaceChildren(dot,meta,cnt,editBtn,delBtn);
    root.appendChild(row);
  });
}

// Filter/Sort/Search
function clearTaskSearch(){
  const el=gid('taskSearch');
  if(el) el.value='';
  if(typeof updateTaskFilters==='function') updateTaskFilters();
}

function updateFiltersSummary(){
  const el=gid('filtersSummary');if(!el)return;
  const so=gid('taskSortSel'),gr=gid('groupBySel');
  const sortPart=so&&so.value?(so.selectedOptions[0]&&so.selectedOptions[0].text)||'':'';
  const grpPart=gr&&gr.value&&gr.value!=='none'?(gr.selectedOptions[0]&&gr.selectedOptions[0].text)||'':'';
  el.textContent=grpPart?sortPart+' · '+grpPart:sortPart;
}

// Count View-sheet options that are not their defaults — shown on #fbView
// badge and used to tint the compact filter trigger when sorting, grouping,
// panel filters, or display toggles stray from baseline.
function _filtersViewCustomizationCount(){
  let count = 0;
  const s = gid('taskSearch'), st = gid('filterStatus'), pr = gid('filterPriority');
  const so = gid('taskSortSel'), gr = gid('groupBySel');
  if(s && s.value.trim()) count++;
  const sem = gid('taskSearchSemantic');
  if(sem && sem.checked) count++;
  if(st && st.value !== 'all') count++;
  if(pr && pr.value !== 'all') count++;
  if(so && so.value !== 'manual' && so.value !== 'smart') count++;
  if(gr && gr.value !== 'none') count++;
  const cat = gid('filterCategory'); if(cat && cat.value !== 'all') count++;
  const sc = gid('showCompletedAll'); if(sc && sc.checked) count++;
  const density = (typeof getCardDensity === 'function') ? getCardDensity() : 'cozy';
  if(density !== 'cozy') count++;
  const hh = gid('hideHabitsInMain'); if(hh && !hh.checked) count++;
  return count;
}

// Keep the compact .filter-bar trigger labels in sync with the live filter
// state. Called at the end of every renderTaskList so list switches, smart-view
// changes, category picks and view toggles all reflect immediately.
function syncFilterBar(){
  const listLbl=gid('fbListsLabel');
  if(listLbl){
    let name='All Lists';
    if(!showAllLists && typeof activeListId!=='undefined' && activeListId){
      const l=lists.find(x=>x.id===activeListId);
      if(l) name=l.name;
    }
    listLbl.textContent=name;
  }
  const fbListsBtn = gid('fbLists');
  if(fbListsBtn){
    const listsActive = !!(typeof showAllLists === 'boolean' && !showAllLists)
      || (typeof smartView !== 'undefined' && smartView && smartView !== 'all');
    fbListsBtn.classList.toggle('active', listsActive);
  }
  const tagLbl=gid('fbTagsLabel');
  if(tagLbl){
    const cat=(gid('filterCategory')||{}).value||'all';
    let label='Life areas';
    const activeTags = (typeof parseTaskSearchQuery === 'function')
      ? (parseTaskSearchQuery((gid('taskSearch')||{}).value||'').ops.tag||[])
      : [];
    if(cat && cat !== 'all'){
      if(typeof getCategoryChipLabel === 'function') label = getCategoryChipLabel(cat);
      else if(typeof getCategoryDef === 'function'){
        const catDef = getCategoryDef(cat);
        if(catDef && catDef.label) label = catDef.label;
      }
    }
    if(activeTags.length) label = '#' + activeTags[0] + (activeTags.length > 1 ? ' +' + (activeTags.length - 1) : '');
    tagLbl.textContent=label;
    const btn=gid('fbTags');
    if(btn) btn.classList.toggle('active', (cat&&cat!=='all') || activeTags.length > 0);
  }
  const viewLbl=gid('fbViewLabel');
  if(viewLbl){
    viewLbl.textContent=taskView==='board'?'Board':taskView==='calendar'?'Cal':'List';
  }
  const fbViewBtn = gid('fbView');
  if(fbViewBtn){
    const viewActive = _filtersViewCustomizationCount() > 0
      || (typeof taskView === 'string' && taskView !== 'list');
    fbViewBtn.classList.toggle('active', viewActive);
  }
}
window.syncFilterBar=syncFilterBar;

let _semanticSearchReqId=0;
let _updateTaskFiltersDebounce=null;

// ── Search operator parser ──────────────────────────────────────────────────
// The task search box accepts power-user operators alongside free text:
//
//   tag:work          one or more tags (#work also works)
//   list:Personal     list by name (case-insensitive)
//   is:overdue        overdue|today|week|done|starred|recurring
//   priority:high     urgent|high|normal|low|none (@high also works)
//   due:today         today|tomorrow|week|none|overdue|YYYY-MM-DD
//   status:open       open|progress|review|blocked|done
//
// Operators are AND-combined; multiple values within one operator are OR.
// Anything left over after stripping the operators is the free-text query.
// Returns: { text: 'free part', ops: { tag:[], list:[], is:[], priority:[],
//                                       due:[], status:[] } }
function parseTaskSearchQuery(raw){
  const ops = { tag: [], list: [], is: [], priority: [], due: [], status: [] };
  if(typeof raw !== 'string') return { text: '', ops };
  // Match `key:value` (quoted optional) or shorthand prefixes.
  const opRe = /(\w+):("[^"]+"|'[^']+'|\S+)|#(\S+)|@(\S+)/g;
  // Build a list of [start, end] ranges to splice out of the source. The old
  // implementation used String.replace(m[0], '') which always replaced the
  // FIRST occurrence — if two operators shared a prefix (or a literal token
  // matched another operator's value as substring) the wrong text got
  // removed, corrupting both the leftover and the operator list (#21 in UX
  // audit). Splicing by index avoids the issue entirely.
  const cuts = [];
  let m;
  while((m = opRe.exec(raw)) !== null){
    let consumed = false;
    if(m[3]){
      ops.tag.push(m[3].toLowerCase());
      consumed = true;
    } else if(m[4]){
      const v = m[4].toLowerCase();
      if(['urgent','high','normal','low','none'].includes(v)){ ops.priority.push(v); consumed = true; }
      else consumed = true; // strip @whatever even if it isn't a known priority
    } else {
      const key = m[1].toLowerCase();
      let val = m[2];
      if((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))){
        val = val.slice(1, -1);
      }
      val = val.toLowerCase();
      if(key === 'tag'){ ops.tag.push(val); consumed = true; }
      else if(key === 'list'){ ops.list.push(val); consumed = true; }
      else if(key === 'is'){ ops.is.push(val); consumed = true; }
      else if(key === 'priority'){ ops.priority.push(val); consumed = true; }
      else if(key === 'due'){ ops.due.push(val); consumed = true; }
      else if(key === 'status'){ ops.status.push(val); consumed = true; }
      // else: unknown operator → leave it in the leftover free-text query.
    }
    if(consumed) cuts.push([m.index, opRe.lastIndex]);
  }
  // Splice cuts out in reverse so earlier indices stay valid.
  let leftover = raw;
  for(let i = cuts.length - 1; i >= 0; i--){
    const [s, e] = cuts[i];
    leftover = leftover.slice(0, s) + leftover.slice(e);
  }
  const text = leftover.replace(/\s+/g, ' ').trim().toLowerCase();
  return { text, ops };
}
if(typeof window !== 'undefined') window.parseTaskSearchQuery = parseTaskSearchQuery;

// Build a single removable chip — used by renderActiveFilters for every
// filter source so the bar reads as one consistent row of pills.
function _afChip(cls, labelText, ariaText, onRemove){
  const pill = document.createElement('span');
  pill.className = 'qpc ' + (cls || 'qpc--filter');
  const lbl = document.createElement('span');
  lbl.textContent = labelText;
  pill.appendChild(lbl);
  if(typeof onRemove === 'function'){
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'qpc-rm';
    rm.title = 'Remove ' + (ariaText || labelText);
    rm.setAttribute('aria-label', 'Remove ' + (ariaText || labelText));
    rm.textContent = '×';
    rm.onclick = onRemove;
    pill.appendChild(rm);
  }
  return pill;
}

// Strip a search-operator token (and its shorthand variant) from the live
// taskSearch input value, then re-run filtering. Shared by the operator
// chips so each one knows how to remove just itself.
function _afStripOperatorFromInput(key, value){
  const inp = gid('taskSearch');
  if(!inp) return;
  const escVal = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [ new RegExp('\\b' + key + ':"?' + escVal + '"?\\s*', 'gi') ];
  if(key === 'tag')      patterns.push(new RegExp('#' + escVal + '\\b\\s*', 'gi'));
  if(key === 'priority') patterns.push(new RegExp('@' + escVal + '\\b\\s*', 'gi'));
  let next = inp.value;
  for(const p of patterns) next = next.replace(p, '');
  inp.value = next.replace(/\s+/g, ' ').trim();
  updateTaskFilters();
  renderTaskList();
}

// Unified "active filters" bar. Renders ONE chip per active filter from
// every source (smart view, active list, free-text search, search
// operators, filter-panel status/priority/category). Each chip's × clears
// just that filter; a "Clear all" button appears when ≥2 filters are
// active. Self-hides when nothing is active.
function renderActiveFilters(){
  const host = gid('activeFiltersBar');
  if(!host) return;
  host.replaceChildren();
  const chips = [];

  // Smart view (anything other than 'all' is an active narrowing).
  if(typeof smartView !== 'undefined' && smartView && smartView !== 'all'){
    const labelMap = {
      inbox:'Inbox', today:'Today', week:'This week', overdue:'Overdue',
      unscheduled:'Unscheduled', starred:'Starred', impact:'Impact',
      waiting:'Waiting', stuck:'Stuck', snoozed:'Snoozed',
      habits:'Habits', completed:'Done',
    };
    const label = labelMap[smartView] || smartView;
    chips.push(_afChip('qpc--view', 'View: ' + label, 'view ' + label,
      () => { if(typeof setSmartView === 'function') setSmartView('all'); }));
  }

  // Free-text search residue (after operator stripping).
  if(taskFilters.search){
    const txt = taskFilters.search.length > 32 ? taskFilters.search.slice(0, 30) + '…' : taskFilters.search;
    chips.push(_afChip('qpc--search', '“' + txt + '”', 'search ' + txt,
      () => {
        const inp = gid('taskSearch');
        if(!inp) return;
        // Strip everything that ISN'T an operator token — leave operators
        // (tag:foo, #x, @y, key:val) in place so the user doesn't lose
        // them when clearing just the free-text portion.
        const opRe = /(\w+:("[^"]+"|'[^']+'|\S+))|#\S+|@\S+/g;
        const kept = (inp.value.match(opRe) || []).join(' ');
        inp.value = kept;
        updateTaskFilters();
        renderTaskList();
      }));
  }

  // Search operators (tag/list/is/priority/due/status). Skip ops.priority
  // when the filter-panel priority dropdown is non-'all' to avoid showing
  // two chips for the same effective filter.
  const ops = taskFilters.ops || {};
  const opOrder = ['is', 'tag', 'list', 'priority', 'due', 'status'];
  const opLabels = { is:'is', tag:'tag', list:'list', priority:'priority', due:'due', status:'status' };
  for(const key of opOrder){
    const vals = ops[key];
    if(!vals || !vals.length) continue;
    for(const v of vals){
      chips.push(_afChip('qpc--filter', opLabels[key] + ':' + v, opLabels[key] + ' ' + v,
        () => _afStripOperatorFromInput(key, v)));
    }
  }

  // Filter-panel status (anything other than 'all').
  if(taskFilters.status && taskFilters.status !== 'all'){
    const sLabel = taskFilters.status === 'active' ? 'Active' :
      (typeof STATUSES === 'object' && STATUSES && STATUSES[taskFilters.status] && STATUSES[taskFilters.status].label) || taskFilters.status;
    chips.push(_afChip('qpc--accent', 'status: ' + sLabel, 'status filter',
      () => {
        const sel = gid('filterStatus'); if(sel) sel.value = 'all';
        if(typeof updateTaskFilters === 'function') updateTaskFilters();
        renderTaskList();
      }));
  }
  // Filter-panel priority.
  if(taskFilters.priority && taskFilters.priority !== 'all'){
    chips.push(_afChip('qpc--accent', 'priority: ' + taskFilters.priority, 'priority filter',
      () => {
        const sel = gid('filterPriority'); if(sel) sel.value = 'all';
        if(typeof updateTaskFilters === 'function') updateTaskFilters();
        renderTaskList();
      }));
  }
  // Filter-panel life area (classification category).
  if(taskFilters.category && taskFilters.category !== 'all'){
    let catLabel = taskFilters.category;
    if(typeof getCategoryChipLabel === 'function') catLabel = getCategoryChipLabel(taskFilters.category);
    else if(typeof getCategoryDef === 'function'){
      const d = getCategoryDef(taskFilters.category);
      if(d && d.label) catLabel = d.label;
    }
    chips.push(_afChip('qpc--tag', 'life area: ' + catLabel, 'life area filter',
      () => {
        if(typeof setFilterCategory === 'function') setFilterCategory('all');
        else {
          const sel = gid('filterCategory'); if(sel) sel.value = 'all';
          if(typeof updateTaskFilters === 'function') updateTaskFilters();
        }
        renderTaskList();
      }));
  }
  // Active list. Only chip when focusListMode is ON — that's the only state
  // the user can explicitly clear ("remove the list narrowing"). The default
  // implicit "All view scopes to active list" narrowing isn't user-removable
  // (the only way out is to switch lists or change smart view), so showing a
  // removable chip for it produces a phantom that re-renders on every tick.
  if(typeof activeListId !== 'undefined' && activeListId
     && typeof cfg === 'object' && cfg && cfg.focusListMode
     && Array.isArray(lists) && lists.length > 1){
    const l = lists.find(x => x.id === activeListId);
    if(l){
      chips.push(_afChip('qpc--list', 'list: ' + (l.name || '') + ' (focus)', 'list focus on ' + (l.name || ''),
        () => {
          // Turn off the focus-list opt-in so other lists return to view.
          // activeListId stays as a pointer; the user can re-enter focus via
          // the lists strip toggle.
          if(typeof cfg === 'object' && cfg) cfg.focusListMode = false;
          try{ document.body.classList.remove('app-focus-list'); }catch(_){}
          if(typeof renderTaskList === 'function') renderTaskList();
          if(typeof saveState === 'function') saveState('user');
        }));
    }
  }

  if(!chips.length){ host.hidden = true; return; }
  host.hidden = false;

  const mainRow = document.createElement('div');
  mainRow.className = 'af-main-row';

  const lbl = document.createElement('span');
  lbl.className = 'af-label';
  lbl.textContent = 'Filters';
  mainRow.appendChild(lbl);
  for(const c of chips) mainRow.appendChild(c);
  host.appendChild(mainRow);

  if(chips.length >= 2){
    const clearAll = document.createElement('button');
    clearAll.type = 'button';
    clearAll.className = 'af-clear-all';
    clearAll.textContent = 'Clear all';
    clearAll.title = 'Reset every active filter';
    clearAll.onclick = () => {
      // Reset every filter source in turn. Smart view returns to 'all'
      // which itself triggers renderTaskList; we still clobber the search
      // input and the filter-panel selects explicitly so the user sees
      // them empty too.
      const inp = gid('taskSearch'); if(inp) inp.value = '';
      const fS = gid('filterStatus');    if(fS) fS.value = 'all';
      const fP = gid('filterPriority');  if(fP) fP.value = 'all';
      const fC = gid('filterCategory');  if(fC) fC.value = 'all';
      if(typeof cfg === 'object' && cfg) cfg.focusListMode = false;
      try{ document.body.classList.remove('app-focus-list'); }catch(_){}
      if(typeof setSmartView === 'function') setSmartView('all');
      if(typeof updateTaskFilters === 'function') updateTaskFilters();
      renderTaskList();
    };
    const footerRow = document.createElement('div');
    footerRow.className = 'af-footer-row';
    footerRow.appendChild(clearAll);
    host.appendChild(footerRow);
  }
}
if(typeof window !== 'undefined') window.renderActiveFilters = renderActiveFilters;

// Back-compat shim — older call sites still invoke renderSearchOpPills.
// Route them through the unified renderActiveFilters so we keep one render
// path and one source of truth.
function renderSearchOpPills(){ if(typeof renderActiveFilters === 'function') renderActiveFilters(); }
if(typeof window !== 'undefined') window.renderSearchOpPills = renderSearchOpPills;

function updateTaskFilters(){
  const raw = gid('taskSearch').value;
  const parsed = parseTaskSearchQuery(raw);
  // taskFilters.search keeps the legacy free-text semantics for the substring
  // / semantic-search code paths; parsed.ops drives the new operator filters.
  taskFilters.search = parsed.text;
  taskFilters.ops    = parsed.ops;
  taskFilters.status=gid('filterStatus').value;
  taskFilters.priority=gid('filterPriority').value;
  taskFilters.category=(gid('filterCategory')||{}).value||'all';
  taskSortBy=gid('taskSortSel').value;
  const g=gid('groupBySel');if(g)taskGroupBy=g.value;
  const sem=gid('taskSearchSemantic');
  window._taskSearchSemantic=sem?sem.checked:false;
  updateFiltersActiveBadge();
  updateFiltersSummary();
  if(typeof syncFilterBar === 'function') syncFilterBar();
  const clr=gid('taskSearchClear');
  if(clr) clr.hidden = !(gid('taskSearch').value.trim());
  const semPill=gid('taskSearchSemanticPill');
  if(semPill) semPill.hidden = !((gid('taskSearchSemantic')&&gid('taskSearchSemantic').checked));
  // Render the parsed operator chips so the user sees what matched.
  if(typeof renderSearchOpPills === 'function') renderSearchOpPills();
  if(window._taskSearchSemantic && taskFilters.search && typeof semanticSearch === 'function' && typeof isIntelReady === 'function' && isIntelReady()){
    // Debounce the semantic path the same way as the literal path. Without
    // this, every keystroke fired a fresh semanticSearch → embedText, which
    // is a main-thread WASM call. The request-id pattern below cancels stale
    // RESULTS but does not cancel the in-flight WASM work — typing "groceries"
    // queued 9 sequential inferences and the UI froze for the duration.
    const rawQ = gid('taskSearch').value.trim();
    if(_updateTaskFiltersDebounce) clearTimeout(_updateTaskFiltersDebounce);
    _updateTaskFiltersDebounce = setTimeout(() => {
      _updateTaskFiltersDebounce = null;
      // Re-read the live query at fire time so the request matches what the
      // user actually settled on, not the keystroke that scheduled the timer.
      const liveQ = (gid('taskSearch') && gid('taskSearch').value.trim()) || rawQ;
      const myReq = ++_semanticSearchReqId;
      void (async () => {
        try{
          const results = await semanticSearch(liveQ, 800);
          if(myReq!==_semanticSearchReqId) return;
          window._semanticScores = new Map(results.map(r => [r.id, r.score]));
        }catch(e){
          if(myReq!==_semanticSearchReqId) return;
          window._semanticScores = null;
        }
        if(myReq!==_semanticSearchReqId) return;
        renderTaskList();
      })();
    }, 200);
    return;
  }
  window._semanticScores = null;
  _semanticSearchReqId++;
  if(_updateTaskFiltersDebounce) clearTimeout(_updateTaskFiltersDebounce);
  _updateTaskFiltersDebounce=setTimeout(()=>{
    _updateTaskFiltersDebounce=null;
    renderTaskList();
  },200);
}
function setTaskView(v){
  taskView=v;
  gid('viewList').classList.toggle('active',v==='list');
  gid('viewBoard').classList.toggle('active',v==='board');
  if(gid('viewCal'))gid('viewCal').classList.toggle('active',v==='calendar');
  gid('taskList').hidden = !(v==='list');
  gid('boardView').hidden = v !== 'board';
  if(gid('calendarView'))gid('calendarView').hidden = !(v==='calendar');
  document.body.classList.toggle('cal-active-mobile',v==='calendar');
  if(v==='calendar' && !_calFocusDate && typeof todayISO==='function') _calFocusDate=todayISO();
  renderTaskList();
  saveState('user')
}
function matchesFilters(t){
  // List filter — only apply on 'all' view, not on focused smart views
  const listSensitiveViews=['all','inbox','waiting','stuck'];
  if(!showAllLists&&listSensitiveViews.includes(smartView)&&t.listId&&activeListId&&t.listId!==activeListId)return false;
  // G-7: Focus-on-list mode forces list scoping in EVERY smart view
  if(!showAllLists&&typeof cfg==='object'&&cfg&&cfg.focusListMode&&activeListId&&t.listId!==activeListId)return false;
  // Smart view filters
  const today=todayISO();
  // hiddenUntil (snooze): hide from EVERY main view except 'snoozed',
  // UNLESS the user explicitly searched is:snoozed — that should surface
  // snoozed tasks regardless of the active smart view (#22 in UX audit).
  // Same for is:hidden (alias) and is:any (kept for symmetry).
  const opIsList = (taskFilters && taskFilters.ops && Array.isArray(taskFilters.ops.is)) ? taskFilters.ops.is : [];
  const _snoozedOverride = opIsList.includes('snoozed') || opIsList.includes('hidden');
  if(t.hiddenUntil && t.hiddenUntil>today && smartView!=='snoozed' && smartView!=='completed' && !_snoozedOverride) return false;
  if(smartView==='today'){if(t.dueDate!==today||t.status==='done')return false}
  else if(smartView==='week'){
    if(!t.dueDate||t.status==='done')return false;
    const d=new Date();const w=new Date();w.setDate(d.getDate()+7);
    const weekEnd=w.getFullYear()+'-'+String(w.getMonth()+1).padStart(2,'0')+'-'+String(w.getDate()).padStart(2,'0');
    if(t.dueDate>weekEnd)return false;
  }
  else if(smartView==='overdue'){if(!t.dueDate||t.dueDate>=today||t.status==='done')return false}
  else if(smartView==='unscheduled'){if(t.dueDate||t.status==='done')return false}
  else if(smartView==='starred'){if(!t.starred||t.status==='done')return false}
  else if(smartView==='impact'){if(t.status==='done'||!_paretoTopSet.has(t.id))return false}
  else if(smartView==='completed'){if(t.status!=='done')return false}
  else if(smartView==='habits'){if(!t.recur||t.archived||t.status==='done')return false}
  // Inbox: untriaged — no list, no category, no due, no tags, not done.
  else if(smartView==='inbox'){
    if(t.status==='done')return false;
    if(t.listId)return false;
    if(t.category)return false;
    if(t.dueDate)return false;
    if(Array.isArray(t.tags)&&t.tags.length)return false;
  }
  // Waiting: tasks the user has flagged as blocked-on-someone-else.
  else if(smartView==='waiting'){
    if(t.type!=='waiting'||t.status==='done')return false;
  }
  // Stuck: untouched for 14+ days, still open.
  else if(smartView==='stuck'){
    if(t.status==='done')return false;
    const lm=typeof t.lastModified==='number'?t.lastModified:0;
    const cutoff=Date.now()-(14*86400000);
    if(!lm||lm>=cutoff)return false;
  }
  // Snoozed: hidden-until > today.
  else if(smartView==='snoozed'){
    if(!t.hiddenUntil||t.hiddenUntil<=today)return false;
    if(t.status==='done')return false;
  }
  if(smartView==='all'){
    const sd=gid('showCompletedAll');
    if((!sd||!sd.checked)&&t.status==='done')return false;
  }
  // Search — semantic (cosine) or substring
  if(taskFilters.search){
    const semActive = window._taskSearchSemantic && window._semanticScores && window._semanticScores.size > 0;
    if(semActive){
      if(!window._semanticScores.has(t.id))return false;
    }else{
      const hay=(t.name+' '+(t.description||'')+' '+(t.tags||[]).join(' ')+' '+(t.category||'')+' '+(t.valuesAlignment||[]).join(' ')).toLowerCase();
      if(!hay.includes(taskFilters.search))return false;
    }
  }
  if(taskFilters.status!=='all'){
    if(taskFilters.status==='active'){if(t.status==='done')return false}
    else if(t.status!==taskFilters.status)return false;
  }
  if(taskFilters.priority!=='all'&&t.priority!==taskFilters.priority)return false;
  // Category filter
  if(taskFilters.category&&taskFilters.category!=='all'&&t.category!==taskFilters.category)return false;
  // Operator filters from `tag:` / `list:` / `is:` / `priority:` / `due:` /
  // `status:` (and #tag, @priority shorthands). AND across operator keys,
  // OR across values within a single key.
  const ops = taskFilters.ops;
  if(ops){
    if(ops.tag && ops.tag.length){
      const tt = (t.tags || []).map(x => String(x).toLowerCase());
      if(!ops.tag.every(want => tt.includes(want))) return false;
    }
    if(ops.list && ops.list.length){
      const list = (typeof lists !== 'undefined' && Array.isArray(lists)) ? lists.find(l => l.id === t.listId) : null;
      const name = list ? String(list.name || '').toLowerCase() : '';
      if(!ops.list.some(want => name === want || name.includes(want))) return false;
    }
    if(ops.priority && ops.priority.length){
      const p = String(t.priority || 'none').toLowerCase();
      if(!ops.priority.includes(p)) return false;
    }
    if(ops.status && ops.status.length){
      const s = String(t.status || 'open').toLowerCase();
      if(!ops.status.includes(s)) return false;
    }
    if(ops.due && ops.due.length){
      const today = todayISO();
      const dd = t.dueDate || '';
      const matchOne = (want) => {
        if(want === 'none')     return !dd;
        if(want === 'today')    return dd === today;
        if(want === 'tomorrow'){
          const d=new Date(); d.setDate(d.getDate()+1);
          const iso = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
          return dd === iso;
        }
        if(want === 'week'){
          if(!dd) return false;
          const w=new Date(); w.setDate(w.getDate()+7);
          const wIso=w.getFullYear()+'-'+String(w.getMonth()+1).padStart(2,'0')+'-'+String(w.getDate()).padStart(2,'0');
          return dd >= today && dd <= wIso;
        }
        if(want === 'overdue'){
          return !!dd && dd < today && t.status !== 'done';
        }
        if(/^\d{4}-\d{2}-\d{2}$/.test(want)) return dd === want;
        return false;
      };
      if(!ops.due.some(matchOne)) return false;
    }
    if(ops.is && ops.is.length){
      const today = todayISO();
      const matchOne = (want) => {
        switch(want){
          case 'overdue':   return !!t.dueDate && t.dueDate < today && t.status !== 'done';
          case 'today':     return t.dueDate === today;
          case 'week':{
            if(!t.dueDate) return false;
            const w=new Date(); w.setDate(w.getDate()+7);
            const wIso=w.getFullYear()+'-'+String(w.getMonth()+1).padStart(2,'0')+'-'+String(w.getDate()).padStart(2,'0');
            return t.dueDate >= today && t.dueDate <= wIso;
          }
          case 'done':      return t.status === 'done';
          case 'open':      return t.status !== 'done';
          case 'starred':   return !!t.starred;
          case 'recurring':
          case 'habit':     return !!t.recur;
          case 'snoozed':   return !!t.hiddenUntil && t.hiddenUntil > today;
          default: return false;
        }
      };
      if(!ops.is.every(matchOne)) return false;
    }
  }
  if(!habitVisibilityOk(t))return false;
  return true;
}
/** Recurring tasks optional hide from main smart views (not Overdue / Done / Archive / Week …). */
function habitVisibilityOk(t){
  if(smartView==='habits') return true;
  if(typeof cfg!=='object'||!cfg||cfg.hideHabitsInMainViews===false) return true;
  const mainHide=['all','today','week','unscheduled','starred','impact','inbox','waiting','stuck'];
  if(mainHide.includes(smartView)&&t.recur) return false;
  return true;
}
/** How many recurring tasks are hidden by "hide habits" in the current smart view (for footer link). */
function countHabitsHiddenInView(){
  if(typeof cfg!=='object'||!cfg||cfg.hideHabitsInMainViews===false) return 0;
  const mainHide=['all','today','week','unscheduled','starred','impact','inbox','waiting','stuck'];
  if(!mainHide.includes(smartView)) return 0;
  const was=cfg.hideHabitsInMainViews;
  cfg.hideHabitsInMainViews=false;
  const open=tasks.filter(matchesFilters).filter(t=>t.recur);
  cfg.hideHabitsInMainViews=true;
  const hid=tasks.filter(matchesFilters);
  cfg.hideHabitsInMainViews=was;
  const idH=new Set(hid.map(t=>t.id));
  return open.filter(t=>!idH.has(t.id)).length;
}
function updateHabitsHiddenNotice(){
  const el=gid('habitsHiddenNotice');
  if(!el) return;
  const n=countHabitsHiddenInView();
  if(n>0 && typeof cfg==='object' && cfg && cfg.hideHabitsInMainViews!==false){
    el.hidden = false;
    el.innerHTML=''+n+' recurring hidden — <button type="button" class="habits-hidden-link" data-action="setSmartView" data-arg="habits">View Habits</button>';
  }else{ el.hidden = true; el.textContent=''; }
}
function onHideHabitsToggle(){
  const h=gid('hideHabitsInMain');
  if(!h||typeof cfg!=='object'||!cfg) return;
  cfg.hideHabitsInMainViews=!!h.checked;
  saveState('user');
  if(typeof updateFiltersActiveBadge==='function') updateFiltersActiveBadge();
  renderTaskList();
}
function sortTasks(arr){
  const sorted=arr.slice();
  if(window._semanticScores && window._semanticScores.size && window._taskSearchSemantic && taskFilters.search){
    return sorted.sort((a,b)=>(window._semanticScores.get(b.id)||0)-(window._semanticScores.get(a.id)||0));
  }
  const by = taskSortBy==='order'?'manual':taskSortBy;
  if(by==='manual')return sorted.sort((a,b)=>(a.order||0)-(b.order||0));
  sorted.sort((a,b)=>{
    if(by==='smart'){
      // Starred first, then overdue, then today, then by priority+due
      if(!!b.starred-!!a.starred)return !!b.starred-!!a.starred;
      const today=todayISO();
      const aOver=a.dueDate&&a.dueDate<today?0:1,bOver=b.dueDate&&b.dueDate<today?0:1;
      if(aOver!==bOver)return aOver-bOver;
      const aToday=a.dueDate===today?0:1,bToday=b.dueDate===today?0:1;
      if(aToday!==bToday)return aToday-bToday;
      const pd=(PRIORITY_ORDER[a.priority||'none']||9)-(PRIORITY_ORDER[b.priority||'none']||9);
      if(pd!==0)return pd;
      if(!a.dueDate&&b.dueDate)return 1;if(a.dueDate&&!b.dueDate)return -1;
      if(a.dueDate&&b.dueDate)return a.dueDate.localeCompare(b.dueDate);
      return (a.order||0)-(b.order||0);
    }
    if(by==='impact'){
      const sa=_paretoScoreMap.get(a.id)||0, sb=_paretoScoreMap.get(b.id)||0;
      if(sa!==sb) return sb-sa;
      // Stable tiebreaker: starred, then due, then priority
      if(!!b.starred-!!a.starred) return !!b.starred-!!a.starred;
      if(a.dueDate&&b.dueDate&&a.dueDate!==b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      return (PRIORITY_ORDER[a.priority||'none']||9)-(PRIORITY_ORDER[b.priority||'none']||9);
    }
    if(by==='name')return (a.name||'').localeCompare(b.name||'');
    if(by==='priority')return (PRIORITY_ORDER[a.priority||'none']||9)-(PRIORITY_ORDER[b.priority||'none']||9);
    if(by==='due'){
      if(!a.dueDate&&!b.dueDate)return 0;
      if(!a.dueDate)return 1;if(!b.dueDate)return -1;
      return a.dueDate.localeCompare(b.dueDate);
    }
    // created is "YYYY-MM-DD HH:MM" (zero-padded) so string compare is chronological;
    // id is the monotonic creation counter, used as a tiebreaker / fallback.
    if(by==='created')return (a.created||'').localeCompare(b.created||'') || (a.id-b.id);
    if(by==='recent')return (b.created||'').localeCompare(a.created||'') || (b.id-a.id);
    if(by==='updated'){
      const ma=(typeof _taskImportRelevanceMs==='function')?_taskImportRelevanceMs(a):(a.lastModified||0);
      const mb=(typeof _taskImportRelevanceMs==='function')?_taskImportRelevanceMs(b):(b.lastModified||0);
      return (mb-ma) || (b.id-a.id);
    }
    if(by==='time')return getRolledUpTime(b.id)-getRolledUpTime(a.id);
    return 0;
  });
  return sorted;
}

function renderTodayBanner(){
  const today=todayISO();
  const activeTasks=tasks.filter(t=>!t.archived&&t.status!=='done');
  const overdue=activeTasks.filter(t=>t.dueDate&&t.dueDate<today).length;
  const dueToday=activeTasks.filter(t=>t.dueDate===today).length;
  const weekAhead=new Date();weekAhead.setDate(weekAhead.getDate()+7);
  const weekEnd=weekAhead.getFullYear()+'-'+String(weekAhead.getMonth()+1).padStart(2,'0')+'-'+String(weekAhead.getDate()).padStart(2,'0');
  const thisWeek=activeTasks.filter(t=>t.dueDate&&t.dueDate>=today&&t.dueDate<=weekEnd).length;
  const doneToday=tasks.filter(t=>{
    if(t.status!=='done'||!t.completedAt)return false;
    const dk=completionDateKey(t.completedAt);
    return dk===today;
  }).length;
  if(gid('tbOverdue'))gid('tbOverdue').textContent=overdue;
  if(gid('tbToday'))gid('tbToday').textContent=dueToday;
  if(gid('tbWeek'))gid('tbWeek').textContent=thisWeek;
  if(gid('tbDoneToday'))gid('tbDoneToday').textContent=doneToday;
  // Show banner ONLY when there's something urgent — overdue tasks or tasks due today
  // Week-ahead and done-today are available via smart views, no need to duplicate
  const banner=gid('todayBanner');
  if(banner){
    let snooze=null;
    try{ snooze=localStorage.getItem((window.ODTAULAI_CONFIG && window.ODTAULAI_CONFIG.STORAGE_KEYS && window.ODTAULAI_CONFIG.STORAGE_KEYS.TB_SNOOZE) || 'odtaulai_tb_snooze'); }catch(e){}
    const hasUrgent=overdue>0||dueToday>0;
    const hiddenBySnooze=snooze===today;
    banner.hidden = !(hasUrgent&&!hiddenBySnooze);
  }
}
function snoozeTodayBanner(){
  try{ localStorage.setItem((window.ODTAULAI_CONFIG && window.ODTAULAI_CONFIG.STORAGE_KEYS && window.ODTAULAI_CONFIG.STORAGE_KEYS.TB_SNOOZE) || 'odtaulai_tb_snooze', todayISO()); }catch(e){}
  const banner=gid('todayBanner');
  if(banner) banner.hidden = true;
}

function updateFiltersActiveBadge(){
  // Show a badge on the Filters button when any View-sheet option is non-default.
  const badge=gid('filtersActiveCount');if(!badge)return;
  const count = _filtersViewCustomizationCount();
  if(count > 0){badge.textContent=count;badge.hidden = false;}
  else{badge.hidden = true;}
}

function renderSmartViewCounts(){
  const today=todayISO();
  const inList=t=>showAllLists||!t.listId||!activeListId||t.listId===activeListId;
  const active=tasks.filter(t=>!t.archived&&inList(t));
  const activeNotDone=active.filter(t=>t.status!=='done');
  const weekAhead=new Date();weekAhead.setDate(weekAhead.getDate()+7);
  const weekEnd=weekAhead.getFullYear()+'-'+String(weekAhead.getMonth()+1).padStart(2,'0')+'-'+String(weekAhead.getDate()).padStart(2,'0');
  const set=(id,n)=>{const el=gid(id);if(el)el.textContent=n};
  // Hide snoozed (hiddenUntil > today) from "active" counts so the chips
  // don't advertise tasks the user explicitly deferred.
  const visibleNow=activeNotDone.filter(t=>!t.hiddenUntil||t.hiddenUntil<=today);
  set('svcAll',visibleNow.length);
  set('svcToday',visibleNow.filter(t=>t.dueDate===today).length);
  set('svcWeek',visibleNow.filter(t=>t.dueDate&&t.dueDate>=today&&t.dueDate<=weekEnd).length);
  set('svcOverdue',visibleNow.filter(t=>t.dueDate&&t.dueDate<today).length);
  set('svcUnscheduled',visibleNow.filter(t=>!t.dueDate).length);
  set('svcStarred',visibleNow.filter(t=>t.starred).length);
  set('svcImpact',visibleNow.filter(t=>_paretoTopSet.has(t.id)&&inList(t)).length);
  // Surface the cap on the Impact chip's tooltip so a power user with 200
  // tasks knows the chip is showing top-20 out of a theoretical 40 (#24).
  const impactChip = document.querySelector('.sv-chip[data-view="impact"]');
  if(impactChip){
    if(_paretoMeta && _paretoMeta.capped){
      impactChip.title = `Top ~20% by leverage — capped at ${_paretoMeta.shown} of ${_paretoMeta.theoretical} candidates`;
    } else {
      impactChip.title = 'Top ~20% by leverage — derived from priority, due, effort, unblocks, values, star';
    }
  }
  set('svcHabits',visibleNow.filter(t=>t.recur&&inList(t)).length);
  set('svcInbox',visibleNow.filter(t=>!t.listId&&!t.category&&!t.dueDate&&!(Array.isArray(t.tags)&&t.tags.length)).length);
  set('svcWaiting',visibleNow.filter(t=>t.type==='waiting').length);
  const stuckCutoff=Date.now()-(14*86400000);
  set('svcStuck',visibleNow.filter(t=>typeof t.lastModified==='number'&&t.lastModified>0&&t.lastModified<stuckCutoff).length);
  set('svcSnoozed',activeNotDone.filter(t=>t.hiddenUntil&&t.hiddenUntil>today).length);
  set('svcCompleted',active.filter(t=>t.status==='done').length);
  const doneChip=document.querySelector('.sv-chip[data-view="completed"]');
  if(doneChip) doneChip.classList.toggle('sv-chip-pinned', (active.filter(t=>t.status==='done').length)>0);
}

// Main render (list view)
// ── Daily momentum (progress ring + streak + 7-day sparkline) ──────────────
// Cheap to compute and called from renderTaskList so it always reflects the
// current task state without a separate change feed. All work is O(N over
// non-archived tasks) — fine for the bounded list sizes the app supports.
function _ymd(d){
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function _dailyMomentumStats(){
  const today = (typeof todayISO === 'function') ? todayISO() : _ymd(new Date());
  // Today: open tasks due today (or earlier) + tasks completed today.
  let dueToday = 0, doneToday = 0;
  // 7-day completion histogram (oldest → newest including today).
  const days = [];
  const dayKeys = [];
  for(let i = 6; i >= 0; i--){
    const d = new Date(); d.setDate(d.getDate() - i);
    dayKeys.push(_ymd(d));
    days.push(0);
  }
  // Per-day completed-count set for streak math.
  const completedDays = new Set();
  for(const t of tasks){
    if(!t || t.archived) continue;
    if(t.status === 'done'){
      const k = (typeof completionDateKey === 'function') ? completionDateKey(t.completedAt) : null;
      if(k){
        completedDays.add(k);
        const idx = dayKeys.indexOf(k);
        if(idx >= 0) days[idx] += 1;
        if(k === today) doneToday += 1;
      }
    } else {
      // Counts toward today's "due" denominator only if it's due today (or overdue but still open).
      if(t.dueDate && t.dueDate <= today) dueToday += 1;
    }
  }
  // Streak: walk backwards from today while each day has ≥1 completion.
  // Today not yet completed doesn't break a streak that ran through
  // yesterday — we treat today as "in progress" so the user isn't punished
  // for opening the app at 9am before finishing anything.
  let streak = 0;
  const d = new Date();
  if(!completedDays.has(today)) d.setDate(d.getDate() - 1);
  while(completedDays.has(_ymd(d))){
    streak += 1;
    d.setDate(d.getDate() - 1);
  }
  const total = dueToday + doneToday;
  const pct = total > 0 ? Math.round((doneToday / total) * 100) : 0;
  return { dueToday, doneToday, total, pct, streak, days, dayKeys, today };
}
function renderDailyMomentum(){
  const host = gid('dailyMomentum');
  if(!host) return;
  // Hide while the welcome card is up (no tasks yet — no momentum to show).
  if(!Array.isArray(tasks) || !tasks.length){ host.hidden = true; host.replaceChildren(); return; }
  const s = _dailyMomentumStats();
  host.hidden = false;
  host.replaceChildren();
  const mkCell = (cls, label, valueText, valueClass, onClick, ariaLabel) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dm-cell';
    if(onClick) b.onclick = onClick;
    if(ariaLabel) b.setAttribute('aria-label', ariaLabel);
    const inner = document.createElement('div');
    inner.style.display = 'flex'; inner.style.flexDirection = 'column'; inner.style.gap = '2px'; inner.style.alignItems = 'flex-start';
    const lbl = document.createElement('span'); lbl.className = 'dm-cell-label'; lbl.textContent = label;
    const val = document.createElement('span'); val.className = 'dm-cell-value' + (valueClass ? ' ' + valueClass : ''); val.textContent = valueText;
    inner.appendChild(lbl); inner.appendChild(val);
    b.appendChild(inner);
    return b;
  };
  // Progress ring (today). Tappable → switch to Today smart view.
  const ringWrap = document.createElement('button');
  ringWrap.type = 'button';
  ringWrap.className = 'dm-cell';
  ringWrap.setAttribute('aria-label', s.doneToday + ' of ' + s.total + ' tasks done today');
  ringWrap.onclick = () => { if(typeof setSmartView === 'function') setSmartView('today'); };
  const ring = document.createElement('div'); ring.className = 'dm-ring';
  const r = 14, c = 2 * Math.PI * r;
  ring.innerHTML = '<svg viewBox="0 0 36 36"><circle class="dm-ring-bg" cx="18" cy="18" r="' + r + '"/><circle class="dm-ring-fg" cx="18" cy="18" r="' + r + '" stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + (c - (c * s.pct / 100)).toFixed(2) + '"/></svg>';
  const txt = document.createElement('div'); txt.className = 'dm-ring-text'; txt.textContent = s.pct + '%';
  ring.appendChild(txt);
  ringWrap.appendChild(ring);
  const ringMeta = document.createElement('div');
  ringMeta.style.display = 'flex'; ringMeta.style.flexDirection = 'column'; ringMeta.style.alignItems = 'flex-start';
  const ringLbl = document.createElement('span'); ringLbl.className = 'dm-cell-label'; ringLbl.textContent = 'Today';
  const ringVal = document.createElement('span'); ringVal.className = 'dm-cell-value';
  ringVal.textContent = s.doneToday + ' / ' + s.total;
  ringMeta.appendChild(ringLbl); ringMeta.appendChild(ringVal);
  ringWrap.appendChild(ringMeta);
  host.appendChild(ringWrap);

  // Day streak (consecutive days you've completed at least one task).
  const streakCls = s.streak >= 7 ? 'dm-cell-value--success' : (s.streak >= 1 ? 'dm-cell-value--accent' : '');
  const streakLabel = s.streak === 0 ? '—' : (s.streak + ' day' + (s.streak !== 1 ? 's' : ''));
  const streakTitle = s.streak === 0
    ? 'Day streak: complete a task today to start one. Counts consecutive days you finish at least one task.'
    : s.streak + '-day streak — consecutive days you’ve completed at least one task. Finish a task today to keep it going.';
  host.appendChild(mkCell('streak', 'Day streak', streakLabel, streakCls,
    () => { if(typeof setSmartView === 'function') setSmartView('completed'); },
    streakTitle));

  // 7-day sparkline of completions.
  const sparkCell = document.createElement('button');
  sparkCell.type = 'button';
  sparkCell.className = 'dm-cell';
  sparkCell.setAttribute('aria-label', '7-day completion sparkline');
  sparkCell.onclick = () => { if(typeof setSmartView === 'function') setSmartView('completed'); };
  const sparkMeta = document.createElement('div');
  sparkMeta.style.display = 'flex'; sparkMeta.style.flexDirection = 'column'; sparkMeta.style.alignItems = 'flex-start'; sparkMeta.style.gap = '2px';
  const sparkLbl = document.createElement('span'); sparkLbl.className = 'dm-cell-label'; sparkLbl.textContent = 'Last 7 days';
  const spark = document.createElement('div'); spark.className = 'dm-spark';
  const max = Math.max(1, ...s.days);
  s.days.forEach((n, i) => {
    const bar = document.createElement('div');
    bar.className = 'dm-spark-bar' + (n === 0 ? ' dm-spark-bar--zero' : '');
    bar.style.height = (4 + Math.round((n / max) * 24)) + 'px';
    bar.title = s.dayKeys[i] + ' — ' + n + ' done';
    spark.appendChild(bar);
  });
  sparkMeta.appendChild(sparkLbl);
  sparkMeta.appendChild(spark);
  sparkCell.appendChild(sparkMeta);
  host.appendChild(sparkCell);
}
if(typeof window !== 'undefined') window.renderDailyMomentum = renderDailyMomentum;

// Set while a Sortable drag is in flight (onChoose→onUnchoose). A re-render
// during a drag detaches the dragged row from #taskList, which crashes
// Sortable's fallback path (it dereferences dragEl.parentNode). Background
// refreshes (duplicate scores, sync patches, day rollover) can fire mid-drag,
// so we defer any render until the drop completes, then flush exactly once.
let _taskDragActive = false;
let _taskDragStarted = false;
let _taskRenderQueuedDuringDrag = false;
function renderTaskList(){
  const list=gid('taskList');
  if(!list)return;
  if(_taskDragActive){ _taskRenderQueuedDuringDrag = true; return; }
  // In-place task updates (toggle done, star, chip edits…) rebuild the whole
  // list, which momentarily empties it; since the page itself scrolls, the
  // browser clamps scrollY to 0 and never restores it. Callers that mutate an
  // existing row set window._preserveTaskScroll so we can put the user back
  // where they were. Context switches (list/smart-view/filter/sort) leave it
  // unset and intentionally land at the top.
  const _keepScroll = !!window._preserveTaskScroll;
  window._preserveTaskScroll = false;
  const _savedScrollY = _keepScroll ? window.scrollY : 0;
  const _restoreScroll = () => { if(_keepScroll) requestAnimationFrame(()=>window.scrollTo(0, _savedScrollY)); };
  // Refresh the momentum tile every render — cheap and always correct.
  if(typeof renderDailyMomentum === 'function') renderDailyMomentum();
  // Same for the unified active-filters bar so a smart-view change /
  // list switch / status filter etc. always updates the chips.
  if(typeof renderActiveFilters === 'function') renderActiveFilters();
  // Apply density class — exactly one of the three modifiers is active.
  if(list){
    const _d = (typeof getCardDensity==='function' ? getCardDensity() : 'cozy');
    list.classList.toggle('task-list--comfortable', _d==='comfortable');
    list.classList.toggle('task-list--cozy',        _d==='cozy');
    list.classList.toggle('task-list--compact',     _d==='compact');
  }
  // H2: compute the "lists that own open tasks" set once per render so
  // renderTaskItem doesn't rebuild it for every row (was O(N²)).
  if(typeof _computeListsWithTasks==='function') _computeListsWithTasks();
  renderLists();
  refreshParetoTopSet();
  renderTodayBanner();
  if(typeof renderTodayCalEvents==='function') renderTodayCalEvents();
  renderSmartViewCounts();
  if(typeof updateHabitsHiddenNotice==='function') updateHabitsHiddenNotice();
  if(typeof updateFiltersSummary==='function') updateFiltersSummary();
  if(typeof syncFilterBar==='function') syncFilterBar();
  const visibleTasks=tasks.filter(matchesFilters);
  const activeCount=visibleTasks.filter(t=>t.status!=='done'&&!t.parentId).length;
  const badge=gid('taskCountBadge');if(badge)badge.textContent=activeCount+' active';
  if(taskView==='board'){renderBoard(visibleTasks);return}
  if(taskView==='calendar'){renderCalendar(visibleTasks);return}
  list.querySelectorAll('.task-item, .task-subtask-form, .task-section').forEach(e=>e.remove());
  if(!visibleTasks.length){
    const empty=gid('taskEmpty');
    empty.hidden = false;
    // Rebuild via createElement so styling is class-driven (theme-aware) and
    // there's no inline-style spaghetti to update when tokens change.
    empty.replaceChildren();
    empty.classList.add('task-empty');
    const buildIcon = (kind) => {
      const ic = document.createElement('div');
      ic.className = 'task-empty-icon';
      const svg = (window.icon && window.icon(kind,{size:28})) || '';
      if(svg){
        // window.icon returns a known-safe inline SVG string from icons.js.
        ic.insertAdjacentHTML('afterbegin', svg);
      }else{
        ic.textContent = kind === 'archive' ? '🗂' : kind === 'filter' ? '🔍' : '✨';
      }
      return ic;
    };
    const addBlock = (cls, text) => {
      const b = document.createElement('div');
      b.className = cls;
      b.textContent = text;
      empty.appendChild(b);
    };
    // Smart-view-specific empty states first so a user landing on Stuck /
    // Snoozed / Waiting learns what the view means rather than getting the
    // generic "no tasks match your filters" hint that doesn't apply.
    if(tasks.length && smartView === 'stuck'){
      empty.appendChild(buildIcon('alertCircle'));
      addBlock('task-empty-title', 'Nothing stuck — nice');
      addBlock('task-empty-help',  'Tasks land here when they\'ve been open for 14+ days without an edit. The fact this list is empty means nothing\'s been hibernating in your backlog.');
    } else if(tasks.length && smartView === 'snoozed'){
      empty.appendChild(buildIcon('moon'));
      addBlock('task-empty-title', 'No snoozed tasks');
      addBlock('task-empty-help',  'Snooze hides a task until a chosen date — useful when something can\'t move until next week. Set a snooze from the task detail modal.');
    } else if(tasks.length && smartView === 'waiting'){
      empty.appendChild(buildIcon('hourglass'));
      addBlock('task-empty-title', 'Nothing waiting on others');
      addBlock('task-empty-help',  'Mark a task type = "waiting" in its detail modal when you\'re blocked on someone else. They show up here so you can chase them at the right moment.');
    } else if(tasks.length && smartView === 'unscheduled'){
      empty.appendChild(buildIcon('circleDashed'));
      addBlock('task-empty-title', 'Every open task has a date');
      addBlock('task-empty-help',  'Tasks without a due date show up here so they don\'t fall through the cracks. Empty = healthy queue.');
    } else if(tasks.length){
      // Has tasks, but filter/view excludes all.
      empty.appendChild(buildIcon('filter'));
      addBlock('task-empty-title', 'No tasks match your filters');
      addBlock('task-empty-help',  'Try adjusting the Filters panel, or switch to the "All" smart view.');
    } else if(smartView==='habits'){
      empty.appendChild(buildIcon('refresh'));
      addBlock('task-empty-title', 'No recurring tasks yet');
      addBlock('task-empty-help',  'Habits and daily check-ins repeat on a schedule and reappear after each completion.');
      const row=document.createElement('div');
      row.className='habit-template-row';
      const tmpls=[
        {label:'+ Daily check-in',name:'Daily check-in',recur:'daily'},
        {label:'+ Every other day',name:'Every other day',recur:'every2d'},
        {label:'+ Weekday habit',name:'Weekday habit',recur:'weekdays'},
        {label:'+ Weekly review',name:'Weekly review',recur:'weekly'},
      ];
      tmpls.forEach(tm=>{
        const b=document.createElement('button');
        b.type='button';
        b.className='first-task-btn habit-template-btn';
        b.textContent=tm.label;
        b.onclick=()=>{ if(typeof addHabitFromTemplate==='function') addHabitFromTemplate(tm.name,tm.recur); };
        row.appendChild(b);
      });
      empty.appendChild(row);
      addBlock('task-empty-tip', 'Or type any task with "daily" / "every weekday" / "weekly" — the parser will set recurrence automatically.');
    } else {
      const mod = /(Mac|iPhone|iPod|iPad)/i.test(navigator.platform||'') ? '⌘' : 'Ctrl';
      empty.appendChild(buildIcon('sparkles'));
      addBlock('task-empty-title', 'No tasks yet');
      // First-run welcome card (only on truly first launch — once we've ever
      // seen tasks, this short tour is just noise). The flag is persistent
      // across sessions so re-emptying the list later doesn't re-show it.
      try{
        const seen = localStorage.getItem('stupind_welcomed') === '1';
        if(!seen){
          const w = document.createElement('div');
          w.className = 'task-empty-welcome';
          const h = document.createElement('div');
          h.className = 'task-empty-welcome-title';
          h.textContent = 'Welcome to Odta';
          w.appendChild(h);
          const ul = document.createElement('ul');
          ul.className = 'task-empty-welcome-list';
          [
            ['Type a task above. Words like "tomorrow", "@urgent", "#tag", "!star" parse automatically.'],
            [`Press ${mod}+K for the command palette — search, jump, run actions, all fully offline.`],
            ['Click chips inside a task (priority, effort, category…) — they save instantly, no Save button needed.'],
            ['Embeddings load automatically in the background — semantic search, smart-add, and duplicate detection just work.'],
          ].forEach(([t]) => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
          w.appendChild(ul);
          const dismiss = document.createElement('button');
          dismiss.type = 'button';
          dismiss.className = 'task-empty-welcome-dismiss';
          dismiss.textContent = 'Got it';
          dismiss.onclick = () => {
            try{ localStorage.setItem('stupind_welcomed', '1'); }catch(_){}
            w.remove();
          };
          w.appendChild(dismiss);
          empty.appendChild(w);
        }
      }catch(_){ /* localStorage disabled — skip the welcome card silently */ }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'first-task-btn';
      btn.textContent = '+ Add your first task';
      btn.onclick = () => {
        const i = gid('taskInput');
        if(i){ i.focus(); i.select(); }
      };
      empty.appendChild(btn);
      const cmdkLine = document.createElement('div');
      cmdkLine.className = 'task-empty-help';
      cmdkLine.append('Or press ');
      const kbd = document.createElement('strong');
      kbd.textContent = mod + '+K';
      cmdkLine.append(kbd);
      cmdkLine.append(' to open the command palette.');
      empty.appendChild(cmdkLine);
      addBlock('task-empty-tip', 'The Filters button sets sort, group, and status — smart-view chips are quick lenses on top.');
      // Inline syntax example.
      const ex = document.createElement('div');
      ex.className = 'task-empty-example';
      ex.append('Buy milk ');
      const tokens = document.createElement('span');
      tokens.className = 'task-empty-example-tokens';
      tokens.textContent = 'tomorrow @urgent #shopping !star';
      ex.appendChild(tokens);
      empty.appendChild(ex);
    }
    // Hide progress bar — empty list has nothing to scroll through.
    if(typeof refreshTaskListProgress==='function') requestAnimationFrame(refreshTaskListProgress);
    return;
  }
  gid('taskEmpty').hidden = true;
  const visibleIds=new Set(visibleTasks.map(t=>t.id));
  // If grouping, bypass tree-render and group flat (only roots)
  if(taskGroupBy!=='none'){
    renderGroupedTasks(visibleTasks);
    if(typeof refreshTaskListProgress==='function') requestAnimationFrame(refreshTaskListProgress);
    _restoreScroll();
    return;
  }
  function renderNode(parentId,depth,inShownSubtree){
    const children=getTaskChildren(parentId);
    const sorted=sortTasks(children);
    sorted.forEach(t=>{
      const selfMatch=visibleIds.has(t.id);
      const descMatch=hasVisibleDescendant(t.id,visibleIds);
      // Once an ancestor matched the filter we render its whole subtree
      // regardless of per-task filter status — otherwise expanding a parent
      // and missing half its subtasks (e.g. completed children in an "active"
      // smart view) reads as "subtasks not appearing." Archived/snoozed
      // tasks still respect global hide-rules so users can't accidentally
      // resurrect deleted-feeling items.
      const includeFromAncestor = inShownSubtree && _subtaskAllowedUnderShownParent(t);
      if(selfMatch||descMatch||includeFromAncestor){
        renderTaskItem(t,depth);
        if(subtaskPromptParent===t.id)renderSubtaskForm(t.id,depth+1);
        if(!t.collapsed)renderNode(t.id,depth+1,inShownSubtree||selfMatch||descMatch);
      }
    });
  }
  renderNode(null,0,false);
  // Long-list affordance: show/hide the scroll-progress bar once DOM commits.
  if(typeof refreshTaskListProgress==='function') requestAnimationFrame(refreshTaskListProgress);
  _restoreScroll();
}

// ========== SECTION GROUPING ==========
function getGroupKey(t){
  if(taskGroupBy==='priority')return t.priority||'none';
  if(taskGroupBy==='status')return t.status||'open';
  if(taskGroupBy==='list')return String(t.listId||'none');
  if(taskGroupBy==='due'){
    const today=todayISO();
    if(!t.dueDate)return 'zzzunscheduled';
    if(t.dueDate<today)return 'overdue';
    if(t.dueDate===today)return 'today';
    const tmr=new Date();tmr.setDate(tmr.getDate()+1);
    const tmrISO=tmr.getFullYear()+'-'+String(tmr.getMonth()+1).padStart(2,'0')+'-'+String(tmr.getDate()).padStart(2,'0');
    if(t.dueDate===tmrISO)return 'tomorrow';
    const wk=new Date();wk.setDate(wk.getDate()+7);
    const wkISO=wk.getFullYear()+'-'+String(wk.getMonth()+1).padStart(2,'0')+'-'+String(wk.getDate()).padStart(2,'0');
    if(t.dueDate<=wkISO)return 'thisweek';
    return 'later';
  }
  return 'all';
}
function getGroupLabel(key){
  if(taskGroupBy==='priority')return({urgent:'P1 Urgent',high:'P2 High',normal:'P3 Normal',low:'P4 Low',none:'No priority'})[key]||key;
  if(taskGroupBy==='status')return (STATUSES[key]||{label:key}).label;
  if(taskGroupBy==='list'){const l=lists.find(l=>String(l.id)===key);return l?l.name:'No list'}
  if(taskGroupBy==='due')return({overdue:'Overdue',today:'Today',tomorrow:'Tomorrow',thisweek:'This Week',later:'Later',zzzunscheduled:'Unscheduled'})[key]||key;
  return key;
}
function getGroupColor(key){
  if(taskGroupBy==='priority')return({urgent:'var(--danger)',high:'var(--warning)',normal:'var(--accent)',low:'var(--text-3)',none:'var(--text-4)'})[key]||'var(--text-3)';
  if(taskGroupBy==='status')return({open:'var(--text-3)',progress:'var(--accent)',review:'var(--purple)',blocked:'var(--danger)',done:'var(--success)'})[key]||'var(--text-3)';
  if(taskGroupBy==='list'){const l=lists.find(l=>String(l.id)===key);return l?l.color:'var(--text-3)'}
  if(taskGroupBy==='due')return({overdue:'var(--danger)',today:'var(--warning)',tomorrow:'var(--accent)',thisweek:'var(--accent)',later:'var(--text-3)',zzzunscheduled:'var(--text-4)'})[key]||'var(--text-3)';
  return 'var(--text-3)';
}
function renderGroupedTasks(visibleTasks){
  const list=gid('taskList');
  const visibleSet=new Set(visibleTasks.map(t=>t.id));
  // Only show root-level in groups (subtasks appear under their parents)
  const roots=visibleTasks.filter(t=>!t.parentId);
  const groups={};
  roots.forEach(t=>{const k=getGroupKey(t);(groups[k]=groups[k]||[]).push(t)});
  // Order keys
  const keyOrder={priority:['urgent','high','normal','low','none'],status:['open','progress','review','blocked','done'],due:['overdue','today','tomorrow','thisweek','later','zzzunscheduled']};
  const preferred=keyOrder[taskGroupBy]||[];
  const sortedKeys=Object.keys(groups).sort((a,b)=>{
    const ai=preferred.indexOf(a),bi=preferred.indexOf(b);
    if(ai!==-1&&bi!==-1)return ai-bi;
    if(ai!==-1)return -1;if(bi!==-1)return 1;
    return a.localeCompare(b);
  });
  sortedKeys.forEach(k=>{
    const items=sortTasks(groups[k]);
    const hdr=document.createElement('div');hdr.className='task-section';
    const isCol=collapsedSections[taskGroupBy+':'+k];
    hdr.innerHTML='<span class="ts-chevron'+(isCol?' collapsed':'')+'">▼</span>'
      +'<span class="ts-color"></span>'
      +'<span class="ts-label">'+esc(getGroupLabel(k))+'</span>'
      +'<span class="ts-count">'+items.length+'</span>';
    // Dynamic group color via DOM API — inline style is blocked by CSP.
    const tsColor = hdr.querySelector('.ts-color');
    if(tsColor) tsColor.style.background = getGroupColor(k);
    hdr.onclick=function(){collapsedSections[taskGroupBy+':'+k]=!isCol;renderTaskList();saveState('user')};
    list.appendChild(hdr);
    if(!isCol){
      items.forEach(t=>{
        renderTaskItem(t,0);
        // Show descendants inline (no further grouping) if not collapsed.
        // Once we render a parent at the group level, render its whole
        // subtree — matching the tree-mode rule above. visibleSet is still
        // consulted for "self matched filter," but a non-matching subtask
        // under a visible parent is included so the user sees the complete
        // tree they expanded into.
        if(!t.collapsed){
          function renderKids(pid,depth){
            getTaskChildren(pid).forEach(c=>{
              if(!_subtaskAllowedUnderShownParent(c)) return;
              renderTaskItem(c,depth);
              if(!c.collapsed) renderKids(c.id, depth+1);
            });
          }
          renderKids(t.id,1);
        }
      });
    }
  });
}

// ========== CHECKLIST ==========
let _clIdCtr=0;
function addChecklistItem(taskId,text){
  const t=findTask(taskId);if(!t||!text.trim())return;
  if(!t.checklist)t.checklist=[];
  t.checklist.push({id:++_clIdCtr,text:text.trim(),done:false,doneAt:null});
  renderChecklist(taskId);saveState('user');
}
function toggleChecklistItem(taskId,itemId){
  const t=findTask(taskId);if(!t)return;
  const item=t.checklist.find(c=>c.id===itemId);if(!item)return;
  item.done=!item.done;item.doneAt=item.done?timeNow():null;
  renderChecklist(taskId);saveState('user');
}
function removeChecklistItem(taskId,itemId){
  const t=findTask(taskId);if(!t)return;
  t.checklist=t.checklist.filter(c=>c.id!==itemId);
  renderChecklist(taskId);saveState('user');
}
function renderChecklist(taskId){
  const t=findTask(taskId);if(!t)return;
  const el=document.getElementById('mdChecklist');if(!el)return;
  const items=t.checklist||[];
  const done=items.filter(c=>c.done).length;
  const pct=items.length?Math.round((done/items.length)*100):0;
  el.innerHTML=`
    ${items.length?`<div class="cl-progress"><div class="cl-bar"></div><span class="cl-pct">${pct}%</span></div>`:''}
    <div class="cl-items" id="clItems"></div>
    <div class="cl-add">
      <input class="cl-input" id="clInput" placeholder="Add item…" data-onkeydown="checklistAddOnEnter" data-task-id="${taskId}">
      <button class="btn-ghost btn-sm" data-action="checklistAddFromButton" data-task-id="${taskId}" aria-label="Add checklist item" title="Add item">+</button>
    </div>`;
  // Dynamic progress width via DOM API.
  const clBar = el.querySelector('.cl-bar');
  if(clBar) clBar.style.width = pct + '%';
  const list=document.getElementById('clItems');
  items.forEach(item=>{
    const d=document.createElement('div');d.className='cl-item'+(item.done?' cl-done':'');
    d.innerHTML=`<button class="cl-check${item.done?' on':''}" data-action="toggleChecklistItem" data-args='[${taskId},${item.id}]' aria-label="${item.done?'Mark item not done':'Mark item done'}" aria-pressed="${item.done?'true':'false'}" title="${item.done?'Mark not done':'Mark done'}">${item.done?'✓':''}</button><span class="cl-text">${esc(item.text)}</span><button class="cl-rm" data-action="removeChecklistItem" data-args='[${taskId},${item.id}]' aria-label="Remove checklist item" title="Remove">×</button>`;
    list.appendChild(d);
  });
}

// ========== DRAG-DROP REORDER (Sortable.js) ==========
// Single Sortable instance bound to #taskList. Replaced the per-task
// HTML5 native drag handlers (which silently failed on iOS Safari and were
// inconsistent on Android). Sortable normalises mouse + touch with a
// synthetic drag image, so reorder finally works on phones.
let _taskListSortable = null;
function _initTaskListSortable(){
  if(_taskListSortable) return; // idempotent: SW + module reloads can call twice
  if(typeof window === 'undefined' || typeof window.Sortable !== 'function') return;
  const list = document.getElementById('taskList');
  if(!list) return;
  _taskListSortable = new window.Sortable(list, {
    // Anchor the gesture to the explicit drag-handle so swipe-to-move/delete
    // and tap-to-open don't fight with reorder. Without this, every touch
    // on a card races between Sortable and our touchstart/end handlers.
    handle: '.drag-handle',
    // Fall back to whole-card drag on desktop where the handle is hover-only,
    // because mouse users don't expect a tiny handle target. .task-action
    // is the action-buttons cluster and must remain clickable.
    filter: '.task-action,button,input,.task-checkbox,.task-play,.task-rm,.task-star,.task-chevron',
    preventOnFilter: false,
    animation: 150,
    ghostClass: 'task-item--ghost',
    chosenClass: 'task-item--chosen',
    dragClass: 'task-item--dragging',
    // Use the synthetic-clone fallback for both mouse and touch. Native HTML5
    // drag never fires from a touchstart, so on phones the only way to drag the
    // handle is Sortable's pointer-tracked fallback. Forcing it everywhere also
    // keeps the drag image consistent across input types.
    forceFallback: true,
    fallbackOnBody: true,
    fallbackTolerance: 4,
    // Hold ~400ms on the grip before drag starts (Google Tasks–style) so
    // horizontal swipes on the row still win when the finger moves first.
    delay: 400,
    delayOnTouchOnly: true,
    swapThreshold: 0.65,
    // Auto-scroll while dragging near the top/bottom edges. Sortable's
    // built-in scroll handler is window-scoped (good — task list lives in
    // the document body for our layout). Without this, dragging across a
    // long list required releasing, scrolling, re-grabbing.
    scroll: true,
    scrollSensitivity: 80,
    scrollSpeed: 14,
    bubbleScroll: true,
    onEnd: function(evt){
      // Cross-surface drop-on-calendar (mobile). The calendar view uses
      // HTML5 ondragover/ondrop on .cal-day for desktop; Sortable's
      // synthetic-touch path doesn't propagate to those handlers, so we
      // probe the release point here. If the user released over a
      // .cal-day we update the task's dueDate instead of treating the
      // event as a reorder. evt.originalEvent is the underlying touch /
      // pointer event Sortable was tracking.
      let calDropApplied = false;
      try{
        const oe = evt.originalEvent || (evt.touches && evt.touches[0]);
        const point = oe ? (oe.changedTouches && oe.changedTouches[0]) || oe : null;
        if(point && Number.isFinite(point.clientX) && Number.isFinite(point.clientY)){
          // dragged item's ghost intercepts elementFromPoint at release; hide
          // it briefly before the lookup so we see the underlying drop target.
          const ghost = document.querySelector('.task-item--dragging, .task-item--ghost');
          const prev = ghost ? ghost.style.visibility : null;
          if(ghost) ghost.style.visibility = 'hidden';
          const el = document.elementFromPoint(point.clientX, point.clientY);
          if(ghost) ghost.style.visibility = prev || '';
          const day = el && el.closest && el.closest('.cal-day');
          if(day && day.dataset && day.dataset.date){
            const taskId = parseInt((evt.item && evt.item.dataset && evt.item.dataset.taskId) || '', 10);
            if(Number.isFinite(taskId) && typeof findTask === 'function'){
              const t = findTask(taskId);
              if(t){
                t.dueDate = day.dataset.date;
                t.reminderFired = false;
                if(typeof saveState === 'function') saveState('user');
                if(typeof renderTaskList === 'function') renderTaskList();
                if(typeof showActionToast === 'function'){
                  const oldDue = (evt.item && evt.item.dataset && evt.item.dataset.prevDue) || null;
                  showActionToast('Due ' + ((typeof fmtDue === 'function') ? fmtDue(day.dataset.date) : day.dataset.date), 'Undo', () => {
                    const u = findTask(taskId);
                    if(u){ u.dueDate = oldDue || null; saveState('user'); renderTaskList(); }
                  }, 4500);
                }
                calDropApplied = true;
              }
            }
          }
        }
      }catch(e){ console.warn('[sortable] cross-surface drop probe', e); }
      if(!calDropApplied){
        // Read new DOM order, persist as t.order. Force manual sort so the
        // user-driven order survives across renders that would otherwise
        // re-sort by smart heuristics. The list is still frozen here, so the
        // DOM reflects exactly where Sortable dropped the row.
        const items = list.querySelectorAll('.task-item');
        let dirty = false;
        items.forEach((el, i) => {
          const id = parseInt(el.dataset.taskId || '', 10);
          if(!Number.isFinite(id)) return;
          const t = (typeof findTask === 'function') ? findTask(id) : null;
          if(!t) return;
          const newOrder = i * 10;
          if(t.order !== newOrder){ t.order = newOrder; dirty = true; }
        });
        if(dirty){
          if(typeof taskSortBy !== 'undefined' && taskSortBy !== 'manual'){
            taskSortBy = 'manual';
            const sel = document.getElementById('taskSortSel');
            if(sel) sel.value = 'manual';
          }
          if(typeof saveState === 'function') saveState('user');
        }
      }
      // Order is applied; safe to unfreeze and run the single deferred render
      // (background refreshes that fired mid-drag, or the cal-drop re-render).
      _taskDragActive = false;
      if(_taskRenderQueuedDuringDrag){
        _taskRenderQueuedDuringDrag = false;
        if(typeof renderTaskList === 'function') renderTaskList();
      }
    },
    onStart: function(evt){
      _taskDragStarted = true;
      // Stash the original dueDate so the cross-surface drop's Undo button
      // can restore it without re-querying for a possibly-stale value.
      const id = parseInt((evt.item && evt.item.dataset && evt.item.dataset.taskId) || '', 10);
      const t = Number.isFinite(id) && typeof findTask === 'function' ? findTask(id) : null;
      if(t && evt.item){ evt.item.dataset.prevDue = t.dueDate || ''; }
    },
    // Freeze list re-renders for the whole drag so a background refresh can't
    // detach the row mid-flight (crashes Sortable's fallback) or reset the
    // order before onEnd persists it. onChoose fires before onStart; onEnd
    // (which applies the new order) owns the unfreeze+flush for real drags.
    onChoose: function(){ _taskDragActive = true; _taskDragStarted = false; },
    onUnchoose: function(){
      // A real drag's unfreeze+flush is handled by onEnd, which runs around
      // this event and only after the order is applied. Here we only cover the
      // tap case — handle pressed but never dragged, so onEnd never fires.
      if(_taskDragStarted) return;
      _taskDragActive = false;
      if(_taskRenderQueuedDuringDrag){
        _taskRenderQueuedDuringDrag = false;
        if(typeof renderTaskList === 'function') renderTaskList();
      }
    },
  });
}
window._initTaskListSortable = _initTaskListSortable;

// ========== TASK NOTES ==========
let _noteIdCtr=0;
/**
 * After loading persisted tasks, set checklist/note id counters to max existing
 * so new items never collide with persisted ids.
 */
function reseedChecklistAndNoteIdCtrs(){
  let maxC = 0, maxN = 0;
  for(const t of tasks || []){
    for(const c of t.checklist || []){
      if(typeof c.id === 'number' && c.id > maxC) maxC = c.id;
    }
    for(const n of t.notes || []){
      const id = n && n.id;
      if(typeof id === 'number' && id > 0 && id < 1e12) maxN = Math.max(maxN, id);
    }
  }
  if(maxC > _clIdCtr) _clIdCtr = maxC;
  if(maxN > _noteIdCtr) _noteIdCtr = maxN;
}
function addTaskNote(taskId,text){
  const t=findTask(taskId);if(!t||!text.trim())return;
  if(!t.notes)t.notes=[];
  t.notes.unshift({id:++_noteIdCtr,text:text.trim(),createdAt:timeNow()});
  renderTaskNotes(taskId);saveState('user');
}
function removeTaskNote(taskId,noteId){
  const t=findTask(taskId);if(!t)return;
  t.notes=t.notes.filter(n=>n.id!==noteId);
  renderTaskNotes(taskId);saveState('user');
}
function renderTaskNotes(taskId){
  const t=findTask(taskId);if(!t)return;
  const el=document.getElementById('mdNotes');if(!el)return;
  el.innerHTML=`
    <div class="note-add">
      <textarea class="note-input" id="noteInput" rows="2" placeholder="Add a timestamped note…"></textarea>
      <button class="btn-ghost btn-sm" data-action="taskNoteAddFromButton" data-task-id="${taskId}">Add</button>
    </div>
    <div id="noteList"></div>`;
  const list=document.getElementById('noteList');
  (t.notes||[]).forEach(n=>{
    const d=document.createElement('div');d.className='note-item';
    d.innerHTML=`<span class="note-time">${esc(n.createdAt||'')}</span><span class="note-text">${esc(n.text)}</span><button class="note-rm" data-action="removeTaskNote" data-args='[${taskId},${n.id}]' aria-label="Remove note" title="Remove">×</button>`;
    list.appendChild(d);
  });
}

// ========== BLOCKED-BY ==========
function addBlockedBy(taskId,blockerIdStr){
  const t=findTask(taskId);if(!t)return;
  const blockerId=parseInt(blockerIdStr);if(!blockerId||blockerId===taskId)return;
  if(!t.blockedBy)t.blockedBy=[];
  if(!t.blockedBy.includes(blockerId))t.blockedBy.push(blockerId);
  renderBlockedBy(taskId);saveState('user');
}
function removeBlockedBy(taskId,blockerId){
  const t=findTask(taskId);if(!t)return;
  t.blockedBy=(t.blockedBy||[]).filter(id=>id!==blockerId);
  renderBlockedBy(taskId);saveState('user');
}
function renderBlockedBy(taskId){
  const t=findTask(taskId);if(!t)return;
  const el=document.getElementById('mdBlockedBy');if(!el)return;
  const blockers=t.blockedBy||[];
  el.innerHTML=`
    <div class="blocker-chips" id="blockerChips"></div>
    <div class="blocker-add-row">
      <select class="mfield-in blocker-sel" id="blockerSel">
        <option value="">Select blocking task…</option>
        ${tasks.filter(x=>x.id!==taskId&&x.status!=='done').map(x=>`<option value="${x.id}">${esc(x.name.slice(0,40))}</option>`).join('')}
      </select>
      <button class="btn-ghost btn-sm" data-action="taskBlockerAddFromSelect" data-task-id="${taskId}">Link</button>
    </div>`;
  const chips=document.getElementById('blockerChips');
  blockers.forEach(bid=>{
    const bt=findTask(bid);if(!bt)return;
    const c=document.createElement('span');c.className='blocker-chip'+(bt.status==='done'?' resolved':'');
    c.innerHTML=`${bt.status==='done'?'✓ ':''}<span>${esc(bt.name.slice(0,30))}</span><button data-action="removeBlockedBy" data-args='[${taskId},${bid}]' aria-label="Remove blocker" title="Remove">×</button>`;
    chips.appendChild(c);
  });
}

(function(){
  const inp = typeof gid === 'function' ? gid('taskInput') : null;
  if(inp) inp.addEventListener('paste', taskInputPaste);
})();

// Density: enum of 'comfortable' | 'cozy' | 'compact'. Default cozy.
// Back-compat: legacy 'detailed' -> 'comfortable'; legacy 'compact' (which was
// the previous default) -> 'cozy' so existing users see no visual change.
const _DENSITY_KEY = (window.ODTAULAI_CONFIG && window.ODTAULAI_CONFIG.STORAGE_KEYS && window.ODTAULAI_CONFIG.STORAGE_KEYS.CARD_DENSITY) || 'stupind_card_density';
function getCardDensity(){
  try{
    const v = localStorage.getItem(_DENSITY_KEY);
    if(v==='comfortable'||v==='cozy'||v==='compact') return v;
    if(v==='detailed') return 'comfortable';
    return 'cozy';
  }catch(e){ return 'cozy'; }
}
function setCardDensity(v){
  if(v!=='comfortable'&&v!=='cozy'&&v!=='compact') v='cozy';
  try{ localStorage.setItem(_DENSITY_KEY, v); }catch(e){}
  // Reflect in the segmented control radios.
  document.querySelectorAll('.density-seg-btn').forEach(b=>{
    const on = b.dataset.density === v;
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.classList.toggle('on', on);
  });
  if(typeof updateFiltersActiveBadge === 'function') updateFiltersActiveBadge();
  renderTaskList();
}
// Legacy entry-point kept so any old data-action="onCardDensityToggle" still works.
function onCardDensityToggle(){
  setCardDensity(getCardDensity()==='comfortable' ? 'cozy' : 'comfortable');
}
function onShowCompletedToggle(){
  try{
    const sc = gid('showCompletedAll');
    localStorage.setItem((window.ODTAULAI_CONFIG && window.ODTAULAI_CONFIG.STORAGE_KEYS && window.ODTAULAI_CONFIG.STORAGE_KEYS.SHOW_DONE_ALL) || 'stupind_show_done_all', sc && sc.checked ? '1' : '0');
  }catch(e){}
  updateTaskFilters();
}
function restoreTaskToolbarPrefs(){
  const sc = gid('showCompletedAll');
  if(sc){
    try{ sc.checked = localStorage.getItem((window.ODTAULAI_CONFIG && window.ODTAULAI_CONFIG.STORAGE_KEYS && window.ODTAULAI_CONFIG.STORAGE_KEYS.SHOW_DONE_ALL) || 'stupind_show_done_all') === '1'; }catch(e){}
  }
  // Reflect persisted density on the new segmented control (and legacy
  // checkbox if still present).
  const _d = getCardDensity();
  document.querySelectorAll('.density-seg-btn').forEach(b=>{
    const on = b.dataset.density === _d;
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.classList.toggle('on', on);
  });
  const cd = gid('cardDensityDetailed');
  if(cd){ cd.checked = (_d === 'comfortable'); }
  const hh = gid('hideHabitsInMain');
  if(hh && typeof cfg === 'object' && cfg && typeof cfg.hideHabitsInMainViews === 'boolean'){
    hh.checked = cfg.hideHabitsInMainViews;
  }
}

window.getCardDensity = getCardDensity;
window.setCardDensity = setCardDensity;
window.onCardDensityToggle = onCardDensityToggle;
window.onShowCompletedToggle = onShowCompletedToggle;
window.restoreTaskToolbarPrefs = restoreTaskToolbarPrefs;
window.describeDue = describeDue;
window.onHideHabitsToggle = onHideHabitsToggle;
window.updateHabitsHiddenNotice = updateHabitsHiddenNotice;
window.completeHabitCycle = completeHabitCycle;
window.getHabitStreak = getHabitStreak;
window.getHabitLoggedSecTotal = getHabitLoggedSecTotal;
window.dismissSwipeTip = dismissSwipeTip;
window.snoozeTodayBanner = snoozeTodayBanner;
window.clearTaskSearch = clearTaskSearch;

// ─── Configurable quick-add panel ──────────────────────────────────────────
// Inline panel beneath the task input. Field set is user-configurable in
// Settings → Quick-add fields. Default fields: list + due. Each field's
// chosen value is staged in window._quickAddValues until the user submits.
const QUICK_ADD_FIELDS = {
  entryKind: { label: 'Entry kind', render: _renderQAEntryKind },
  list: { label: 'List', render: _renderQAList },
  due:  { label: 'Due date', render: _renderQADue },
  category: { label: 'Life area', render: _renderQACategory },
  priority: { label: 'Priority', render: _renderQAPriority },
  type: { label: 'Type', render: _renderQAType },
  recur: { label: 'Repeats', render: _renderQARecur },
  star: { label: 'Star', render: _renderQAStar },
  tags: { label: 'Tags', render: _renderQATags },
};

function _qaVal(){ return (window._quickAddValues = window._quickAddValues || {}); }
function _qaSet(key, val){
  const v = _qaVal();
  if(val == null || val === '' || (Array.isArray(val) && !val.length)) delete v[key];
  else v[key] = val;
}

function _renderQAEntryKind(wrap){
  _renderQAChips(wrap, 'Entry kind', 'entryKind', [
    ['task', 'One-off task'],
    ['habit', 'Habit'],
  ]);
  const v = _qaVal().entryKind;
  if(v === 'habit' && !_qaVal().recur) _qaSet('recur', 'daily');
}
function _renderQAList(wrap){
  wrap.appendChild(_qaLbl('List'));
  const ctl = document.createElement('div');
  ctl.className = 'qa-more-field-control';
  const sel = document.createElement('select');
  sel.className = 'mfield-in';
  sel.style.maxWidth = '100%';
  const optDefault = document.createElement('option');
  optDefault.value = ''; optDefault.textContent = '— default —';
  sel.appendChild(optDefault);
  if(typeof lists !== 'undefined' && Array.isArray(lists)){
    lists.forEach(L => {
      const o = document.createElement('option');
      o.value = String(L.id); o.textContent = L.name;
      sel.appendChild(o);
    });
  }
  if(_qaVal().listId != null) sel.value = String(_qaVal().listId);
  sel.onchange = () => _qaSet('listId', sel.value ? parseInt(sel.value,10) : null);
  ctl.appendChild(sel);
  wrap.appendChild(ctl);
}

function _renderQADue(wrap){
  wrap.appendChild(_qaLbl('Due date'));
  const ctl = document.createElement('div');
  ctl.className = 'qa-more-field-control';
  const inp = document.createElement('input');
  inp.type = 'date'; inp.className = 'mfield-in';
  inp.value = _qaVal().dueDate || '';
  inp.onchange = () => _qaSet('dueDate', inp.value || null);
  ctl.appendChild(inp);
  const mkBtn = (label, daysOffset) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'qd-btn'; b.textContent = label;
    b.onclick = () => {
      if(daysOffset === 'clear'){ inp.value=''; _qaSet('dueDate', null); return; }
      const d = new Date(); d.setDate(d.getDate()+daysOffset);
      const iso = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
      inp.value = iso; _qaSet('dueDate', iso);
    };
    return b;
  };
  ctl.appendChild(mkBtn('Today', 0));
  ctl.appendChild(mkBtn('Tomorrow', 1));
  ctl.appendChild(mkBtn('+1 wk', 7));
  ctl.appendChild(mkBtn('Clear', 'clear'));
  wrap.appendChild(ctl);
}

function _renderQAChips(wrap, label, key, options){
  wrap.appendChild(_qaLbl(label));
  const ctl = document.createElement('div');
  ctl.className = 'qa-more-field-control';
  options.forEach(([val, lbl]) => {
    const b = document.createElement('button');
    b.type='button'; b.className='mfield-chip-btn';
    b.textContent = lbl;
    if(_qaVal()[key] === val) b.classList.add('active');
    b.onclick = () => {
      const cur = _qaVal()[key];
      if(cur === val){ _qaSet(key, null); b.classList.remove('active'); }
      else{
        Array.from(ctl.querySelectorAll('.mfield-chip-btn')).forEach(c=>c.classList.remove('active'));
        b.classList.add('active');
        _qaSet(key, val);
      }
    };
    ctl.appendChild(b);
  });
  wrap.appendChild(ctl);
}
function _renderQACategory(wrap){
  const cats = (typeof getCategoryDefs === 'function') ? getCategoryDefs() : [];
  const opts = cats.map(c => [c.id, c.label]);
  if(!opts.length) opts.push(['general','General']);
  _renderQAChips(wrap, 'Life area', 'category', opts);
}
function _renderQAPriority(wrap){
  _renderQAChips(wrap, 'Priority', 'priority', [
    ['urgent','Urgent'],['high','High'],['normal','Normal'],['low','Low']
  ]);
}
function _renderQAType(wrap){
  _renderQAChips(wrap, 'Type', 'type', [
    ['task','Task'],['waiting','Waiting'],['bug','Bug'],['idea','Idea'],['errand','Errand']
  ]);
}
function _renderQARecur(wrap){
  wrap.appendChild(_qaLbl('Repeats'));
  const ctl = document.createElement('div');
  ctl.className='qa-more-field-control';
  const sel = document.createElement('select');
  sel.className='mfield-in';
  [
    ['','None'],['daily','Daily'],['weekdays','Weekdays'],['every2d','Every 2 days'],
    ['weekly','Weekly'],['monthly','Monthly'],
    ['after1d','After 1d'],['after3d','After 3d'],['after7d','After 7d'],
  ].forEach(([v,l])=>{
    const o=document.createElement('option');o.value=v;o.textContent=l;sel.appendChild(o);
  });
  sel.value = _qaVal().recur || '';
  sel.onchange = () => _qaSet('recur', sel.value || null);
  ctl.appendChild(sel);
  wrap.appendChild(ctl);
}
function _renderQAStar(wrap){
  wrap.appendChild(_qaLbl('Star'));
  const ctl = document.createElement('div');
  ctl.className='qa-more-field-control';
  const b = document.createElement('button');
  b.type='button'; b.className='mfield-chip-btn'+(_qaVal().starred?' active':'');
  b.textContent = _qaVal().starred ? 'Starred' : 'Not starred';
  b.onclick = () => {
    const next = !_qaVal().starred;
    _qaSet('starred', next || null);
    b.classList.toggle('active', next);
    b.textContent = next ? 'Starred' : 'Not starred';
  };
  ctl.appendChild(b);
  wrap.appendChild(ctl);
}
function _renderQATags(wrap){
  wrap.appendChild(_qaLbl('Tags'));
  const ctl = document.createElement('div');
  ctl.className='qa-more-field-control';
  const inp = document.createElement('input');
  inp.type='text'; inp.className='mfield-in';
  inp.placeholder='comma-separated';
  inp.value = (_qaVal().tags || []).join(', ');
  inp.oninput = () => {
    const tags = inp.value.split(',').map(s=>s.trim()).filter(Boolean);
    _qaSet('tags', tags);
  };
  ctl.appendChild(inp);
  wrap.appendChild(ctl);
}
function _qaLbl(text){
  const l = document.createElement('span');
  l.className='qa-more-field-lbl';
  l.textContent = text;
  return l;
}

function renderQuickAddPanel(){
  const panel = document.getElementById('qaMorePanel');
  if(!panel) return;
  const enabled = (typeof cfg==='object' && cfg && Array.isArray(cfg.quickAddFields))
    ? cfg.quickAddFields
    : ['list','due'];
  panel.replaceChildren();
  if(!enabled.length){
    const p = document.createElement('p');
    p.className = 'qa-more-empty';
    const a = document.createElement('a');
    a.textContent = 'Pick fields in Settings';
    a.onclick = () => { if(typeof showTab==='function') showTab('settings'); };
    p.append('No fields enabled — ', a, '.');
    panel.appendChild(p);
    return;
  }
  enabled.forEach(key => {
    const def = QUICK_ADD_FIELDS[key];
    if(!def) return;
    const f = document.createElement('div');
    f.className = 'qa-more-field';
    def.render(f);
    panel.appendChild(f);
  });
}

function toggleQuickAddPanel(){
  const btn = document.getElementById('qaMoreToggle');
  const panel = document.getElementById('qaMorePanel');
  if(!btn || !panel) return;
  const willOpen = panel.hidden;
  btn.setAttribute('aria-expanded', String(willOpen));
  panel.hidden = !willOpen;
  if(willOpen) renderQuickAddPanel();
}

window.QUICK_ADD_FIELDS = QUICK_ADD_FIELDS;
window.renderQuickAddPanel = renderQuickAddPanel;
window.toggleQuickAddPanel = toggleQuickAddPanel;

// Settings → Quick-add fields picker. Renders one checkbox per field so the
// user can choose which subset appears in the inline "More options" panel.
function renderQaFieldsCfg(){
  const root = document.getElementById('qaFieldsCfg');
  if(!root) return;
  root.replaceChildren();
  const enabledArr = (typeof cfg==='object' && cfg && Array.isArray(cfg.quickAddFields))
    ? cfg.quickAddFields
    : ['list','due'];
  const enabled = new Set(enabledArr);
  // Preserve declared order from QUICK_ADD_FIELDS so the picker is stable.
  Object.entries(QUICK_ADD_FIELDS).forEach(([key, def]) => {
    const lbl = document.createElement('label');
    lbl.className = 'qa-field-chip';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'qa-field-chip-cb';
    cb.checked = enabled.has(key);
    cb.onchange = () => {
      if(cb.checked) enabled.add(key); else enabled.delete(key);
      // Persist in declared order so the panel renders predictably.
      const ordered = Object.keys(QUICK_ADD_FIELDS).filter(k => enabled.has(k));
      if(typeof cfg === 'object' && cfg){
        cfg.quickAddFields = ordered;
        if(typeof saveState === 'function') saveState('user');
      }
      // If the inline panel is currently open, re-render so the change is
      // visible immediately.
      const panel = document.getElementById('qaMorePanel');
      if(panel && !panel.hidden) renderQuickAddPanel();
    };
    lbl.appendChild(cb);
    lbl.append(' ' + def.label);
    root.appendChild(lbl);
  });
}
window.renderQaFieldsCfg = renderQaFieldsCfg;
