/**
 * Draggable / minimizable floating timer dock (Pomodoro + quick-timer summary).
 */
function _timerDockCfg(){
  if(typeof cfg !== 'object' || !cfg) return {};
  if(!cfg.timerDock || typeof cfg.timerDock !== 'object') cfg.timerDock = {};
  return cfg.timerDock;
}

// Free-dragging only makes sense on roomy (desktop) viewports. On narrow /
// mobile viewports the dock is pinned to a safe-area corner by CSS, so a saved
// free-drag position must NOT be applied — otherwise it fights the mobile
// `right`/`bottom` rules and the dock gets squeezed into a clipped sliver.
function _timerDockIsMobile(){
  try{ return window.matchMedia('(max-width:640px)').matches; }
  catch(_){ return window.innerWidth <= 640; }
}

// Drop any inline free-drag coords so the CSS corner positioning takes over.
function _timerDockClearInlinePos(dock){
  dock.style.left = '';
  dock.style.top = '';
  dock.style.right = '';
  dock.style.bottom = '';
}

function _timerDockApplyPos(dock){
  const c = _timerDockCfg();
  if(_timerDockIsMobile()){
    _timerDockClearInlinePos(dock);
    return;
  }
  if(typeof c.x === 'number' && typeof c.y === 'number'){
    // Clamp the saved position into the current viewport so a position saved on
    // a larger window can't drop the dock off-screen.
    const pad = 8;
    const w = dock.offsetWidth || 0;
    const h = dock.offsetHeight || 0;
    const left = Math.max(pad, Math.min(c.x, window.innerWidth - w - pad));
    const top = Math.max(pad, Math.min(c.y, window.innerHeight - h - pad));
    dock.style.left = left + 'px';
    dock.style.top = top + 'px';
    dock.style.right = 'auto';
    dock.style.bottom = 'auto';
  } else {
    _timerDockClearInlinePos(dock);
    if(c.corner) dock.dataset.corner = c.corner;
  }
}

function initTimerDock(){
  const dock = gid('timerDock');
  if(!dock) return;
  dock.classList.add('timer-dock');

  const c = _timerDockCfg();
  if(c.minimized) dock.classList.add('timer-dock--min');
  _timerDockApplyPos(dock);

  // Re-pin when the viewport changes (rotation, resize, crossing the mobile
  // breakpoint) so the dock never ends up off-screen or squeezed.
  if(!dock._dockResizeBound){
    dock._dockResizeBound = true;
    let raf = 0;
    window.addEventListener('resize', () => {
      if(raf) return;
      raf = requestAnimationFrame(() => { raf = 0; _timerDockApplyPos(dock); });
    });
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
        // A drag just ended on a handle that also carries a click action
        // (the minimized restore puck). Swallow the click that the browser
        // fires after pointerup so dragging the puck doesn't also restore it.
        dock._dragJustMoved = true;
        setTimeout(() => { dock._dragJustMoved = false; }, 0);
      }
      drag = null;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    const startDrag = (e, handle) => {
      if(e.button !== 0) return;
      // On mobile the dock is corner-pinned by CSS; free-dragging would only
      // write a position that fights those rules, so ignore drags there.
      if(_timerDockIsMobile()) return;
      const r = dock.getBoundingClientRect();
      dock.style.left = r.left + 'px';
      dock.style.top = r.top + 'px';
      dock.style.right = 'auto';
      dock.style.bottom = 'auto';
      drag = { x0: e.clientX, y0: e.clientY, left0: r.left, top0: r.top, moved: false };
      try{ handle.setPointerCapture(e.pointerId); }catch(_){}
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    };
    // The grip drags the expanded dock; the restore puck (shown when the dock
    // is collapsed to a circle) is also draggable so the minimized timer can be
    // repositioned. A plain click on the puck still restores the dock — only a
    // real drag is treated as a move (and its trailing click is suppressed).
    const grip = dock.querySelector('.timer-dock-grip');
    if(grip) grip.addEventListener('pointerdown', e => startDrag(e, grip));
    const handle = dock.querySelector('.timer-dock-handle');
    if(handle){
      handle.addEventListener('pointerdown', e => startDrag(e, handle));
      handle.addEventListener('click', e => {
        if(dock._dragJustMoved){ e.preventDefault(); e.stopImmediatePropagation(); }
      }, true);
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
  const dock = gid('timerDock');
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
