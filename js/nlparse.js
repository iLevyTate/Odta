/**
 * Extends quick-add with chrono-node (dynamic import) for natural date phrases.
 * Depends on global parseQuickAdd from tasks.js.
 *
 * chrono-node is vendored under js/vendor/ — no CDN fetch, works offline.
 */
function _nlparseResolve(spec){
  if(!spec || typeof spec !== 'string') return spec;
  if(/^https?:\/\//i.test(spec)) return spec;
  try{
    return new URL(spec, document.baseURI).href;
  }catch(_e){
    return spec;
  }
}
const CHRONO_URL = _nlparseResolve(
  (window.ODTAULAI_CONFIG && window.ODTAULAI_CONFIG.CHRONO_URL) || './js/vendor/chrono-node.min.mjs');

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

/**
 * Async enrich: runs sync parseQuickAdd then chrono on remaining title for dueDate.
 * @returns {Promise<{name: string, props: object}>}
 */
async function parseQuickAddAsync(raw){
  if(typeof parseQuickAdd !== 'function'){
    console.warn('[nlparse] parseQuickAdd missing');
    return { name: String(raw || '').trim(), props: {} };
  }
  const base = parseQuickAdd(raw);
  if(!base.name || base.props.dueDate) return base;

  try{
    const chrono = await loadChrono();
    const root = chrono.default || chrono;
    const parser = root.parse || chrono.parse;
    if(!parser) return base;
    const results = parser.call(root, base.name, new Date(), { forwardDate: true });
    if(results && results.length){
      const start = results[0].start && results[0].start.date();
      if(start){
        const iso = _isoDate(start);
        if(iso) base.props.dueDate = iso;
      }
    }
  }catch(e){
    console.warn('[nlparse] chrono failed', e);
  }
  return base;
}

window.loadChrono = loadChrono;
window.parseQuickAddAsync = parseQuickAddAsync;
