/**
 * Modal — single open/close mechanism for every modal-like surface.
 *
 * Stage 2 of the modal-system unification (see plan in
 * ~/.claude/plans/effervescent-sparking-llama.md).
 *
 * Public API (attached to window.Modal):
 *   Modal.open(id, opts) -> Promise<true>     // resolves when opacity transition ends
 *   Modal.close(id, result)                    // pops the modal from the stack
 *   Modal.isOpen(id) -> boolean
 *   Modal.topmost() -> string|null
 *
 * opts (all optional):
 *   variant:        'sheet' | 'dialog' | 'palette'  (default inferred from class)
 *   focus:          selector|Element            (focus after open transition; overrides default trap focus)
 *   onOpen(el):     callback fired AFTER the opacity transition completes
 *   onClose(el, r): callback fired when close() is invoked
 *   onRequestClose(): user-requested-close hook (ESC). If provided, the
 *                     Modal utility calls THIS instead of Modal.close so the
 *                     project can run cleanup (e.g. confirm unsaved edits,
 *                     abort in-flight work) and call Modal.close itself when
 *                     ready. Default: Modal.close fires directly.
 *   skipFocusTrap:  install only tab-cycling, no initial focus / prev-focus mgmt
 *   skipInitialFocus: keep focus-trap behaviour but don't auto-focus first item
 *
 * Variants govern behaviour, not look:
 *   sheet   — body scroll lock + swipe-down dismiss (mobile)
 *   dialog  — body scroll lock; no swipe
 *   palette — no scroll lock, no swipe (Cmd+K style overlay)
 *
 * Stack semantics: nested modals stack. ESC closes the topmost; body scroll
 * lock is reference-counted so it releases only when the stack empties.
 *
 * Depends on (graceful when missing):
 *   - openFocusTrap / closeFocusTrap / installTabTrap / removeTabTrap (ui-flip.js)
 *   - bindSheetSwipe (ui.js)
 * Reads --dur-modal from :root; transitions are CSS-driven.
 */
(function(){
  'use strict';

  const VARIANTS = {
    sheet:   { swipe: true,  scrollLock: true,  inferClass: 'modal-overlay'    },
    dialog:  { swipe: false, scrollLock: true,  inferClass: 'modal-overlay'    },
    palette: { swipe: false, scrollLock: false, inferClass: 'cmdk-overlay'     },
  };

  // Stack of currently-open ids. _state holds per-id metadata used at close.
  const _stack = [];
  const _state = new Map();

  // Body-scroll-lock refcount — multiple modals can lock; we only unlock once
  // the last one closes. Preserves scroll position via window.scrollY save+restore.
  let _scrollY = 0, _lockCount = 0;

  function _lockBody(){
    _lockCount++;
    if(_lockCount > 1) return;
    _scrollY = window.scrollY || window.pageYOffset || 0;
    document.body.classList.add('modal-locked');
    // position:fixed on body keeps the scroll position visible without
    // jumping; complement to scrollbar-gutter:stable on <html>.
    document.body.style.top = (-_scrollY) + 'px';
  }
  function _unlockBody(){
    _lockCount = Math.max(0, _lockCount - 1);
    if(_lockCount > 0) return;
    document.body.classList.remove('modal-locked');
    document.body.style.top = '';
    if(_scrollY){ window.scrollTo(0, _scrollY); _scrollY = 0; }
  }

  function _inferVariant(el){
    // mobile sheets (.modal-overlay) default to sheet; dialog is opt-in via opts.variant.
    if(el.classList.contains('cmdk-overlay')) return 'palette';
    if(el.classList.contains('what-next-overlay')) return 'palette';
    return 'sheet';
  }

  function open(id, opts){
    opts = opts || {};
    const el = document.getElementById(id);
    if(!el) return Promise.resolve(false);
    if(el.classList.contains('open')) return Promise.resolve(true);

    const variant = opts.variant || _inferVariant(el);
    const v = VARIANTS[variant] || VARIANTS.dialog;

    _state.set(id, { variant, onClose: opts.onClose, onRequestClose: opts.onRequestClose, locked: v.scrollLock });
    _stack.push(id);
    if(v.scrollLock) _lockBody();

    el.classList.add('open');

    // Defer trap installation by one rAF so the element has reached visible
    // computed style before _focusables() filters by offsetWidth/offsetHeight.
    // (Filter at ui-flip.js:68 excludes invisible elements; without the rAF,
    // first paint is still opacity:0 and everything filters out.)
    requestAnimationFrame(function(){
      if(opts.skipFocusTrap){
        if(typeof installTabTrap === 'function') installTabTrap(el);
      } else if(typeof openFocusTrap === 'function'){
        openFocusTrap(el, { skipInitialFocus: !!opts.skipInitialFocus });
      }
      if(opts.focus){
        const t = (typeof opts.focus === 'string') ? el.querySelector(opts.focus) : opts.focus;
        if(t && typeof t.focus === 'function'){
          try { t.focus({ preventScroll: true }); } catch(_){ try { t.focus(); } catch(_){} }
        }
      }
    });

    if(v.swipe && typeof bindSheetSwipe === 'function'){
      bindSheetSwipe(el, function(){
        const s = _state.get(id);
        if(s && typeof s.onRequestClose === 'function'){
          try { s.onRequestClose(); } catch(err){ console.warn('[modal] swipe onRequestClose', err); close(id); }
        } else {
          close(id);
        }
      });
    }

    // Resolve when the overlay's opacity transition completes — matches the
    // .backdrop-ready trigger so callers can rely on the modal being fully
    // visible when onOpen fires.
    return new Promise(function(resolve){
      let done = false;
      const onEnd = function(e){
        if(done) return;
        if(e.target !== el || e.propertyName !== 'opacity') return;
        done = true;
        el.removeEventListener('transitionend', onEnd);
        if(typeof opts.onOpen === 'function'){
          try { opts.onOpen(el); } catch(err){ console.warn('[modal] onOpen', err); }
        }
        resolve(true);
      };
      el.addEventListener('transitionend', onEnd);
      // Safety net — if transitionend never fires (reduced-motion, browser
      // bug, element removed), still resolve and run onOpen.
      // 400ms covers --dur-modal (240) and --dur-fast (120) with margin.
      setTimeout(function(){
        if(done) return;
        done = true;
        el.removeEventListener('transitionend', onEnd);
        if(typeof opts.onOpen === 'function'){
          try { opts.onOpen(el); } catch(err){ /* swallow */ }
        }
        resolve(true);
      }, 400);
    });
  }

  function close(id, result){
    const el = document.getElementById(id);
    if(!el) return;

    const idx = _stack.lastIndexOf(id);
    if(idx >= 0) _stack.splice(idx, 1);
    const s = _state.get(id);
    _state.delete(id);

    el.classList.remove('open');

    // Drop focus trap if it was on this element. closeFocusTrap restores
    // the previously-focused element (the trigger that opened the modal).
    if(typeof closeFocusTrap === 'function') closeFocusTrap();

    if(s && s.locked) _unlockBody();

    if(s && typeof s.onClose === 'function'){
      try { s.onClose(el, result); } catch(err){ console.warn('[modal] onClose', err); }
    }
  }

  function isOpen(id){
    const el = document.getElementById(id);
    return !!(el && el.classList.contains('open'));
  }
  function topmost(){ return _stack.length ? _stack[_stack.length - 1] : null; }

  // ESC closes the topmost modal in our managed stack. Capture phase so we
  // run before bubble-phase listeners; we only act if the top is OUR modal,
  // so unmigrated modals still fall through to the legacy ESC chain.
  //
  // If the opening caller registered onRequestClose, we delegate to it so
  // project-level cleanup (e.g. closeBulkImportModal's "discard edits?"
  // confirmation) runs before the modal is actually torn down. Otherwise
  // we close directly.
  document.addEventListener('keydown', function(e){
    if(e.key !== 'Escape') return;
    const top = topmost();
    if(!top) return;
    e.preventDefault();
    e.stopPropagation();
    const s = _state.get(top);
    if(s && typeof s.onRequestClose === 'function'){
      try { s.onRequestClose(); } catch(err){ console.warn('[modal] onRequestClose', err); close(top); }
    } else {
      close(top);
    }
  }, true);

  // Backdrop click is handled by the existing data-action="closeXxxOnBackdrop"
  // wires in app.js (which go through _backdropClose). Once each modal's
  // closeXxx function is migrated to call Modal.close, backdrop clicks route
  // through the Modal utility automatically — no separate delegated handler
  // needed here, and we avoid double-firing.

  window.Modal = { open, close, isOpen, topmost };
})();
