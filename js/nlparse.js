/**
 * Extends quick-add with chrono-node (dynamic import) for natural date phrases.
 * Depends on global parseQuickAdd from tasks.js.
 *
 * chrono-node is vendored under js/vendor/ — no CDN fetch, works offline.
 */
const _NBASE = (typeof document !== 'undefined' && document.baseURI) || (typeof location !== 'undefined' ? location.href : '');
const CHRONO_URL = (window.ODTAULAI_CONFIG && window.ODTAULAI_CONFIG.CHRONO_URL)
  || (function(){ try { return new URL('js/vendor/chrono-node.min.mjs', _NBASE).href; } catch (_) { return './js/vendor/chrono-node.min.mjs'; } })();

let _chronoMod = null;
let _chronoLoad = null;

async function loadChrono(){
  if(_chronoMod) return _chronoMod;
  if(_chronoLoad) return _chronoLoad;
  _chronoLoad = import(CHRONO_URL).then(m => { _chronoMod = m; return m; });
  return _chronoLoad;
}

function _isoDate(d){
  const x = new Date(d);
  if(Number.isNaN(+x)) return null;
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}

function _pad2(n){ return String(n).padStart(2, '0'); }

function _localDateTime(d){
  if(!d || Number.isNaN(+d)) return null;
  return d.getFullYear() + '-' + _pad2(d.getMonth() + 1) + '-' + _pad2(d.getDate())
    + 'T' + _pad2(d.getHours()) + ':' + _pad2(d.getMinutes());
}

function _applyChronoResult(base, r0){
  if(!r0 || !r0.start) return;
  const start = r0.start.date();
  if(!start) return;
  const iso = _isoDate(start);
  if(iso && !base.props.dueDate) base.props.dueDate = iso;
  const hasTime = r0.start.isCertain && (
    r0.start.isCertain('hour') || r0.start.isCertain('minute')
  );
  if(hasTime){
    const dt = _localDateTime(start);
    if(dt) base.props.remindAt = dt;
    if(iso) base.props.dueDate = iso;
  }
  if(r0.text != null && typeof r0.index === 'number' && base.name){
    const before = base.name.slice(0, r0.index).trim();
    const after = base.name.slice(r0.index + r0.text.length).trim();
    base.name = (before + (before && after ? ' ' : '') + after).replace(/\s+/g, ' ').trim();
  }
}

/**
 * Async enrich: runs sync parseQuickAdd then chrono on remaining title.
 * @returns {Promise<{name: string, props: object}>}
 */
async function parseQuickAddAsync(raw){
  if(typeof parseQuickAdd !== 'function'){
    console.warn('[nlparse] parseQuickAdd missing');
    return { name: String(raw || '').trim(), props: {} };
  }
  const base = parseQuickAdd(raw);
  if(!base.name) return base;

  try{
    const chrono = await loadChrono();
    const root = chrono.default || chrono;
    const parser = root.parse || chrono.parse;
    if(!parser) return base;
    const results = parser.call(root, base.name, new Date(), { forwardDate: true });
    if(results && results.length) _applyChronoResult(base, results[0]);
  }catch(e){
    console.warn('[nlparse] chrono failed', e);
  }
  return base;
}

let _liveParseTimer = null;
function scheduleLiveParsePreview(){
  if(_liveParseTimer) clearTimeout(_liveParseTimer);
  _liveParseTimer = setTimeout(async () => {
    _liveParseTimer = null;
    const inp = typeof gid === 'function' ? gid('taskInput') : null;
    const host = typeof gid === 'function' ? gid('qaParseChips') : null;
    if(!inp || !host) return;
    const raw = inp.value;
    if(!raw || raw.length < 2){
      if(typeof clearLiveParsePreview === 'function') clearLiveParsePreview();
      return;
    }
    let parsed = { name: raw, props: {} };
    if(typeof parseQuickAddAsync === 'function'){
      try{ parsed = await parseQuickAddAsync(raw); }catch(_){}
    } else if(typeof parseQuickAdd === 'function'){
      parsed = parseQuickAdd(raw);
    }
    const props = parsed.props || {};
    const chips = [];
    const _qpc = typeof _qpcChip === 'function' ? _qpcChip : null;
    if(_qpc){
      if(props.priority) chips.push(_qpc('danger', '@'+props.priority, 'Priority'));
      if(props.tags && props.tags.length) props.tags.forEach(t => chips.push(_qpc('tag', '#'+t, 'Tag')));
      if(props.starred) chips.push(_qpc('star', '★', 'Pinned'));
      if(props.recur) chips.push(_qpc('recur', '↻ '+props.recur, 'Repeats'));
      if(props.type) chips.push(_qpc('tag', '%'+props.type, 'Type'));
      if(props.dueDate){
        let label = props.dueDate;
        if(typeof prettyDate === 'function'){ try{ label = prettyDate(props.dueDate); }catch(_){} }
        chips.push(_qpc('due', label, 'Due'));
      }
      if(props.remindAt) chips.push(_qpc('due', '⏰ remind', 'Reminder time'));
    }
    if(!chips.length){
      if(typeof clearLiveParsePreview === 'function') clearLiveParsePreview();
      return;
    }
    host.replaceChildren();
    if(parsed.name && parsed.name !== raw){
      const n = document.createElement('span');
      n.className = 'qpc-name';
      n.textContent = parsed.name;
      host.appendChild(n);
    }
    const list = document.createElement('span');
    list.className = 'qpc-list';
    chips.forEach(c => list.appendChild(c));
    host.appendChild(list);
    host.hidden = false;
  }, 280);
}

window.loadChrono = loadChrono;
window.parseQuickAddAsync = parseQuickAddAsync;
window.scheduleLiveParsePreview = scheduleLiveParsePreview;
