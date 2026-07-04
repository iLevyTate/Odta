/**
 * Dropdown - pop-up selection picker. One open at a time. Modeled on the
 * same pattern as js/modal.js: a small dependency-free utility attached
 * to window.Dropdown with explicit lifecycle hooks.
 *
 * Public API:
 *   Dropdown.open(trigger, opts) -> Promise<value|null>
 *     trigger : Element                 (the button the dropdown anchors to)
 *     opts    : {
 *       options:    Array<{value, label, icon?, color?}>,
 *       selected?:  value,              (pre-highlight)
 *       anchor?:    'auto'|'below'|'above',   (default 'auto')
 *       searchable?: boolean,           (always-on for >8 options)
 *       onSelect:   (value) => void,
 *       onClose?:   () => void,
 *     }
 *   Dropdown.close()       -> closes the currently-open dropdown
 *   Dropdown.isOpen()      -> true if a dropdown is currently open
 *
 * Mobile (<=640px): renders as a bottom sheet instead of an inline popover.
 *
 * ARIA: container is role=listbox, items are role=option with aria-selected.
 */
(function(){
  'use strict';

  let _open = null;

  function _resolveAnchor(rect, vh, dropdownH, explicit){
    if(explicit === 'above' || explicit === 'below') return explicit;
    const roomBelow = vh - rect.bottom;
    const roomAbove = rect.top;
    if(roomBelow >= dropdownH) return 'below';
    if(roomAbove >= dropdownH) return 'above';
    return roomBelow >= roomAbove ? 'below' : 'above';
  }

  function _isNarrowViewport(){
    return typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches;
  }

  function open(trigger, opts){
    if(_open) close();
    if(!trigger || !opts || !Array.isArray(opts.options)) return Promise.resolve(null);

    return new Promise(function(resolve){
      const isSheet = _isNarrowViewport();
      const root = document.createElement('div');
      root.className = isSheet ? 'dropdown-sheet' : 'dropdown-popover';
      root.setAttribute('role', 'listbox');
      const list = document.createElement('div');
      list.className = 'dropdown-list';
      root.appendChild(list);

      let highlightIdx = -1;
      const options = opts.options;

      function _applyHighlight(){
        const items = Array.prototype.slice.call(list.querySelectorAll('.dropdown-item'));
        items.forEach(function(el, i){
          el.classList.toggle('is-highlight', i === highlightIdx);
          if(i === highlightIdx){
            el.setAttribute('aria-selected', 'true');
            if(el.scrollIntoView) try { el.scrollIntoView({ block: 'nearest' }); } catch(_){}
          } else if(el.dataset.value !== String(opts.selected)){
            el.removeAttribute('aria-selected');
          }
        });
      }

      function renderItems(filter){
        list.replaceChildren();
        const norm = (filter || '').toLowerCase().trim();
        // highlightIdx is an index into the VISIBLE (filtered) DOM items, not
        // the source options array — _applyHighlight/moveHighlight/Enter all
        // operate on the rendered subset. Recompute it from scratch on every
        // render so a filter change can never leave it pointing at the wrong
        // (or a now-hidden) row.
        highlightIdx = -1;
        let domIdx = 0;
        options.forEach(function(o){
          // Substring match — users expect "fox" to find "The quick fox",
          // not only labels that start with the query.
          if(norm && String(o.label || '').toLowerCase().indexOf(norm) === -1) return;
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'dropdown-item';
          item.setAttribute('role', 'option');
          item.dataset.value = o.value;
          if(o.color){
            const sw = document.createElement('span');
            sw.className = 'dropdown-swatch';
            sw.style.background = o.color;
            item.appendChild(sw);
          }
          const lab = document.createElement('span');
          lab.className = 'dropdown-label';
          lab.textContent = o.label;
          item.appendChild(lab);
          if(String(o.value) === String(opts.selected)){
            item.classList.add('is-selected');
            item.setAttribute('aria-selected', 'true');
            if(highlightIdx < 0) highlightIdx = domIdx;
          }
          item.addEventListener('click', function(){ select(o.value); });
          list.appendChild(item);
          domIdx++;
        });
        _applyHighlight();
      }

      let searchEl = null;
      if(opts.searchable || options.length > 8){
        searchEl = document.createElement('input');
        searchEl.type = 'text';
        searchEl.className = 'dropdown-search';
        searchEl.placeholder = 'Type to filter...';
        searchEl.addEventListener('input', function(){ renderItems(searchEl.value); });
        root.insertBefore(searchEl, list);
      }

      renderItems('');

      document.body.appendChild(root);
      const rect = trigger.getBoundingClientRect();
      const dropdownH = root.offsetHeight;
      const vh = window.innerHeight;
      if(!isSheet){
        const where = _resolveAnchor(rect, vh, dropdownH, opts.anchor || 'auto');
        root.style.position = 'fixed';
        root.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - root.offsetWidth - 8)) + 'px';
        root.style.top  = (where === 'below') ? (rect.bottom + 4) + 'px' : (rect.top - dropdownH - 4) + 'px';
      }

      const prevFocus = document.activeElement;
      if(searchEl){ try { searchEl.focus(); } catch(_){} }

      function moveHighlight(delta){
        const items = list.querySelectorAll('.dropdown-item');
        if(!items.length) return;
        if(highlightIdx < 0){
          // Nothing highlighted yet (e.g. just filtered): ArrowDown -> first,
          // ArrowUp -> last.
          highlightIdx = delta > 0 ? 0 : items.length - 1;
        } else {
          highlightIdx = (highlightIdx + delta + items.length) % items.length;
        }
        _applyHighlight();
      }

      function select(value){
        try { if(typeof opts.onSelect === 'function') opts.onSelect(value); }
        catch(err){ console.warn('[dropdown] onSelect', err); }
        close(value);
      }

      function keyHandler(e){
        if(e.key === 'ArrowDown'){ e.preventDefault(); moveHighlight(+1); return; }
        if(e.key === 'ArrowUp'){   e.preventDefault(); moveHighlight(-1); return; }
        if(e.key === 'Enter'){
          e.preventDefault();
          const items = list.querySelectorAll('.dropdown-item');
          const el = items[highlightIdx];
          if(el) select(el.dataset.value);
          return;
        }
        if(e.key === 'Escape'){ e.preventDefault(); close(null); return; }
        // Type-to-search by first character when no explicit search box is shown.
        if(!searchEl && /^[a-z0-9]$/i.test(e.key)){
          const items = Array.prototype.slice.call(list.querySelectorAll('.dropdown-item'));
          const idx = items.findIndex(function(el){
            return String(el.dataset.value || '').toLowerCase().indexOf(e.key.toLowerCase()) === 0
              || String(el.textContent).toLowerCase().indexOf(e.key.toLowerCase()) === 0;
          });
          if(idx >= 0){ highlightIdx = idx; _applyHighlight(); }
        }
      }
      document.addEventListener('keydown', keyHandler, true);

      function outsideHandler(e){
        if(_open && _open.el && !_open.el.contains(e.target) && e.target !== trigger){
          close(null);
        }
      }
      // Defer one frame so the click that opened the dropdown doesn't
      // immediately close it. Track the rAF id: if close() runs before the
      // frame fires, the pending callback would attach outside-handlers that
      // nothing ever removes — cancel it instead.
      const outsideRaf = requestAnimationFrame(function(){
        if(_open) _open.outsideRaf = null;
        document.addEventListener('mousedown', outsideHandler, true);
        document.addEventListener('touchstart', outsideHandler, { capture: true, passive: true });
      });

      _open = { el: root, opts: opts, resolve: resolve, prevFocus: prevFocus,
                keyHandler: keyHandler, outsideHandler: outsideHandler, outsideRaf: outsideRaf };
    });
  }

  function close(value){
    if(!_open) return;
    const ctx = _open;
    if(ctx.outsideRaf != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(ctx.outsideRaf);
    document.removeEventListener('keydown', ctx.keyHandler, true);
    document.removeEventListener('mousedown', ctx.outsideHandler, true);
    document.removeEventListener('touchstart', ctx.outsideHandler, { capture: true });
    if(ctx.el && ctx.el.parentNode) ctx.el.parentNode.removeChild(ctx.el);
    if(ctx.prevFocus && typeof ctx.prevFocus.focus === 'function'){
      try { ctx.prevFocus.focus(); } catch(_){}
    }
    _open = null;
    try { if(typeof ctx.opts.onClose === 'function') ctx.opts.onClose(); }
    catch(err){ console.warn('[dropdown] onClose', err); }
    if(typeof ctx.resolve === 'function') ctx.resolve(value === undefined ? null : value);
  }

  function isOpen(){ return _open !== null; }

  window.Dropdown = { open: open, close: close, isOpen: isOpen };
})();
