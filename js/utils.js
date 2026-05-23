// ========== UTILS ==========
function gid(id){return document.getElementById(id)}
/**
 * HTML-escape a string for safe insertion into innerHTML.
 * SECURITY: This is the primary XSS boundary. All user-supplied
 * data rendered via innerHTML MUST pass through esc() first.
 * Uses DOM textContent encoding — handles &, <, >, ", ' correctly.
 */
function esc(s){const d=document.createElement("div");d.textContent=s;return d.innerHTML}
/** Escape for HTML double-quoted attributes (title=, etc.). */
function escAttr(s){
  if(s==null)return '';
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
/** Local completion timestamp YYYY-MM-DDTHH:MM:SS (for completedAt / done-today). */
function stampCompletion(){
  const d=new Date();
  const p=n=>String(n).padStart(2,'0');
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
}
/** Date portion of completion stamp (handles legacy HH:MM-only values as today). */
function completionDateKey(completedAt){
  if(!completedAt)return null;
  const s=String(completedAt);
  if(/^\d{4}-\d{2}-\d{2}/.test(s))return s.slice(0,10);
  if(/^\d{1,2}:\d{2}$/.test(s))return typeof todayKey==='function'?todayKey():null;
  return null;
}

function showExportToast(msg){
  let t=document.getElementById('exportToast');
  if(!t){
    t=document.createElement('div');
    t.id='exportToast';
    t.className='export-toast';
    t.setAttribute('role','status');
    document.body.appendChild(t);
  }
  // Rebuild via DOM nodes (not textContent) so the dismiss × survives and
  // the caller-supplied message is still treated as text.
  t.replaceChildren();
  const lbl=document.createElement('span');
  lbl.className='export-toast-lbl';
  lbl.textContent=msg;
  t.appendChild(lbl);
  const x=document.createElement('button');
  x.type='button';
  x.className='toast-dismiss';
  x.setAttribute('aria-label','Dismiss');
  x.textContent='×';
  x.onclick=()=>{ t.classList.remove('show'); clearTimeout(t._tm); };
  t.appendChild(x);
  t.classList.add('show');
  clearTimeout(t._tm);
  t._tm=setTimeout(()=>t.classList.remove('show'),2800);
}

/** Allow only simple hex colors for inline styles from user data */
function sanitizeListColor(c){
  const s=String(c||'').trim();
  if(/^#[0-9A-Fa-f]{3}$/.test(s)||/^#[0-9A-Fa-f]{6}$/.test(s))return s;
  return '#888888';
}
function fmt(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sc=s%60;if(h>0)return h+":"+String(m).padStart(2,"0")+":"+String(sc).padStart(2,"0");return String(m).padStart(2,"0")+":"+String(sc).padStart(2,"0")}
function fmtHMS(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sc=s%60;return String(h).padStart(2,"0")+":"+String(m).padStart(2,"0")+":"+String(sc).padStart(2,"0")}
function fmtShort(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60);return h>0?h+"h "+m+"m":m+"m"}
function timeNow(){const d=new Date();return String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0")}
function todayKey(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function dateStr(d){return (d||new Date()).toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}
function prettyDate(iso){const d=new Date(iso+'T12:00:00');return d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'})}

/** Render today's date into the header. Called from app.js init so this
 *  module no longer mutates the DOM at script-evaluation time. */
function setHeaderDate(){const el=gid('headerDate');if(el) el.textContent=dateStr();}
window.setHeaderDate=setHeaderDate;

function timeNowFull(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')}

/**
 * Polite a11y announcement for transient events (task added/removed, sort
 * changed, filter applied). Re-set after a tick so consecutive identical
 * messages are still announced (some SRs dedupe identical aria-live values).
 */
function announce(msg){
  const r=gid('srAnnouncer');if(!r||!msg)return;
  r.textContent='';
  setTimeout(()=>{r.textContent=String(msg)},30);
  clearTimeout(r._clr);
  r._clr=setTimeout(()=>{r.textContent=''},1200);
}
function announceTaskAdd(name){announce('Task added: '+(name||'(unnamed)'))}
window.announce=announce;

// ── Managed setInterval lifecycle ──────────────────────────────────────────
// Module-init setIntervals can leak when:
//   (a) a hot script reload (dev) re-runs the module and the second call to
//       `setInterval(fn, ms)` clobbers the variable reference without
//       clearing the first handle, or
//   (b) the browser restores the page from bfcache and certain setIntervals
//       don't survive the round-trip — re-init then doubles them up.
// setManagedInterval gives each timer a stable string key; setting a key
// that already exists clears the previous handle before scheduling the
// new one, so re-init is idempotent. clearAllManagedIntervals runs on
// pagehide so a bfcache-restored page starts from a clean slate. Call
// sites then re-establish their intervals on pageshow if e.persisted.
(function(){
  if(typeof window === 'undefined') return;
  if(!window._managedIntervals) window._managedIntervals = new Map();
  window.setManagedInterval = function(key, fn, ms){
    if(typeof key !== 'string' || typeof fn !== 'function') return null;
    const prev = window._managedIntervals.get(key);
    if(prev != null){ try{ clearInterval(prev); }catch(_){} }
    const id = setInterval(fn, ms);
    window._managedIntervals.set(key, id);
    return id;
  };
  window.clearManagedInterval = function(key){
    const id = window._managedIntervals.get(key);
    if(id != null){ try{ clearInterval(id); }catch(_){} window._managedIntervals.delete(key); }
  };
  window.clearAllManagedIntervals = function(){
    for(const [key, id] of window._managedIntervals){
      try{ clearInterval(id); }catch(_){}
    }
    window._managedIntervals.clear();
  };
  // pagehide fires both on real navigation away AND on bfcache freeze. We
  // clear unconditionally — the cost of restarting from scratch on pageshow
  // is negligible relative to the cost of double-firing every interval for
  // the remaining session.
  window.addEventListener('pagehide', () => { try{ window.clearAllManagedIntervals(); }catch(_){} });
  // bfcache restore: each caller registers a resumer via _onBfcacheRestore.
  // The handler invokes them so timers reinstate themselves with fresh
  // setManagedInterval calls (clobber-safe).
  window._bfcacheResumers = window._bfcacheResumers || [];
  window.onBfcacheRestore = function(fn){
    if(typeof fn === 'function') window._bfcacheResumers.push(fn);
  };
  window.addEventListener('pageshow', (e) => {
    if(!e.persisted) return;
    for(const fn of (window._bfcacheResumers || [])){
      try{ fn(); }catch(err){ console.warn('[bfcache] resumer failed', err); }
    }
  });
})();

// ── On-screen keyboard inset tracker ────────────────────────────────────────
// Mobile browsers don't shrink `100vh` / `100dvh` when the soft keyboard
// appears, so bottom-anchored overlays (cmdK chat, task modal, settings
// sheets) end up hidden under the keyboard. The VisualViewport API does
// report the real visible-area shrink — we surface that as CSS variables:
//   --kb-inset  : pixel height of the keyboard (0 when closed)
//   --vv-height : pixel height of the visible viewport
// Plus a body class `kb-open` so individual rules can flip layout when needed
// (e.g. a sheet that re-pins to the top instead of the bottom).
//
// Touching style + class lists on the root only when values actually change
// keeps the resize handler cheap — it can fire many times per second during
// keyboard animation.
(function setupKeyboardInsetTracker(){
  if(typeof window === 'undefined' || !window.visualViewport) return;
  const vv = window.visualViewport;
  const root = document.documentElement;
  let lastInset = -1, lastVvH = -1, lastClass = false;
  const update = () => {
    // offsetTop is non-zero when the page scrolls inside the visual viewport
    // (e.g. iOS pinch-zoom). Including it ensures kb-inset reflects ONLY the
    // keyboard region, not the address-bar / zoomed-pan area.
    const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    const vvH = Math.round(vv.height);
    const open = inset > 80; // ≥80px reliably distinguishes a keyboard from
                             // address-bar collapse on every mobile we tested
    if(inset !== lastInset){ root.style.setProperty('--kb-inset', inset + 'px'); lastInset = inset; }
    if(vvH !== lastVvH){     root.style.setProperty('--vv-height', vvH + 'px'); lastVvH = vvH; }
    if(open !== lastClass){  root.classList.toggle('kb-open', open); lastClass = open; }
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  // Initial values so CSS doesn't see an undefined custom property and fall
  // back to the keyword default (which often isn't what the rule expects).
  update();

  // When an input gains focus inside an overlay, the browser sometimes
  // doesn't scroll it into view above the keyboard (Safari especially when
  // the overlay is `position: fixed`). Wait for the visualViewport resize to
  // settle (one rAF post-event), then nudge the element into view.
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if(!el || !el.matches) return;
    if(!el.matches('input, textarea, [contenteditable="true"]')) return;
    // Skip when the keyboard isn't actually open — avoids unnecessary jumps
    // on desktop where focusin fires for normal tab navigation.
    setTimeout(() => {
      if(!root.classList.contains('kb-open')) return;
      try{ el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }catch(_){}
    }, 160);
  });
})();
window.announceTaskAdd=announceTaskAdd;

/**
 * Action toast: a transient bottom-right toast with a single action button
 * (typically "Undo"). The toast auto-dismisses after `ms` and the action
 * fires only if the user clicks it before then. Built via createElement so
 * any caller-supplied label is treated as text, never HTML.
 *
 *   showActionToast('Task added', 'Undo', () => removeTask(id), 5000);
 */
function showActionToast(label, actionLabel, actionFn, ms){
  const ttl = (typeof ms === 'number' && ms > 0) ? ms : 8000;
  // Mirror the action's undo into the global undo ring so Cmd+Z keeps
  // working after the toast fades. Only when actionLabel reads as "Undo"
  // (a "Dismiss" or "Confirm" toast isn't an undoable action).
  if(actionLabel && typeof actionFn === 'function' && /^\s*undo\b/i.test(String(actionLabel)) && typeof pushUndo === 'function'){
    try{ pushUndo(label, actionFn); }catch(_){}
  }
  let host = document.getElementById('actionToast');
  if(!host){
    host = document.createElement('div');
    host.id = 'actionToast';
    host.className = 'action-toast';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  // Reset any in-flight toast so the new one supersedes it cleanly.
  host.replaceChildren();
  clearTimeout(host._tm);
  clearInterval(host._prog);

  // Header row: label + button
  const hdr = document.createElement('div');
  hdr.className = 'action-toast-header';

  const lbl = document.createElement('span');
  lbl.className = 'action-toast-lbl';
  lbl.textContent = label;
  hdr.appendChild(lbl);

  if(actionLabel && typeof actionFn === 'function'){
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'action-toast-btn';
    btn.textContent = actionLabel;
    btn.onclick = () => {
      try { actionFn(); } catch(_) {}
      host.classList.remove('show');
      clearInterval(host._prog);
    };
    hdr.appendChild(btn);
  }
  // Dismiss × — always present so the toast never has to be waited out
  // when it lands over content the user wants to interact with.
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'toast-dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.textContent = '×';
  dismiss.onclick = () => {
    host.classList.remove('show');
    clearTimeout(host._tm);
    clearInterval(host._prog);
  };
  hdr.appendChild(dismiss);
  host.appendChild(hdr);

  // Ctrl+Z hint (only if undo button exists)
  if(actionLabel && typeof actionFn === 'function'){
    const kbdHint = document.createElement('span');
    kbdHint.className = 'action-toast-kbd-hint';
    kbdHint.textContent = 'Also: Ctrl+Z';
    host.appendChild(kbdHint);
  }

  // Progress bar
  const prog = document.createElement('div');
  prog.className = 'action-toast-progress';
  const progBar = document.createElement('div');
  progBar.className = 'action-toast-progress-bar';
  progBar.style.width = '100%';
  prog.appendChild(progBar);
  host.appendChild(prog);

  // Animate progress bar
  const startTime = Date.now();
  host._prog = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const pct = Math.max(0, 100 - (elapsed / ttl) * 100);
    progBar.style.width = pct + '%';
    if(pct <= 0) clearInterval(host._prog);
  }, 80);

  // Force a frame so the .show transition kicks in.
  requestAnimationFrame(() => host.classList.add('show'));
  host._tm = setTimeout(() => {
    host.classList.remove('show');
    clearInterval(host._prog);
  }, ttl);
}
window.showActionToast = showActionToast;
