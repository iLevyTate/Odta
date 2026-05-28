// ========== CALENDAR VIEW ==========
function _calEffectiveFocusDate(){
  if(_calFocusDate) return _calFocusDate;
  return (typeof todayISO === 'function') ? todayISO() : new Date().toISOString().slice(0, 10);
}

/** Focus a day in the calendar: highlight cell + show full event list below. */
function calFocusDay(iso){
  if(!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
  _calFocusDate = iso;
  window._calSelectedDate = iso;
  const wantMonth = iso.slice(0, 7);
  const anchor = _calMonthAnchor();
  const visibleMonth = anchor.getFullYear() + '-' + String(anchor.getMonth() + 1).padStart(2, '0');
  if(wantMonth !== visibleMonth) calMonth = wantMonth;
  renderTaskList();
}
window.calFocusDay = calFocusDay;

function _calMonthAnchor(){
  if(!calMonth) return new Date();
  if(/^\d{4}-\d{2}$/.test(calMonth)){
    const p=calMonth.split('-').map(Number);
    return new Date(p[0],p[1]-1,1,12,0,0);
  }
  return new Date(calMonth);
}
function setCalMode(mode){
  if(typeof cfg!=='object'||!cfg)return;
  const m=mode==='week'||mode==='day'?mode:'month';
  cfg.calMode=m;
  if(typeof saveState==='function')saveState('user');
  if(typeof renderTaskList==='function')renderTaskList();
}
window.setCalMode=setCalMode;

function _calModeSegHtml(active){
  const modes=[['month','Month'],['week','Week'],['day','Day']];
  let h='<div class="cal-mode-seg" role="group" aria-label="Calendar layout">';
  modes.forEach(([k,l])=>{
    h+='<button type="button" class="cal-mode-btn'+(active===k?' active':'')+'" data-action="setCalMode" data-arg="'+k+'">'+l+'</button>';
  });
  return h+'</div>';
}

function renderCalendar(visibleTasks){
  const container=gid('calendarView');if(!container)return;
  const calMode=(typeof cfg==='object'&&cfg&&cfg.calMode)||'month';
  const focusIso=_calEffectiveFocusDate();
  const byDate={};
  visibleTasks.forEach(t=>{if(t.dueDate){(byDate[t.dueDate]=byDate[t.dueDate]||[]).push(t)}});

  if(calMode==='day'){
    container.innerHTML=_calModeSegHtml('day')+_renderCalDayAgendaHtml(focusIso, byDate, true);
    _bindCalAgendaClicks(container);
    return;
  }

  if(calMode==='week'){
    const anchor=new Date(focusIso+'T12:00:00');
    const dow=anchor.getDay();
    const weekStart=new Date(anchor);
    weekStart.setDate(anchor.getDate()-dow);
    let html=_calModeSegHtml('week')+'<div class="cal-week-grid">';
    for(let i=0;i<7;i++){
      const d=new Date(weekStart);
      d.setDate(weekStart.getDate()+i);
      const iso=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
      const dayLbl=d.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});
      html+='<div class="cal-week-col'+(iso===focusIso?' selected':'')+'" data-date="'+iso+'">'
        +'<button type="button" class="cal-week-col-head" data-action="calFocusDay" data-arg="'+iso+'">'+esc(dayLbl)+'</button>'
        +'<div class="cal-week-col-body">'+_renderCalDayAgendaInner(iso, byDate)+'</div></div>';
    }
    html+='</div>';
    container.innerHTML=html;
    _bindCalWeekCols(container);
    return;
  }

  const now=_calMonthAnchor();
  const year=now.getFullYear(),month=now.getMonth();
  const first=new Date(year,month,1);
  const startDay=first.getDay();
  const daysInMonth=new Date(year,month+1,0).getDate();
  const prevDays=new Date(year,month,0).getDate();
  const today=todayISO();
  const monthName=now.toLocaleDateString(undefined,{month:'long',year:'numeric'});
  // Surface feed sync failures inline at the top of the calendar so users
  // realise their displayed events may be stale. Falls back silently when
  // the calfeed module isn't loaded (e.g. in test sandbox).
  let feedAlertHtml='';
  if(typeof getFailedCalFeeds === 'function'){
    const failed = getFailedCalFeeds();
    if(failed && failed.length){
      const names = failed.map(f => esc(f.label || 'Feed')).slice(0, 3).join(', ');
      const more = failed.length > 3 ? ' +' + (failed.length - 3) : '';
      feedAlertHtml = '<div class="cal-feed-alert" role="status">'
        + '<span class="cal-feed-alert-msg">⚠ ' + names + more + ' — sync failed; events may be stale</span>'
        + '<button type="button" class="cal-feed-alert-btn" data-action="retryFailedCalFeeds">Retry sync</button>'
        + '</div>';
    }
  }
  let html=feedAlertHtml+_calModeSegHtml('month')+'<div class="calendar"><div class="cal-head">'
    +'<button class="cal-nav" data-action="calNav" data-args="[-1]" title="Previous month" aria-label="Previous month">‹</button>'
    +'<div class="cal-title">'+monthName+'</div>'
    +'<button class="cal-today-btn" data-action="calToday">Today</button>'
    +'<button class="cal-nav" data-action="calNav" data-args="[1]" title="Next month" aria-label="Next month">›</button>'
    +'</div><div class="cal-weekdays">';
  ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(w=>{html+='<div class="cal-weekday">'+w+'</div>'});
  html+='</div><div class="cal-grid">';
  // Prev month trailing
  for(let i=startDay-1;i>=0;i--){
    const day=prevDays-i;const d=new Date(year,month-1,day);
    const iso=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    html+='<div class="cal-day other-month'+(iso===focusIso?' selected':'')+'" data-date="'+iso+'"><div class="cal-daynum">'+day+'</div>'+renderCalTasks(byDate[iso], iso)+'</div>';
  }
  // Current month
  for(let day=1;day<=daysInMonth;day++){
    const iso=year+'-'+String(month+1).padStart(2,'0')+'-'+String(day).padStart(2,'0');
    const isToday=iso===today;
    html+='<div class="cal-day'+(isToday?' today':'')+(iso===focusIso?' selected':'')+'" data-date="'+iso+'"><div class="cal-daynum">'+day+'</div>'+renderCalTasks(byDate[iso], iso)+'</div>';
  }
  // Next month leading
  const totalCells=startDay+daysInMonth;
  const rem=(7-totalCells%7)%7;
  for(let day=1;day<=rem;day++){
    const d=new Date(year,month+1,day);
    const iso=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    html+='<div class="cal-day other-month'+(iso===focusIso?' selected':'')+'" data-date="'+iso+'"><div class="cal-daynum">'+day+'</div>'+renderCalTasks(byDate[iso], iso)+'</div>';
  }
  html+='</div>'+_renderCalDayAgendaHtml(focusIso, byDate)+'</div>';
  container.innerHTML=html;
  // Apply per-event border-left-color via DOM API — inline style is blocked
  // by CSP, but el.style.X writes are allowed.
  container.querySelectorAll('.cal-feed-event[data-feed-color]').forEach(el=>{
    el.style.borderLeftColor = el.dataset.feedColor;
  });
  container.querySelectorAll('.cal-agenda-dot[data-feed-color]').forEach(el=>{
    el.style.background = el.dataset.feedColor;
  });
  container.querySelectorAll('.cal-agenda-task[data-task-id]').forEach(el=>{
    el.onclick = function(e){
      e.stopPropagation();
      const tid = parseInt(el.dataset.taskId, 10);
      if(tid) openTaskDetail(tid);
    };
  });
  // Click handlers - click day background opens new task with that date, click task opens detail
  container.querySelectorAll('.cal-task').forEach(el=>{
    el.onclick=function(e){e.stopPropagation();const tid=parseInt(el.dataset.taskId);if(tid)openTaskDetail(tid)};
  });
  container.querySelectorAll('.cal-day').forEach(el=>{
    el.ondragover=function(e){e.preventDefault();e.dataTransfer.dropEffect='move';el.classList.add('drop-target')};
    el.ondragleave=function(){el.classList.remove('drop-target')};
    el.ondrop=function(e){
      e.preventDefault();el.classList.remove('drop-target');
      const srcId=parseInt(e.dataTransfer.getData('text/plain'));const src=findTask(srcId);
      if(src){src.dueDate=el.dataset.date;renderTaskList();saveState('user')}
    };
    el.onclick=function(e){
      if(e.target.closest('.cal-task')||e.target.closest('[data-action]')||e.target.closest('.cal-task-more'))return;
      const date=el.dataset.date;
      if(date && typeof calFocusDay === 'function') calFocusDay(date);
      const inp=gid('taskInput');if(inp){inp.value='';inp.focus();}
    };
  });
  container.querySelectorAll('.cal-task-more').forEach(el=>{
    el.onclick=function(e){
      e.stopPropagation();
      const date=el.dataset.date;
      if(date){
        if(typeof setCalMode==='function') setCalMode('day');
        if(typeof calFocusDay==='function') calFocusDay(date);
      }
    };
  });
}
function _renderCalDayAgendaInner(isoDate, byDate){
  const tasks = (byDate && byDate[isoDate]) ? byDate[isoDate] : [];
  const feedEvents = (typeof getCalFeedEventsForDate === 'function' && isoDate)
    ? getCalFeedEventsForDate(isoDate) : [];
  let rows = '';
  const sortKey = (ev) => ev.allDay ? '00:00' : String(ev.time || '99:99');
  feedEvents.slice().sort((a, b) => sortKey(a).localeCompare(sortKey(b))).forEach(ev => {
    rows += '<div class="cal-agenda-row cal-agenda-feed"><span class="cal-agenda-title">'+esc(ev.title||'(event)')+'</span></div>';
  });
  tasks.slice().sort((a,b)=>String(a.name).localeCompare(String(b.name))).forEach(t=>{
    rows+='<div class="cal-agenda-row cal-agenda-task" data-task-id="'+t.id+'"><span class="cal-agenda-title">'+esc(t.name)+'</span></div>';
  });
  return rows || '<div class="cal-agenda-empty">Nothing scheduled</div>';
}

function _bindCalAgendaClicks(container){
  if(!container) return;
  container.querySelectorAll('.cal-agenda-task[data-task-id]').forEach(el=>{
    el.onclick=function(e){
      e.stopPropagation();
      const tid=parseInt(el.dataset.taskId,10);
      if(tid) openTaskDetail(tid);
    };
  });
}

function _bindCalWeekCols(container){
  if(!container) return;
  _bindCalAgendaClicks(container);
}

function _renderCalDayAgendaHtml(isoDate, byDate, dayOnly){
  const tasks = (byDate && byDate[isoDate]) ? byDate[isoDate] : [];
  const feedEvents = (typeof getCalFeedEventsForDate === 'function' && isoDate)
    ? getCalFeedEventsForDate(isoDate) : [];
  const today = (typeof todayISO === 'function') ? todayISO() : '';
  const label = (typeof prettyDate === 'function') ? prettyDate(isoDate) : isoDate;
  const heading = isoDate === today ? 'Today — ' + label : label;
  let rows = '';
  const sortKey = (ev) => ev.allDay ? '00:00' : String(ev.time || '99:99');
  feedEvents.slice().sort((a, b) => sortKey(a).localeCompare(sortKey(b))).forEach(ev => {
    const uid = String(ev.uid || '');
    const mk = uid && typeof createTaskFromCalEvent === 'function'
      ? `<button type="button" class="cal-agenda-mk" title="Create task from this event" aria-label="Create task from event" data-action="createTaskFromCalEvent" data-args='${JSON.stringify([String(ev.feedId), uid])}'>+Task</button>`
      : '';
    rows += '<div class="cal-agenda-row cal-agenda-feed">'
      + '<span class="cal-agenda-dot" data-feed-color="'+escAttr(sanitizeListColor(ev.feedColor))+'"></span>'
      + '<span class="cal-agenda-time">'+(ev.allDay ? 'All day' : esc(String(ev.time || '').slice(0, 5)))+'</span>'
      + '<span class="cal-agenda-title">'+esc(ev.title || '(no title)')+'</span>'
      + '<span class="cal-agenda-src">'+esc(ev.feedLabel || '')+'</span>'
      + mk
      + '</div>';
  });
  tasks.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).forEach(t => {
    rows += '<div class="cal-agenda-row cal-agenda-task p-'+(t.priority||'none')+(t.status==='done'?' done':'')+'" data-task-id="'+t.id+'">'
      + '<span class="cal-agenda-dot"></span>'
      + '<span class="cal-agenda-time">Due</span>'
      + '<span class="cal-agenda-title">'+esc(t.name)+'</span>'
      + '<span class="cal-agenda-src">Task</span>'
      + '</div>';
  });
  const empty = !rows
    ? '<div class="cal-agenda-empty">No tasks or calendar events on this day.</div>'
    : rows;
  const nav = dayOnly
    ? '<div class="cal-day-nav">'
      +'<button type="button" class="cal-nav" data-action="calDayNav" data-args="[-1]">‹</button>'
      +'<button type="button" class="cal-today-btn" data-action="calToday">Today</button>'
      +'<button type="button" class="cal-nav" data-action="calDayNav" data-args="[1]">›</button>'
      +'</div>'
    : '';
  return '<div class="cal-day-agenda'+(dayOnly?' cal-day-agenda--full':'')+'" id="calDayAgenda" data-date="'+escAttr(isoDate)+'">'
    + nav
    + '<div class="cal-agenda-head">'+esc(heading)+'</div>'
    + '<div class="cal-agenda-list">'+empty+'</div>'
    + '</div>';
}

function calDayNav(dir){
  const d=parseInt(dir,10)||0;
  const iso=_calEffectiveFocusDate();
  const x=new Date(iso+'T12:00:00');
  x.setDate(x.getDate()+d);
  const next=x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0');
  calFocusDay(next);
}
window.calDayNav=calDayNav;
function renderCalTasks(arr, isoDate){
  // Merge local tasks with external calendar feed events for this date
  const feedEvents = (typeof getCalFeedEventsForDate === 'function' && isoDate)
    ? getCalFeedEventsForDate(isoDate) : [];

  const haveAnything = (arr && arr.length) || feedEvents.length;
  if(!haveAnything) return '';

  let html = '';
  // Render local tasks first (show up to 2)
  if(arr && arr.length){
    const show = arr.slice(0, 2);
    html += show.map(t=>'<div class="cal-task p-'+(t.priority||'none')+(t.status==='done'?' done':'')+'" data-task-id="'+t.id+'">'+esc(t.name)+'</div>').join('');
  }
  // Render external feed events (show up to 2)
  if(feedEvents.length){
    const showEvs = feedEvents.slice(0, 2);
    html += showEvs.map(ev => {
      const uid = String(ev.uid || '');
      const mk = uid && typeof createTaskFromCalEvent === 'function'
        ? `<button type="button" class="cal-ev-mk-task" title="Create task from this event" aria-label="Create task from event" data-action="createTaskFromCalEvent" data-args='${JSON.stringify([String(ev.feedId), uid])}'>+Task</button>`
        : '';
      return `<div class="cal-task cal-feed-event" data-feed-color="${escAttr(sanitizeListColor(ev.feedColor))}" title="${esc(ev.feedLabel)}: ${esc(ev.title)}${ev.time?' at '+esc(String(ev.time)):''}${ev.location?' — '+esc(ev.location):''}">`
        + mk
        + (ev.time ? `<span class="cal-feed-time">${esc(ev.time)}</span> ` : '')
        + esc(ev.title)
        + '</div>';
    }).join('');
  }
  const taskN=arr?arr.length:0;
  const feedN=feedEvents.length;
  if(taskN||feedN){
    html+='<span class="cal-day-count" title="'+taskN+' tasks, '+feedN+' events">'+taskN+'·'+feedN+'</span>';
  }
  // "+N more" indicator if we truncated
  const totalCount = (arr ? arr.length : 0) + feedEvents.length;
  const shownCount = Math.min(arr ? arr.length : 0, 2) + Math.min(feedEvents.length, 2);
  if(totalCount > shownCount){
    html += '<button type="button" class="cal-task-more" data-date="'+escAttr(isoDate)+'">+'+(totalCount-shownCount)+' more</button>';
  }
  return html;
}
function calNav(dir){
  const now=_calMonthAnchor();
  now.setMonth(now.getMonth()+dir);
  calMonth=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');
  renderTaskList();
}
function calToday(){
  calMonth=null;
  _calFocusDate=(typeof todayISO==='function')?todayISO():null;
  window._calSelectedDate=_calFocusDate;
  renderTaskList();
}
window.calNav=calNav;
window.calToday=calToday;

// ========== COMMAND PALETTE (Cmd+K) ==========
let cmdkActiveIdx=0,cmdkFilteredItems=[];
function openCmdK(){
  const ov=gid('cmdkOverlay');if(!ov)return;
  // Render content BEFORE delegating to Modal so the panel is fully built
  // by the time the open transition runs (no mid-fade DOM growth).
  _applyCmdkMode();
  const inp=gid('cmdkInput');
  if(inp)inp.value='';
  cmdkActiveIdx=0;renderCmdK();
  // Modal utility owns prev-focus capture/restore, ESC, and Tab-trap.
  // skipInitialFocus + focus:'#cmdkInput' = the trap watches Tab but we
  // pick the focus target ourselves (the input, not the first focusable).
  Modal.open('cmdkOverlay', { variant:'palette', focus:'#cmdkInput', skipInitialFocus:true });
}
function closeCmdK(){
  Modal.close('cmdkOverlay');
}
function _cmdkTouchOrNarrowUI(){
  return typeof matchMedia==='function' && (matchMedia('(max-width: 640px)').matches || matchMedia('(pointer: coarse)').matches);
}
function _syncCmdkFindHint(){
  const h=gid('cmdkFindHint');
  if(!h)return;
  h.hidden=!_cmdkTouchOrNarrowUI();
}
function _applyCmdkMode(){
  const input=gid('cmdkInput');
  if(input) input.placeholder='Search tasks, actions, views…';
  _syncCmdkFindHint();
}
function _cmdkFootFindText(){
  const foot=gid('cmdkFoot');if(!foot)return;
  if(_cmdkTouchOrNarrowUI()){
    foot.textContent='Tap a row to run · outside = close';
  }else{
    const mod=/(Mac|iPhone|iPod|iPad)/i.test(navigator.platform||'')?'⌘':'Ctrl';
    foot.textContent=mod+'/Ctrl+K · ↑↓ · Enter · Esc';
  }
}
function renderCmdK(){
  const rawInput=gid('cmdkInput');
  const rawVal=rawInput?rawInput.value:'';
  const q=rawVal.toLowerCase().trim();
  const results=gid('cmdkResults');
  const ic=(n)=>(typeof window.icon==='function'?window.icon(n):'');
  const navActions=[
    {type:'action',label:'Go to Tasks',icon:ic('list'),kbd:'1',run:()=>showTab('tasks')},
    {type:'action',label:'Go to Timer',icon:ic('timer'),kbd:'2',run:()=>showTab('focus')},
    {type:'action',label:'Go to Tools',icon:ic('toolSparkle'),kbd:'3',run:()=>showTab('tools')},
    {type:'action',label:'Go to Data',icon:ic('database'),kbd:'4',run:()=>showTab('data')},
    {type:'action',label:'Go to Settings',icon:ic('gear'),kbd:'5',run:()=>showTab('settings')},
    {type:'action',label:'Inbox view (untriaged)',icon:ic('inbox'),run:()=>{showTab('tasks');setSmartView('inbox')}},
    {type:'action',label:'Today view',icon:ic('calendar'),run:()=>{showTab('tasks');setSmartView('today')}},
    {type:'action',label:'Overdue view',icon:ic('alertTriangle'),run:()=>{showTab('tasks');setSmartView('overdue')}},
    {type:'action',label:'Starred view',icon:ic('star'),run:()=>{showTab('tasks');setSmartView('starred')}},
    {type:'action',label:'Waiting view (blocked on others)',icon:ic('hourglass'),run:()=>{showTab('tasks');setSmartView('waiting')}},
    {type:'action',label:'Stuck view (untouched 14+ days)',icon:ic('alertCircle'),run:()=>{showTab('tasks');setSmartView('stuck')}},
    {type:'action',label:'Snoozed view (hidden until a date)',icon:ic('moon'),run:()=>{showTab('tasks');setSmartView('snoozed')}},
    {type:'action',label:'Habits view (recurring tasks)',icon:ic('refresh'),run:()=>{showTab('tasks');setSmartView('habits')}},
    {type:'action',label:'Impact view (Pareto 80/20)',icon:ic('zap'),run:()=>{showTab('tasks');setSmartView('impact')}},
    {type:'action',label:'Sort by Impact (Pareto)',icon:ic('zap'),run:()=>{showTab('tasks');const s=gid('taskSortSel');if(s){s.value='impact';if(typeof updateTaskFilters==='function')updateTaskFilters()}}},
    {type:'action',label:'List view',icon:ic('list'),run:()=>{showTab('tasks');setTaskView('list')}},
    {type:'action',label:'Board view',icon:ic('grid'),run:()=>{showTab('tasks');setTaskView('board')}},
    {type:'action',label:'Calendar view',icon:ic('calendar'),run:()=>{showTab('tasks');setTaskView('calendar')}},
    {type:'action',label:'Toggle theme',icon:ic('moon'),run:()=>toggleTheme()},
    {type:'action',label:'Focus-on-list mode (hide other lists)',icon:ic('folder'),run:()=>toggleFocusListMode()},
    {type:'action',label:(isBulkMode()?'Exit bulk-edit mode':'Bulk-edit mode (multi-select)'),icon:ic('check'),run:()=>toggleBulkMode()},
    {type:'action',label:((typeof isReorderMode==='function'&&isReorderMode())?'Exit reorder mode':'Reorder mode (move & indent tasks)'),icon:ic('list'),run:()=>{showTab('tasks');if(typeof toggleReorderMode==='function')toggleReorderMode()}},
    {type:'action',label:'Save current view…',icon:ic('star'),run:()=>savePerspectivePrompt()},
    {type:'action',label:'Suggest due date for open task',icon:ic('calendar'),run:()=>suggestDueDateForTask()},
    {type:'action',label:'Snooze open task — 1 day',icon:ic('moon'),run:()=>{ if(editingTaskId!=null) snoozeTaskForDays(editingTaskId,1); else if(typeof showExportToast==='function') showExportToast('Open a task first.') }},
    {type:'action',label:'Snooze open task — 3 days',icon:ic('moon'),run:()=>{ if(editingTaskId!=null) snoozeTaskForDays(editingTaskId,3); else if(typeof showExportToast==='function') showExportToast('Open a task first.') }},
    {type:'action',label:'Snooze open task — 1 week',icon:ic('moon'),run:()=>{ if(editingTaskId!=null) snoozeTaskForDays(editingTaskId,7); else if(typeof showExportToast==='function') showExportToast('Open a task first.') }},
    {type:'action',label:'Unsnooze open task',icon:ic('refresh'),run:()=>{ if(editingTaskId!=null) unsnoozeTask(editingTaskId); else if(typeof showExportToast==='function') showExportToast('Open a task first.') }},
    {type:'action',label:'Manage saved views (perspectives)',icon:ic('star'),run:()=>showManagePerspectivesCard()},
    {type:'action',label:'Render markdown in open task description',icon:ic('book'),run:()=>{ if(typeof toggleDescriptionRender==='function') toggleDescriptionRender(); }},
    {type:'action',label:'Export open task as Markdown',icon:ic('clipboard'),run:()=>{ if(editingTaskId!=null) exportSingleTaskAsMarkdown(editingTaskId); else if(typeof showExportToast==='function') showExportToast('Open a task first.') }},
    {type:'action',label:'Save open task as template',icon:ic('clipboard'),run:()=>saveCurrentTaskAsTemplate()},
    {type:'action',label:'Apply task template…',icon:ic('clipboard'),run:()=>showApplyTemplateCard()},
    {type:'action',label:'Start focus timer',icon:ic('play'),run:()=>{showTab('focus');if(!running)startTimer()}},
    {type:'action',label:'Add new list',icon:ic('plus'),run:()=>{showTab('tasks');addList()}},
    {type:'action',label:'Harmonize all fields (embeddings)',icon:ic('harmonize'),run:()=>{showTab('tools');if(typeof intelHarmonizeFields==='function')intelHarmonizeFields()}},
    {type:'action',label:'Find duplicate tasks',icon:ic('copy'),run:()=>{showTab('tools');if(typeof intelFindDuplicatesUI==='function')intelFindDuplicatesUI()}},
    {type:'action',label:'Toggle semantic search',icon:ic('search'),run:()=>{showTab('tasks');if(typeof isIntelReady !== 'function' || !isIntelReady()){if(typeof syncHeaderAIChip === 'function') syncHeaderAIChip('error', 'Load model first — open Tools');showTab('tools');return}const cb=gid('taskSearchSemantic');if(cb){cb.checked=!cb.checked;if(typeof toggleTaskSearchSemantic==='function')toggleTaskSearchSemantic()}}},
  ];
  const items=[];
  // Append saved perspectives dynamically
  if(typeof cfg === 'object' && cfg && Array.isArray(cfg.perspectives)){
    cfg.perspectives.forEach(p => {
      if(!p || !p.name) return;
      const label = 'View: ' + p.name;
      navActions.push({ type:'action', label, icon: ic('star'), run: () => applyPerspective(p.name) });
    });
  }
  const matchedNav=q?navActions.filter(a=>a.label.toLowerCase().includes(q)):navActions;
  if(matchedNav.length){items.push({section:'Actions'});matchedNav.forEach(a=>items.push(a))}
  // Match tasks. Search includes name, description, AND tags so a quick-add
  // like `#errands` finds anything tagged. The same operator syntax used in
  // the task search bar (tag: / list: / is: / priority: / due: / status:)
  // works here too, so a power-user can type "is:overdue priority:high" in
  // Cmd+K and see exactly that slice.
  const parsedQ = (typeof parseTaskSearchQuery === 'function') ? parseTaskSearchQuery(rawVal) : { text: q, ops: null };
  const freeText = parsedQ.text || '';
  const qOps = parsedQ.ops;
  const _matchOps = (t) => {
    if(!qOps) return true;
    if(qOps.tag && qOps.tag.length){
      const tt = (t.tags || []).map(x => String(x).toLowerCase());
      if(!qOps.tag.every(w => tt.includes(w))) return false;
    }
    if(qOps.priority && qOps.priority.length && !qOps.priority.includes(String(t.priority || 'none').toLowerCase())) return false;
    if(qOps.status   && qOps.status.length   && !qOps.status.includes(String(t.status   || 'open').toLowerCase())) return false;
    if(qOps.list && qOps.list.length){
      const l = (typeof lists !== 'undefined' && Array.isArray(lists)) ? lists.find(x => x.id === t.listId) : null;
      const name = l ? String(l.name || '').toLowerCase() : '';
      if(!qOps.list.some(w => name === w || name.includes(w))) return false;
    }
    if(qOps.is && qOps.is.length){
      const today = (typeof todayISO==='function') ? todayISO() : '';
      const matchOne = (w) => {
        if(w==='overdue')  return !!t.dueDate && t.dueDate < today && t.status !== 'done';
        if(w==='today')    return t.dueDate === today;
        if(w==='done')     return t.status === 'done';
        if(w==='open')     return t.status !== 'done';
        if(w==='starred')  return !!t.starred;
        if(w==='recurring' || w==='habit') return !!t.recur;
        return false;
      };
      if(!qOps.is.every(matchOne)) return false;
    }
    return true;
  };
  const matchTask = (t) => {
    if(!_matchOps(t)) return false;
    if(!freeText) return true;
    if(t.name.toLowerCase().includes(freeText)) return true;
    if((t.description||'').toLowerCase().includes(freeText)) return true;
    if(Array.isArray(t.tags) && t.tags.some(tg => String(tg).toLowerCase().includes(freeText))) return true;
    return false;
  };
  // Show task hits when the user typed free text OR any operator. Operators
  // alone (e.g. `is:overdue`) should produce results — the legacy `if(q)`
  // gate suppressed those.
  const hasOps = !!(qOps && (qOps.tag.length||qOps.list.length||qOps.is.length||qOps.priority.length||qOps.due.length||qOps.status.length));
  const shouldShowTasks = !!freeText || hasOps;
  const activeMatches = tasks.filter(t => !t.archived && t.status !== 'done' && matchTask(t)).slice(0, 12);
  if(shouldShowTasks && activeMatches.length){
    items.push({section:'Tasks'});
    activeMatches.forEach(t=>items.push({type:'task',label:t.name,icon:t.status==='done'?'✓':'○',desc:(t.dueDate?fmtDue(t.dueDate):'')||getTaskPath(t.id).slice(0,-1).join(' › '),run:()=>{showTab('tasks');openTaskDetail(t.id)}}));
  }
  const doneMatches = tasks.filter(t => t.status === 'done' && matchTask(t)).slice(0, 6);
  if(shouldShowTasks && doneMatches.length){
    items.push({section:'Completed'});
    doneMatches.forEach(t=>items.push({type:'task',label:t.name,icon:'✓',desc:'done',run:()=>{
      // Switching to the matching smart view so the user can see the task in
      // context instead of just opening it in isolation. rAF instead of an
      // arbitrary 60ms timer so slow phones don't race the modal open
      // ahead of the list paint, and re-resolve the task by id so a
      // cross-tab sync between click and open doesn't open a stale row.
      const taskId = t.id;
      showTab('tasks');
      if(typeof setSmartView==='function') setSmartView('completed');
      requestAnimationFrame(() => {
        const fresh = (typeof findTask === 'function') ? findTask(taskId) : null;
        if(!fresh) return;
        if(typeof openTaskDetail==='function') openTaskDetail(taskId);
      });
    }}));
  }
  // Match lists by name.
  if(q && typeof lists !== 'undefined' && Array.isArray(lists)){
    const listMatches = lists.filter(l => l && (l.name||'').toLowerCase().includes(q)).slice(0, 6);
    if(listMatches.length){
      items.push({section:'Lists'});
      listMatches.forEach(l => items.push({
        type:'action', label:'Open list: '+l.name, icon: ic('folder'),
        run: () => { showTab('tasks'); if(typeof switchList==='function') switchList(l.id); }
      }));
    }
  }
  // Settings index — when the user types a setting-y keyword, surface a jump
  // straight to the Settings tab. Cheap and dramatically improves
  // findability vs. scrolling the long flat settings panel.
  if(q){
    // Each entry: [keywords, label, target-section-id]. The id lets the
    // command palette jump straight into the matching Settings section
    // instead of just landing the user on the (long, flat) Settings tab.
    const settingsIndex = [
      ['theme dark light',                  'Theme (dark / light)',          'set-general'],
      ['sound chime audio',                 'Sound & chimes',                'set-general'],
      ['notification permission',           'Notifications',                 'set-general'],
      ['ai embedding model download',       'AI / on-device model',          'set-integrations'],
      ['sync peer p2p webrtc',              'Sync (peer-to-peer)',           'set-integrations'],
      ['export import backup csv json ical','Data export / import',          'set-about'],
      ['encrypt password',                  'Encrypted backup',              'set-about'],
      ['calendar feed ics ical',            'Calendar feeds',                'set-integrations'],
      ['category classification',           'Categories',                    'set-classifications'],
      ['list project',                      'Lists / projects',              'set-lists'],
      ['phase preset pomodoro work break',  'Pomodoro presets',              'set-general'],
      ['install pwa app',                   'Install as App',                'set-about'],
      ['storage quota system info',         'System info / storage',         'set-about'],
    ];
    const settingsHits = settingsIndex.filter(([keys]) => keys.split(' ').some(k => k.startsWith(q)) || keys.includes(q)).slice(0, 6);
    if(settingsHits.length){
      items.push({section:'Settings'});
      settingsHits.forEach(([, label, target]) => items.push({
        type:'action', label:'Go to: '+label, icon: ic('gear'),
        run: () => {
          showTab('settings');
          // requestAnimationFrame so the tab swap lands before we measure.
          requestAnimationFrame(() => {
            if(typeof jumpToSettingsSection === 'function') jumpToSettingsSection(target);
          });
        }
      }));
    }
  }
  cmdkFilteredItems=items.filter(i=>!i.section);
  if(cmdkActiveIdx>=cmdkFilteredItems.length)cmdkActiveIdx=Math.max(0,cmdkFilteredItems.length-1);
  _cmdkFootFindText();
  if(!items.length){results.textContent='';const emp=document.createElement('div');emp.className='cmdk-empty';emp.textContent='No matches';results.appendChild(emp);return}
  let itemIdx=0;
  results.innerHTML=items.map(i=>{
    if(i.section)return '<div class="cmdk-section">'+i.section+'</div>';
    const active=itemIdx===cmdkActiveIdx;
    const cur=itemIdx++;
    const kbd=i.kbd?'<span class="cmdk-kbd">'+i.kbd+'</span>':(i.desc?'<span class="cmdk-desc">'+esc(i.desc)+'</span>':'');
    return '<div class="cmdk-item'+(active?' active':'')+'" data-idx="'+cur+'" data-action="cmdkRun" data-arg="'+cur+'"><span class="cmdk-icon">'+i.icon+'</span><span>'+esc(i.label)+'</span>'+kbd+'</div>';
  }).join('');
}
function cmdkRun(idx){
  const item=cmdkFilteredItems[idx];if(!item||!item.run)return;
  closeCmdK();setTimeout(()=>item.run(),50);
}
function cmdkKeydown(e){
  if(e.key==='Escape'){closeCmdK();return}
  if(e.key==='ArrowDown'){e.preventDefault();cmdkActiveIdx=Math.min(cmdkActiveIdx+1,cmdkFilteredItems.length-1);renderCmdK()}
  else if(e.key==='ArrowUp'){e.preventDefault();cmdkActiveIdx=Math.max(cmdkActiveIdx-1,0);renderCmdK()}
  else if(e.key==='Enter'){e.preventDefault();cmdkRun(cmdkActiveIdx)}
}
function _blockingOverlaysForCmdK(){
  const wno = document.getElementById('whatNextOverlay');
  if(wno && wno.classList.contains('open')) return true;
  const tm = document.getElementById('taskModal');
  if(tm && tm.classList.contains('open')) return true;
  if(document.getElementById('bulkImportModal')?.classList.contains('open')) return true;
  if(document.getElementById('appConfirmModal')?.classList.contains('open')) return true;
  if(document.getElementById('appPromptModal')?.classList.contains('open')) return true;
  return false;
}
// Keyboard shortcut: Cmd+K / Ctrl+K
document.addEventListener('keydown',e=>{
  if((e.ctrlKey||e.metaKey)&&(e.key==='k'||e.key==='K')){
    if(_blockingOverlaysForCmdK()) return;
    e.preventDefault();
    openCmdK();
  }
});

// ── Extended undo stack ─────────────────────────────────────────────────────
// The action-toast button only lives ~4s. Anything beyond that — and any
// action that finished without a toast — was previously irrecoverable. We
// also push every undoable action into a small ring buffer (depth 10, ~30s
// per entry) that Cmd+Z drains in LIFO order. The toast button still runs
// the same undo function, but it's no longer the only path.
const _UNDO_RING_MAX = 10;
const _UNDO_TTL_MS = 60_000;
const _undoRing = [];
function _pruneUndoRing(){
  const cutoff = Date.now() - _UNDO_TTL_MS;
  while(_undoRing.length && _undoRing[0].ts < cutoff) _undoRing.shift();
  while(_undoRing.length > _UNDO_RING_MAX) _undoRing.shift();
}
function pushUndo(label, undoFn){
  if(typeof undoFn !== 'function') return;
  _undoRing.push({ ts: Date.now(), label: String(label || 'Last action'), fn: undoFn });
  _pruneUndoRing();
}
function popUndo(){
  _pruneUndoRing();
  return _undoRing.pop() || null;
}
window.pushUndo = pushUndo;
window.popUndo = popUndo;

// Keyboard shortcut: Ctrl+Z / Cmd+Z — undo the last action. Falls back to the
// extended ring buffer when there's no live action-toast to click.
document.addEventListener('keydown',(e)=>{
  if((e.ctrlKey||e.metaKey)&&e.key==='z'&&!e.shiftKey){
    const active=document.activeElement;
    const tag=active?active.tagName.toLowerCase():'';
    // Don't intercept undo in text inputs/textareas (they handle Ctrl+Z natively)
    if(tag!=='input'&&tag!=='textarea'&&tag!=='select'){
      const toast=document.getElementById('actionToast');
      const btn=toast?.querySelector('.action-toast-btn');
      if(btn&&toast?.classList?.contains('show')){
        e.preventDefault();
        btn.click();
        return;
      }
      // Toast already vanished — fall back to the ring buffer.
      const entry = popUndo();
      if(entry){
        e.preventDefault();
        try{ entry.fn(); }catch(err){ console.warn('[undo] failed', err); }
        if(typeof showExportToast === 'function') showExportToast('Undone: ' + entry.label);
      }
    }
  }
},true);

// Global shortcut: Cmd/Ctrl+N (or plain "n" when not focused in a field) →
// jump to Tasks and focus the new-task input. Matches the muscle memory from
// Todoist/Things/Notion — quick-capture from any tab without scrolling.
document.addEventListener('keydown',(e)=>{
  if(_blockingOverlaysForCmdK && _blockingOverlaysForCmdK()) return;
  const active = document.activeElement;
  const tag = active ? active.tagName.toLowerCase() : '';
  const inField = (tag==='input' || tag==='textarea' || tag==='select' || (active && active.isContentEditable));
  const isMeta = (e.ctrlKey || e.metaKey);
  const isShortcut = (isMeta && (e.key==='n' || e.key==='N')) || (!inField && !isMeta && (e.key==='n' || e.key==='N') && !e.altKey && !e.shiftKey);
  if(!isShortcut) return;
  // Skip native "new window" only when the meta-N combo would conflict — but
  // Cmd+N is browser-level "new window" so we must require the focus to NOT
  // be in a field AND the user to be in the app's primary surface.
  if(isMeta && tag === 'input') return;
  e.preventDefault();
  // Same path as the FAB: on mobile the add cluster lives in the bottom sheet.
  if(typeof quickAddFabClick === 'function'){ quickAddFabClick(); return; }
  if(typeof showTab === 'function') showTab('tasks');
  const inp = document.getElementById('taskInput');
  if(inp){
    try{ inp.focus(); inp.select && inp.select(); }catch(_){}
    inp.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
});

// Global shortcut: Shift+D — toggle theme. Advertised on the theme button via
// aria-keyshortcuts; wired here so the affordance isn't a lie.
document.addEventListener('keydown',(e)=>{
  if(!e.shiftKey) return;
  if(e.ctrlKey || e.metaKey || e.altKey) return;
  if(e.key !== 'D' && e.key !== 'd') return;
  if(_blockingOverlaysForCmdK && _blockingOverlaysForCmdK()) return;
  const active = document.activeElement;
  const tag = active ? active.tagName.toLowerCase() : '';
  if(tag==='input' || tag==='textarea' || tag==='select' || (active && active.isContentEditable)) return;
  e.preventDefault();
  if(typeof toggleTheme === 'function') toggleTheme();
});

// Global shortcut: "?" (Shift+/) when not in a field → show the keyboard
// shortcuts cheatsheet. Discoverability: today shortcuts are scattered
// across the codebase and there's no one place to learn them.
document.addEventListener('keydown',(e)=>{
  if(e.key !== '?') return;
  if(e.ctrlKey || e.metaKey || e.altKey) return;
  if(_blockingOverlaysForCmdK && _blockingOverlaysForCmdK()) return;
  const active = document.activeElement;
  const tag = active ? active.tagName.toLowerCase() : '';
  if(tag==='input' || tag==='textarea' || tag==='select' || (active && active.isContentEditable)) return;
  e.preventDefault();
  if(typeof showShortcutsHelp === 'function') showShortcutsHelp();
});

function showShortcutsHelp(){
  const groups = [
    { title: 'Navigation', items: [
      ['Ctrl/⌘ + K', 'Open command palette (find tasks, run actions)'],
      ['Ctrl/⌘ + N or N', 'Focus the new-task input (jumps to Tasks)'],
      ['1 – 5', 'Switch top-level tab (Tasks / Timer / Tools / Data / Settings)'],
      ['Esc', 'Close any open modal / palette / sheet'],
    ]},
    { title: 'Tasks', items: [
      ['Click a row', 'Open task detail'],
      ['Click + on a task', 'Add subtask'],
      ['Long-press a task (touch)', 'Enter bulk-edit mode'],
      ['Click the status pill', 'Cycle Open → In Progress → Review → Blocked → Done'],
      ['Paste multiple lines', 'Bulk-import preview'],
    ]},
    { title: 'Undo & feedback', items: [
      ['Ctrl/⌘ + Z', 'Undo last action (extended — works up to 60s)'],
      ['Click an action toast', 'Undo just that action'],
    ]},
    { title: 'Quick-add syntax (in task input)', items: [
      ['tomorrow / today / next mon', 'Set due date'],
      ['@urgent @high @normal @low', 'Priority'],
      ['#tag1 #tag2', 'Tags'],
      ['!star', 'Mark starred'],
      ['~daily / ~weekdays / ~weekly / ~monthly', 'Recurrence'],
    ]},
  ];
  // Build modal DOM. Reuses .modal-overlay/.modal classes so it inherits the
  // existing keyboard-inset and mobile-sheet behaviour.
  let ov = document.getElementById('shortcutsHelpOverlay');
  if(ov){ ov.classList.add('open'); return; }
  ov = document.createElement('div');
  ov.id = 'shortcutsHelpOverlay';
  ov.className = 'modal-overlay';
  const close = () => { ov.classList.remove('open'); setTimeout(() => ov.remove(), 200); };
  ov.addEventListener('click', (e) => { if(e.target === ov) close(); });
  const m = document.createElement('div');
  m.className = 'modal shortcuts-help-modal';
  const head = document.createElement('div');
  head.className = 'modal-head';
  const h = document.createElement('strong');
  h.textContent = 'Keyboard shortcuts';
  head.appendChild(h);
  const x = document.createElement('button');
  x.className = 'modal-close';
  x.textContent = '×';
  x.title = 'Close';
  x.setAttribute('aria-label', 'Close shortcuts help');
  x.onclick = close;
  head.appendChild(x);
  const body = document.createElement('div');
  body.className = 'modal-body shortcuts-help-body';
  for(const g of groups){
    const sec = document.createElement('div');
    const st = document.createElement('div');
    st.className = 'shortcuts-help-group-title';
    st.textContent = g.title;
    sec.appendChild(st);
    const tbl = document.createElement('div');
    tbl.className = 'shortcuts-help-grid';
    for(const [k, v] of g.items){
      const kEl = document.createElement('kbd');
      kEl.className = 'shortcuts-help-kbd';
      kEl.textContent = k;
      const vEl = document.createElement('span');
      vEl.className = 'shortcuts-help-val';
      vEl.textContent = v;
      tbl.appendChild(kEl);
      tbl.appendChild(vEl);
    }
    sec.appendChild(tbl);
    body.appendChild(sec);
  }
  m.appendChild(head); m.appendChild(body);
  ov.appendChild(m);
  document.body.appendChild(ov);
  requestAnimationFrame(() => ov.classList.add('open'));
  // Esc closes.
  const onKey = (e) => { if(e.key === 'Escape'){ close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
}
window.showShortcutsHelp = showShortcutsHelp;

// Quick-add syntax cheatsheet — anchored from the "?" button next to the
// task input. Smaller surface than showShortcutsHelp (single subject, no
// app-wide cross-section), so we render as a popover positioned beneath
// the input rather than a modal. Click-outside / Esc dismisses.
function showQuickAddSyntaxHint(){
  const existing = document.getElementById('taskSyntaxPopover');
  if(existing){ existing.remove(); return; }
  const anchor = document.getElementById('taskSyntaxHintBtn');
  const input = document.getElementById('taskInput');
  if(!anchor && !input) return;
  const pop = document.createElement('div');
  pop.id = 'taskSyntaxPopover';
  pop.className = 'task-syntax-popover';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Quick-add syntax cheatsheet');
  const items = [
    ['tomorrow / today / next mon', 'Set due date'],
    ['fri / sat / sun (next occurrence)', 'Day-of-week shortcuts'],
    ['in 3 days', 'Relative date'],
    ['@urgent / @high / @normal / @low', 'Priority'],
    ['#tag1 #tag2', 'Tags (multiple allowed)'],
    ['!star', 'Mark starred'],
    ['~daily / ~weekdays / ~weekly / ~monthly', 'Recurrence'],
  ];
  const head = document.createElement('div'); head.className = 'task-syntax-popover-head';
  const h = document.createElement('strong'); h.textContent = 'Quick-add syntax';
  head.appendChild(h);
  const ex = document.createElement('button');
  ex.type = 'button'; ex.className = 'task-syntax-popover-close'; ex.textContent = '×';
  ex.setAttribute('aria-label', 'Close cheatsheet');
  ex.onclick = () => pop.remove();
  head.appendChild(ex);
  pop.appendChild(head);
  const tbl = document.createElement('div'); tbl.className = 'task-syntax-popover-tbl';
  for(const [k, v] of items){
    const kEl = document.createElement('code'); kEl.textContent = k;
    const vEl = document.createElement('span'); vEl.textContent = v;
    tbl.appendChild(kEl); tbl.appendChild(vEl);
  }
  pop.appendChild(tbl);
  const ex2 = document.createElement('div');
  ex2.className = 'task-syntax-popover-example';
  ex2.innerHTML = 'Example: <code>Buy milk tomorrow @urgent #shopping</code>';
  pop.appendChild(ex2);
  document.body.appendChild(pop);
  // Anchor positioning — beneath the input, right-aligned to its trailing edge
  // so the "?" button reads as the source. requestAnimationFrame so the
  // popover dimensions are known before we measure.
  requestAnimationFrame(() => {
    const r = (input || anchor).getBoundingClientRect();
    const pw = pop.offsetWidth;
    const vw = window.innerWidth;
    let left = Math.min(r.right - pw, vw - pw - 8);
    if(left < 8) left = 8;
    pop.style.left = left + 'px';
    pop.style.top = (r.bottom + window.scrollY + 6) + 'px';
  });
  // Outside-click + Esc close.
  const off = (e) => {
    if(!pop.contains(e.target) && e.target !== anchor){
      pop.remove();
      document.removeEventListener('mousedown', off, true);
      document.removeEventListener('keydown', onKey, true);
    }
  };
  const onKey = (e) => { if(e.key === 'Escape'){ pop.remove(); document.removeEventListener('keydown', onKey, true); document.removeEventListener('mousedown', off, true); } };
  setTimeout(() => {
    document.addEventListener('mousedown', off, true);
    document.addEventListener('keydown', onKey, true);
  }, 50);
}
window.showQuickAddSyntaxHint = showQuickAddSyntaxHint;

// ========== THEME TOGGLE ==========
// Manual toggle wins over OS preference: once the user picks a theme it sticks
// across reloads (persisted in localStorage). The OS auto-apply only takes
// effect for users who haven't explicitly chosen yet.
const _THEME_MANUAL_KEY = 'stupind_theme_manual';
function _isThemeManual(){
  try{ return localStorage.getItem(_THEME_MANUAL_KEY) === '1'; }catch(_){ return false; }
}
// ── Settings navigation: jump-links + inline filter ────────────────────────
// Click a jump-link → expand the section, scroll into view (accounting for
// the sticky nav bar's height), and mark the link active. Settings filter
// hides rows whose label text doesn't match the query so a user can type
// "notif" and only see notification-related controls across all sections.

function _setNavBarHeight(){
  const bar = document.querySelector('.set-nav');
  return bar ? bar.getBoundingClientRect().height : 0;
}
function _setActiveJumpLink(id){
  document.querySelectorAll('.set-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.arg === id);
  });
}
function jumpToSettingsSection(id){
  const sec = document.getElementById(id);
  if(!sec) return;
  // Open the details so the body is in the layout flow before we measure
  // scroll target. Settings sections are <details>; setting `open` is the
  // canonical disclosure operation and triggers our ontoggle handlers.
  try{ sec.open = true; }catch(_){}
  _setActiveJumpLink(id);
  // requestAnimationFrame lets the open-state layout settle so getBoundingClientRect
  // returns the post-expansion position instead of the closed-collapsed one.
  requestAnimationFrame(() => {
    const rect = sec.getBoundingClientRect();
    const offset = _setNavBarHeight() + 8;
    const top = window.scrollY + rect.top - offset;
    window.scrollTo({ top, behavior: 'smooth' });
  });
}
window.jumpToSettingsSection = jumpToSettingsSection;

// Filter every .srow by its label text (and a few sibling fragments). Hides
// the row when nothing matches; hides the whole section when none of its
// rows match. Empty query restores everything. Survives across re-renders
// of the dynamic sub-panels (classifications, lists, sync, AI) by being
// called once after each render via the document.querySelectorAll sweep.
let _settingsFilterRaf = null;
function filterSettingsRows(){
  if(_settingsFilterRaf) cancelAnimationFrame(_settingsFilterRaf);
  _settingsFilterRaf = requestAnimationFrame(_filterSettingsRowsImmediate);
}
function _filterSettingsRowsImmediate(){
  _settingsFilterRaf = null;
  const inp = document.getElementById('settingsFilter');
  const clr = document.getElementById('settingsFilterClear');
  const q = inp ? inp.value.trim().toLowerCase() : '';
  if(clr) clr.hidden = !q;
  const sections = document.querySelectorAll('#settingsBody .set-section');
  sections.forEach(sec => {
    if(!q){
      sec.classList.remove('set-section--hidden');
      sec.querySelectorAll('.srow').forEach(r => {
        r.classList.remove('srow--filter-hidden');
        r.classList.remove('srow--filter-match');
      });
      return;
    }
    // Auto-open the section so matches are visible without manual expansion.
    try{ sec.open = true; }catch(_){}
    let anyMatch = false;
    sec.querySelectorAll('.srow').forEach(row => {
      const txt = row.textContent.toLowerCase();
      const hit = txt.includes(q);
      row.classList.toggle('srow--filter-hidden', !hit);
      row.classList.toggle('srow--filter-match', hit);
      if(hit) anyMatch = true;
    });
    // Some sections embed dynamic non-.srow content (classification manager,
    // lists manager, sync panel, AI settings). Treat the section-body's
    // textContent as a fallback so a hit on "category labels" or "peer code"
    // still surfaces the relevant section even without .srow markup.
    if(!anyMatch){
      const body = sec.querySelector('.set-section-body');
      if(body && body.textContent.toLowerCase().includes(q)) anyMatch = true;
    }
    sec.classList.toggle('set-section--hidden', !anyMatch);
  });
}
function clearSettingsFilter(){
  const inp = document.getElementById('settingsFilter');
  if(inp){ inp.value = ''; }
  filterSettingsRows();
  if(inp) inp.focus();
}
window.filterSettingsRows = filterSettingsRows;
window.clearSettingsFilter = clearSettingsFilter;

// When a settings section is opened/closed manually (without a jump-link
// click) — and when the user scrolls Settings — keep the active jump-link
// in sync with the section currently in view. Helps the user track where
// they are in a long Settings page without re-scanning the buttons.
(function setupSettingsScrollSpy(){
  if(typeof window === 'undefined' || !('IntersectionObserver' in window)) return;
  // Wait for DOMContentLoaded so #settingsBody exists.
  const wire = () => {
    const sections = document.querySelectorAll('#settingsBody .set-section');
    if(!sections.length) return;
    const observer = new IntersectionObserver((entries) => {
      // Only one section is "active" at a time — the topmost intersecting one.
      const visible = entries
        .filter(e => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if(visible.length){
        _setActiveJumpLink(visible[0].target.id);
      }
    }, { rootMargin: '-80px 0px -60% 0px', threshold: 0 });
    sections.forEach(s => observer.observe(s));
  };
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();

function toggleTheme(){
  theme=theme==='dark'?'light':'dark';
  try{ localStorage.setItem(_THEME_MANUAL_KEY, '1'); }catch(_){}
  applyTheme();saveState('user');
}
function applyTheme(){
  document.body.classList.toggle('light-theme',theme==='light');
  // Theme-toggle glyph: SVG icon via the project icon system (no emoji — the
  // U+1F319 moon and U+2600 sun glyphs fall back to ✱ on Windows in many
  // sans-serif stacks, hiding the affordance entirely).
  const btn=gid('themeToggleBtn');
  if(btn){
    const span = btn.querySelector('[data-icon]');
    if(span){
      span.setAttribute('data-icon', theme==='dark' ? 'moon' : 'sun');
      span.textContent = '';
      span.__iconHydrated = false;
      if(typeof window.hydrateIcons === 'function') window.hydrateIcons(btn);
    }else{
      btn.textContent = theme==='dark' ? '🌙' : '☀';
    }
  }
  const meta=document.querySelector('meta[name="theme-color"]');
  if(meta){
    const c=getComputedStyle(document.body).getPropertyValue('--bg-0').trim();
    if(c) meta.setAttribute('content',c);
  }
}
// Sync to OS preference on load, but only when the user hasn't made a manual
// choice. matchMedia listener also tracks runtime OS-theme changes.
(function _syncThemeToOS(){
  try{
    const mq = matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      if(_isThemeManual()) return;
      const want = mq.matches ? 'light' : 'dark';
      if(theme !== want){ theme = want; applyTheme(); }
    };
    if(typeof mq.addEventListener === 'function') mq.addEventListener('change', apply);
    else if(typeof mq.addListener === 'function') mq.addListener(apply);
    // Defer the initial sync until after saveState's restore pass has set the
    // persisted theme value, otherwise we'd overwrite the user's prior choice.
    setTimeout(apply, 100);
  }catch(_){}
})();
function hasVisibleDescendant(taskId,visibleSet){
  return getTaskDescendantIds(taskId).some(id=>visibleSet.has(id))
}

/** Compute the set of list IDs that still own at least one non-archived, non-done
 *  task. Scans the full task array once — intended to be called by renderTaskList
 *  and cached on window._listsWithTasksCache for the duration of one render. */
function _computeListsWithTasks(){
  const s=new Set();
  for(const x of tasks){ if(!x.archived && x.status!=='done') s.add(x.listId); }
  window._listsWithTasksCache=s;
  return s;
}

function renderTaskItem(t,depth){
  const list=gid('taskList');
  const isActive=activeTaskId===t.id;
  const rolledTime=getRolledUpTime(t.id);
  const kids=hasChildren(t.id);
  const isDone=t.status==='done';
  const dueCls=getDueClass(t.dueDate);
  const d=document.createElement('div');
  d.className='task-item clickable'
    +(isActive?' active-task task-item--tracking':'')
    +(kids?' has-children':'')
    +(depth>0?' depth-'+Math.min(depth,4):'')
    +(isDone?' completed':'')
    +(dueCls==='overdue'&&!isDone?' overdue':'')
    +(t.starred?' starred-task':'');
  if(smartView==='impact'&&typeof isParetoTop==='function'&&isParetoTop(t.id))d.classList.add('task-item--pareto');
  d.dataset.priority=(!t.starred&&t.priority&&t.priority!=='none')?t.priority:'';
  d.style.marginLeft=(depth*18)+'px';
  // Reorder is now handled by Sortable.js (see _initTaskListSortable below).
  // Native draggable=true would double-fire and conflict with Sortable's
  // synthetic touch path on iOS, so we don't set it here anymore. The drop
  // target on calendar days (.cal-day) keeps its own native handlers — that
  // surface accepts a drop from a Sortable item without further config since
  // Sortable falls back to native dragstart on desktop.
  d.dataset.taskId=t.id;
  if(t.category&&dueCls!=='overdue'&&typeof getCategoryDef==='function'){
    const cdef=getCategoryDef(t.category);
    if(cdef&&cdef.color){
      d.classList.add('task-cat-stripe');
      d.setAttribute('data-cat-id', t.category);
    }
  }
  if(window._lastAddedTaskId===t.id){
    d.classList.add('task-item--enter');
    window._lastAddedTaskId=null;
    requestAnimationFrame(()=>{try{d.scrollIntoView({block:'nearest',behavior:'smooth'})}catch(_){}});
  }
  // A keyboard reorder/indent rebuilds the list and drops focus. Restore it to
  // the moved row so arrow/Tab sequences chain without re-grabbing the mouse.
  if(window._refocusTaskId===t.id){
    window._refocusTaskId=null;
    requestAnimationFrame(()=>{try{d.focus();d.scrollIntoView({block:'nearest'})}catch(_){}});
  }
  // Per-task ondragstart/over/leave/drop handlers were removed in the
  // Sortable migration. The container-level Sortable instance now owns
  // reorder; .drop-above/.drop-below visual hints are no longer used because
  // Sortable provides its own ghost/placeholder.
  d.onclick=function(e){
    if(e.target.closest('button')||e.target.closest('.task-chevron')||e.target.closest('.drag-handle')||e.target.closest('[data-action]'))return;
    // In reorder mode the row's tap target is repurposed for the arrange
    // controls — don't open the detail modal out from under them.
    if(typeof isReorderMode === 'function' && isReorderMode()) return;
    if(typeof isBulkMode === 'function' && isBulkMode()){
      bulkToggleSelect(t.id);
      d.classList.toggle('task-bulk-selected', _bulkSelectedIds.has(t.id));
      return;
    }
    openTaskDetail(t.id)
  };
  // Keyboard a11y: the row is the primary way to open the task-detail modal.
  // Without role+tabindex+key handlers, keyboard-only users could only reach
  // the row's inner buttons (star/play/sub/×) but never the detail view.
  d.setAttribute('role', 'button');
  d.setAttribute('tabindex', '0');
  d.setAttribute('aria-label', (t.name || 'Task') + ' — Enter to open details');
  d.addEventListener('keydown', function(e){
    // Don't intercept when focus is on an inner control — those have their
    // own key handlers (e.g. Space toggles a button) and we shouldn't
    // double-fire openTaskDetail underneath them.
    if(e.target !== d) return;
    // Reorder shortcuts. Alt+↑/↓ moves among siblings (works any time so power
    // users don't need the mode); Tab/Shift+Tab indent/outdent but only while
    // Reorder mode is on, so normal focus traversal is preserved otherwise.
    if(e.altKey && e.key === 'ArrowUp'){ e.preventDefault(); if(typeof moveTaskUp==='function') moveTaskUp(t.id); return; }
    if(e.altKey && e.key === 'ArrowDown'){ e.preventDefault(); if(typeof moveTaskDown==='function') moveTaskDown(t.id); return; }
    if(e.key === 'Tab' && typeof isReorderMode === 'function' && isReorderMode()){
      e.preventDefault();
      if(e.shiftKey){ if(typeof outdentTask==='function') outdentTask(t.id); }
      else { if(typeof indentTask==='function') indentTask(t.id); }
      return;
    }
    if(e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if(typeof isReorderMode === 'function' && isReorderMode()) return;
    if(typeof isBulkMode === 'function' && isBulkMode()){
      bulkToggleSelect(t.id);
      d.classList.toggle('task-bulk-selected', _bulkSelectedIds.has(t.id));
      return;
    }
    openTaskDetail(t.id);
  });
  // Reflect prior bulk selection on re-render
  if(typeof isBulkMode === 'function' && isBulkMode() && typeof _bulkSelectedIds !== 'undefined' && _bulkSelectedIds.has(t.id)){
    d.classList.add('task-bulk-selected');
  }
  // Swipe-right-to-move + swipe-left-to-delete + long-press-to-bulk-select for
  // touch. Long-press is
  // the standard mobile gesture for "select multiple" (Files, Mail, Photos);
  // hooking it here makes bulk mode discoverable without a desktop palette.
  let touchStartX=0,touchStartY=0,touchCurrentX=0,swiping=false;
  let _longPressId=null,_longPressFired=false;
  d.addEventListener('touchstart',function(e){
    // Don't track a swipe (or long-press) when the touch begins on the drag
    // grip — that gesture belongs to Sortable's reorder, and double-handling
    // it would also fire move/delete on release. Also short-circuit when the
    // touch begins inside a horizontally-scrollable selection bar so its
    // native overflow-x scroll wins.
    if(e.target.closest('button')||e.target.closest('input')||e.target.closest('.drag-handle'))return;
    if(e.target.closest('.smart-views, .lists-bar, .tags-bar, .bulk-route-row, select, .task-action-menu'))return;
    touchStartX=e.touches[0].clientX;touchStartY=e.touches[0].clientY;swiping=false;
    _longPressFired=false;
    if(_longPressId){clearTimeout(_longPressId);_longPressId=null}
    _longPressId=setTimeout(() => {
      // Long-press only triggers when the finger hasn't moved enough to count
      // as a swipe. Enters bulk mode and selects this task as the first item.
      if(swiping) return;
      // The host element may have been detached and replaced by a fresh
      // renderTaskList between touchstart and now (any save / sync patch /
      // filter change forces a re-render). Without this guard, the timer
      // still fires on the orphan element and silently flips the user into
      // bulk mode on a task they're no longer touching, with no touchend
      // listener to clean it up.
      if(!d.isConnected) return;
      _longPressFired=true;
      haptic(20);
      if(typeof isBulkMode === 'function' && !isBulkMode() && typeof toggleBulkMode === 'function'){
        toggleBulkMode();
      }
      if(typeof bulkToggleSelect === 'function') bulkToggleSelect(t.id);
      d.classList.toggle('task-bulk-selected', _bulkSelectedIds && _bulkSelectedIds.has(t.id));
    }, 600);
  },{passive:true});
  d.addEventListener('touchmove',function(e){
    if(!touchStartX)return;
    touchCurrentX=e.touches[0].clientX;
    const dx=touchCurrentX-touchStartX,dy=e.touches[0].clientY-touchStartY;
    if(!swiping&&Math.abs(dx)>12&&Math.abs(dx)>Math.abs(dy)*1.5)swiping=true;
    // Movement cancels the long-press timer.
    if((Math.abs(dx) > 8 || Math.abs(dy) > 8) && _longPressId){
      clearTimeout(_longPressId); _longPressId = null;
    }
    if(swiping){
      if(e.cancelable)e.preventDefault();
      d.style.transform='translateX('+dx+'px)';
      d.style.transition='none';
      d.style.background=dx>0?'linear-gradient(90deg,var(--accent-bg),var(--bg-1) 80%)':'linear-gradient(90deg,var(--bg-1) 20%,var(--danger-bg))';
    }
  },{passive:false});
  d.addEventListener('touchend',function(e){
    if(_longPressId){ clearTimeout(_longPressId); _longPressId = null; }
    const dx=touchCurrentX-touchStartX;
    d.style.transition='transform .2s,background .2s';d.style.transform='';d.style.background='';
    if(_longPressFired){
      // Suppress the synthetic click that would otherwise open the detail.
      e.preventDefault && e.preventDefault();
      touchStartX=0;touchCurrentX=0;swiping=false;_longPressFired=false;
      return;
    }
    if(swiping&&Math.abs(dx)>80){
      haptic(20);
      if(dx>0){showTaskListPickerSheet(t.id)}
      else{removeTask(t.id,null)}
    }
    touchStartX=0;touchCurrentX=0;swiping=false;
  },{passive:false});
  // Defensive: if the touch is cancelled (system gesture preempted us, screen
  // recognised a long-press for context menu, etc.) the touchend handler
  // never fires and any active translateX stays applied, leaving the card
  // visually shoved off-screen. Reset on touchcancel too.
  d.addEventListener('touchcancel',function(){
    if(_longPressId){ clearTimeout(_longPressId); _longPressId = null; }
    d.style.transition='transform .2s,background .2s';
    d.style.transform='';
    d.style.background='';
    touchStartX=0;touchCurrentX=0;swiping=false;_longPressFired=false;
  },{passive:true});

  // At rest: due chip (overdue / today / soon only) + subtask progress. Habits view: ↻ + streak. Rest on hover.
  const chevron=kids
    ?'<button class="task-chevron'+(t.collapsed?' collapsed':'')+'" data-action="toggleCollapse" data-arg="'+t.id+'" title="'+(t.collapsed?'Expand':'Collapse')+'" aria-label="'+(t.collapsed?'Expand subtasks':'Collapse subtasks')+'" aria-expanded="'+(t.collapsed?'false':'true')+'">▸</button>'
    :'<span class="task-chevron-spacer"></span>';
  const habitHint=t.recur?' title="Log habit completion (stays open, next due scheduled)" aria-label="Log habit completion"':' title="'+(isDone?'Mark not done':'Mark done')+'" aria-label="'+(isDone?'Mark task as not done':'Mark task done')+'"';
  const checkbox='<button class="task-checkbox'+(isDone?' checked':'')+(t.recur?' task-checkbox--habit':'')+'" data-action="toggleTaskDoneQuick" data-arg="'+t.id+'" data-stop-prop="1"'+habitHint+' aria-pressed="'+(isDone?'true':'false')+'">'+(isDone?'✓':'')+'</button>';

  let signalChips='';
  if(t.dueDate&&!isDone){
    const du=typeof describeDue==='function'?describeDue(t.dueDate):{label:fmtDue(t.dueDate),cls:dueCls};
    if(du&&du.cls&&(du.cls==='overdue'||du.cls==='today'||du.cls==='soon')){
      signalChips+='<span class="date-chip date-chip--'+du.cls+'">'+esc(du.label)+'</span>';
    }
  }
  const prog=getSubtaskProgress(t.id);
  if(prog) signalChips+='<span class="task-sig sig-subs" title="'+prog.done+' of '+prog.total+' subtasks done" aria-label="'+prog.done+' of '+prog.total+' subtasks done">'+prog.done+'/'+prog.total+'</span>';
  if(t.recur){
    signalChips+='<span class="task-sig sig-habit" title="Habit — completing logs a cycle and schedules the next due date" aria-label="Habit">Habit</span>';
    signalChips+='<span class="task-sig sig-recur" title="Repeats '+escAttr(String(t.recur))+'" aria-label="Repeats '+escAttr(String(t.recur))+'">↻</span>';
    if(typeof getHabitStreak==='function'){
      const st=getHabitStreak(t);
      if(st>0) signalChips+='<span class="task-sig sig-streak" title="Consecutive days with a logged completion" aria-label="'+st+' day streak">'+st+'d</span>';
    }
  }

  const status=STATUSES[t.status||'open'];
  // Status badge is interactive (click/Enter cycles through statuses). It
  // was previously a plain <span> with no tabindex/role and was display:none
  // for the "open" state — keyboard users couldn't reach it AT ALL and even
  // mouse users had to know to hover (#14 in UX audit). Now it's a <button>
  // visible across all states and routed through the keyboard delegation.
  const statusBadge='<button type="button" class="status-badge '+status.cls+'" data-action="cycleStatus" data-args="['+t.id+']" title="Cycle status (current: '+esc(status.label)+')" aria-label="Status: '+esc(status.label)+'. Activate to cycle to next status.">'+status.label+'</button>';
  const tagsVisible=(t.tags||[]).slice(0,3).map(tg=>'<span class="tag-chip">'+esc(tg)+'</span>').join('');
  const descPrev=(t.description&&t.description.length>0)?'<span class="task-desc-inline">'+esc(t.description.slice(0,50))+(t.description.length>50?'…':'')+'</span>':'';

  // Row actions. Two modes:
  //   • reorder mode → move ↑/↓ + outdent/indent (the row no longer navigates)
  //   • default      → one primary (timer) + a ⋯ overflow menu (star / subtask /
  //                    delete), so the resting row stays uncluttered.
  const reorderOn=(typeof isReorderMode==='function'&&isReorderMode());
  let actions;
  if(reorderOn){
    actions=
      '<button type="button" class="ta-btn ta-move" data-action="moveTaskUp" data-args="['+t.id+']" title="Move up" aria-label="Move task up">↑</button>'
     +'<button type="button" class="ta-btn ta-move" data-action="moveTaskDown" data-args="['+t.id+']" title="Move down" aria-label="Move task down">↓</button>'
     +'<button type="button" class="ta-btn ta-move" data-action="outdentTask" data-args="['+t.id+']" title="Outdent (promote)" aria-label="Outdent task"'+(t.parentId==null?' disabled':'')+'>⟸</button>'
     +'<button type="button" class="ta-btn ta-move" data-action="indentTask" data-args="['+t.id+']" title="Indent (nest under task above)" aria-label="Indent task">⟹</button>';
  } else {
    actions=
      '<button type="button" class="ta-btn ta-play '+(isActive?'on':'')+'" data-action="toggleTask" data-args="['+t.id+']" title="'+(isActive?'Stop timer':'Start timer')+'" aria-label="'+(isActive?'Stop timer for this task':'Start timer for this task')+'" aria-pressed="'+(isActive?'true':'false')+'">'+(isActive?'■':'▶')+'</button>'
     +'<button type="button" class="ta-btn ta-more" data-action="showTaskActionMenu" data-args="['+t.id+']" title="More actions" aria-label="More actions" aria-haspopup="menu">⋯</button>';
  }

  // Star pin — shown prominently only if starred (otherwise hidden in hover actions)
  const starPin=t.starred?'<span class="star-pin" title="Pinned" aria-label="Pinned to top">★</span>':'';

  // Always render the grip so drag-to-reorder is available regardless of the
  // active sort. Dragging from a non-manual sort reorders and then locks the
  // list to manual (see _initTaskListSortable's onEnd), so the gesture always
  // sticks — gating the handle on manual sort just made reorder undiscoverable.
  const dragGrip='<span class="drag-handle" title="Drag to reorder" role="img" aria-label="Drag handle">⠿</span>';
  d.innerHTML=
    '<div class="task-row-primary">'
      +dragGrip
      +chevron
      +checkbox
      +'<div class="task-main">'
        +starPin
        +'<span class="task-name">'+esc(t.name)+'</span>'
        +(signalChips?'<span class="task-signals">'+signalChips+'</span>':'')
      +'</div>'
      +'<div class="task-row-actions">'+actions+'</div>'
    +'</div>'
    +'<div class="task-row-secondary-wrap"><div class="task-row-secondary">'
      +statusBadge
      +(tagsVisible?'<span class="task-tags-inline">'+tagsVisible+'</span>':'')
      +descPrev
    +'</div></div>';
  // Surface a small "Xh Ym" pill next to the task name when the user is
  // currently filtering or sorting by duration/completion - so they can see
  // why a task survived the filter without opening the detail modal. Built
  // via DOM APIs (createElement / appendChild) after the row is in place,
  // so the production esc() escapes the name and the pill text comes from
  // fmtHMS (digits + unit letters, no metachars).
  const _showDurPill = (window._activeDurationFilter || window._activeCompletedFilter
                        || taskSortBy === 'time') && rolledTime > 0;
  if(_showDurPill){
    const _nameEl = d.querySelector('.task-name');
    if(_nameEl){
      const _pill = document.createElement('span');
      _pill.className = 'task-duration-pill';
      _pill.title = 'Time tracked';
      _pill.textContent = fmtHMS(rolledTime);
      _nameEl.insertAdjacentElement('afterend', _pill);
    }
  }
  list.appendChild(d)
}

function renderSubtaskForm(parentId,depth){
  const list=gid('taskList');
  const d=document.createElement('div');
  d.className='task-subtask-form';
  d.style.marginLeft=(depth*18)+'px';
  const inp=document.createElement('input');inp.className='task-sub-input';inp.dataset.parent=parentId;inp.placeholder='Subtask name...';
  inp.onkeydown=function(e){if(e.key==='Enter')addSubtask(parentId);if(e.key==='Escape')cancelSubtaskPrompt()};
  d.appendChild(inp);
  const btns=document.createElement('div');btns.className='task-sub-btns';
  const addBtn=document.createElement('button');addBtn.className='task-sub-btn task-sub-add';addBtn.textContent='Add';addBtn.onclick=function(){addSubtask(parentId)};btns.appendChild(addBtn);
  const cancelBtn=document.createElement('button');cancelBtn.className='task-sub-btn task-sub-cancel';cancelBtn.textContent='×';cancelBtn.onclick=function(){cancelSubtaskPrompt()};btns.appendChild(cancelBtn);
  d.appendChild(btns);
  list.appendChild(d);
  if(typeof _subtaskFormDraftParent==='number'&&_subtaskFormDraftParent===parentId&&typeof _subtaskFormDraftText==='string'){
    inp.value=_subtaskFormDraftText;
  }
  inp.addEventListener('input',()=>{
    _subtaskFormDraftText=inp.value;
    _subtaskFormDraftParent=parentId;
  });
}

// Toggle a board card's nested-subtask disclosure. Mirrors t.collapsed in the
// list view but is board-specific so the two surfaces don't fight over one
// flag. Default (undefined) = collapsed, so busy parents start tidy.
function toggleBoardExpand(id){
  const t=findTask(id);if(!t)return;
  t.boardExpanded=!t.boardExpanded;
  renderTaskList();saveState('user');
}
window.toggleBoardExpand=toggleBoardExpand;

// A compact, tap-to-open card for a nested subtask shown inside its parent.
// No drag — its status follows the parent's column; tapping opens the detail
// where it can be edited or re-parented.
function _boardMiniCard(k){
  const mc=document.createElement('div');
  mc.className='board-mini-card priority-'+(k.priority||'none')+'-card'+(k.status==='done'?' done':'');
  mc.setAttribute('role','button');mc.setAttribute('tabindex','0');
  mc.onclick=function(){openTaskDetail(k.id)};
  mc.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();openTaskDetail(k.id)}});
  const stt=STATUSES[k.status||'open'];
  const ddc=k.dueDate&&typeof describeDue==='function'?describeDue(k.dueDate):(k.dueDate?{cls:getDueClass(k.dueDate),label:fmtDue(k.dueDate)}:null);
  const due=ddc?'<span class="date-chip'+(ddc.cls?' date-chip--'+ddc.cls:'')+'">'+esc(String(ddc.label||''))+'</span>':'';
  const gk=getTaskChildren(k.id).filter(x=>!x.archived).length;
  mc.innerHTML='<div class="board-mini-name">'+(k.status==='done'?'<span class="bmc-check" aria-hidden="true">✓</span>':'')+esc(k.name)+'</div>'
    +'<div class="board-mini-meta"><span class="status-badge '+stt.cls+'">'+esc(stt.label)+'</span>'+due
    +(gk?'<span class="bmc-subs" title="'+gk+' nested subtask'+(gk>1?'s':'')+'">'+gk+' ▾</span>':'')+'</div>';
  return mc;
}

// Kanban Board View
function renderBoard(visibleTasks){
  const board=gid('boardView');board.textContent='';
  const isMobile=window.matchMedia('(max-width:640px)').matches;
  const visibleSet=new Set(visibleTasks.map(t=>t.id));
  STATUS_ORDER.forEach(st=>{
    const status=STATUSES[st];
    // Only top-level cards per column: roots, plus any visible subtask whose
    // parent is filtered out (so it doesn't silently vanish). Subtasks of a
    // visible parent are nested under that parent's card instead.
    const colTasks=sortTasks(visibleTasks.filter(t=>(t.status||'open')===st && (!t.parentId || !visibleSet.has(t.parentId))));
    // On mobile, hide empty columns unless it's "open" (default drop target) or "done" (completed)
    if(isMobile&&colTasks.length===0&&st!=='open'&&st!=='done')return;
    const col=document.createElement('div');col.className='board-col';
    col.dataset.status=st;
    col.ondragover=function(e){e.preventDefault();e.dataTransfer.dropEffect='move';col.classList.add('drop-target')};
    col.ondragleave=function(){col.classList.remove('drop-target')};
    col.ondrop=function(e){
      e.preventDefault();col.classList.remove('drop-target');
      const srcId=parseInt(e.dataTransfer.getData('text/plain'),10);
      if(!Number.isFinite(srcId)||srcId<=0)return;
      const src=findTask(srcId);if(!src)return;
      if(src.status===st)return;
      const backup=JSON.parse(JSON.stringify(src));
      src.status=st;
      if(st==='done'){
        if(src.recur && typeof completeHabitCycle==='function'){completeHabitCycle(src)}
        else{src.completedAt=stampCompletion()}
      }
      else src.completedAt=null;
      renderTaskList();saveState('user');
      if(typeof showActionToast==='function'){
        showActionToast('Moved to '+STATUSES[st].label, 'Undo', ()=>{
          const u=findTask(srcId);
          if(u){Object.assign(u,backup);renderTaskList();saveState('user')}
        }, 4000);
      }
    };
    col.innerHTML='<div class="board-col-hdr"><span class="status-badge '+status.cls+'">'+status.label+'</span><span class="cc-count">'+colTasks.length+'</span></div><div class="board-col-body"></div>';
    const body=col.querySelector('.board-col-body');
    colTasks.forEach(t=>{
      const card=document.createElement('div');
      card.className='board-card priority-'+(t.priority||'none')+'-card';
      card.setAttribute('draggable','true');
      card.ondragstart=function(e){e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',t.id);card.style.opacity='.4'};
      card.ondragend=function(){card.style.opacity='1'};
      // Ignore taps on the subtask expander or a nested mini-card — those have
      // their own handlers; only a tap on the parent body opens its detail.
      card.onclick=function(e){
        if(e.target.closest('[data-action]')||e.target.closest('.board-mini-card'))return;
        openTaskDetail(t.id);
      };
      const path=getTaskPath(t.id);
      const breadcrumb=path.length>1?'<div class="board-breadcrumb">'+esc(path.slice(0,-1).join(' › '))+'</div>':'';
      const dueIc=(typeof window.icon==='function')?window.icon('calendar',{size:12}):'';
      const ddc=t.dueDate&&typeof describeDue==='function'?describeDue(t.dueDate):{cls:getDueClass(t.dueDate),label:fmtDue(t.dueDate)};
      const dueMod=ddc&&ddc.cls?' date-chip--'+ddc.cls:'';
      const due=t.dueDate?'<span class="date-chip'+dueMod+'">'+dueIc+' '+esc(String(ddc.label||fmtDue(t.dueDate)||''))+'</span>':'';
      const tags=(t.tags||[]).slice(0,2).map(tg=>'<span class="tag-chip">'+esc(tg)+'</span>').join('');
      const time=getRolledUpTime(t.id)>0?'<span class="task-elapsed">'+fmtHMS(getRolledUpTime(t.id))+'</span>':'';
      card.innerHTML=breadcrumb
        +'<div class="board-card-name">'+esc(t.name)+'</div>'
        +'<div class="board-card-meta">'+due+tags+time+'</div>';

      // Nested subtasks: collapsed by default behind a count pill; expanding
      // reveals tap-to-open mini-cards. Tapping a mini-card opens its detail so
      // it can be edited or moved — exactly the "click takes you back" ask.
      const kids=getTaskChildren(t.id).filter(k=>!k.archived);
      if(kids.length){
        const prog=(typeof getSubtaskProgress==='function')?getSubtaskProgress(t.id):null;
        const expanded=!!t.boardExpanded;
        const pill=document.createElement('button');
        pill.type='button';
        pill.className='board-subs-toggle'+(expanded?' expanded':'');
        pill.dataset.action='toggleBoardExpand';
        pill.dataset.args='['+t.id+']';
        pill.setAttribute('aria-expanded',expanded?'true':'false');
        pill.draggable=false;
        pill.innerHTML='<span class="bst-caret" aria-hidden="true">▸</span>'
          +kids.length+' subtask'+(kids.length>1?'s':'')
          +(prog?' · '+prog.done+'/'+prog.total+' done':'');
        card.appendChild(pill);
        if(expanded){
          const wrap=document.createElement('div');wrap.className='board-card-subs';
          sortTasks(kids).forEach(k=>wrap.appendChild(_boardMiniCard(k)));
          card.appendChild(wrap);
        }
      }

      // ── Touch drag-and-drop (mobile Kanban) ─────────────────────────────
      // Ghost-element pattern: clone the card at a fixed position that follows
      // the finger. elementFromPoint() (with ghost temporarily display:none)
      // resolves which board column is under the touch. Mirrors the mouse
      // ondragstart/ondrop path so status changes are committed identically.
      let _ghost=null,_srcCol=col,_overCol=null;
      function _applyDrop(dropSt){
        if(!dropSt||dropSt===(t.status||'open'))return;
        const src=findTask(t.id);if(!src)return;
        const backup=JSON.parse(JSON.stringify(src));
        src.status=dropSt;
        if(dropSt==='done'){
          if(src.recur&&typeof completeHabitCycle==='function')completeHabitCycle(src);
          else src.completedAt=stampCompletion();
        } else {
          src.completedAt=null;
        }
        if(typeof haptic==='function')haptic(30);
        renderTaskList();saveState('user');
        if(typeof showActionToast==='function'){
          showActionToast('Moved to '+STATUSES[dropSt].label, 'Undo', ()=>{
            const u=findTask(t.id);
            if(u){Object.assign(u,backup);renderTaskList();saveState('user')}
          }, 4000);
        }
      }
      card.addEventListener('touchstart',function(e){
        if(e.target.closest('button'))return;
        const r=card.getBoundingClientRect();
        _ghost=card.cloneNode(true);
        _ghost.style.cssText='position:fixed;top:'+r.top+'px;left:'+r.left+'px;width:'+r.width+'px;z-index:9999;pointer-events:none;opacity:.88;box-shadow:0 10px 32px rgba(0,0,0,.55);border-radius:var(--r-md,10px);transform:scale(1.04);transition:none';
        document.body.appendChild(_ghost);
        card.style.opacity='.28';
        e.preventDefault();
      },{passive:false});
      card.addEventListener('touchmove',function(e){
        if(!_ghost)return;
        const touch=e.touches[0];
        const gh=_ghost.getBoundingClientRect();
        _ghost.style.top=(touch.clientY-gh.height/2)+'px';
        _ghost.style.left=(touch.clientX-gh.width/2)+'px';
        _ghost.style.display='none';
        const el=document.elementFromPoint(touch.clientX,touch.clientY);
        _ghost.style.display='';
        const targetCol=el&&el.closest('.board-col');
        if(targetCol!==_overCol){
          if(_overCol)_overCol.classList.remove('drop-target');
          _overCol=targetCol||null;
          if(_overCol&&_overCol!==_srcCol)_overCol.classList.add('drop-target');
        }
        if(e.cancelable)e.preventDefault();
      },{passive:false});
      function _touchEnd(){
        if(!_ghost)return;
        _ghost.remove();_ghost=null;
        card.style.opacity='1';
        if(_overCol)_overCol.classList.remove('drop-target');
        const dropSt=_overCol?_overCol.dataset.status:null;
        _overCol=null;
        _applyDrop(dropSt);
      }
      card.addEventListener('touchend',_touchEnd,{passive:true});
      card.addEventListener('touchcancel',_touchEnd,{passive:true});
      // ── end touch DnD ────────────────────────────────────────────────────

      body.appendChild(card)
    });
    if(!colTasks.length){
      const empty=document.createElement('div');empty.className='board-col-empty';
      empty.textContent=isMobile ? 'No tasks' : 'Drop tasks here';body.appendChild(empty);
    }
    board.appendChild(col)
  })
}

// Task Detail Modal — chips commit immediately to the live task and persist
// via saveState. _taskModalSnapshot is a deep clone taken on open so close-
// without-save can revert the *text fields* (name, description, dates, url,
// notes) — but chip-driven fields (priority, effort, energy, category, type,
// recur, tags, status) are explicitly re-snapshotted on each commit so they
// are NOT reverted on cancel. This matches the user's mental model: clicking
// a chip looks like an immediate action, so it should be one. Typing into a
// textarea and bailing should still discard, hence the per-field handling.
let _taskModalSnapshot=null;
const TASK_MODAL_CHIP_FIELDS = ['priority','effort','energyLevel','category','type','recur','tags','status','completedAt','dueDate'];
// Commit a chip-driven mutation: persist via saveState, refresh the chip
// portion of the snapshot so closeTaskDetail's revert pass can't undo it,
// re-render the task list (so chips on the row update live), and pulse the
// existing save-indicator pill so the user gets visible "saved" feedback.
function _commitChipChange(t){
  if(!t || !_taskModalSnapshot) return;
  TASK_MODAL_CHIP_FIELDS.forEach(f => {
    const v = t[f];
    _taskModalSnapshot[f] = (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v;
  });
  if(typeof saveState === 'function') saveState('user');
  window._preserveTaskScroll = true;
  if(typeof renderTaskList === 'function') renderTaskList();
  if(typeof showSaveIndicator === 'function') showSaveIndicator();
}
function openTaskDetail(id){
  const t=findTask(id);if(!t)return;
  // Re-entrance guard: a rapid double-tap on a task row can fire openTaskDetail
  // twice before the modal animation lands. Without this, the second pass
  // re-runs all field wiring (and re-attaches the tab-trap listener via
  // capture-phase document.addEventListener), leaking handlers on every close.
  const _modalEl=document.getElementById('taskModal');
  if(_modalEl && _modalEl.classList.contains('open') && editingTaskId===id) return;
  _taskModalSnapshot=JSON.parse(JSON.stringify(t));
  editingTaskId=id;
  gid('mdName').value=t.name;
  gid('mdCheckbox').classList.toggle('checked',t.status==='done');
  gid('mdCheckbox').textContent=t.status==='done'?'✓':'';
  gid('mdDue').value=t.dueDate||'';
  if(gid('mdSnoozeUntil')) gid('mdSnoozeUntil').value=t.hiddenUntil||'';
  // Type chips (task / waiting / bug / idea / errand)
  const tChips=gid('mdTypeChips');
  if(tChips){
    tChips.replaceChildren();
    [['task','Task'],['waiting','Waiting on'],['bug','Bug'],['idea','Idea'],['errand','Errand']].forEach(([key,lbl])=>{
      const b=document.createElement('button');
      b.type='button';
      b.className='mfield-chip-btn'+((t.type||'task')===key?' active':'');
      b.textContent=lbl;
      b.onclick=function(){
        t.type=key;
        Array.from(tChips.children).forEach(c=>c.classList.remove('active'));
        b.classList.add('active');
        _commitChipChange(t);
      };
      tChips.appendChild(b);
    });
  }
  gid('mdStartDate').value=t.startDate||'';
  gid('mdEstimate').value=t.estimateMin||0;
  gid('mdDesc').value=t.description||'';
  gid('mdUrl').value=t.url||'';
  gid('mdCompletionNote').value=t.completionNote||'';
  if(gid('mdRemindAt'))gid('mdRemindAt').value=t.remindAt||'';
  gid('mdTracked').textContent=fmtHMS(getRolledUpTime(id))+' · '+getRolledUpSessions(id)+' sessions';
  const path=getTaskPath(id);
  const pathStr=path.length>1?path.slice(0,-1).join(' › ')+' › ':'';
  gid('mdStats').innerHTML='<span><b>Path:</b> '+esc(pathStr)+'<b class="md-name-strong">'+esc(t.name)+'</b></span> · <span>Created '+esc(t.created||'—')+'</span>'+(t.completedAt?' · <span>Done '+esc(String(t.completedAt))+'</span>':'');
  // List selector — populate the hidden shadow <select> (saveTaskDetail
  // reads its .value) and set the visible trigger's label to the current
  // list's name. The Dropdown utility builds its option list from the
  // shadow select when openListDropdown fires.
  const listSel=gid('mdList');
  listSel.replaceChildren();
  lists.forEach(l=>{
    const opt=document.createElement('option');
    opt.value=l.id;
    opt.textContent=l.name;
    if((t.listId||lists[0].id)===l.id) opt.selected=true;
    listSel.appendChild(opt);
  });
  const _listLabelEl = gid('mdListLabel');
  if(_listLabelEl){
    const _selOpt = listSel.options[listSel.selectedIndex];
    _listLabelEl.textContent = _selOpt ? _selOpt.textContent : 'List';
  }
  // ARIA chip helpers — without role/aria-checked or aria-pressed, screen
  // readers can't tell selected state since visual selection is color-only
  // (#13 in UX audit). Radio-group chips (single-select) use role=radio +
  // aria-checked; toggle chips (Effort, Energy — clicking active deselects)
  // use aria-pressed.
  const _setRadioGroupSelection = (container, btn) => {
    [...container.children].forEach(c => { c.classList.remove('active'); if(c.setAttribute) c.setAttribute('aria-checked', 'false'); });
    btn.classList.add('active'); if(btn.setAttribute) btn.setAttribute('aria-checked', 'true');
  };
  const _setPressedGroupSelection = (container, btn, isActive) => {
    [...container.children].forEach(c => { c.classList.remove('active'); if(c.setAttribute) c.setAttribute('aria-pressed', 'false'); });
    if(isActive){ btn.classList.add('active'); btn.setAttribute('aria-pressed', 'true'); }
  };
  // Status chips
  const sChips=gid('mdStatusChips');sChips.innerHTML='';
  sChips.setAttribute('role','radiogroup');
  STATUS_ORDER.forEach(st=>{
    const b=document.createElement('button');b.type='button';b.className='mfield-chip-btn'+((t.status||'open')===st?' active':'');
    b.setAttribute('role','radio');
    b.setAttribute('aria-checked', (t.status||'open')===st ? 'true' : 'false');
    b.textContent=STATUSES[st].label;
    b.onclick=function(){
      if(st==='done'&&t.recur&&typeof completeHabitCycle==='function'){
        completeHabitCycle(t);
        gid('mdCheckbox').classList.remove('checked');gid('mdCheckbox').textContent='';
        [...sChips.children].forEach((c,i)=>{ const active=(STATUS_ORDER[i]==='open'); c.classList.toggle('active',active); c.setAttribute('aria-checked', active?'true':'false'); });
        renderMdHabitLog(t);
        renderMdSessions(t);
        gid('mdTracked').textContent=fmtHMS(getRolledUpTime(t.id))+' · '+getRolledUpSessions(t.id)+' sessions';
      }else{
        t.status=st;
        if(st==='done' && !t.completedAt && typeof stampCompletion === 'function') t.completedAt = stampCompletion();
        if(st!=='done') t.completedAt = null;
        gid('mdCheckbox').classList.toggle('checked',st==='done');gid('mdCheckbox').textContent=st==='done'?'✓':'';
        _setRadioGroupSelection(sChips, b);
      }
      _commitChipChange(t);
    };
    sChips.appendChild(b)
  });
  // Priority chips
  const pChips=gid('mdPriorityChips');pChips.innerHTML='';
  pChips.setAttribute('role','radiogroup');
  ['urgent','high','normal','low','none'].forEach(pr=>{
    const b=document.createElement('button');b.type='button';b.className='mfield-chip-btn'+((t.priority||'none')===pr?' active':'');
    b.setAttribute('role','radio');
    b.setAttribute('aria-checked', (t.priority||'none')===pr ? 'true' : 'false');
    // Use a CSS-token-driven color so "low" hits AA contrast in both themes —
    // hard-coded #7f8c8d was ~3.6:1 on the dark modal bg (#22 in UX audit).
    b.style.color=pr!=='none'?({urgent:'var(--prio-urgent)',high:'var(--prio-high)',normal:'var(--prio-normal)',low:'var(--prio-low)'}[pr]):'';
    b.textContent=PRIORITIES[pr].label;
    b.onclick=function(){t.priority=pr;_setRadioGroupSelection(pChips, b);_commitChipChange(t)};
    pChips.appendChild(b)
  });
  // Effort chips (toggle — clicking the active chip deselects)
  const eChips=gid('mdEffortChips');eChips.innerHTML='';
  eChips.setAttribute('role','group');
  [['xs','XS'],['s','S'],['m','M'],['l','L'],['xl','XL']].forEach(([key,lbl])=>{
    const b=document.createElement('button');b.type='button';b.className='mfield-chip-btn'+((t.effort||null)===key?' active':'');
    b.setAttribute('aria-pressed', (t.effort||null)===key ? 'true' : 'false');
    b.textContent=lbl;b.title={xs:'Extra small (~15min)',s:'Small (~1hr)',m:'Medium (~half day)',l:'Large (~full day)',xl:'Extra large (multi-day)'}[key];
    b.onclick=function(){
      t.effort=t.effort===key?null:key;
      _setPressedGroupSelection(eChips, b, t.effort===key);
      renderEffortChips(t,eChips);_commitChipChange(t)
    };
    eChips.appendChild(b)
  });
  // Energy chips (toggle)
  const enChips=gid('mdEnergyChips');enChips.innerHTML='';
  enChips.setAttribute('role','group');
  [['high','High energy'],['low','Low energy']].forEach(([key,lbl])=>{
    const b=document.createElement('button');b.type='button';b.className='mfield-chip-btn'+((t.energyLevel||null)===key?' active':'');
    b.setAttribute('aria-pressed', (t.energyLevel||null)===key ? 'true' : 'false');
    b.textContent=lbl;
    b.onclick=function(){
      t.energyLevel=t.energyLevel===key?null:key;
      _setPressedGroupSelection(enChips, b, !!t.energyLevel);
      _commitChipChange(t)
    };
    enChips.appendChild(b)
  });
  // Recurrence — moved from an 11-chip radiogroup to a single dropdown
  // trigger. The 11 options were dominating the modal on narrow viewports
  // (multiple chip rows). The trigger button shows the current selection;
  // clicking it opens a Dropdown popover (or bottom-sheet on mobile). The
  // hidden #mdRecur input keeps a syncable DOM reference for any consumers.
  const _recurOptions = [
    ['none','No repeat'],
    ['daily','Daily'],['weekdays','Weekdays'],['every2d','Every 2 days'],['weekly','Weekly'],['monthly','Monthly'],
    ['after1d','After 1d'],['after3d','After 3d'],['after7d','After 7d'],['after14d','After 14d'],['after30d','After 30d'],
  ];
  window._recurOptions = _recurOptions;  // openRecurDropdown reads this
  const _recurKey = t.recur || 'none';
  const _recurLabel = gid('mdRecurLabel');
  const _recurHidden = gid('mdRecur');
  if(_recurLabel){
    const _row = _recurOptions.find(r => r[0] === _recurKey);
    _recurLabel.textContent = _row ? _row[1] : 'No repeat';
  }
  if(_recurHidden) _recurHidden.value = _recurKey;
  // The dropdown's onSelect (in openRecurDropdown below) mutates t.recur,
  // syncs the trigger label + hidden input, and calls _commitChipChange.
  // Tags
  renderTagsEditor(id);
  // Category chips (toggle)
  const catChips=gid('mdCategoryChips');catChips.innerHTML='';
  catChips.setAttribute('role','group');
  const catList=(typeof getActiveCategories==='function')?getActiveCategories():[];
  catList.forEach(row=>{
    const key=row.id,lbl=row.label||row.id;
    const b=document.createElement('button');b.type='button';b.className='mfield-chip-btn mfield-chip-btn--cat'+((t.category||null)===key?' active':'');
    b.setAttribute('aria-pressed', (t.category||null)===key ? 'true' : 'false');
    const chipLbl = (typeof getCategoryChipLabel === 'function') ? getCategoryChipLabel(key) : (lbl.slice(0, 40));
    b.textContent=chipLbl;
    const cdef=(typeof getCategoryDef==='function')?getCategoryDef(key):null;
    if(cdef){
      b.setAttribute('data-cat-id', key);
      const tip=((cdef.label||key)+(cdef.focus?': '+(cdef.focus):'')+((cdef.examples&&cdef.examples.length)?' · e.g. '+cdef.examples.slice(0,3).join(', '):'')).slice(0,280);
      if(tip) b.setAttribute('title', tip);
    }
    b.onclick=function(){
      t.category=t.category===key?null:key;
      _setPressedGroupSelection(catChips, b, !!t.category);
      _commitChipChange(t);
    };
    catChips.appendChild(b)
  });
  const vn=gid('mdValuesNote');if(vn)vn.textContent=t.valuesNote||'';
  // C-1: visible task ID badge near the task name
  if(typeof renderTaskIdBadge === 'function') renderTaskIdBadge(t);
  // Checklist (legacy single + C-7 multiple named groups)
  renderChecklist(id);
  if(typeof renderChecklistGroups === 'function') renderChecklistGroups(id);
  // Notes
  renderTaskNotes(id);
  // Blocked by
  renderBlockedBy(id);
  // C-9 related tasks (non-blocking links)
  if(typeof renderRelatedTasks === 'function') renderRelatedTasks(id);
  // C-2 activity log
  if(typeof renderTaskActivity === 'function') renderTaskActivity(t);
  // C-6 estimate vs actual variance
  if(typeof renderEstimateVariance === 'function') renderEstimateVariance(t);
  renderMdHabitLog(t);
  renderMdSessions(t);
  if(typeof renderMdAttachments === 'function') renderMdAttachments(id);
  // 'sheet' variant: body scroll lock + bottom-sheet swipe.
  // onRequestClose routes ESC through closeTaskDetail so the
  // "discard unsaved text edits?" confirmation runs before tear-down.
  // onOpen runs when the slide-up transition completes (transitionend),
  // so the similar-tasks accordion never expands mid-slide — that
  // expansion would change the modal's height; on mobile (align-items:
  // flex-end) the bottom stays anchored and the TOP would jolt upward
  // ("jitter at the top"). editingTaskId guard cancels stale fetches.
  Modal.open('taskModal', {
    variant: 'sheet',
    focus: '#mdName',
    skipInitialFocus: true,
    onRequestClose: ()=>closeTaskDetail(),
    onOpen: ()=>{ if(editingTaskId===id) refreshMdSimilarTasks(id); }
  });
}

/**
 * Per-task session history. Renders one entry per timer session that recorded
 * to t.sessionEntries (timer.js writes these on phase complete + skip). Hidden
 * gracefully when the task has no sessions yet so empty tasks don't show a
 * useless empty list.
 */
function renderMdSessions(t){
  const el = gid('mdSessions');
  const wrap = gid('mdSessionsWrap');
  if(!el) return;
  const entries = (typeof getTaskSessionEntries === 'function')
    ? getTaskSessionEntries(t)
    : (t && Array.isArray(t.sessionEntries) ? t.sessionEntries : []);
  if(!entries.length){
    el.replaceChildren();
    if(wrap) wrap.hidden = true;
    const sessCount = (typeof getRolledUpSessions === 'function') ? getRolledUpSessions(t.id) : (t.sessions || 0);
    if(sessCount > 0 && wrap){
      wrap.hidden = false;
      const hint = document.createElement('p');
      hint.className = 'md-sessions-legacy-hint';
      hint.textContent = sessCount + ' session' + (sessCount !== 1 ? 's' : '')
        + ' tracked before per-session history was saved. New timer rounds will appear here.';
      el.appendChild(hint);
    }
    return;
  }
  if(wrap) wrap.hidden = false;
  el.replaceChildren();
  // Show newest first, cap at 30 visible to keep the modal scrollable.
  const recent = entries.slice(-30).reverse();
  const ul = document.createElement('ul');
  ul.className = 'md-sessions-list';
  recent.forEach(s => {
    const li = document.createElement('li');
    li.className = 'md-sessions-item' + (s.type === 'work-partial' ? ' md-sessions-item--partial' : '');
    const ts = document.createElement('span');
    ts.className = 'md-sessions-ts';
    // Format: "Apr 27, 2:34 PM" — small but parseable. timeNowFull stores
    // ISO so Date(s.ts) is safe.
    try{
      const d = new Date(s.ts);
      ts.textContent = d.toLocaleString(undefined, {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'});
    }catch(_){ ts.textContent = String(s.ts || ''); }
    const dur = document.createElement('span');
    dur.className = 'md-sessions-dur';
    dur.textContent = (typeof fmtHMS === 'function') ? fmtHMS(s.durationSec || 0) : (s.durationSec || 0) + 's';
    li.append(ts, dur);
    if(s.type === 'work-partial'){
      const tag = document.createElement('span');
      tag.className = 'md-sessions-tag';
      tag.textContent = 'partial';
      li.appendChild(tag);
    }
    ul.appendChild(li);
  });
  if(entries.length > 30){
    const more = document.createElement('li');
    more.className = 'md-sessions-more';
    more.textContent = '+ ' + (entries.length - 30) + ' earlier sessions';
    ul.appendChild(more);
  }
  el.appendChild(ul);
}

function renderMdHabitLog(t){
  const el=gid('mdHabitLog');
  if(!el)return;
  if(!t||!t.recur||!Array.isArray(t.completions)||!t.completions.length){
    el.textContent='';const hint=document.createElement('span');hint.className='intel-muted';hint.textContent='Completion history appears after you finish a repeating task.';el.appendChild(hint);
    return;
  }
  const rows=t.completions.slice(-14).reverse();
  const sum=(typeof getHabitLoggedSecTotal==='function')?getHabitLoggedSecTotal(t):0;
  el.textContent='';
  const sumDiv=document.createElement('div');sumDiv.className='habit-log-sum';sumDiv.textContent='Logged in completions: ';
  const sumStrong=document.createElement('strong');sumStrong.textContent=fmtHMS(sum);sumDiv.appendChild(sumStrong);el.appendChild(sumDiv);
  const ul=document.createElement('ul');ul.className='habit-log-list';
  rows.forEach(c=>{const li=document.createElement('li');const ds=document.createElement('span');ds.textContent=c.date;li.appendChild(ds);li.append(' · '+fmtHMS(c.sec||0));ul.appendChild(li)});
  el.appendChild(ul);
}

async function refreshMdSimilarTasks(id){
  const body = gid('mdSimilarTasks');
  const acc = gid('mdSimilarAccordion');
  const clusterBtn = gid('mdClusterBtn');
  if(!body) return;
  if(clusterBtn) clusterBtn.hidden = true;
  if(typeof isIntelReady !== 'function' || !isIntelReady()){
    body.textContent='';const m1=document.createElement('span');m1.className='intel-muted';m1.textContent='Load the model (AI chip or Tools → Task understanding) for similar tasks.';body.appendChild(m1);
    if(acc) acc.classList.remove('open');
    return;
  }
  body.textContent='';const m2=document.createElement('span');m2.className='intel-muted';m2.textContent='Finding neighbors…';body.appendChild(m2);
  try{
    const sim = await similarTasksFor(id, 5);
    if (editingTaskId !== id) return;
    if(!sim.length){
      body.textContent='';const m3=document.createElement('span');m3.className='intel-muted';m3.textContent='No similar tasks found yet.';body.appendChild(m3);
      return;
    }
    body.textContent='';
    sim.forEach(({ t: ot, sim: s }) => {
      const btn=document.createElement('button');btn.type='button';btn.className='similar-task-row';
      btn.onclick=function(){closeTaskDetail();openTaskDetail(parseInt(ot.id,10)||0)};
      const nm=document.createElement('span');nm.className='st-name';nm.textContent=ot.name.slice(0,48);btn.appendChild(nm);
      const sc=document.createElement('span');sc.className='st-sim';sc.textContent=s.toFixed(2);btn.appendChild(sc);
      body.appendChild(btn);
    });
    // Offer clustering only when at least one neighbor is similar enough to be
    // worth grouping under a shared theme.
    if(clusterBtn) clusterBtn.hidden = !sim.some(x => x.sim >= CLUSTER_SIM_FLOOR);
    if(acc) acc.classList.add('open');
  }catch(e){
    if (editingTaskId !== id) return;
    body.textContent='';const m4=document.createElement('span');m4.className='intel-muted';m4.textContent='Could not load neighbors.';body.appendChild(m4);
  }
}

// Minimum cosine similarity for a neighbor to be folded into a cluster.
const CLUSTER_SIM_FLOOR = 0.5;

// Group the current task and its close neighbors under a brand-new parent
// "theme" task (kept in the current task's list), nesting them as subtasks.
// Reuses the embedding neighbor search + the app's parentId subtask model.
async function clusterSimilarTasks(){
  const id = editingTaskId;
  if(id == null) return;
  const anchor = findTask(id);
  if(!anchor) return;
  if(typeof isIntelReady !== 'function' || !isIntelReady() || typeof similarTasksFor !== 'function'){
    if(typeof showActionToast === 'function') showActionToast('Load the model first to group similar tasks','',null,3000);
    return;
  }
  let neighbors = [];
  try{ neighbors = await similarTasksFor(id, 8); }catch(e){ neighbors = []; }
  // Keep close-enough, non-archived neighbors. The new theme parent is created
  // top-level, so re-parenting under it can never form a cycle.
  const members = neighbors
    .filter(x => x && x.sim >= CLUSTER_SIM_FLOOR && x.t && !x.t.archived)
    .map(x => x.t)
    .filter(ot => ot.id !== id);
  if(!members.length){
    if(typeof showActionToast === 'function') showActionToast('No similar tasks close enough to group','',null,3000);
    return;
  }
  const group = [anchor, ...members];
  const suggested = 'Theme: ' + (anchor.name || '').slice(0, 40);
  const themeName = (typeof showAppPrompt === 'function')
    ? await showAppPrompt('Name this theme (groups ' + group.length + ' tasks):', suggested)
    : prompt('Name this theme:', suggested);
  if(themeName === null) return;
  const name = String(themeName).trim();
  if(!name) return;

  // Snapshot prior parents for Undo before re-parenting.
  const prevParents = group.map(t => ({ id: t.id, parentId: t.parentId == null ? null : t.parentId }));

  const parent = Object.assign(
    { id: ++taskIdCtr, name, totalSec: 0, sessions: 0, created: timeNowFull(), parentId: null, collapsed: false },
    defaultTaskProps(),
    { listId: anchor.listId == null ? null : anchor.listId },
  );
  tasks.push(parent);
  if(typeof _taskIndexRegister === 'function') _taskIndexRegister(parent);
  // Captured from prevParents (pre-mutation) so Undo restores the right value.
  const anchorPrevEntry = prevParents.find(p => p.id === id);
  const anchorPrevParent = anchorPrevEntry ? anchorPrevEntry.parentId : null;
  group.forEach(t => { t.parentId = parent.id; });
  // The detail modal reverts the anchor to its open-time snapshot on close;
  // sync the new parent into the snapshot so closing doesn't pop it back out.
  if(_taskModalSnapshot && editingTaskId === id) _taskModalSnapshot.parentId = parent.id;

  if(typeof saveState === 'function') saveState('user');
  if(typeof renderTaskList === 'function') renderTaskList();
  await refreshMdSimilarTasks(id);

  if(typeof showActionToast === 'function'){
    const pid = parent.id;
    showActionToast('Grouped ' + group.length + ' tasks under "' + name + '"', 'Undo', () => {
      prevParents.forEach(p => { const t = findTask(p.id); if(t) t.parentId = p.parentId; });
      if(_taskModalSnapshot && editingTaskId === id) _taskModalSnapshot.parentId = anchorPrevParent == null ? null : anchorPrevParent;
      if(typeof _taskIndexRemove === 'function') _taskIndexRemove(pid);
      tasks = tasks.filter(t => t.id !== pid);
      if(typeof saveState === 'function') saveState('user');
      if(typeof renderTaskList === 'function') renderTaskList();
    }, 6000);
  }
}
window.clusterSimilarTasks = clusterSimilarTasks;


function renderEffortChips(t,eChips){
  [...eChips.children].forEach(b=>{b.classList.toggle('active',b.textContent.toLowerCase()===t.effort)})
}

function renderTagsEditor(id){
  const t=findTask(id);if(!t)return;
  const ed=gid('mdTagsEditor');ed.textContent='';
  (t.tags||[]).forEach((tag,i)=>{
    const chip=document.createElement('span');chip.className='tag-edit-chip';
    chip.textContent=tag;
    // Plain <span> with onclick was keyboard-unreachable (#16 UX audit).
    // A real <button> picks up the global focus styles + Enter/Space activation.
    const rm=document.createElement('button');rm.type='button';rm.className='tag-rm';rm.textContent='×';rm.setAttribute('aria-label','Remove tag '+(tag||''));rm.onclick=function(){removeTag(id,i)};chip.appendChild(rm);
    ed.appendChild(chip)
  });
  const inp=document.createElement('input');inp.className='tag-input';inp.placeholder='+ tag';
  inp.onkeydown=function(e){if(e.key==='Enter'&&inp.value.trim()){addTag(id,inp.value.trim());inp.value=''}};
  ed.appendChild(inp)
}
function addTag(id,tag){const t=findTask(id);if(!t)return;if(!t.tags)t.tags=[];if(!t.tags.includes(tag))t.tags.push(tag);renderTagsEditor(id);_commitChipChange(t)}
function removeTag(id,idx){const t=findTask(id);if(!t||!t.tags)return;t.tags.splice(idx,1);renderTagsEditor(id);_commitChipChange(t)}

// _taskModalPrevFocus and _taskModalTabTrap removed in Stage 2 — Modal.open
// owns focus capture/restore (via openFocusTrap) and Tab cycling for taskModal.
// Snapshot-vs-form-fields divergence check. Only the *text/number* form
// fields gate the discard-confirm — chip edits already committed via
// _commitChipChange aren't considered "unsaved". Returns true when the user
// has typed or changed an input that would be lost on revert.
function _taskModalHasUnsavedTextEdits(){
  if(!_taskModalSnapshot) return false;
  const pairs = [
    ['mdName',         _taskModalSnapshot.name         || ''],
    ['mdDesc',         _taskModalSnapshot.description  || ''],
    ['mdUrl',          _taskModalSnapshot.url          || ''],
    ['mdCompletionNote', _taskModalSnapshot.completionNote || ''],
    ['mdDue',          _taskModalSnapshot.dueDate      || ''],
    ['mdStartDate',    _taskModalSnapshot.startDate    || ''],
    ['mdSnoozeUntil',  _taskModalSnapshot.hiddenUntil  || ''],
    ['mdRemindAt',     _taskModalSnapshot.remindAt     || ''],
    ['mdEstimate',     String(_taskModalSnapshot.estimateMin ?? 0)],
  ];
  for(const [id, baseline] of pairs){
    const el = gid(id);
    if(!el) continue;
    const cur = (id === 'mdName' || id === 'mdUrl' || id === 'mdCompletionNote') ? (el.value||'').trim() : (el.value||'');
    const base = (id === 'mdName' || id === 'mdUrl' || id === 'mdCompletionNote') ? String(baseline).trim() : String(baseline);
    if(cur !== base) return true;
  }
  return false;
}
async function closeTaskDetail(opts){
  if(typeof closeAttachLightbox === 'function') closeAttachLightbox();
  _abortMdVoiceRecording();
  const skipRevert=opts&&opts.skipRevert;
  // Confirm before discarding text/number edits the user typed but didn't
  // save. Chip edits aren't gated by this — they were already committed.
  if(!skipRevert && _taskModalSnapshot && _taskModalHasUnsavedTextEdits() && typeof showAppConfirm === 'function'){
    const ok = await showAppConfirm('Discard unsaved text edits?');
    if(!ok) return;
  }
  if(!skipRevert&&_taskModalSnapshot&&editingTaskId!=null){
    const id=editingTaskId,si=tasks.findIndex(x=>x.id===id);
    if(si>=0){
      const snap=JSON.parse(JSON.stringify(_taskModalSnapshot));
      tasks[si]=snap;
    }
  }
  _taskModalSnapshot=null;
  const _modalEl=gid('taskModal');
  // Reset any leftover swipe-drag transform from the bottom-sheet gesture so
  // the next open starts cleanly. Do this BEFORE Modal.close so the transform
  // reset doesn't fight the close transition.
  const _sheet=_modalEl&&_modalEl.querySelector('.modal');
  if(_sheet){_sheet.style.transform='';_sheet.style.transition=''}
  Modal.close('taskModal');
  if(!skipRevert){ window._preserveTaskScroll = true; renderTaskList(); }
  editingTaskId=null;
  if(typeof _updateActiveTaskTickSchedule==='function')_updateActiveTaskTickSchedule();
  // If midnight rolled over while the modal was open, the day-rollover
  // handler deferred (see app.js _isTaskModalOpen). Retry now that the
  // modal is closed so bookkeeping doesn't wait for the next 60s tick.
  if(typeof _handleDayRollover === 'function'){
    try{ _handleDayRollover(); }catch(e){ console.warn('[ui] post-close rollover', e); }
  }
}

// ── Bottom-sheet swipe-to-dismiss ──────────────────────────────────────────
// On mobile (<640px) a .modal-overlay renders as a bottom sheet. Swipe down on
// its header to dismiss — matches iOS / Android conventions. Header-only so
// scrolling the body doesn't accidentally trigger a dismiss. Generic so every
// sheet (task detail, filter sheets, quick-add) shares one implementation.
function bindSheetSwipe(overlay, closeFn){
  if(!overlay||overlay.dataset.swipeBound==='1') return;
  const sheet=overlay.querySelector('.modal');
  const head=overlay.querySelector('.modal-head');
  if(!sheet||!head) return;
  let startY=null,deltaY=0,active=false;
  const isSheetMode=()=>matchMedia('(max-width:640px)').matches;
  const onStart=(e)=>{
    if(!isSheetMode()) return;
    const t=e.touches?e.touches[0]:e;
    startY=t.clientY;deltaY=0;active=true;
    sheet.style.transition='none';
  };
  const onMove=(e)=>{
    if(!active||startY==null) return;
    const t=e.touches?e.touches[0]:e;
    const dy=t.clientY-startY;
    if(dy<0){deltaY=0;sheet.style.transform='';return}
    deltaY=dy;
    sheet.style.transform='translateY('+dy+'px)';
    if(e.cancelable) e.preventDefault();
  };
  const onEnd=()=>{
    if(!active) return;
    active=false;
    sheet.style.transition='transform .2s ease-out';
    if(deltaY>120){
      // Animate to fully off-screen, then close (close also resets transform).
      sheet.style.transform='translateY(110%)';
      setTimeout(()=>{ try{ closeFn(); }finally{ sheet.style.transform=''; } },180);
    }else{
      sheet.style.transform='';
    }
    startY=null;deltaY=0;
  };
  head.addEventListener('touchstart',onStart,{passive:true});
  head.addEventListener('touchmove',onMove,{passive:false});
  head.addEventListener('touchend',onEnd,{passive:true});
  head.addEventListener('touchcancel',onEnd,{passive:true});
  overlay.dataset.swipeBound='1';
}
window.bindSheetSwipe=bindSheetSwipe;

function _initTaskModalSwipeDismiss(){
  bindSheetSwipe(gid('taskModal'), ()=>closeTaskDetail());
}
window._initTaskModalSwipeDismiss=_initTaskModalSwipeDismiss;

// ── Generic filter/options sheet open-close ─────────────────────────────────
// Reuses the .modal-overlay.open bottom-sheet styling. Esc closes the topmost
// open sheet; backdrop taps close via each overlay's data-action.
function openSheet(id){
  const ov=document.getElementById(id);
  if(!ov) return;
  // 'sheet' variant: body scroll lock + bottom-sheet swipe (bindSheetSwipe).
  // onRequestClose ensures ESC routes through closeSheet so sheet-specific
  // cleanup (e.g. _restoreQuickAddHost) always runs.
  Modal.open(id, {
    variant: 'sheet',
    focus: '.modal-close,button,select,input,a[href]',
    skipInitialFocus: true,
    onRequestClose: ()=>closeSheet(id)
  });
}
function closeSheet(id){
  Modal.close(id);
  // The quick-add sheet borrows the inline add-task cluster — put it back so
  // the DOM is left as found (and the inline copy reappears on desktop).
  if(id==='quickAddSheet' && typeof _restoreQuickAddHost==='function') _restoreQuickAddHost();
}
window.openSheet=openSheet;
window.closeSheet=closeSheet;

// Named triggers wired from the .filter-bar buttons (data-action).
window.openListsSheet=()=>openSheet('listsSheet');
window.closeListsSheet=()=>closeSheet('listsSheet');
window.openTagsSheet=()=>{
  if(typeof refreshClassificationUi==='function') refreshClassificationUi();
  openSheet('tagsSheet');
};
window.closeTagsSheet=()=>closeSheet('tagsSheet');
window.openViewSheet=()=>openSheet('viewSheet');
window.closeViewSheet=()=>closeSheet('viewSheet');
// Backdrop-close handlers (fire only when the click lands on the overlay itself).
window.closeListsSheetOnBackdrop=(e)=>{ if(e&&e.target&&e.target.id==='listsSheet') closeSheet('listsSheet'); };
window.closeTagsSheetOnBackdrop=(e)=>{ if(e&&e.target&&e.target.id==='tagsSheet') closeSheet('tagsSheet'); };
window.closeViewSheetOnBackdrop=(e)=>{ if(e&&e.target&&e.target.id==='viewSheet') closeSheet('viewSheet'); };
function toggleSearchBar(){
  const bar=document.getElementById('searchBarWrap');
  if(!bar) return;
  const show=bar.hasAttribute('hidden');
  if(show){ bar.removeAttribute('hidden'); const inp=document.getElementById('taskSearch'); if(inp){ try{ inp.focus(); }catch(_){} } }
  else { bar.setAttribute('hidden',''); }
  const btn=document.getElementById('fbSearch');
  if(btn) btn.classList.toggle('active', show);
}
window.toggleSearchBar=toggleSearchBar;

// ── Task row overflow menu ──────────────────────────────────────────────────
// The ⋯ button on each row opens a small popover with the secondary actions
// (star / add subtask / delete) that used to crowd the row. One menu instance
// at a time; outside-click or Esc dismisses.
let _taskActionMenuEl=null;
function closeTaskActionMenu(){
  if(_taskActionMenuEl){ _taskActionMenuEl.remove(); _taskActionMenuEl=null; }
  document.removeEventListener('mousedown',_tamOutside,true);
  document.removeEventListener('keydown',_tamKey,true);
}
function _tamOutside(e){ if(_taskActionMenuEl && !_taskActionMenuEl.contains(e.target)) closeTaskActionMenu(); }
function _tamKey(e){ if(e.key==='Escape'){ e.preventDefault(); closeTaskActionMenu(); } }
function showTaskActionMenu(id){
  const ev=arguments[arguments.length-1];
  const t=findTask(id); if(!t) return;
  closeTaskActionMenu();
  const anchor=(ev&&ev.target&&ev.target.closest)?ev.target.closest('button'):null;
  const menu=document.createElement('div');
  menu.className='task-action-menu';
  menu.setAttribute('role','menu');
  const rows=[
    {ic:'→', label:'Move to list…', run:()=>showTaskListPickerSheet(id)},
    {ic:t.starred?'★':'☆', label:t.starred?'Unpin':'Pin to top', run:()=>toggleStar(id)},
    {ic:'+', label:'Add subtask', run:()=>addSubtaskPrompt(id)},
    {ic:'×', label:'Delete', danger:true, run:()=>removeTask(id)},
  ];
  rows.forEach(r=>{
    const b=document.createElement('button');
    b.type='button';
    b.className='tam-item'+(r.danger?' tam-danger':'');
    b.setAttribute('role','menuitem');
    const ic=document.createElement('span');ic.className='tam-ic';ic.setAttribute('aria-hidden','true');ic.textContent=r.ic;
    const lb=document.createElement('span');lb.textContent=r.label;
    b.append(ic,lb);
    b.onclick=()=>{ closeTaskActionMenu(); r.run(); };
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  // Position under the anchor, flipping above / clamping to the viewport.
  const r=anchor?anchor.getBoundingClientRect():{top:80,bottom:80,right:window.innerWidth-12};
  const mw=menu.offsetWidth, mh=menu.offsetHeight;
  let top=r.bottom+6, left=r.right-mw;
  if(left<8) left=8;
  if(top+mh>window.innerHeight-8) top=Math.max(8,r.top-mh-6);
  menu.style.top=top+'px';
  menu.style.left=left+'px';
  _taskActionMenuEl=menu;
  setTimeout(()=>{
    document.addEventListener('mousedown',_tamOutside,true);
    document.addEventListener('keydown',_tamKey,true);
  },0);
  const first=menu.querySelector('.tam-item'); if(first){ try{ first.focus(); }catch(_){} }
}
window.showTaskActionMenu=showTaskActionMenu;
window.closeTaskActionMenu=closeTaskActionMenu;

// ── Swipe-right list picker ─────────────────────────────────────────────────
// Right-swipe on a task row opens this popover of every OTHER list. Picking one
// moves the task there with an Undo toast. Reuses the row-overflow menu's
// element slot + outside-click/Esc handlers so only one popover lives at a time.
function _moveTaskToList(id,newListId){
  const t=findTask(id); if(!t) return;
  const prev = t.listId==null?null:t.listId;
  if(prev===newListId) return;
  const before={listId:prev};
  t.listId=newListId;
  if(typeof recordTaskActivity==='function') recordTaskActivity(t,before);
  if(typeof invalidateListVectorCache==='function') invalidateListVectorCache();
  if(typeof saveState==='function') saveState('user');
  window._preserveTaskScroll = true;
  if(typeof renderTaskList==='function') renderTaskList();
  const dest=(Array.isArray(lists)?lists.find(l=>l.id===newListId):null);
  if(typeof showActionToast==='function'){
    showActionToast('Moved to "'+((dest&&dest.name)||'list')+'"','Undo',()=>{
      const u=findTask(id); if(!u) return;
      u.listId=prev;
      if(typeof invalidateListVectorCache==='function') invalidateListVectorCache();
      if(typeof saveState==='function') saveState('user');
      if(typeof renderTaskList==='function') renderTaskList();
    },5000);
  }
}
function showTaskListPickerSheet(id){
  const t=findTask(id); if(!t) return;
  const others=(Array.isArray(lists)?lists:[]).filter(l=>l.id!==t.listId);
  if(!others.length){
    if(typeof showActionToast==='function') showActionToast('Create another list to move tasks into','',null,3000);
    return;
  }
  closeTaskActionMenu();
  const menu=document.createElement('div');
  menu.className='task-action-menu';
  menu.setAttribute('role','menu');
  const hdr=document.createElement('div');
  hdr.className='tam-hdr';
  hdr.textContent='Move to list';
  menu.appendChild(hdr);
  others.forEach(l=>{
    const b=document.createElement('button');
    b.type='button';
    b.className='tam-item';
    b.setAttribute('role','menuitem');
    const ic=document.createElement('span');ic.className='tam-ic';ic.setAttribute('aria-hidden','true');ic.textContent='→';
    const lb=document.createElement('span');lb.textContent=l.name||'Untitled list';
    b.append(ic,lb);
    b.onclick=()=>{ closeTaskActionMenu(); _moveTaskToList(id,l.id); };
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  // No anchor button on a swipe — position against the task row's right edge,
  // flipping above / clamping to the viewport like showTaskActionMenu does.
  const row=document.querySelector('.task-item[data-task-id="'+id+'"]');
  const r=row?row.getBoundingClientRect():{top:80,bottom:120,right:window.innerWidth-12};
  const mw=menu.offsetWidth, mh=menu.offsetHeight;
  const vw=window.innerWidth, vh=window.innerHeight;
  let top=r.bottom+6, left=r.right-mw;
  // Clamp horizontally to the viewport - the previous code only clamped the
  // LEFT edge, so on narrow mobile viewports a menu wider than r.right (a
  // long list name etc.) could have its RIGHT side cut off, leaving only
  // the leftmost part of the column reachable.
  if(left + mw > vw - 8) left = vw - mw - 8;
  if(left < 8) left = 8;
  if(top+mh>vh-8) top=Math.max(8, r.top-mh-6);
  if(top < 8) top = 8;
  menu.style.top=top+'px';
  menu.style.left=left+'px';
  _taskActionMenuEl=menu;
  setTimeout(()=>{
    document.addEventListener('mousedown',_tamOutside,true);
    document.addEventListener('keydown',_tamKey,true);
  },0);
  const first=menu.querySelector('.tam-item'); if(first){ try{ first.focus(); }catch(_){} }
}
window.showTaskListPickerSheet=showTaskListPickerSheet;

// Recurrence dropdown - opens a Dropdown popover (or bottom-sheet on
// mobile) for the 11 recurrence options. Replaces the previous chip-row
// pattern that wrapped onto multiple lines on narrow viewports. The
// onSelect callback mutates the live task object the modal is editing.
function openRecurDropdown(){
  if(typeof Dropdown === 'undefined' || !Dropdown.open) return;
  const trigger = gid('mdRecurTrigger');
  const label = gid('mdRecurLabel');
  const hidden = gid('mdRecur');
  if(!trigger || editingTaskId == null) return;
  const t = findTask(editingTaskId);
  if(!t) return;
  const rows = window._recurOptions || [];
  const options = rows.map(function(r){ return { value: r[0], label: r[1] }; });
  Dropdown.open(trigger, {
    options: options,
    selected: t.recur || 'none',
    onSelect: function(key){
      const hadRecur = !!t.recur;
      t.recur=key==='none'?null:key;
      const row = rows.find(function(r){ return r[0] === key; });
      if(label) label.textContent = row ? row[1] : 'No repeat';
      if(hidden) hidden.value = key;
      // First-time recurrence on a task with no due date defaults to today
      // so it actually shows up in Today / Habits views immediately.
      // Mirrors the same behaviour the old chip-click handler had.
      if(t.recur && !t.dueDate && typeof todayISO === 'function') t.dueDate = todayISO();
      if(t.recur && typeof _pinTaskVisibleBriefly === 'function') _pinTaskVisibleBriefly(t.id, 8000);
      if(typeof _commitChipChange === 'function') _commitChipChange(t);
      if(t.recur && !hadRecur && typeof showActionToast === 'function'){
        const rowLbl = row ? row[1] : String(t.recur);
        showActionToast('Repeats ' + rowLbl + ' — also in Habits view', null, null, 4500);
      }
    },
  });
}
window.openRecurDropdown = openRecurDropdown;

// List dropdown - opens a Dropdown popover for the task's destination
// list. Each option carries the list's color metadata so the dropdown
// renders a small swatch beside the name, matching the chip-based color
// language used elsewhere. saveTaskDetail still reads gid('mdList').value,
// so the dropdown writes the selected id into the hidden <select>.
function openListDropdown(){
  if(typeof Dropdown === 'undefined' || !Dropdown.open) return;
  const trigger = gid('mdListTrigger');
  const sel = gid('mdList');
  const label = gid('mdListLabel');
  if(!trigger || !sel) return;
  const allLists = (typeof lists !== 'undefined' && Array.isArray(lists)) ? lists : [];
  const options = Array.prototype.slice.call(sel.options).map(function(o){
    const found = allLists.find(function(L){ return String(L.id) === String(o.value); });
    const rawColor = found && found.color ? found.color : null;
    const safeColor = (rawColor && typeof sanitizeListColor === 'function')
      ? sanitizeListColor(rawColor) : rawColor;
    return { value: o.value, label: o.textContent, color: safeColor };
  });
  Dropdown.open(trigger, {
    options: options,
    selected: sel.value,
    searchable: options.length > 8,
    onSelect: function(value){
      sel.value = value;
      const opt = options.find(function(o){ return String(o.value) === String(value); });
      if(label) label.textContent = opt ? opt.label : 'List';
      if(editingTaskId != null && typeof _commitChipChange === 'function'){
        const t = findTask(editingTaskId);
        if(t){ t.listId = parseInt(value, 10) || t.listId; _commitChipChange(t); }
      }
    },
  });
}
window.openListDropdown = openListDropdown;

function saveTaskDetail(){
  if(!editingTaskId)return;
  const t=findTask(editingTaskId);if(!t)return;
  // C-2: snapshot the fields we'll diff against post-save so we can append
  // a per-field activity entry. Snapshot is a shallow copy of relevant fields.
  const _activityBefore = {
    name: t.name, dueDate: t.dueDate, hiddenUntil: t.hiddenUntil, startDate: t.startDate,
    estimateMin: t.estimateMin, description: t.description, url: t.url,
    completionNote: t.completionNote, remindAt: t.remindAt, listId: t.listId,
    status: t.status, priority: t.priority, category: t.category,
    effort: t.effort, energyLevel: t.energyLevel, type: t.type,
    starred: t.starred,
    tags: Array.isArray(t.tags) ? t.tags.slice() : [],
    valuesAlignment: Array.isArray(t.valuesAlignment) ? t.valuesAlignment.slice() : [],
    relatedTo: Array.isArray(t.relatedTo) ? t.relatedTo.slice() : [],
    recur: t.recur,
  };
  try{
  if(t.recur&&t.status==='done'&&typeof completeHabitCycle==='function'&&!t._habitCycledInSession){
    completeHabitCycle(t);
    gid('mdCheckbox').classList.remove('checked');gid('mdCheckbox').textContent='';
  }
  t.name=gid('mdName').value.trim()||t.name;
  const _newDue = gid('mdDue').value || null;
  const _dueChanged = _newDue !== t.dueDate;
  t.dueDate = _newDue;
  // Re-arm the implicit 09:00 reminder whenever the due date changes — without
  // this, rescheduling a task that had already fired its reminder leaves it
  // permanently muted (#19 in UX audit).
  if(_dueChanged) t.reminderFired = false;
  if(gid('mdSnoozeUntil')) t.hiddenUntil=gid('mdSnoozeUntil').value||null;
  t.startDate=gid('mdStartDate').value||null;
  t.estimateMin=parseInt(gid('mdEstimate').value)||0;
  t.description=gid('mdDesc').value;
  t.url=gid('mdUrl').value.trim()||null;
  t.completionNote=gid('mdCompletionNote').value.trim()||null;
  const ra=gid('mdRemindAt')?gid('mdRemindAt').value:'';
  const _remindChanged = ra && ra !== t.remindAt;
  if(ra!==t.remindAt){t.remindAt=ra||null;t.reminderFired=false}
  // If they set a due date or reminder but the browser's notification
  // permission is still 'default', a one-shot toast offers to enable it.
  // Without this, reminders silently never fire and the feature feels broken.
  if((_dueChanged || _remindChanged) && typeof _maybeNudgeNotifPerm === 'function') _maybeNudgeNotifPerm();
  t.listId=parseInt(gid('mdList').value)||t.listId;
  const _recurEl = gid('mdRecur');
  if(_recurEl){
    const rk = _recurEl.value;
    t.recur = (rk === 'none' || !rk) ? null : rk;
  }
  if(t.status==='done'&&!t.completedAt)t.completedAt=stampCompletion();
  if(t.status!=='done')t.completedAt=null;
  // C-2: record diffs into task.activity[] (cap at 50 entries)
  if(typeof recordTaskActivity === 'function') recordTaskActivity(t, _activityBefore);
  _taskModalSnapshot=null;
  Modal.close('taskModal');
  editingTaskId=null;
  }finally{
    try{ delete t._habitCycledInSession; }catch(e){}
  }
  window._preserveTaskScroll = true;
  renderTaskList();
  saveState('user');
  if(typeof _updateActiveTaskTickSchedule==='function')_updateActiveTaskTickSchedule();
}
function deleteTaskFromModal(){
  if(!editingTaskId)return;
  const id=editingTaskId;closeTaskDetail({skipRevert:true});removeTask(id);
}
function toggleTaskDone(){
  if(!editingTaskId)return;
  const t=findTask(editingTaskId);if(!t)return;
  if(t.status==='done'){t.status='open';t.completedAt=null;gid('mdCheckbox').classList.remove('checked');gid('mdCheckbox').textContent=''}
  else if(t.recur&&typeof completeHabitCycle==='function'){
    completeHabitCycle(t);
    gid('mdCheckbox').classList.remove('checked');gid('mdCheckbox').textContent='';
    renderMdHabitLog(t);
    renderMdSessions(t);
    gid('mdTracked').textContent=fmtHMS(getRolledUpTime(t.id))+' · '+getRolledUpSessions(t.id)+' sessions';
  }else{t.status='done';t.completedAt=stampCompletion();gid('mdCheckbox').classList.add('checked');gid('mdCheckbox').textContent='✓'}
  // Update status chips
  const sChips=gid('mdStatusChips');if(sChips){[...sChips.children].forEach((c,i)=>c.classList.toggle('active',STATUS_ORDER[i]===t.status))}
  _commitChipChange(t);
}

function renderBanner(){
  const b=gid('banner');
  if(!activeTaskId){b.hidden = true;return}
  const t=findTask(activeTaskId);if(!t){b.hidden = true;return}
  b.hidden = false;
  const path=getTaskPath(activeTaskId);
  const bel=gid('bannerTask');
  if(path.length>1){
    bel.textContent='';const bc=document.createElement('span');bc.className='task-breadcrumb';bc.textContent=path.slice(0,-1).join(' › ')+' › ';bel.appendChild(bc);bel.append(t.name);
  }else{
    bel.textContent=t.name;
  }
  gid('bannerTime').textContent=fmtHMS(getTaskElapsed(t))
}
/** H1: Previously this re-rendered the whole task list every second, which
 *  burned CPU and reset scroll/hover state on long lists. Now we only patch
 *  the active row's live-time chip and re-render the floating banner. If the
 *  active row isn't currently rendered (filtered out, archive view, etc.),
 *  we silently no-op. A full render still happens on real state changes. */
function _tickActiveTaskRow(){
  if(!activeTaskId) return;
  const t=findTask(activeTaskId);
  if(!t){ renderBanner(); return; }
  const row=document.querySelector('.task-item[data-task-id="'+activeTaskId+'"]');
  if(row){
    let chip=row.querySelector('.sig-active');
    const elapsed=fmtHMS(getRolledUpTime(t.id));
    if(chip){
      chip.textContent='● '+elapsed;
    }else{
      const signals=row.querySelector('.task-signals');
      if(signals){
        chip=document.createElement('span');
        chip.className='task-sig sig-active';
        chip.title='Tracking time';
        chip.textContent='● '+elapsed;
        signals.appendChild(chip);
      }
    }
  }
  renderBanner();
}
let _activeTaskTickId=null;
function _updateActiveTaskTickSchedule(){
  if(activeTaskId){
    if(!_activeTaskTickId) _activeTaskTickId=setInterval(_tickActiveTaskRow,1000);
  }else if(_activeTaskTickId){
    clearInterval(_activeTaskTickId);
    _activeTaskTickId=null;
  }
}
window._updateActiveTaskTickSchedule=_updateActiveTaskTickSchedule;

// ========== APP DIALOGS (replace native confirm/prompt) ==========
let _appConfirmResolve=null;
function closeAppConfirm(ok){
  const fn=_appConfirmResolve;
  _appConfirmResolve=null;
  Modal.close('appConfirmModal');
  if(fn) fn(!!ok);
}
function showAppConfirm(message){
  return new Promise(resolve=>{
    const ov=gid('appConfirmModal'), m=gid('appConfirmMessage');
    if(!ov||!m){ resolve(confirm(message)); return; }
    m.textContent=message;
    _appConfirmResolve=resolve;
    // Modal.open captures prev-focus via openFocusTrap and restores on close.
    // skipInitialFocus + focus:'#appConfirmOk' = trap watches Tab; we pick
    // the OK button as the initial target (matches the original 30ms focus).
    Modal.open('appConfirmModal', { variant:'dialog', focus:'#appConfirmOk', skipInitialFocus:true, onRequestClose:()=>closeAppConfirm(false) });
  });
}

// Reusable side-by-side delta dialog for destructive imports. Builds a
// rich body (heading + delta rows + warning) into the existing app-confirm
// modal so we don't need a second modal element. Numbers only — task
// content never enters the prompt.
function showImportConfirm(summary){
  return new Promise(resolve => {
    const ov = gid('appConfirmModal'), m = gid('appConfirmMessage');
    if(!ov || !m){
      resolve(confirm(`Replace current ${summary.current.tasks} tasks with ${summary.incoming.tasks} from backup?`));
      return;
    }
    m.replaceChildren();
    const h = document.createElement('div');
    h.className = 'import-delta-title';
    h.textContent = 'Restore from backup?';
    m.appendChild(h);
    const tbl = document.createElement('div');
    tbl.className = 'import-delta-grid';
    const rows = [
      ['', 'Current', 'After import'],
      ['Tasks',    summary.current.tasks,    summary.incoming.tasks],
      ['Lists',    summary.current.lists,    summary.incoming.lists],
    ];
    rows.forEach((row, i) => {
      row.forEach((cell, j) => {
        const c = document.createElement('div');
        c.textContent = String(cell);
        if(i === 0){
          c.className = 'import-delta-colhead';
        }
        else if(j > 0){
          c.className = 'import-delta-num';
        }
        tbl.appendChild(c);
      });
    });
    m.appendChild(tbl);
    if(summary.archiveDays != null){
      const a = document.createElement('div');
      a.className = 'import-delta-note';
      a.textContent = `Plus ${summary.archiveDays} archived day${summary.archiveDays === 1 ? '' : 's'}.`;
      m.appendChild(a);
    }
    const w = document.createElement('div');
    w.className = 'import-delta-warn';
    w.textContent = '⚠ This replaces all current tasks, lists, and settings. Cannot be undone.';
    m.appendChild(w);
    _appConfirmResolve = resolve;
    Modal.open('appConfirmModal', { variant:'dialog', focus:'#appConfirmOk', skipInitialFocus:true, onRequestClose:()=>closeAppConfirm(false) });
  });
}
if(typeof window !== 'undefined') window.showImportConfirm = showImportConfirm;
let _appPromptResolve=null,_appPromptMultiline=false;
function _appPromptTextareaKeydown(e){
  if(!_appPromptMultiline) return;
  if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){
    e.preventDefault();
    submitAppPrompt();
  }
}
function closeAppPrompt(val){
  const multi=gid('appPromptTextarea');
  if(multi && multi._appPromptKd){
    multi.removeEventListener('keydown', multi._appPromptKd);
    multi._appPromptKd=null;
  }
  const fn=_appPromptResolve;
  _appPromptResolve=null;
  _appPromptMultiline=false;
  Modal.close('appPromptModal');
  if(fn) fn(val);
}
function submitAppPrompt(){
  const single=gid('appPromptInput'), multi=gid('appPromptTextarea');
  let v='';
  if(_appPromptMultiline&&multi) v=multi.value;
  else if(single) v=single.value;
  closeAppPrompt(v);
}
function showAppPrompt(label, defaultValue, opts){
  opts=opts||{};
  return new Promise(resolve=>{
    const ov=gid('appPromptModal'), lb=gid('appPromptLabel'), single=gid('appPromptInput'), multi=gid('appPromptTextarea');
    if(!ov||!lb){ resolve(prompt(label, defaultValue||'')||null); return; }
    const useMulti=!!opts.multiline;
    _appPromptMultiline=useMulti;
    lb.textContent=label;
    if(lb.setAttribute) lb.setAttribute('for', useMulti ? 'appPromptTextarea' : 'appPromptInput');
    if(single){ single.hidden = !!(useMulti); single.value=defaultValue||'' }
    if(multi){
      if(multi._appPromptKd){ multi.removeEventListener('keydown', multi._appPromptKd); multi._appPromptKd=null }
      multi.hidden = !(useMulti);
      multi.value=defaultValue||'';
      if(useMulti){
        multi._appPromptKd=_appPromptTextareaKeydown;
        multi.addEventListener('keydown', multi._appPromptKd);
      }
    }
    _appPromptResolve=resolve;
    const focusSel = useMulti ? '#appPromptTextarea' : '#appPromptInput';
    Modal.open('appPromptModal', { variant:'dialog', focus:focusSel, skipInitialFocus:true, onRequestClose:()=>closeAppPrompt(null) });
  });
}
window.closeAppConfirm=closeAppConfirm;
window.closeAppPrompt=closeAppPrompt;
window.submitAppPrompt=submitAppPrompt;
window.showAppConfirm=showAppConfirm;
window.showAppPrompt=showAppPrompt;

// Legacy ESC chain removed in Stage 3 — every overlay now routes through
// js/modal.js's capture-phase ESC listener (via onRequestClose hooks).

// ========== LOG ==========
function addLog(name,durSec,type){timeLog.unshift({id:++logIdCtr,name,durSec,type,time:timeNow()});renderLog();saveState('user')}
function removeLog(id){timeLog=timeLog.filter(l=>l.id!==id);renderLog();saveState('user')}
function renderLog(){const list=gid('logList');list.querySelectorAll('.log-item').forEach(e=>e.remove());if(!timeLog.length){gid('logEmpty').hidden = false;return}gid('logEmpty').hidden = true;timeLog.slice(0,40).forEach(l=>{const d=document.createElement('div');d.className='log-item';const col=l.type==='work'?'var(--work)':l.type==='short'?'var(--short)':l.type==='quick'?'var(--quick-accent)':'var(--long)';const lid=l.id||0;const dot=document.createElement('div');dot.className='log-dot';dot.style.background=col;d.appendChild(dot);const nm=document.createElement('span');nm.className='log-name';nm.textContent=l.name;d.appendChild(nm);const dur=document.createElement('span');dur.className='log-dur';dur.textContent=fmtShort(l.durSec);d.appendChild(dur);const tm=document.createElement('span');tm.className='log-time';tm.textContent=l.time;d.appendChild(tm);if(lid){const del=document.createElement('button');del.className='log-del';del.title='Remove';del.textContent='×';del.setAttribute('aria-label','Remove log entry');del.onclick=function(){removeLog(lid)};d.appendChild(del)}list.appendChild(d)})}
async function clearLog(){
  if(!timeLog.length) return;
  const msg = 'Clear ' + timeLog.length + ' time-log entr' + (timeLog.length===1?'y':'ies') + '? This cannot be undone.';
  if(typeof showAppConfirm === 'function'){
    if(!(await showAppConfirm(msg))) return;
  } else if(!confirm(msg)) return;
  timeLog=[];renderLog();saveState('user');
}
window.clearLog = clearLog;

// ========== TAB NAVIGATION ==========
function showTab(tab){
  if(typeof closeCmdK==='function')closeCmdK();
  activeTab=tab;
  document.querySelectorAll('[data-tab]').forEach(el=>{el.hidden = !(el.dataset.tab===tab)});
  document.querySelectorAll('.nav-tab').forEach(el=>{
    const on=el.dataset.navtab===tab;
    el.classList.toggle('active',on);
    el.setAttribute('aria-selected',on?'true':'false');
    // aria-current also marks navigation membership for screen readers that
    // navigate by page/section (in addition to the tablist's aria-selected).
    if(on) el.setAttribute('aria-current','page'); else el.removeAttribute('aria-current');
  });
  if(tab==='settings'){
    // Refresh the dynamic sub-managers so legacy data (renamed categories,
    // newly added lists) shows up immediately when the tab is opened.
    if(typeof renderClassificationSettings==='function') renderClassificationSettings();
    if(typeof renderListsManager==='function') renderListsManager();
  }
  const nav=gid('navTabs');
  if(nav&&nav.getBoundingClientRect().top<0){
    window.scrollTo({top:nav.offsetTop-20,behavior:'smooth'});
  }
  if(tab==='focus'&&typeof setTimerSub==='function') setTimerSub(cfg.timerSub||'pomo');
  updateMiniTimer();
  saveState('auto');
}

// Mark panels as "entered" after initial animation so repeat visits don't re-trigger
(function(){
  let _enteredTabs = {};
  const _origShowTab = window.showTab;
  window.showTab = function(tab) {
    _origShowTab(tab);
    if(!_enteredTabs[tab]) {
      const panel = document.querySelector('[data-tab="' + tab + '"]:not([hidden])');
      if(panel) {
        setTimeout(() => {
          panel.setAttribute('data-panel-entered', '1');
          _enteredTabs[tab] = true;
        }, 360);
      }
    }
  };
})();

// Session completion summary: celebrate work phase completion with closure toast
window.showPomodoroSummary=function(){
  const pomosToday=window.totalPomos||0;
  const activeId=window.activeTaskId;
  let taskName='';
  if(activeId&&typeof window.findTask==='function'){
    const t=window.findTask(activeId);
    taskName=t?.name||'';
  }
  const msg=taskName?'Focus session complete — '+taskName:'Focus session complete!';
  if(typeof window.showActionToast==='function'){
    window.showActionToast(msg+(pomosToday>1?' · '+pomosToday+' today':''),null,null,5000);
  }
};

// ========== TASK ATTACHMENTS (modal) ==========
let _mdAttachUrls = [];
let _mdAttachLightboxUrl = null;
let _mdVoiceSession = null;

function _pickMdAudioMime(){
  if(typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  for(let i = 0; i < candidates.length; i++){
    if(MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
  }
  return '';
}

function _abortMdVoiceRecording(){
  const s = _mdVoiceSession;
  if(!s) return;
  _mdVoiceSession = null;
  try{
    if(s.recorder && s.recorder.state !== 'inactive') s.recorder.stop();
  }catch(_){}
  if(s.stream) s.stream.getTracks().forEach(t => { try{ t.stop(); }catch(_){} });
  if(s.saveOnStop) s.saveOnStop = false;
}

function _revokeMdAttachUrls(){
  _mdAttachUrls.forEach(u=>{
    if(u === _mdAttachLightboxUrl) return;
    try{ URL.revokeObjectURL(u); }catch(_){}
  });
  _mdAttachUrls = _mdAttachUrls.filter(u => u === _mdAttachLightboxUrl);
}

function closeAttachLightbox(){
  const overlay = gid('attachLightbox');
  if(overlay) overlay.classList.remove('open');
  if(_mdAttachLightboxUrl){
    try{ URL.revokeObjectURL(_mdAttachLightboxUrl); }catch(_){}
    const i = _mdAttachUrls.indexOf(_mdAttachLightboxUrl);
    if(i >= 0) _mdAttachUrls.splice(i, 1);
    _mdAttachLightboxUrl = null;
  }
  const body = overlay && overlay.querySelector('.attach-lightbox-body');
  if(body) body.replaceChildren();
}

function openAttachLightboxBlob(blob){
  if(!blob || !(blob instanceof Blob)) return;
  let overlay = gid('attachLightbox');
  if(!overlay){
    overlay = document.createElement('div');
    overlay.id = 'attachLightbox';
    overlay.className = 'attach-lightbox';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Attachment preview');
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'attach-lightbox-close';
    closeBtn.setAttribute('aria-label', 'Close preview');
    closeBtn.textContent = '×';
    closeBtn.onclick = closeAttachLightbox;
    const body = document.createElement('div');
    body.className = 'attach-lightbox-body';
    overlay.append(closeBtn, body);
    overlay.addEventListener('click', e => { if(e.target === overlay) closeAttachLightbox(); });
    document.body.appendChild(overlay);
  }
  closeAttachLightbox();
  const url = URL.createObjectURL(blob);
  _mdAttachLightboxUrl = url;
  const body = overlay.querySelector('.attach-lightbox-body');
  const img = document.createElement('img');
  img.src = url;
  img.alt = 'Full-size attachment';
  body.appendChild(img);
  overlay.classList.add('open');
}
window.closeAttachLightbox = closeAttachLightbox;

/** Keep modal discard from reverting attachment ids while blobs stay in IDB. */
function _commitAttachmentChange(taskId){
  if(!_taskModalSnapshot || editingTaskId !== taskId) return;
  const t = typeof findTask === 'function' ? findTask(taskId) : null;
  if(!t) return;
  _taskModalSnapshot.attachments = Array.isArray(t.attachments) ? t.attachments.slice() : [];
}
window._commitAttachmentChange = _commitAttachmentChange;

document.addEventListener('keydown', e => {
  if(e.key !== 'Escape') return;
  const lb = gid('attachLightbox');
  if(lb && lb.classList.contains('open')){
    e.preventDefault();
    e.stopPropagation();
    closeAttachLightbox();
  }
}, true);

async function renderMdAttachments(taskId){
  const host = gid('mdAttachments');
  if(!host) return;
  if(_mdVoiceSession && _mdVoiceSession.taskId !== taskId) _abortMdVoiceRecording();
  _revokeMdAttachUrls();
  host.replaceChildren();
  if(typeof listTaskAttachments !== 'function') return;
  const rows = await listTaskAttachments(taskId);
  const tools = document.createElement('div');
  tools.className = 'md-attach-tools';
  const photoLbl = document.createElement('label');
  photoLbl.className = 'btn-ghost btn-sm';
  photoLbl.textContent = 'Add photo';
  const photoIn = document.createElement('input');
  photoIn.type = 'file';
  photoIn.accept = 'image/*';
  photoIn.capture = 'environment';
  photoIn.hidden = true;
  photoIn.onchange = async () => {
    const f = photoIn.files && photoIn.files[0];
    photoIn.value = '';
    if(f && typeof addImageAttachment === 'function'){
      await addImageAttachment(taskId, f);
      _commitAttachmentChange(taskId);
      renderMdAttachments(taskId);
    }
  };
  photoLbl.appendChild(photoIn);
  tools.appendChild(photoLbl);

  let recBtn = null;
  if(typeof MediaRecorder !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia){
    recBtn = document.createElement('button');
    recBtn.type = 'button';
    recBtn.className = 'btn-ghost btn-sm';
    recBtn.textContent = 'Record voice';
    recBtn.onclick = async () => {
      if(_mdVoiceSession && _mdVoiceSession.taskId === taskId && _mdVoiceSession.recorder.state !== 'inactive'){
        _mdVoiceSession.saveOnStop = true;
        try{ if(_mdVoiceSession.recorder.state === 'recording') _mdVoiceSession.recorder.requestData(); }catch(_){}
        _mdVoiceSession.recorder.stop();
        return;
      }
      if(_mdVoiceSession) _abortMdVoiceRecording();
      try{
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const chunks = [];
        const mime = _pickMdAudioMime();
        const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        const blobType = mime || recorder.mimeType || 'audio/webm';
        recorder.ondataavailable = e => { if(e.data && e.data.size) chunks.push(e.data); };
        recorder.onstop = async () => {
          stream.getTracks().forEach(t => { try{ t.stop(); }catch(_){} });
          const session = _mdVoiceSession;
          _mdVoiceSession = null;
          const btn = session && session.recBtn;
          if(btn){
            btn.textContent = 'Record voice';
            btn.classList.remove('on');
          }
          if(!session || !session.saveOnStop) return;
          if(!chunks.length){
            if(typeof toast === 'function') toast('No audio captured — try again');
            return;
          }
          const blob = new Blob(chunks, { type: blobType });
          if(blob.size < 1){
            if(typeof toast === 'function') toast('Recording too short');
            return;
          }
          if(typeof addAudioAttachment === 'function'){
            await addAudioAttachment(taskId, blob, blobType);
            _commitAttachmentChange(taskId);
            renderMdAttachments(taskId);
          }
        };
        recorder.onerror = () => {
          if(typeof toast === 'function') toast('Recording failed');
          _abortMdVoiceRecording();
          recBtn.textContent = 'Record voice';
          recBtn.classList.remove('on');
        };
        _mdVoiceSession = { taskId, recorder, stream, recBtn, saveOnStop: false };
        recorder.start(250);
        recBtn.textContent = 'Stop';
        recBtn.classList.add('on');
      }catch(e){
        if(typeof toast === 'function') toast('Microphone access denied or unavailable');
      }
    };
    if(_mdVoiceSession && _mdVoiceSession.taskId === taskId){
      _mdVoiceSession.recBtn = recBtn;
      recBtn.textContent = 'Stop';
      recBtn.classList.add('on');
    }
    tools.appendChild(recBtn);
  } else {
    const noRec = document.createElement('p');
    noRec.className = 'intel-muted md-attach-voice-hint';
    noRec.textContent = 'Voice recording needs a browser with microphone support (Chrome, Edge, Firefox).';
    tools.appendChild(noRec);
  }
  host.appendChild(tools);

  const grid = document.createElement('div');
  grid.className = 'md-attach-grid';
  for(const row of rows){
    const card = document.createElement('div');
    card.className = 'md-attach-card md-attach-'+row.kind;
    if(row.kind === 'image' && typeof _attachGet === 'function'){
      const full = await _attachGet(row.id);
      if(full && full.blob){
        const url = attachmentObjectUrl(full);
        if(url){
          _mdAttachUrls.push(url);
          const img = document.createElement('img');
          img.src = url;
          img.alt = 'Attachment';
          img.className = 'md-attach-thumb';
          img.title = 'View full size';
          img.tabIndex = 0;
          img.setAttribute('role', 'button');
          img.setAttribute('aria-label', 'View full-size photo');
          const openFull = e => {
            e.stopPropagation();
            openAttachLightboxBlob(full.blob);
          };
          img.addEventListener('click', openFull);
          img.addEventListener('keydown', e => {
            if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); openFull(e); }
          });
          card.appendChild(img);
        }
      }
    } else if(row.kind === 'audio' && typeof _attachGet === 'function'){
      const full = await _attachGet(row.id);
      if(full && full.blob){
        const url = attachmentObjectUrl(full);
        if(url){
          _mdAttachUrls.push(url);
          const aud = document.createElement('audio');
          aud.controls = true;
          aud.src = url;
          card.appendChild(aud);
        }
      }
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'md-attach-del';
    del.textContent = '×';
    del.setAttribute('aria-label', 'Remove attachment');
    del.onclick = async () => {
      if(typeof removeAttachment === 'function') await removeAttachment(taskId, row.id);
      _commitAttachmentChange(taskId);
      renderMdAttachments(taskId);
    };
    card.appendChild(del);
    grid.appendChild(card);
  }
  if(!rows.length){
    const hint = document.createElement('p');
    hint.className = 'intel-muted';
    hint.textContent = 'Photos and voice notes stay on this device (not synced).';
    grid.appendChild(hint);
  }
  host.appendChild(grid);
}
window.renderMdAttachments = renderMdAttachments;

// ========== FLOATING MINI TIMER ==========
// Show the mini-timer when not on the Timer (focus) tab. Click it to jump to Timer.
window.toggleSimilarAccordion = function(){
  const acc = gid('mdSimilarAccordion');
  if(acc) acc.classList.toggle('open');
};

function updateMiniTimer(){
  const el=gid('timerDock')||gid('miniTimer');if(!el)return;
  // Hide on the Timer tab (the full timer is already visible there)
  if(activeTab==='focus'){el.classList.remove('visible');return}
  el.classList.add('visible');
  // Phase styling
  el.classList.remove('work','short','long');el.classList.add(phase);
  const dot=gid('mtDot');dot.classList.remove('work','short','long','running');
  dot.classList.add(phase);if(running)dot.classList.add('running');
  // Label & time
  gid('mtLabel').textContent=getPL(phase);
  const timeEl=gid('mtTime');
  timeEl.textContent=fmt(remaining);
  timeEl.classList.remove('warn','done');
  if(finished)timeEl.classList.add('done');
  else if(remaining<=10&&running)timeEl.classList.add('warn');
  // Button state
  const btn=gid('mtToggle');
  btn.classList.remove('mt-play','mt-pause');
  if(running){btn.classList.add('mt-pause');btn.textContent='⏸'}
  else if(finished){btn.classList.add('mt-play');btn.textContent='↻'}
  else{btn.classList.add('mt-play');btn.textContent='▶'}
}
function miniTimerToggle(){
  if(finished){advancePhase();return}
  if(running)pauseTimer();
  else if(remaining<totalDuration&&remaining>0)resumeTimer();
  else startTimer();
  updateMiniTimer()
}

// Floating quick-add FAB handler. Jumps to Tasks, scrolls the new-task input
// into view, focuses it. Same flow as Cmd+N — the FAB is the touch-friendly
// surface for users who don't have a keyboard handy.
// Relocate the add-task cluster into the bottom sheet (mobile) and focus it.
function openQuickAddSheet(){
  const host=document.getElementById('quickAddHost');
  const slot=document.getElementById('quickAddSheetSlot');
  if(host&&slot&&host.parentElement!==slot) slot.appendChild(host);
  openSheet('quickAddSheet');
  const inp=document.getElementById('taskInput');
  if(inp) requestAnimationFrame(()=>{
    try{ inp.focus(); inp.select&&inp.select(); }catch(_){}
    if(typeof maybeShowEnhanceBtn === 'function') maybeShowEnhanceBtn();
  });
}
// Move the cluster back to its inline anchor so closeSheet leaves the DOM as it
// found it (the anchor is CSS-hidden on mobile, visible on desktop).
function _restoreQuickAddHost(){
  const host=document.getElementById('quickAddHost');
  const anchor=document.getElementById('quickAddAnchor');
  if(host&&anchor&&host.parentElement!==anchor) anchor.appendChild(host);
}
window.openQuickAddSheet=openQuickAddSheet;
window.closeQuickAddSheet=()=>closeSheet('quickAddSheet');
window.closeQuickAddSheetOnBackdrop=(e)=>{ if(e&&e.target&&e.target.id==='quickAddSheet') closeSheet('quickAddSheet'); };

function quickAddFabClick(){
  const fab = document.getElementById('quickAddFab');
  if(fab){ fab.classList.add('flash'); setTimeout(() => fab.classList.remove('flash'), 350); }
  if(typeof showTab === 'function') showTab('tasks');
  if(typeof haptic === 'function') haptic(10);
  // Mobile: open the thumb-zone sheet. Desktop: the inline form is always
  // visible (the FAB is display:none there anyway), so just focus it.
  if(matchMedia('(max-width:640px)').matches){ openQuickAddSheet(); return; }
  const inp = document.getElementById('taskInput');
  if(!inp) return;
  requestAnimationFrame(() => {
    try{ inp.focus(); inp.select && inp.select(); }catch(_){}
    inp.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}
window.quickAddFabClick = quickAddFabClick;

// Auto-hide the floating quick-add FAB while the user is scrolling DOWN
// through tasks (it was sitting over the last visible rows), and bring it
// back when they scroll UP or stop. Only the bottom-anchored visual is
// suppressed — the keyboard shortcut + Cmd+K path stays available. The
// listener is passive so it can't stall scroll, and it bails out early on
// desktop where the FAB is `display:none` anyway.
(function setupFabScrollHide(){
  if(typeof window === 'undefined' || typeof document === 'undefined') return;
  let lastY = window.scrollY || 0;
  let ticking = false;
  let restoreTm = 0;
  const TRIGGER_PX = 12; // ignore tiny rubber-band jitters
  const apply = () => {
    ticking = false;
    const fab = document.getElementById('quickAddFab');
    if(!fab) return;
    // Don't fight the CSS — desktop hides the FAB entirely, and the
    // keyboard-open inset already removes it.
    const cs = window.getComputedStyle(fab);
    if(cs.display === 'none'){ fab.classList.remove('scroll-hidden'); return; }
    const y = window.scrollY || 0;
    const dy = y - lastY;
    // Near the top — always show. Avoids a stuck-hidden FAB if the user
    // flicks down then taps Tasks to jump back up.
    if(y < 80){ fab.classList.remove('scroll-hidden'); lastY = y; return; }
    if(Math.abs(dy) < TRIGGER_PX){ lastY = y; return; }
    if(dy > 0) fab.classList.add('scroll-hidden');
    else       fab.classList.remove('scroll-hidden');
    lastY = y;
    // After the user stops scrolling, bring the FAB back so a still page
    // never leaves it hidden.
    clearTimeout(restoreTm);
    restoreTm = setTimeout(() => { fab.classList.remove('scroll-hidden'); }, 900);
  };
  window.addEventListener('scroll', () => {
    if(ticking) return;
    ticking = true;
    requestAnimationFrame(apply);
  }, { passive: true });
})();

// ========== STATS ==========
function renderStats(){
  gid('statPomos').textContent=totalPomos;
  const fm=Math.floor(totalFocusSec/60);
  gid('statFocus').textContent=fm>=60?Math.floor(fm/60)+'h '+fm%60+'m':fm+'m';
  gid('statBreaks').textContent=totalBreaks;
  const h=gid('historyBlocks');
  h.textContent='';
  sessionHistory.forEach(s=>{const b=document.createElement('div');b.className='hblock h'+s.type[0];h.appendChild(b)});
  // Empty state — when nothing has happened today, the three big "0"s look
  // like a rendering bug. Append a one-line hint so new users know what to
  // do next. Removed automatically once any session lands.
  let hint = gid('statsEmptyHint');
  if(totalPomos === 0 && (!sessionHistory || !sessionHistory.length)){
    if(!hint){
      hint = document.createElement('div');
      hint.id = 'statsEmptyHint';
      hint.className = 'stats-empty-hint';
      hint.textContent = 'No sessions yet today — press Start on the timer above to begin a focus block.';
      const host = h.parentNode;
      if(host) host.insertBefore(hint, h.nextSibling);
    }
  } else if(hint){
    hint.remove();
  }
  if(typeof renderStatsByArea==='function') renderStatsByArea();
  if(typeof renderFocusStreak==='function') renderFocusStreak();
}

// ========== G-17 STATS BY LIFE AREA ==========
// Pivot today's timeLog by the active task's category — purely from existing
// state (no new fields). Builds the DOM with createElement / textContent so
// untrusted task names can never form HTML.
function renderStatsByArea(){
  const host = gid('statsByArea');
  if(!host) return;
  const todays = timeLog.filter(l => l && l.type === 'work' && l.durSec > 0);
  host.replaceChildren();
  if(!todays.length){ host.hidden = true; return; }
  const byCat = new Map();
  for(const l of todays){
    const t = tasks.find(x => x.name === l.name);
    const cat = (t && t.category) || 'general';
    byCat.set(cat, (byCat.get(cat) || 0) + l.durSec);
  }
  const total = Array.from(byCat.values()).reduce((a,b)=>a+b,0);
  if(!total){ host.hidden = true; return; }
  host.hidden = false;
  const cats = (typeof getCategoryDefs === 'function') ? getCategoryDefs() : [];
  const labelFor = id => { const c = cats.find(c => c.id === id); return c ? c.label : id; };
  const colorFor = id => { const c = cats.find(c => c.id === id); return (c && c.accent) || 'var(--accent)'; };
  const title = document.createElement('div');
  title.className = 'sba-title';
  title.textContent = 'Today by life area';
  host.appendChild(title);
  const rows = Array.from(byCat.entries()).sort((a,b)=>b[1]-a[1]);
  rows.forEach(([id,sec])=>{
    const pct = Math.round((sec/total)*100);
    const mins = Math.round(sec/60);
    const row = document.createElement('div'); row.className = 'sba-row';
    const dot = document.createElement('span'); dot.className = 'sba-dot';
    dot.style.background = colorFor(id);
    dot.style.color = colorFor(id);
    const lbl = document.createElement('span'); lbl.className = 'sba-lbl'; lbl.textContent = labelFor(id);
    const bar = document.createElement('span'); bar.className = 'sba-bar';
    const fill = document.createElement('span'); fill.className = 'sba-bar-fill';
    fill.style.width = pct + '%'; fill.style.background = colorFor(id);
    bar.appendChild(fill);
    const val = document.createElement('span'); val.className = 'sba-val';
    val.textContent = mins + 'm · ' + pct + '%';
    row.append(dot, lbl, bar, val);
    host.appendChild(row);
  });
}
window.renderStatsByArea = renderStatsByArea;

// ========== G-14 FOCUS STREAKS ==========
// Aggregate the existing daily archive into a streak counter (current/best)
// and a 56-day heatmap. Pure read of getArchives() — no new state.
function renderFocusStreak(){
  const host = gid('focusStreak');
  if(!host) return;
  let archives = [];
  try{ archives = (typeof getArchives === 'function') ? getArchives() : []; }catch(_){}
  const byDate = new Map(archives.map(a => [a.date, a]));
  const today = (typeof todayKey === 'function') ? todayKey() : (new Date()).toISOString().slice(0,10);
  if(typeof totalFocusSec === 'number' && totalFocusSec > 0){
    byDate.set(today, { date: today, totalFocusSec, totalPomos });
  }
  let cur = 0, best = 0, run = 0;
  const today0 = new Date(today + 'T00:00:00');
  const isFocusDay = key => {
    const a = byDate.get(key);
    return !!(a && (a.totalPomos > 0 || a.totalFocusSec > 0));
  };
  for(let i = 0; i < 365; i++){
    const d = new Date(today0); d.setDate(d.getDate() - i);
    const k = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    if(isFocusDay(k)){
      run++;
      if(i === cur) cur = run;
      if(run > best) best = run;
    } else {
      if(i === 0) cur = 0;
      run = 0;
    }
  }
  host.replaceChildren();
  const top = document.createElement('div'); top.className = 'streak-row';
  const num = document.createElement('span'); num.className = 'streak-num'; num.textContent = String(cur);
  const lbl = document.createElement('span'); lbl.className = 'streak-lbl'; lbl.textContent = 'day streak';
  const bst = document.createElement('span'); bst.className = 'streak-best'; bst.textContent = 'best ' + best;
  top.append(num, lbl, bst);
  host.appendChild(top);
  const grid = document.createElement('div'); grid.className = 'hm-grid';
  for(let i = 55; i >= 0; i--){
    const d = new Date(today0); d.setDate(d.getDate() - i);
    const k = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    const a = byDate.get(k);
    const min = a ? Math.round((a.totalFocusSec || 0) / 60) : 0;
    let level = 0;
    if(min >= 240) level = 4;
    else if(min >= 120) level = 3;
    else if(min >= 60) level = 2;
    else if(min > 0) level = 1;
    const cell = document.createElement('span');
    cell.className = 'hm-cell hm-l' + level;
    cell.title = k + ': ' + min + ' min';
    grid.appendChild(cell);
  }
  host.appendChild(grid);
  host.hidden = false;
}
window.renderFocusStreak = renderFocusStreak;

// ========== G-15 SESSION-NOTE PROMPT ==========
function showSessionNotePrompt(taskId){
  const card = gid('mainCard');
  if(!card) return;
  let host = gid('sessionNotePrompt');
  if(!host){
    host = document.createElement('div');
    host.id = 'sessionNotePrompt';
    host.className = 'session-note-prompt';
    card.parentNode.insertBefore(host, card.nextSibling);
  }
  const t = (typeof findTask === 'function') ? findTask(taskId) : null;
  if(!t){ host.hidden = true; return; }
  host.replaceChildren();
  const lbl = document.createElement('label'); lbl.className = 'snp-lbl';
  lbl.appendChild(document.createTextNode('Quick note about your session on '));
  const strong = document.createElement('strong'); strong.textContent = t.name || 'this task';
  lbl.appendChild(strong);
  host.appendChild(lbl);
  const input = document.createElement('textarea');
  input.id = 'sessionNoteInput'; input.className = 'snp-input';
  input.rows = 2; input.placeholder = 'What did you get done?';
  host.appendChild(input);
  const actions = document.createElement('div'); actions.className = 'snp-actions';
  const saveBtn = document.createElement('button'); saveBtn.type = 'button';
  saveBtn.className = 'snp-save'; saveBtn.textContent = 'Save note';
  const skipBtn = document.createElement('button'); skipBtn.type = 'button';
  skipBtn.className = 'snp-skip'; skipBtn.textContent = 'Skip';
  const offLbl = document.createElement('label'); offLbl.className = 'snp-off';
  const offCb = document.createElement('input'); offCb.type = 'checkbox'; offCb.id = 'sessionNoteDisable';
  offLbl.append(offCb, document.createTextNode(' Stop asking'));
  actions.append(saveBtn, skipBtn, offLbl);
  host.appendChild(actions);
  host.hidden = false;
  try{ input.focus(); }catch(_){}
  const close = () => { host.hidden = true; };
  saveBtn.onclick = function(){
    const text = (input.value || '').trim();
    if(text){
      if(!Array.isArray(t.notes)) t.notes = [];
      t.notes.push({ id: Date.now() + Math.random(), text, createdAt: (typeof timeNowFull === 'function') ? timeNowFull() : new Date().toISOString() });
      t.lastModified = Date.now();
      if(typeof saveState === 'function') saveState('user');
      if(typeof renderTaskList === 'function') renderTaskList();
    }
    if(offCb.checked){ cfg.askSessionNote = false; if(typeof saveState === 'function') saveState('user'); }
    close();
  };
  skipBtn.onclick = function(){
    if(offCb.checked){ cfg.askSessionNote = false; if(typeof saveState === 'function') saveState('user'); }
    close();
  };
}
window.showSessionNotePrompt = showSessionNotePrompt;

/**
 * Live-refresh the task detail modal's tracking surfaces when a timer session
 * completes for the task that's currently open. Without this, the modal shows
 * stale "1 session" text after the user kicked off a second timer round and
 * watched it complete with the modal still open.
 */
function refreshOpenTaskModalIfMatches(taskId){
  if(editingTaskId == null || editingTaskId !== taskId) return;
  const t = (typeof findTask === 'function') ? findTask(taskId) : null;
  if(!t) return;
  const trackedEl = gid('mdTracked');
  if(trackedEl) trackedEl.textContent = fmtHMS(getRolledUpTime(t.id)) + ' · ' + getRolledUpSessions(t.id) + ' sessions';
  if(typeof renderMdSessions === 'function') renderMdSessions(t);
  if(typeof renderMdHabitLog === 'function') renderMdHabitLog(t);
}
window.refreshOpenTaskModalIfMatches = refreshOpenTaskModalIfMatches;

async function suggestDueDateForTask(taskId){
  const id = taskId != null ? taskId : editingTaskId;
  if(id == null){
    if(typeof showExportToast === 'function') showExportToast('Open a task first (click any task), then rerun this action.');
    return;
  }
  const t = (typeof findTask === 'function') ? findTask(id) : null;
  if(!t || typeof predictDueDate !== 'function') return;
  if(typeof isIntelReady !== 'function' || !isIntelReady()){
    if(typeof showExportToast === 'function') showExportToast('Load embeddings first (Tools tab)');
    return;
  }
  const next = await predictDueDate(t.name);
  if(!next){
    if(typeof showExportToast === 'function') showExportToast('No similar tasks with due dates yet — try again later');
    return;
  }
  if(t.dueDate === next){
    if(typeof showExportToast === 'function') showExportToast('Suggested date matches the current due date');
    return;
  }
  if(typeof acceptProposedOps === 'function'){
    await acceptProposedOps([{ name: 'UPDATE_TASK', args: { id: t.id, dueDate: next }, _rationale: 'kNN median of similar tasks' }], { source: 'ai-due-suggest', destructiveLevel: 'none' });
  }
}
window.suggestDueDateForTask = suggestDueDateForTask;

// ========== G-18 TODAY-VIEW CALENDAR EVENTS ==========
// Show today's calendar events as a compact strip above the task list when
// the user is on the Today smart view. Read-only — uses existing parser.
function renderTodayCalEvents(){
  const host = gid('todayCalEvents');
  if(!host) return;
  const sv = (typeof smartView === 'string') ? smartView : 'all';
  if(sv !== 'today' && sv !== 'week'){ host.hidden = true; host.replaceChildren(); return; }
  if(typeof getCalFeedEventsForDate !== 'function'){ host.hidden = true; return; }
  const todayK = (typeof todayKey === 'function') ? todayKey() : (typeof todayISO === 'function' ? todayISO() : new Date().toISOString().slice(0,10));
  let evs = [];
  if(sv === 'today'){
    try{ evs = getCalFeedEventsForDate(todayK) || []; }catch(_){}
  } else if(typeof getUpcomingEvents === 'function'){
    try{ evs = getUpcomingEvents(8, 24, { strictFuture: false }) || []; }catch(_){}
  }
  if(!evs.length){ host.hidden = true; host.replaceChildren(); return; }
  evs.sort((a,b)=>{
    const da = a.dateISO || todayK, db = b.dateISO || todayK;
    if(da !== db) return da.localeCompare(db);
    if(a.allDay && !b.allDay) return -1;
    if(!a.allDay && b.allDay) return 1;
    return String(a.time||'').localeCompare(String(b.time||''));
  });
  host.replaceChildren();
  const head = document.createElement('div');
  head.className = 'tce-head';
  head.textContent = sv === 'week'
    ? (evs.length === 1 ? '1 event this week' : evs.length + ' events this week')
    : (evs.length === 1 ? '1 event today' : evs.length + ' events today');
  host.appendChild(head);
  const wrap = document.createElement('div');
  wrap.className = 'tce-list';
  evs.slice(0, 12).forEach(ev => {
    const row = document.createElement('div');
    row.className = 'tce-row';
    const dot = document.createElement('span');
    dot.className = 'tce-dot';
    dot.style.background = ev.feedColor || 'var(--accent)';
    const tm = document.createElement('span');
    tm.className = 'tce-time';
    if(sv === 'week' && ev.dateISO && ev.dateISO !== todayK){
      tm.textContent = ev.dateISO.slice(5) + ' ' + (ev.allDay ? 'All day' : (ev.time || '').slice(0, 5));
    } else {
      tm.textContent = ev.allDay ? 'All day' : (ev.time || '').slice(0, 5);
    }
    const title = document.createElement('span');
    title.className = 'tce-title';
    title.textContent = ev.title || '(no title)';
    if(ev.location){ title.title = ev.location; }
    const feed = document.createElement('span');
    feed.className = 'tce-feed';
    feed.textContent = ev.feedLabel || '';
    row.append(dot, tm, title, feed);
    wrap.appendChild(row);
  });
  host.appendChild(wrap);
  host.hidden = false;
}
window.renderTodayCalEvents = renderTodayCalEvents;

// ========== G-4 BULK-SELECT EDIT MODE ==========
// Multi-select tasks then batch-apply ops through the existing
// acceptProposedOps pipeline (which gives the user a preview + undo).
const _bulkSelectedIds = new Set();
function isBulkMode(){ return !!(typeof cfg === 'object' && cfg && cfg.bulkMode); }
function toggleBulkMode(){
  if(typeof cfg !== 'object' || !cfg) return;
  cfg.bulkMode = !cfg.bulkMode;
  if(!cfg.bulkMode) _bulkSelectedIds.clear();
  document.body.classList.toggle('app-bulk-mode', !!cfg.bulkMode);
  if(typeof renderTaskList === 'function') renderTaskList();
  renderBulkBar();
  if(typeof saveState === 'function') saveState('user');
}
function bulkToggleSelect(id){
  const n = parseInt(id, 10);
  if(!Number.isFinite(n)) return;
  if(_bulkSelectedIds.has(n)) _bulkSelectedIds.delete(n);
  else _bulkSelectedIds.add(n);
  renderBulkBar();
  // Also flip the checkbox visual on the row
  const cb = document.querySelector('.task-bulk-cb[data-id="' + n + '"]');
  if(cb) cb.checked = _bulkSelectedIds.has(n);
}
function bulkClear(){
  _bulkSelectedIds.clear();
  document.querySelectorAll('.task-bulk-cb').forEach(cb => { cb.checked = false; });
  renderBulkBar();
}
function bulkSelectVisible(){
  const visible = Array.isArray(tasks) ? tasks.filter(t => typeof matchesFilters === 'function' && matchesFilters(t)) : [];
  visible.forEach(t => _bulkSelectedIds.add(t.id));
  document.querySelectorAll('.task-bulk-cb').forEach(cb => {
    const n = parseInt(cb.dataset.id, 10);
    if(_bulkSelectedIds.has(n)) cb.checked = true;
  });
  renderBulkBar();
}
async function _bulkApplyOps(makeOps){
  if(!_bulkSelectedIds.size) return;
  const ids = Array.from(_bulkSelectedIds);
  const ops = ids.flatMap(id => makeOps(id)).filter(Boolean);
  if(!ops.length) return;
  // Validate before previewing — surfaces destructive-ACK levels
  if(typeof validateOps === 'function'){
    const tasksById = new Map((tasks || []).map(t => [t.id, t]));
    const listsById = new Map((lists || []).map(l => [l.id, l]));
    const v = validateOps(ops, { tasksById, listsById });
    if(typeof acceptProposedOps === 'function'){
      await acceptProposedOps(v.valid, { source: 'bulk', destructiveLevel: v.destructiveLevel });
    }
  } else if(typeof acceptProposedOps === 'function'){
    await acceptProposedOps(ops, { source: 'bulk', destructiveLevel: 'none' });
  }
  // Selection persists so the user can adjust, but we exit bulk mode after
  // a destructive batch so the chips stop blocking.
  if(ops.some(o => o.name === 'DELETE_TASK')) {
    _bulkSelectedIds.clear();
  }
  renderBulkBar();
}
function bulkDelete(){ return _bulkApplyOps(id => [{ name: 'DELETE_TASK', args: { id } }]); }
function bulkStar(){ return _bulkApplyOps(id => [{ name: 'TOGGLE_STAR', args: { id } }]); }
function bulkSetPriority(p){
  if(!['urgent','high','normal','low','none'].includes(p)) return;
  return _bulkApplyOps(id => [{ name: 'UPDATE_TASK', args: { id, priority: p } }]);
}
function bulkAddTag(tag){
  const t = String(tag || '').replace(/^#/, '').trim();
  if(!t) return;
  return _bulkApplyOps(id => [{ name: 'ADD_TAG', args: { id, tag: t } }]);
}
function bulkChangeList(listId){
  const n = parseInt(listId, 10);
  if(!Number.isFinite(n)) return;
  return _bulkApplyOps(id => [{ name: 'CHANGE_LIST', args: { id, listId: n } }]);
}
function bulkAddTagPrompt(){
  const t = prompt('Tag to add to ' + _bulkSelectedIds.size + ' selected task' + (_bulkSelectedIds.size === 1 ? '' : 's') + ':');
  if(t) bulkAddTag(t);
}
function renderBulkBar(){
  let bar = document.getElementById('bulkBar');
  if(!bar){
    bar = document.createElement('div');
    bar.id = 'bulkBar';
    bar.className = 'bulk-bar';
    document.body.appendChild(bar);
  }
  if(!isBulkMode() || _bulkSelectedIds.size === 0){ bar.hidden = true; return; }
  bar.replaceChildren();
  const count = document.createElement('span');
  count.className = 'bulk-count';
  count.textContent = _bulkSelectedIds.size + ' selected';
  bar.appendChild(count);
  const mkBtn = (label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'bulk-btn';
    b.textContent = label;
    b.onclick = fn;
    return b;
  };
  bar.appendChild(mkBtn('Star', bulkStar));
  bar.appendChild(mkBtn('Delete', bulkDelete));
  bar.appendChild(mkBtn('Tag…', bulkAddTagPrompt));
  // Priority dropdown
  const prSel = document.createElement('select');
  prSel.className = 'bulk-sel';
  const prOpts = [['','Set priority…'],['urgent','Urgent'],['high','High'],['normal','Normal'],['low','Low'],['none','None']];
  prOpts.forEach(([v,l])=>{ const o=document.createElement('option'); o.value=v; o.textContent=l; prSel.appendChild(o); });
  prSel.onchange = function(){ if(prSel.value) bulkSetPriority(prSel.value); prSel.value=''; };
  bar.appendChild(prSel);
  // List dropdown
  if(Array.isArray(lists) && lists.length > 1){
    const lsSel = document.createElement('select');
    lsSel.className = 'bulk-sel';
    const placeholder = document.createElement('option'); placeholder.value=''; placeholder.textContent='Move to list…';
    lsSel.appendChild(placeholder);
    lists.forEach(l => { const o=document.createElement('option'); o.value=String(l.id); o.textContent=l.name; lsSel.appendChild(o); });
    lsSel.onchange = function(){ if(lsSel.value) bulkChangeList(lsSel.value); lsSel.value=''; };
    bar.appendChild(lsSel);
  }
  bar.appendChild(mkBtn('Select all visible', bulkSelectVisible));
  const close = mkBtn('✕', toggleBulkMode);
  close.className = 'bulk-btn bulk-close';
  bar.appendChild(close);
  bar.hidden = false;
}
window.toggleBulkMode = toggleBulkMode;
window.bulkToggleSelect = bulkToggleSelect;
window.bulkClear = bulkClear;
window.bulkSelectVisible = bulkSelectVisible;
window.renderBulkBar = renderBulkBar;
window._bulkSelectedIds = _bulkSelectedIds;

// ========== G-5 PERSPECTIVES (Saved Filter Sets) ==========
// Snapshot the current filter/sort/view tuple under a user-chosen name.
function _currentPerspectiveTuple(){
  const so = gid('taskSortSel'), gr = gid('groupBySel'), st = gid('filterStatus'), pr = gid('filterPriority'), ca = gid('filterCategory'), srch = gid('taskSearch');
  return {
    smartView: typeof smartView === 'string' ? smartView : 'all',
    status:    st ? st.value : 'all',
    priority:  pr ? pr.value : 'all',
    category:  ca ? ca.value : 'all',
    sort:      so ? so.value : 'manual',
    group:     gr ? gr.value : 'none',
    search:    srch ? srch.value : '',
    activeListId: typeof activeListId !== 'undefined' ? activeListId : null,
  };
}
function showManagePerspectivesCard(){
  const arr = (typeof cfg === 'object' && cfg && Array.isArray(cfg.perspectives)) ? cfg.perspectives : [];
  let host = document.getElementById('perspectivesCard');
  if(!host){
    host = document.createElement('div');
    host.id = 'perspectivesCard';
    host.className = 'ai-brief-card';
    document.body.appendChild(host);
  }
  host.replaceChildren();
  host.hidden = false;
  const head = document.createElement('div'); head.className = 'aibc-head';
  const h = document.createElement('span'); h.className = 'aibc-title'; h.textContent = 'Saved views';
  const close = document.createElement('button'); close.type = 'button'; close.className = 'aibc-close';
  close.textContent = '✕'; close.onclick = function(){ host.hidden = true; };
  head.append(h, close);
  host.appendChild(head);
  const body = document.createElement('div'); body.className = 'aibc-body';
  if(!arr.length){
    body.textContent = 'No saved views yet. Use the command palette ("Save current view…") to create one.';
  } else {
    arr.forEach(p => {
      if(!p || !p.name) return;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)';
      const apply = document.createElement('button');
      apply.type = 'button';
      apply.className = 'bulk-btn';
      apply.style.flex = '1';
      apply.textContent = p.name;
      apply.onclick = function(){ applyPerspective(p.name); host.hidden = true; };
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'bulk-btn bulk-close';
      del.textContent = '✕';
      del.title = 'Delete this saved view';
      del.onclick = function(){ removePerspective(p.name); showManagePerspectivesCard(); };
      row.append(apply, del);
      body.appendChild(row);
    });
  }
  host.appendChild(body);
}
window.showManagePerspectivesCard = showManagePerspectivesCard;

function _ensurePerspectivesArray(){
  if(typeof cfg !== 'object' || !cfg) return [];
  if(!Array.isArray(cfg.perspectives)) cfg.perspectives = [];
  return cfg.perspectives;
}
function savePerspectivePrompt(){
  const name = prompt('Name this view (e.g. "Today @work", "Stuck deep work"):');
  if(!name) return;
  savePerspective(name);
}
function savePerspective(name){
  const trimmed = String(name || '').trim().slice(0, 64);
  if(!trimmed) return;
  const arr = _ensurePerspectivesArray();
  const tuple = _currentPerspectiveTuple();
  const existing = arr.findIndex(p => p && p.name === trimmed);
  const entry = { name: trimmed, view: tuple };
  if(existing >= 0) arr[existing] = entry;
  else arr.push(entry);
  if(typeof saveState === 'function') saveState('user');
  if(typeof showExportToast === 'function') showExportToast('View saved: ' + trimmed);
}
function applyPerspective(name){
  const arr = _ensurePerspectivesArray();
  const p = arr.find(x => x && x.name === name);
  if(!p || !p.view) return;
  const v = p.view;
  if(v.smartView && typeof setSmartView === 'function') setSmartView(v.smartView);
  const setIf = (id, val) => { const el = gid(id); if(el && val != null){ el.value = val; } };
  setIf('filterStatus',   v.status);
  setIf('filterPriority', v.priority);
  setIf('filterCategory', v.category);
  setIf('taskSortSel',    v.sort);
  setIf('groupBySel',     v.group);
  setIf('taskSearch',     v.search || '');
  if(v.activeListId != null && typeof switchList === 'function') switchList(v.activeListId);
  if(typeof updateTaskFilters === 'function') updateTaskFilters();
  if(typeof showTab === 'function') showTab('tasks');
}
function removePerspective(name){
  if(typeof cfg !== 'object' || !cfg || !Array.isArray(cfg.perspectives)) return;
  cfg.perspectives = cfg.perspectives.filter(p => !p || p.name !== name);
  if(typeof saveState === 'function') saveState('user');
}
window.savePerspective = savePerspective;
window.savePerspectivePrompt = savePerspectivePrompt;
window.applyPerspective = applyPerspective;
window.removePerspective = removePerspective;

// ========== G-12 VOICE QUICK-ADD ==========
// Uses Web Speech API — fully browser-native (Chrome/Edge/Safari/iOS Safari).
// Transcribes into the existing taskInput so all the smart-add / nlparse
// downstream still applies.
let _voiceRec = null;
let _voiceActive = false;
function _voiceSupport(){
  return typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
}
function showVoiceButtonIfSupported(){
  const btn = gid('taskVoiceBtn');
  if(!btn) return;
  btn.hidden = !(_voiceSupport());
}
function toggleVoiceInput(){
  if(_voiceActive){ stopVoiceInput(); return; }
  startVoiceInput();
}
function startVoiceInput(){
  const Ctor = _voiceSupport();
  if(!Ctor) return;
  if(_voiceRec){ try{ _voiceRec.abort(); }catch(_){} }
  const rec = new Ctor();
  rec.continuous = false;
  rec.interimResults = true;
  rec.lang = (navigator.language || 'en-US');
  const inp = gid('taskInput');
  const btn = gid('taskVoiceBtn');
  let baseValue = (inp && inp.value) || '';
  rec.onstart = function(){
    _voiceActive = true;
    if(btn) btn.classList.add('on');
  };
  rec.onresult = function(e){
    let txt = '';
    for(let i = e.resultIndex; i < e.results.length; i++){
      txt += e.results[i][0].transcript;
    }
    if(inp){
      inp.value = (baseValue ? (baseValue + ' ') : '') + txt.trim();
      if(typeof maybeShowEnhanceBtn === 'function') maybeShowEnhanceBtn();
    }
  };
  rec.onerror = function(e){
    console.warn('[voice] recognition error', e && e.error);
    stopVoiceInput();
  };
  rec.onend = function(){
    _voiceActive = false;
    _voiceRec = null;
    if(btn) btn.classList.remove('on');
  };
  _voiceRec = rec;
  try{ rec.start(); }catch(e){ console.warn('[voice] start failed', e); }
}
function stopVoiceInput(){
  if(_voiceRec){ try{ _voiceRec.stop(); }catch(_){} }
  _voiceActive = false;
  const btn = gid('taskVoiceBtn');
  if(btn) btn.classList.remove('on');
}
window.toggleVoiceInput = toggleVoiceInput;
window.startVoiceInput = startVoiceInput;
window.stopVoiceInput = stopVoiceInput;
window.showVoiceButtonIfSupported = showVoiceButtonIfSupported;
window.addEventListener('DOMContentLoaded', showVoiceButtonIfSupported);

// ========== G-24 MODAL FOCUS TRAP ==========
// Generic focus-trap helper. Existing modals open via `.open` class — we
// hook the document keydown to detect Tab/Shift+Tab inside any visible modal.
function _focusableInside(root){
  if(!root) return [];
  const sel = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll(sel)).filter(el => el.offsetParent !== null && !el.hasAttribute('aria-hidden'));
}
document.addEventListener('keydown', function(e){
  if(e.key !== 'Tab') return;
  // Find the topmost open modal-ish container.
  const candidates = [
    document.getElementById('appConfirmModal'),
    document.getElementById('appPromptModal'),
    document.getElementById('cmdkOverlay'),
    document.getElementById('taskModal'),
    document.getElementById('bulkImportModal'),
    document.getElementById('whatNextOverlay'),
    document.getElementById('aiBriefCard'),
  ].filter(Boolean);
  // App-confirm/prompt sit at the top of the stack — they're blocking dialogs
  // launched from other modals. Iterate in reverse so the most recently opened
  // dialog wins the trap regardless of DOM order.
  const open = candidates.reverse().find(el => {
    const cls = el.classList;
    if(cls.contains('open')) return true;
    // aiBriefCard still uses the hidden-attribute pattern; what-next, cmdk,
    // and the modal-overlays all moved to .open class in Stages 1-3.
    if(el.id === 'aiBriefCard' && !el.hidden) return true;
    return false;
  });
  if(!open) return;
  const focusables = _focusableInside(open);
  if(!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if(e.shiftKey){
    if(document.activeElement === first || !open.contains(document.activeElement)){
      e.preventDefault();
      try{ last.focus(); }catch(_){}
    }
  } else {
    if(document.activeElement === last){
      e.preventDefault();
      try{ first.focus(); }catch(_){}
    }
  }
});

// ========== MODAL BACKDROP-READY TRANSITION ==========
// Defer .modal-overlay/.cmdk-overlay backdrop-filter:blur(...) until AFTER
// the opacity transition completes. The GPU stalls when blur is composited
// on the same frame an animation starts — historically the source of the
// "jitter" felt at the top of bottom-up sheets. We listen once at document
// level so dynamically-created overlays (e.g. showShortcutsHelp) are covered
// without any per-element wiring. Capture phase so the listener fires even
// if a child stops propagation.
document.addEventListener('transitionend', function(e){
  const t = e.target;
  if(!(t instanceof Element)) return;
  if(e.propertyName !== 'opacity') return;
  if(!t.matches('.modal-overlay, .cmdk-overlay')) return;
  if(t.classList.contains('open')) t.classList.add('backdrop-ready');
  else t.classList.remove('backdrop-ready');
}, true);

// ========== G-7 FOCUS-ON-LIST MODE ==========
function toggleFocusListMode(){
  cfg.focusListMode = !cfg.focusListMode;
  document.body.classList.toggle('app-focus-list', !!cfg.focusListMode);
  if(typeof renderTaskList === 'function') renderTaskList();
  if(typeof saveState === 'function') saveState('user');
}
window.toggleFocusListMode = toggleFocusListMode;
function _applyFocusListClass(){
  if(typeof cfg === 'object' && cfg && cfg.focusListMode){
    document.body.classList.add('app-focus-list');
  }
}
window.addEventListener('DOMContentLoaded', _applyFocusListClass);
async function resetStats(){
  if(!(await showAppConfirm('Reset today\'s pomodoro stats and time log? Tasks and goals are not affected. A snapshot is archived to Past Days if there is progress to keep.')))return;
  const state={date:todayKey(),totalPomos,totalBreaks,totalFocusSec,goals:goals.map(g=>({text:g.text,done:g.done,doneAt:g.doneAt})),tasks:tasks.map(t=>({name:t.name,totalSec:getTaskElapsed(t),sessions:t.sessions})),timeLog,sessionHistory};
  if(totalPomos>0||goals.length>0||tasks.length>0)archiveDay(state);
  totalPomos=0;totalBreaks=0;totalFocusSec=0;pomosInCycle=0;sessionHistory=[];timeLog=[];
  renderStats();renderPips();renderGoalList();renderTaskList();renderLog();renderBanner();renderArchive();saveState('user');
  if(typeof _updateActiveTaskTickSchedule==='function')_updateActiveTaskTickSchedule();
}
function updateTitle(){if(running)document.title=(phase==='work'?'🔴':'🟢')+' '+fmt(remaining)+' — '+getPL(phase);else if(finished)document.title='✅ '+getPL(phase)+' Complete';else document.title='Odta'}

// ========== C-1 Task ID badge ==========
function renderTaskIdBadge(t){
  if(!t) return;
  const stats = document.getElementById('mdStats');
  if(!stats) return;
  let badge = stats.querySelector('.md-task-id');
  if(!badge){
    badge = document.createElement('span');
    badge.className = 'md-task-id';
    stats.appendChild(badge);
  }
  badge.textContent = ' · #' + (t.id != null ? t.id : '?');
  badge.title = 'Task ID — use in task references';
}
window.renderTaskIdBadge = renderTaskIdBadge;

// ========== C-2 Activity log ==========
function recordTaskActivity(t, before){
  if(!t || !before) return;
  if(!Array.isArray(t.activity)) t.activity = [];
  const at = (typeof timeNowFull === 'function') ? timeNowFull() : new Date().toISOString();
  const fmt = v => {
    if(v == null) return '';
    if(Array.isArray(v)) return v.join(', ');
    return String(v);
  };
  const eq = (a, b) => {
    if(Array.isArray(a) && Array.isArray(b)){
      if(a.length !== b.length) return false;
      const sa = a.slice().sort(); const sb = b.slice().sort();
      for(let i = 0; i < sa.length; i++) if(sa[i] !== sb[i]) return false;
      return true;
    }
    return (a == null ? '' : a) === (b == null ? '' : b);
  };
  for(const k of Object.keys(before)){
    const a = before[k]; const b = t[k];
    if(!eq(a, b)){
      t.activity.push({ at, field: k, from: fmt(a).slice(0, 80), to: fmt(b).slice(0, 80) });
    }
  }
  if(t.activity.length > 50) t.activity = t.activity.slice(-50);
}
window.recordTaskActivity = recordTaskActivity;

function renderTaskActivity(t){
  if(!t) return;
  let host = document.getElementById('mdActivity');
  if(!host){
    const desc = document.getElementById('mdDesc');
    if(!desc || !desc.parentNode) return;
    host = document.createElement('div');
    host.id = 'mdActivity';
    host.className = 'md-activity';
    desc.parentNode.parentNode.appendChild(host);
  }
  host.replaceChildren();
  if(!Array.isArray(t.activity) || !t.activity.length){
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const head = document.createElement('div');
  head.className = 'md-activity-head';
  head.textContent = 'Activity (last ' + Math.min(t.activity.length, 8) + ')';
  host.appendChild(head);
  const list = document.createElement('ul');
  list.className = 'md-activity-list';
  t.activity.slice(-8).reverse().forEach(a => {
    const li = document.createElement('li');
    const when = document.createElement('span'); when.className = 'mda-when'; when.textContent = String(a.at).slice(0, 16);
    const what = document.createElement('span'); what.className = 'mda-what';
    const fromTo = a.from ? '“' + a.from + '” → ' : '';
    what.textContent = a.field + ': ' + fromTo + '“' + a.to + '”';
    li.append(when, what);
    list.appendChild(li);
  });
  host.appendChild(list);
}
window.renderTaskActivity = renderTaskActivity;

// ========== C-3 Markdown render in description ==========
function renderMarkdownInline(text){
  const escapeHtml = s => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const lines = String(text || '').split('\n');
  const out = [];
  let inList = false;
  for(const raw of lines){
    let line = escapeHtml(raw);
    line = line.replace(/`([^`]+)`/g, '<code>$1</code>');
    line = line.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    line = line.replace(/(^|\W)\*([^*\s][^*]*?)\*(\W|$)/g, '$1<em>$2</em>$3');
    line = line.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    if(/^### (.+)/.test(raw)){ if(inList){ out.push('</ul>'); inList=false;} out.push('<h4>' + line.replace(/^### /, '') + '</h4>'); continue; }
    if(/^## (.+)/.test(raw)){  if(inList){ out.push('</ul>'); inList=false;} out.push('<h3>' + line.replace(/^## /,  '') + '</h3>'); continue; }
    if(/^# (.+)/.test(raw)){   if(inList){ out.push('</ul>'); inList=false;} out.push('<h2>' + line.replace(/^# /,   '') + '</h2>'); continue; }
    const bullet = raw.match(/^\s*[-*]\s+(.+)/);
    if(bullet){
      if(!inList){ out.push('<ul>'); inList = true; }
      out.push('<li>' + line.replace(/^\s*[-*]\s+/, '') + '</li>');
      continue;
    }
    if(inList){ out.push('</ul>'); inList = false; }
    if(raw.trim() === '') out.push('<br>');
    else out.push('<p>' + line + '</p>');
  }
  if(inList) out.push('</ul>');
  return out.join('');
}
window.renderMarkdownInline = renderMarkdownInline;
function _safeWriteMarkdown(host, src){
  const html = renderMarkdownInline(src);
  const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
  const wrap = doc.body.firstChild;
  host.replaceChildren();
  while(wrap && wrap.firstChild){
    host.appendChild(wrap.firstChild);
  }
}
function toggleDescriptionRender(){
  const ta = document.getElementById('mdDesc');
  let view = document.getElementById('mdDescView');
  if(!ta) return;
  if(view){
    view.remove();
    ta.hidden = false;
    const btn = document.getElementById('mdDescToggle');
    if(btn) btn.textContent = 'Render markdown';
    return;
  }
  view = document.createElement('div');
  view.id = 'mdDescView';
  view.className = 'md-desc-view';
  _safeWriteMarkdown(view, ta.value || '');
  ta.hidden = true;
  ta.parentNode.insertBefore(view, ta.nextSibling);
  const btn = document.getElementById('mdDescToggle');
  if(btn) btn.textContent = 'Edit';
}
window.toggleDescriptionRender = toggleDescriptionRender;

// ========== C-4 Single-task export ==========
function exportSingleTaskAsMarkdown(taskId){
  const id = taskId != null ? taskId : editingTaskId;
  if(id == null) return;
  const t = (typeof findTask === 'function') ? findTask(id) : null;
  if(!t) return;
  const lines = [];
  lines.push('# ' + (t.name || 'Task'));
  lines.push('');
  if(t.priority && t.priority !== 'none') lines.push('**Priority:** ' + t.priority);
  if(t.status) lines.push('**Status:** ' + t.status);
  if(t.dueDate) lines.push('**Due:** ' + t.dueDate);
  if(t.startDate) lines.push('**Start:** ' + t.startDate);
  if(t.hiddenUntil) lines.push('**Snoozed until:** ' + t.hiddenUntil);
  if(t.category) lines.push('**Life area:** ' + t.category);
  if(t.effort) lines.push('**Effort:** ' + t.effort);
  if(t.energyLevel) lines.push('**Energy:** ' + t.energyLevel);
  if(Array.isArray(t.tags) && t.tags.length) lines.push('**Tags:** ' + t.tags.map(x => '#' + x).join(' '));
  if(t.url) lines.push('**URL:** ' + t.url);
  if(t.estimateMin) lines.push('**Estimate:** ' + t.estimateMin + ' min');
  if(t.totalSec) lines.push('**Tracked:** ' + Math.round(t.totalSec / 60) + ' min · ' + (t.sessions || 0) + ' sessions');
  if(t.description){ lines.push(''); lines.push(t.description); }
  const allLists = [];
  if(Array.isArray(t.checklists) && t.checklists.length) allLists.push(...t.checklists);
  if(Array.isArray(t.checklist) && t.checklist.length) allLists.push({ name: 'Checklist', items: t.checklist });
  if(allLists.length){
    lines.push('');
    allLists.forEach(g => {
      lines.push('## ' + (g.name || 'Checklist'));
      (g.items || []).forEach(c => lines.push('- [' + (c.done ? 'x' : ' ') + '] ' + (c.text || '')));
    });
  }
  if(Array.isArray(t.notes) && t.notes.length){
    lines.push('');
    lines.push('## Notes');
    t.notes.forEach(n => lines.push('- ' + (n.createdAt || '') + ' — ' + (n.text || '')));
  }
  if(t.completionNote){ lines.push(''); lines.push('## Completion note'); lines.push(t.completionNote); }
  if(Array.isArray(t.activity) && t.activity.length){
    lines.push('');
    lines.push('## Activity');
    t.activity.slice(-10).forEach(a => {
      const fromTo = a.from ? '“' + a.from + '” → ' : '';
      lines.push('- ' + a.at + ' — ' + a.field + ': ' + fromTo + '“' + a.to + '”');
    });
  }
  lines.push('');
  lines.push('— task #' + t.id);
  const md = lines.join('\n');
  const blob = new Blob([md], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const slug = (t.name || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
  a.download = 'odtaulai-task-' + slug + '-' + t.id + '.md';
  a.click();
  URL.revokeObjectURL(a.href);
  if(typeof showExportToast === 'function') showExportToast('Exported task — ' + a.download);
}
window.exportSingleTaskAsMarkdown = exportSingleTaskAsMarkdown;

// ========== C-6 Estimate vs actual variance ==========
function renderEstimateVariance(t){
  if(!t) return;
  let host = document.getElementById('mdVariance');
  if(!host){
    const tracked = document.getElementById('mdTracked');
    if(!tracked || !tracked.parentNode) return;
    host = document.createElement('div');
    host.id = 'mdVariance';
    host.className = 'md-variance';
    tracked.parentNode.parentNode.appendChild(host);
  }
  host.replaceChildren();
  const est = parseInt(t.estimateMin, 10) || 0;
  const act = Math.round((t.totalSec || 0) / 60);
  if(est <= 0 || act <= 0){ host.hidden = true; return; }
  host.hidden = false;
  const ratio = act / est;
  const pct = Math.round((ratio - 1) * 100);
  const label = document.createElement('span');
  label.className = 'mdv-label';
  label.textContent = 'Variance';
  const val = document.createElement('span');
  val.className = 'mdv-val';
  val.textContent = (pct >= 0 ? '+' : '') + pct + '% (estimate ' + est + 'm · actual ' + act + 'm)';
  if(ratio > 1.25) val.classList.add('mdv-over');
  else if(ratio < 0.75) val.classList.add('mdv-under');
  else val.classList.add('mdv-ok');
  host.append(label, val);
}
window.renderEstimateVariance = renderEstimateVariance;

// ========== C-7 Multiple named checklists ==========
function renderChecklistGroups(taskId){
  const t = (typeof findTask === 'function') ? findTask(taskId) : null;
  if(!t) return;
  const legacyHost = document.getElementById('mdChecklist');
  if(!legacyHost) return;
  let host = document.getElementById('mdChecklistGroups');
  if(!host){
    host = document.createElement('div');
    host.id = 'mdChecklistGroups';
    host.className = 'md-checklist-groups';
    legacyHost.parentNode.appendChild(host);
  }
  host.replaceChildren();
  if(!Array.isArray(t.checklists)) t.checklists = [];
  t.checklists.forEach(group => {
    const wrap = document.createElement('div'); wrap.className = 'mclg-group';
    const head = document.createElement('div'); head.className = 'mclg-head';
    const title = document.createElement('input');
    title.type = 'text'; title.className = 'mclg-name';
    title.value = group.name || ''; title.placeholder = 'Checklist name';
    title.onchange = function(){ group.name = title.value.trim() || 'Checklist'; if(typeof saveState==='function') saveState('user'); };
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'mclg-rm';
    rm.textContent = '✕'; rm.title = 'Remove this checklist';
    rm.onclick = function(){
      t.checklists = t.checklists.filter(g => g !== group);
      renderChecklistGroups(taskId);
      if(typeof saveState==='function') saveState('user');
    };
    head.append(title, rm);
    wrap.appendChild(head);
    const list = document.createElement('ul'); list.className = 'mclg-items';
    if(!Array.isArray(group.items)) group.items = [];
    group.items.forEach((c, idx) => {
      const li = document.createElement('li');
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = !!c.done;
      cb.onchange = function(){
        c.done = cb.checked;
        c.doneAt = cb.checked ? (new Date()).toISOString() : null;
        if(typeof saveState==='function') saveState('user');
      };
      const txt = document.createElement('input');
      txt.type = 'text'; txt.className = 'mclg-item-txt';
      txt.value = c.text || ''; txt.placeholder = 'Item';
      txt.onchange = function(){ c.text = txt.value.trim(); if(!c.text){ group.items.splice(idx, 1); renderChecklistGroups(taskId); } if(typeof saveState==='function') saveState('user'); };
      const xb = document.createElement('button');
      xb.type = 'button'; xb.className = 'mclg-item-x';
      xb.textContent = '×';
      xb.onclick = function(){ group.items.splice(idx, 1); renderChecklistGroups(taskId); if(typeof saveState==='function') saveState('user'); };
      li.append(cb, txt, xb);
      list.appendChild(li);
    });
    wrap.appendChild(list);
    const add = document.createElement('button');
    add.type = 'button'; add.className = 'mclg-add';
    add.textContent = '+ item';
    add.onclick = function(){
      group.items.push({ id: Date.now() + Math.random(), text: '', done: false, doneAt: null });
      renderChecklistGroups(taskId);
      setTimeout(() => {
        const inputs = wrap.querySelectorAll('.mclg-item-txt');
        if(inputs.length) inputs[inputs.length - 1].focus();
      }, 50);
    };
    wrap.appendChild(add);
    host.appendChild(wrap);
  });
  const addGroup = document.createElement('button');
  addGroup.type = 'button'; addGroup.className = 'mclg-add-group';
  addGroup.textContent = '+ checklist group';
  addGroup.onclick = function(){
    if(!Array.isArray(t.checklists)) t.checklists = [];
    t.checklists.push({ id: Date.now() + Math.random(), name: 'Checklist ' + (t.checklists.length + 1), items: [] });
    renderChecklistGroups(taskId);
    if(typeof saveState==='function') saveState('user');
  };
  host.appendChild(addGroup);
}
window.renderChecklistGroups = renderChecklistGroups;

// ========== C-9 Linked / related tasks ==========
function renderRelatedTasks(taskId){
  const t = (typeof findTask === 'function') ? findTask(taskId) : null;
  if(!t) return;
  const blocked = document.getElementById('mdBlockedBy');
  if(!blocked || !blocked.parentNode) return;
  let host = document.getElementById('mdRelatedTo');
  if(!host){
    host = document.createElement('div');
    host.id = 'mdRelatedTo';
    host.className = 'md-related';
    const wrap = document.createElement('div');
    wrap.className = 'mfield';
    const lbl = document.createElement('div');
    lbl.className = 'mfield-lbl';
    lbl.textContent = 'Related tasks (non-blocking links)';
    wrap.append(lbl, host);
    blocked.parentNode.parentNode.insertBefore(wrap, blocked.parentNode.nextSibling);
  }
  host.replaceChildren();
  if(!Array.isArray(t.relatedTo)) t.relatedTo = [];
  t.relatedTo.forEach((rid, idx) => {
    const other = (typeof findTask === 'function') ? findTask(rid) : null;
    if(!other) return;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'related-chip';
    chip.textContent = '#' + rid + ' ' + (other.name || '').slice(0, 40);
    chip.onclick = function(){ closeTaskDetail(); openTaskDetail(rid); };
    const x = document.createElement('span');
    x.className = 'related-x';
    x.textContent = '×';
    x.title = 'Unlink';
    x.onclick = function(ev){
      ev.stopPropagation();
      t.relatedTo.splice(idx, 1);
      renderRelatedTasks(taskId);
      if(typeof saveState==='function') saveState('user');
    };
    chip.appendChild(x);
    host.appendChild(chip);
  });
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'related-add';
  add.textContent = '+ link';
  add.onclick = function(){
    const idStr = prompt('Task ID to link (visible as #N in the drawer header):');
    if(!idStr) return;
    const n = parseInt(String(idStr).replace(/^#/, ''), 10);
    if(!Number.isFinite(n) || n <= 0) return;
    if(n === t.id){ alert('A task can\'t be linked to itself.'); return; }
    if(!findTask(n)){ alert('No task with id #' + n); return; }
    if(!Array.isArray(t.relatedTo)) t.relatedTo = [];
    if(!t.relatedTo.includes(n)) t.relatedTo.push(n);
    renderRelatedTasks(taskId);
    if(typeof saveState==='function') saveState('user');
  };
  host.appendChild(add);
}
window.renderRelatedTasks = renderRelatedTasks;

