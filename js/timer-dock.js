/**
 * Draggable / minimizable floating timer dock (Pomodoro + quick-timer summary).
 */
function _timerDockCfg(){
  if(typeof cfg !== 'object' || !cfg) return {};
  if(!cfg.timerDock || typeof cfg.timerDock !== 'object') cfg.timerDock = {};
  return cfg.timerDock;
}

function initTimerDock(){
  const dock = gid('timerDock') || gid('miniTimer');
  if(!dock) return;
  dock.classList.add('timer-dock');

  const c = _timerDockCfg();
  if(c.minimized) dock.classList.add('timer-dock--min');
  if(typeof c.x === 'number' && typeof c.y === 'number'){
    dock.style.left = c.x + 'px';
    dock.style.top = c.y + 'px';
    dock.style.right = 'auto';
    dock.style.bottom = 'auto';
  } else if(c.corner){
    dock.dataset.corner = c.corner;
  }

  if(!dock._dockDragBound){
    dock._dockDragBound = true;
    let drag = null;
    const onMove = e => {
      if(!drag) return;
      const dx = (e.clientX || 0) - drag.x0;
      const dy = (e.clientY || 0) - drag.y0;
      if(!drag.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) drag.moved = true;
      if(!drag.moved) return;
      e.preventDefault();
      let left = drag.left0 + dx;
      let top = drag.top0 + dy;
      const pad = 8;
      const w = dock.offsetWidth;
      const h = dock.offsetHeight;
      left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));
      top = Math.max(pad, Math.min(top, window.innerHeight - h - pad));
      dock.style.left = left + 'px';
      dock.style.top = top + 'px';
      dock.style.right = 'auto';
      dock.style.bottom = 'auto';
      delete dock.dataset.corner;
    };
    const onUp = () => {
      if(!drag) return;
      if(drag.moved){
        const c2 = _timerDockCfg();
        c2.x = parseInt(dock.style.left, 10) || 0;
        c2.y = parseInt(dock.style.top, 10) || 0;
        delete c2.corner;
        if(typeof saveState === 'function') saveState('user');
      }
      drag = null;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    const grip = dock.querySelector('.timer-dock-grip');
    if(grip){
      grip.addEventListener('pointerdown', e => {
        if(e.button !== 0) return;
        const r = dock.getBoundingClientRect();
        dock.style.left = r.left + 'px';
        dock.style.top = r.top + 'px';
        dock.style.right = 'auto';
        dock.style.bottom = 'auto';
        drag = { x0: e.clientX, y0: e.clientY, left0: r.left, top0: r.top, moved: false };
        grip.setPointerCapture(e.pointerId);
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
      });
    }
  }
}

function toggleTimerDockMin(){
  const dock = gid('timerDock');
  if(!dock) return;
  const c = _timerDockCfg();
  c.minimized = !c.minimized;
  dock.classList.toggle('timer-dock--min', !!c.minimized);
  if(typeof saveState === 'function') saveState('user');
  if(typeof updateTimerDock === 'function') updateTimerDock();
}

function updateTimerDock(){
  const dock = gid('timerDock') || gid('miniTimer');
  if(!dock) return;

  const qtEl = gid('timerDockQt');
  if(!qtEl) return;
  const running = (typeof quickTimers !== 'undefined' && Array.isArray(quickTimers))
    ? quickTimers.filter(q => q && q.running && !q.finished)
    : [];
  if(running.length && activeTab !== 'focus'){
    qtEl.hidden = false;
    const first = running[0];
    const label = (first.label || 'Timer').slice(0, 24);
    const rem = typeof fmtHMS === 'function' ? fmtHMS(first.remaining || 0) : '';
    qtEl.textContent = running.length > 1
      ? running.length + ' timers · ' + label + ' ' + rem
      : label + ' ' + rem;
    qtEl.title = 'Open Focus → Quick timers';
  } else {
    qtEl.hidden = true;
    qtEl.textContent = '';
  }
}

window.initTimerDock = initTimerDock;
window.toggleTimerDockMin = toggleTimerDockMin;
window.updateTimerDock = updateTimerDock;

document.addEventListener('DOMContentLoaded', () => {
  try{ initTimerDock(); }catch(e){ console.warn('[timer-dock]', e); }
});
