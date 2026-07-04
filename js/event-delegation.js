/**
 * Single-document delegated event dispatcher.
 *
 * Replaces inline `onclick="fn(arg)"` / `onchange="fn()"` etc. attributes,
 * which require CSP `script-src 'unsafe-inline'`. With every handler going
 * through this dispatcher, the CSP can drop `'unsafe-inline'` and gain real
 * XSS protection.
 *
 * Markup conventions:
 *
 *   <button data-action="fnName" data-args='["a", 1]'>     → fnName('a', 1)
 *   <button data-action="fnName" data-arg="single">        → fnName('single')
 *   <button data-action="fnName">                          → fnName()
 *
 *   <select data-onchange="fnName">    → fnName.call(el, event) on change
 *   <input data-oninput="fnName">      → fnName.call(el, event) on input
 *   <input data-onkeydown="fnName">    → fnName.call(el, event) on keydown
 *   <details data-ontoggle="fnName">   → fnName.call(el, event) on toggle
 *
 *   <div data-action="fnName" data-stop-prop="1">  → calls e.stopPropagation()
 *
 * Handler resolution: looks up `window[name]`. If the function isn't defined
 * yet, the click is silently no-op'd (matches the legacy `typeof fn ===
 * 'function'` guards scattered through inline handlers today).
 */
(function setupEventDelegation(){
  function resolve(name){
    if(!name || typeof name !== 'string') return null;
    const fn = window[name];
    return typeof fn === 'function' ? fn : null;
  }

  function parseArgs(el){
    if(!el || !el.dataset) return [];
    const ds = el.dataset;
    if(ds.args){
      try {
        const a = JSON.parse(ds.args);
        return Array.isArray(a) ? a : [a];
      } catch(e){ return []; }
    }
    if(ds.arg !== undefined) return [ds.arg];
    return [];
  }

  // Click — the by-far most common handler. Event is passed as the LAST
  // argument so handlers that need it (modal-backdrop close, miniTimer
  // delegation, etc.) can read e.target / e.key without breaking handlers
  // that just ignore the extra arg.
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if(!el) return;
    if(el.dataset.stopProp === '1') e.stopPropagation();
    if(el.dataset.preventDefault === '1') e.preventDefault();
    const fn = resolve(el.dataset.action);
    if(!fn) return;
    try { fn.apply(el, [...parseArgs(el), e]); }
    catch(err){ console.error('[delegation] click handler failed:', el.dataset.action, err); }
  });

  // Generic factory for the form/text-input event family. Each event type
  // looks at `data-on<type>` for the handler name.
  function attachEvent(eventName, dataAttr){
    document.addEventListener(eventName, e => {
      // e.target may be a non-Element (text node, document) for some events.
      const target = e.target;
      if(!target || typeof target.closest !== 'function') return;
      const el = target.closest(`[data-${dataAttr}]`);
      if(!el) return;
      const fn = resolve(el.dataset[toCamel(dataAttr)]);
      if(!fn) return;
      try { fn.call(el, e); }
      catch(err){ console.error(`[delegation] ${eventName} handler failed:`, el.dataset[toCamel(dataAttr)], err); }
    }, NON_BUBBLING.has(eventName));
  }
  // toggle, focus and blur do not bubble — a document-level listener only sees
  // them in the capture phase, so bubble-phase delegation for these types
  // would silently never fire.
  const NON_BUBBLING = new Set(['toggle', 'focus', 'blur']);

  function toCamel(kebab){
    return kebab.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }

  attachEvent('change',  'onchange');
  attachEvent('input',   'oninput');
  attachEvent('keydown', 'onkeydown');
  attachEvent('keyup',   'onkeyup');
  attachEvent('blur',    'onblur');
  attachEvent('focus',   'onfocus');
  attachEvent('submit',  'onsubmit');
  attachEvent('toggle',  'ontoggle');

  // Keyboard activation for non-button elements that opt into button semantics
  // via role="button". The native button element handles Enter/Space already,
  // so this only matters for divs/spans tagged role="button" (e.g. the
  // mini-timer wrapper). Without this, keyboard-only users can focus the
  // element but can't trigger its data-action. Synthesises a click so the
  // existing click delegation above handles the dispatch.
  document.addEventListener('keydown', e => {
    if(e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target;
    if(!target || typeof target.closest !== 'function') return;
    const el = target.closest('[role="button"][data-action]');
    if(!el || el.tagName === 'BUTTON' || el.tagName === 'A') return;
    // Skip when the focus is inside a form control sitting inside the
    // role=button container — those have their own activation semantics.
    const editable = target.closest('input, textarea, select, button, [contenteditable="true"]');
    if(editable && editable !== el && el.contains(editable)) return;
    e.preventDefault();
    try { el.click(); }
    catch(err){ console.error('[delegation] keyboard activation failed:', err); }
  });

  // Expose for any code that wants to manually dispatch (rare).
  window.ODTAULAI_DELEGATION_READY = true;
})();
