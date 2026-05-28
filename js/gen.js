// ========== GENERATIVE LLM (opt-in, local-only) ==========
// Mirrors js/intel.js but loads a small instruct-tuned text-generation
// pipeline for the Ask feature. Strictly opt-in: nothing happens until
// the user flips a Settings toggle AND clicks download. No cloud LLM,
// no analytics, no fetch besides the one-time model weights from the
// same Hugging Face CDN already used by the embedding model.

const _GC = window.ODTAULAI_CONFIG || {};
const GEN_TRANSFORMERS_CDN = _GC.TRANSFORMERS_CDN || 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.1';
const GEN_CFG_KEY  = (_GC.STORAGE_KEYS && _GC.STORAGE_KEYS.GEN_CFG)     || 'stupind_gen_cfg';
const GEN_HIST_KEY = (_GC.STORAGE_KEYS && _GC.STORAGE_KEYS.GEN_HISTORY) || 'stupind_gen_history';

// Published instruct-tuned models with ONNX weights. The HuggingFaceTB
// originals and onnx-community repacks both ship ONNX weights under onnx/.
// If one namespace is unreachable, the other usually works — so we surface
// both as presets and auto-retry the sibling on load failure.
const GEN_MODEL_PRESETS = [
  { id:'HuggingFaceTB/SmolLM2-360M-Instruct',        dtype:'q4', sizeMb:230, label:'SmolLM2 360M (balanced)',       note:'Recommended for most devices' },
  { id:'HuggingFaceTB/SmolLM2-135M-Instruct',        dtype:'q4', sizeMb:100, label:'SmolLM2 135M (tiny)',           note:'Lowest RAM — older phones' },
  { id:'onnx-community/Qwen2.5-0.5B-Instruct',       dtype:'q4', sizeMb:320, label:'Qwen2.5 0.5B (bigger)',         note:'Desktop / WebGPU preferred' },
  { id:'onnx-community/Qwen2.5-1.5B-Instruct',     dtype:'q4', sizeMb:600, label:'Qwen2.5 1.5B (native tools)',  note:'Cognitask uses tokenizer tools + <tool_call> XML; WebGPU recommended' },
  { id:'onnx-community/SmolLM2-360M-Instruct',       dtype:'q4', sizeMb:230, label:'SmolLM2 360M (onnx-community)', note:'Use if HuggingFaceTB mirror fails' },
  { id:'onnx-community/SmolLM2-135M-Instruct-ONNX',  dtype:'q4', sizeMb:100, label:'SmolLM2 135M (onnx-community)', note:'Use if HuggingFaceTB mirror fails' },
];

// Slugs we'll transparently retry if the primary 401/403/404s.
const GEN_MODEL_ALT_SLUGS = {
  'HuggingFaceTB/SmolLM2-360M-Instruct': 'onnx-community/SmolLM2-360M-Instruct',
  'HuggingFaceTB/SmolLM2-135M-Instruct': 'onnx-community/SmolLM2-135M-Instruct-ONNX',
};

// Any pre-v27 config that points at the stale Xenova/* slugs gets reset to
// the current default preset. Keeps existing users from hitting a 401.
const GEN_CFG_VERSION = 2;

let _genPipe = null;
let _genReady = false;
let _genLoading = false;
let _genGenerating = false;
let _genDevice = null;
let _genModelId = null;
let _genLoadPromise = null;
let _genLoadAbortCtl = null;
let _genAbortCtl = null;
let _genLastError = null;
let _genStoppingCriteria = null; // InterruptableStoppingCriteria instance (if available)
// (M5) Sets tracking all concurrent in-flight abort controllers / stopping
// criteria so genAbort() can cancel every active call, not just the latest.
const _genActiveAbortCtls = new Set();
const _genActiveStoppers  = new Set();
let _genTransformersMod = null;  // cached module handle
/** Ref-count concurrent genGenerate calls — only clear "busy" when the last in-flight run finishes. */
let _genGenInFlight = 0;

function getGenDevice(){ return _genDevice; }
function getGenModel(){ return _genModelId; }
function isGenReady(){ return _genReady; }
function isGenLoading(){ return _genLoading; }
function isGenGenerating(){ return _genGenerating; }
function isGenBusy(){ return _genLoading || _genGenerating; }
function getGenLastError(){ return _genLastError; }
function clearGenLastError(){ _genLastError = null; }

async function _importTransformers(){
  if(_genTransformersMod) return _genTransformersMod;
  _genTransformersMod = await import(GEN_TRANSFORMERS_CDN);
  return _genTransformersMod;
}

/**
 * Force-reload the Transformers.js module on next import.
 * Used when a WebGPU crash poisons the ONNX Runtime WASM instance — a fresh
 * import gets a new, un-aborted WASM module for the CPU fallback path.
 */
function _resetTransformersCache(){
  _genTransformersMod = null;
}

/**
 * Pre-flight check: verify the browser can actually create a WebGPU device.
 * Returns true only when adapter + device succeed; false on any failure.
 * Prevents the fatal ONNX Runtime WASM `Aborted()` crash that occurs when
 * WebGPU is nominally present but the GPU backend can't initialise.
 */
async function _probeWebGPU(){
  try{
    if(typeof navigator === 'undefined' || !navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    if(!adapter) return false;
    const device = await adapter.requestDevice();
    if(!device) return false;
    device.destroy();
    return true;
  }catch(e){
    console.info('[gen] WebGPU probe failed — will use WASM (CPU)', e);
    return false;
  }
}

function _pickDefaultPresetForDevice(){
  // Low-RAM devices default to the Tiny preset; otherwise the Balanced one.
  if(typeof navigator !== 'undefined' && typeof navigator.deviceMemory === 'number' && navigator.deviceMemory < 4){
    const tiny = GEN_MODEL_PRESETS.find(p => /135M/i.test(p.label));
    if(tiny) return tiny;
  }
  return GEN_MODEL_PRESETS[0];
}

function _loadGenCfg(){
  let cfg = {};
  try{ cfg = JSON.parse(localStorage.getItem(GEN_CFG_KEY) || '{}') || {}; }
  catch(e){ cfg = {}; }
  const fresh = !cfg.modelId;
  if(typeof cfg.enabled !== 'boolean') cfg.enabled = false;
  if(fresh){
    const preset = _pickDefaultPresetForDevice();
    cfg.modelId = preset.id;
    cfg.dtype   = preset.dtype;
  }
  if(!cfg.dtype)  cfg.dtype  = GEN_MODEL_PRESETS[0].dtype;
  if(typeof cfg.timeoutSec !== 'number') cfg.timeoutSec = _defaultTimeoutSec();

  // Per-model download record. Back-compat for installs predating downloadedIds:
  // legacy `downloaded:true` means the currently-selected model was the last
  // one fetched, so seed that id into the array.
  if(!Array.isArray(cfg.downloadedIds)){
    cfg.downloadedIds = (cfg.downloaded === true && cfg.modelId) ? [cfg.modelId] : [];
  }

  // Migrate: old builds wrote Xenova/SmolLM2-* ids that don't exist on HF.
  // Also fall forward to the current default if the stored id isn't in the
  // preset list so users never get stuck on a stale slug. When migrating off
  // a dead slug we purge the downloadedIds cache too — those weights never
  // actually landed in the browser cache.
  const known = GEN_MODEL_PRESETS.some(p => p.id === cfg.modelId);
  if(!known || cfg.cfgVersion !== GEN_CFG_VERSION){
    const preset = _pickDefaultPresetForDevice();
    cfg.modelId = preset.id;
    cfg.dtype = preset.dtype;
    cfg.downloadedIds = cfg.downloadedIds.filter(id => GEN_MODEL_PRESETS.some(p => p.id === id));
    cfg.cfgVersion = GEN_CFG_VERSION;
  }

  // Keep the legacy boolean in sync for any external readers.
  cfg.downloaded = cfg.downloadedIds.includes(cfg.modelId);
  return cfg;
}

/** True if weights for `modelId` have been fetched at least once on this device. */
function isGenDownloaded(modelId){
  if(!modelId) return false;
  const cfg = _loadGenCfg();
  return cfg.downloadedIds.includes(modelId);
}

/** Record a successful download for `modelId`. */
function markGenDownloaded(modelId){
  if(!modelId) return;
  const cfg = _loadGenCfg();
  if(!cfg.downloadedIds.includes(modelId)) cfg.downloadedIds.push(modelId);
  cfg.downloaded = cfg.downloadedIds.includes(cfg.modelId);
  _saveGenCfg(cfg);
}

function _saveGenCfg(cfg){
  try{ localStorage.setItem(GEN_CFG_KEY, JSON.stringify(cfg)); }catch(e){}
}

function _defaultTimeoutSec(){
  // Guarded so Node test harnesses without a navigator shim don't blow up
  // (the browser always has one).
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);
  return isMobile ? 30 : 60;
}

function _mobileRamHint(){
  // Very coarse hint; iOS Safari does not report deviceMemory, fall back to agent.
  if(typeof navigator === 'undefined') return null;
  const dm = navigator.deviceMemory;
  if(typeof dm === 'number' && dm < 4) return 'low';
  if(/iPhone|iPad|iPod/.test(navigator.userAgent || '')) return 'ios-unknown';
  return null;
}

function getGenPresets(){ return GEN_MODEL_PRESETS.slice(); }
function getGenCfg(){ return _loadGenCfg(); }
function saveGenCfg(cfg){ _saveGenCfg(cfg); return cfg; }

function getAskHistory(){
  try{ const arr = JSON.parse(localStorage.getItem(GEN_HIST_KEY) || '[]'); return Array.isArray(arr) ? arr : []; }
  catch(e){ return []; }
}
function pushAskHistory(text){
  const s = String(text || '').trim();
  if(!s) return;
  const arr = getAskHistory().filter(x => x && x.text !== s);
  arr.unshift({ ts: Date.now(), text: s.slice(0, 280) });
  try{ localStorage.setItem(GEN_HIST_KEY, JSON.stringify(arr.slice(0, 5))); }catch(e){}
}
function clearAskHistory(){
  try{ localStorage.removeItem(GEN_HIST_KEY); }catch(e){}
}

/**
 * Best-effort "clear cached LLM weights." Transformers.js uses the browser
 * HTTP cache (not IndexedDB), so we can only clear caches *we* own — anything
 * the browser auto-caches is left to "Clear site data." We scan for any
 * Cache Storage entries that look like HF weights and delete them.
 * Returns the number of cache entries removed.
 */
async function clearLLMCache(){
  if(typeof caches === 'undefined' || !caches.keys) return 0;
  let removed = 0;
  try{
    const keys = await caches.keys();
    for(const k of keys){
      // Only touch caches we might have created, not the PWA shell cache.
      if(k && /transformers|huggingface|gen|llm/i.test(k) && !/odtaulai-v\d/.test(k)){
        const ok = await caches.delete(k);
        if(ok) removed++;
      }
    }
  }catch(e){ /* swallow */ }
  return removed;
}

function _isMissingFileError(e){
  const m = String((e && e.message) || e || '');
  return /Unauthorized|status:\s*40[134]|404|\bnot found\b/i.test(m);
}

/**
 * Load the text-generation pipeline. Does nothing if already loaded for this
 * modelId.
 *
 * Concurrency:
 *   - Same model already loading → return the in-flight promise.
 *   - *Different* model requested while one is mid-load → reject with
 *     GEN_SWITCH_IN_PROGRESS so callers never silently receive the wrong
 *     pipeline. (The UI disables the model dropdown while loading to avoid
 *     tripping this in practice.)
 *
 * Supports abort via genAbortLoad() and auto-retries an alternate namespace
 * (e.g. `onnx-community/*`) when the primary repo returns 401/403/404.
 *
 * @param {string} modelId
 * @param {string} dtype
 * @param {(progress: { progress?:number, status?:string, file?:string }) => void} [onProgress]
 */
async function genLoad(modelId, dtype, onProgress){
  if(!modelId) throw new Error('GEN_NO_MODEL');
  if(_genReady && _genModelId === modelId) return;
  if(_genLoadPromise){
    if(_genModelId === modelId) return _genLoadPromise;
    throw new Error('GEN_SWITCH_IN_PROGRESS');
  }

  _genLoading = true;
  _genModelId = modelId;
  _genReady = false;
  _genPipe = null;
  _genDevice = null;
  _genLastError = null;
  _genLoadAbortCtl = new AbortController();
  const loadSignal = _genLoadAbortCtl.signal;

  const cb = typeof onProgress === 'function' ? onProgress : () => {};

  _genLoadPromise = (async () => {
    let pipeline, env;
    try{
      const mod = await _importTransformers();
      pipeline = mod.pipeline;
      env = mod.env;
    }catch(e){
      _genLastError = 'Failed to load Transformers.js from CDN: ' + (e.message || e);
      throw e;
    }
    env.allowLocalModels = false;
    env.useBrowserCache = true;

    // On WebGPU we prefer q4f16 (int4 weights + fp16 activations) when the
    // caller's stored dtype is plain q4; on WASM we use q4 (fp16 activations
    // aren't supported). This mirrors what works across Transformers.js v3.
    const webgpuDtype = dtype === 'q4' ? 'q4f16' : (dtype || 'q4f16');
    const wasmDtype   = dtype === 'q4f16' ? 'q4' : (dtype || 'q4');

    const tryPipeline = async (slug) => {
      // ---- WebGPU attempt (only if probe succeeds) ----
      const gpuOk = await _probeWebGPU();
      if(gpuOk){
        try{
          if(loadSignal.aborted) throw new Error('LOAD_ABORTED');
          _genPipe = await pipeline('text-generation', slug, {
            device: 'webgpu',
            dtype: webgpuDtype,
            progress_callback: cb,
          });
          _genDevice = 'webgpu';
          return; // success — done
        }catch(e){
          if(loadSignal.aborted) throw new Error('LOAD_ABORTED');
          console.warn('[gen] WebGPU pipeline failed, falling back to WASM', e);
          // A fatal WASM Aborted() crash poisons the ONNX Runtime instance.
          // Force-reset so the WASM fallback below gets a clean module.
          _resetTransformersCache();
          try{
            const freshMod = await _importTransformers();
            pipeline = freshMod.pipeline;
          }catch(reimportErr){
            console.error('[gen] Failed to re-import Transformers.js after WebGPU crash', reimportErr);
          }
        }
      } else {
        console.info('[gen] WebGPU not available — loading with WASM (CPU)');
      }
      // ---- WASM (CPU) fallback ----
      if(loadSignal.aborted) throw new Error('LOAD_ABORTED');
      try{ cb({ status: 'Loading with WASM (CPU)', file: slug, progress: undefined }); }catch(_){}
      _genPipe = await pipeline('text-generation', slug, {
        device: 'wasm',
        dtype: wasmDtype,
        progress_callback: cb,
      });
      _genDevice = 'wasm';
    };

    let finalSlug = modelId;
    try{
      await tryPipeline(modelId);
    }catch(e){
      if(String(e && e.message) === 'LOAD_ABORTED') throw e;
      const alt = GEN_MODEL_ALT_SLUGS[modelId];
      if(alt && _isMissingFileError(e)){
        console.warn('[gen] primary slug failed, retrying alternate:', alt);
        cb({ status: 'retry', file: alt, progress: 0 });
        _genModelId = alt;
        finalSlug = alt;
        await tryPipeline(alt);
        // Persist the working slug so next session doesn't re-try the
        // dead primary. User can still switch back via the dropdown.
        try{
          const cfg = _loadGenCfg();
          cfg.modelId = alt;
          _saveGenCfg(cfg);
        }catch(_){}
      } else {
        throw e;
      }
    }
    _genReady = true;
    _genLastError = null;
    // Record successful download against whichever slug actually resolved, so
    // the "cached" indicator matches what's in the browser HTTP cache.
    try{ markGenDownloaded(finalSlug); }catch(_){}
  })().catch(err => {
    _genPipe = null;
    _genReady = false;
    _genDevice = null;
    const msg = (err && err.message) ? err.message : String(err);
    if(msg === 'LOAD_ABORTED'){
      _genLastError = 'Download cancelled.';
    } else if(msg !== 'GEN_SWITCH_IN_PROGRESS'){
      _genLastError = _friendlyGenError(msg, modelId);
    }
    throw err;
  }).finally(() => {
    _genLoading = false;
    _genLoadPromise = null;
    _genLoadAbortCtl = null;
  });

  return _genLoadPromise;
}

/**
 * Cancel an in-flight model download. Transformers.js v3 honors an abort by
 * detecting it in our signal guard at each tryPipeline() step, so the next
 * `await` after the abort rejects with LOAD_ABORTED. In-flight fetches
 * already running will complete, but nothing further starts.
 */
function genAbortLoad(){
  if(_genLoadAbortCtl){
    try{ _genLoadAbortCtl.abort(); }catch(e){}
  }
}

function _friendlyGenError(msg, modelId){
  const m = String(msg || '');
  if(/Unauthorized|403|404|not found/i.test(m)){
    return `Model "${modelId}" could not be downloaded. The repo may be private, missing, or not published with ONNX weights. Try a different preset. Raw: ${m.slice(0, 120)}`;
  }
  if(/NetworkError|Failed to fetch/i.test(m)){
    return 'Network error while downloading model weights. Check connection and retry.';
  }
  if(/out of memory|OOM|Allocation failed/i.test(m)){
    return 'Device ran out of memory loading the model. Try the smaller Tiny (135M) preset.';
  }
  if(/Aborted\b|RuntimeError/i.test(m)){
    return 'The ONNX runtime crashed while loading the model. Try clearing site data (Settings → Privacy → Clear browsing data) and reloading, or switch to a smaller model preset.';
  }
  return 'Load failed: ' + m.slice(0, 180);
}

/**
 * Cancel ALL in-flight generation calls. Uses Transformers.js v3's
 * InterruptableStoppingCriteria when available so decoding actually halts
 * (vs. rejecting the promise but letting tokens keep decoding in the bg).
 *
 * (M5) Iterates the full Sets so concurrent calls are all cancelled, not
 * just the most recent one.
 */
function genAbort(){
  for(const sc of _genActiveStoppers){
    if(sc && typeof sc.interrupt === 'function'){
      try{ sc.interrupt(); }catch(e){}
    }
  }
  for(const ctl of _genActiveAbortCtls){
    if(ctl){
      try{ ctl.abort(); }catch(e){}
    }
  }
  // Legacy single-ref compat (genDispose calls genAbort before clearing these)
  if(_genStoppingCriteria && typeof _genStoppingCriteria.interrupt === 'function'){
    try{ _genStoppingCriteria.interrupt(); }catch(e){}
  }
  if(_genAbortCtl){
    try{ _genAbortCtl.abort(); }catch(e){}
  }
}

/**
 * Generate text. Streams tokens via onToken if provided.
 * @param {{ messages?:Array, prompt?:string, tools?:Array, maxTokens?:number, temperature?:number, onToken?:(t:string)=>void, signal?:AbortSignal }} opts
 * @returns {Promise<string>} Full generated text (without the prompt).
 */
async function genGenerate(opts){
  if(!_genReady || !_genPipe) throw new Error('GEN_NOT_READY');
  const maxTokens   = Math.min(1024, Math.max(16, opts.maxTokens || 512));
  const temperature = typeof opts.temperature === 'number' ? opts.temperature : 0.2;
  const onToken     = typeof opts.onToken === 'function' ? opts.onToken : null;

  _genGenInFlight++;
  _genGenerating = _genGenInFlight > 0;
  const ctl = new AbortController();
  _genAbortCtl = ctl;
  _genActiveAbortCtls.add(ctl); // (M5)
  if(opts.signal){
    if(opts.signal.aborted){ ctl.abort(); }
    else opts.signal.addEventListener('abort', () => ctl.abort(), { once: true });
  }

  let stopping = null;
  try{
    // Route aborts through InterruptableStoppingCriteria when available so
    // decoding halts immediately instead of continuing in the background.
    ctl.signal.addEventListener('abort', () => {
      if(stopping && _genStoppingCriteria === stopping && typeof stopping.interrupt === 'function'){
        try{ stopping.interrupt(); }catch(e){}
      }
    }, { once: true });

    const tokenizer = _genPipe.tokenizer;
    let inputs;
    if(Array.isArray(opts.messages) && typeof tokenizer.apply_chat_template === 'function'){
      const tplOpts = { tokenize: false, add_generation_prompt: true };
      if(Array.isArray(opts.tools) && opts.tools.length) tplOpts.tools = opts.tools;
      inputs = tokenizer.apply_chat_template(opts.messages, tplOpts);
    } else if(typeof opts.prompt === 'string'){
      inputs = opts.prompt;
    } else {
      throw new Error('GEN_NO_INPUT');
    }

    let streamer = null;
    try{
      const mod = await _importTransformers();
      if(mod && mod.TextStreamer && onToken){
        streamer = new mod.TextStreamer(tokenizer, {
          skip_prompt: true,
          skip_special_tokens: true,
          callback_function: (t) => { try{ onToken(t); }catch(e){} },
        });
      }
      if(mod && mod.InterruptableStoppingCriteria){
        stopping = new mod.InterruptableStoppingCriteria();
        _genStoppingCriteria = stopping;
        _genActiveStoppers.add(stopping); // (M5)
      }
    }catch(e){
      // streaming/stopping criteria are best-effort; generation still works without them.
    }

    const generateOpts = {
      max_new_tokens: maxTokens,
      do_sample: temperature > 0,
      temperature: temperature,
      return_full_text: false,
      streamer,
    };
    if(stopping) generateOpts.stopping_criteria = stopping;

    const out = await _genPipe(inputs, generateOpts);

    if(ctl.signal.aborted) throw new Error('GEN_ABORTED');

    if(Array.isArray(out) && out.length){
      const first = out[0];
      if(first && typeof first.generated_text === 'string') return first.generated_text;
    }
    return '';
  } finally {
    // (M5) Remove this call's handles from the active sets AND clear the
    // legacy single-ref when it still points at this call's instance.
    _genActiveAbortCtls.delete(ctl);
    if(stopping) _genActiveStoppers.delete(stopping);
    if(stopping && _genStoppingCriteria === stopping) _genStoppingCriteria = null;
    if(_genAbortCtl === ctl) _genAbortCtl = null;
    _genGenInFlight = Math.max(0, _genGenInFlight - 1);
    _genGenerating = _genGenInFlight > 0;
  }
}

// ========== LLM HELPERS (hybrid AI: augment the embedding pipeline) ==========
// Each helper is a pure wrapper around genGenerate. Inputs are plain objects so
// callers pass only the minimal facts the LLM needs (no global `tasks` / `lists`
// coupling). Every helper gracefully returns `null` when the LLM isn't ready,
// on parse failure, or on timeout — callers MUST fall back to the ambient
// embedding-only behaviour in that case. Think: "LLM makes good features
// better when it's present; it must never make them worse when it's absent."
//
// Conventions:
//   - Low temperature (0.1) for deterministic JSON; helpers that produce free
//     prose use 0.3.
//   - Short token budgets (64–192) to keep latency bounded. These helpers run
//     interactively during harmonize/auto-organize/smart-add; 10s is too long.
//   - System prompt hard-constrains output shape. Schema enforcement is still
//     done by the caller (validateOps / manual guards) — trust but verify.

/**
 * Qwen2.5 chat template asks the model to return JSON in `<tool_call>...</tool_call>`.
 * Returns `null` if there are no `<tool_call>` tags, or if tags exist but no inner JSON parsed (caller may fall back to parseOpsJson).
 *
 * Limitation: the inner match is non-greedy up to the first `</tool_call>`. If a string value in the JSON
 * contains that closing tag literally, extraction can truncate or fail to parse (then returns null for fallback).
 * @param {string} text
 * @returns {Array<{ name:string, args:object }> | null}
 */
function parseQwen25ToolCallBlocks(text){
  const s = String(text || '');
  if(s.indexOf('<tool_call>') < 0) return null;
  const rx = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  const out = [];
  let m;
  const pushOne = (obj) => {
    if(!obj || typeof obj.name !== 'string') return;
    const name = String(obj.name).toUpperCase().replace(/\s/g, '_');
    let a = obj.arguments;
    if(a == null) a = {};
    else if(typeof a === 'string'){
      try{ a = JSON.parse(a); }catch(e){ a = {}; }
    }
    if(typeof a !== 'object' || Array.isArray(a)) a = {};
    out.push({ name, args: a });
  };
  while((m = rx.exec(s)) !== null){
    const inner = (m[1] || '').trim();
    if(!inner) continue;
    let obj;
    try{ obj = JSON.parse(inner); }catch(e){ continue; }
    if(Array.isArray(obj)) obj.forEach(pushOne);
    else pushOne(obj);
  }
  if(!out.length) return null;
  return out;
}

/**
 * @returns {boolean} True when the loaded model uses Qwen2.5 native `<tool_call>` (see parseQwen25ToolCallBlocks).
 */
function isGenModelNativeQwen25Tools(){
  const id = _genModelId || '';
  return /Qwen2\.5-.+Instruct/i.test(String(id));
}

function _stripCodeFences(s){
  return String(s || '')
    .replace(/^\s*```(?:json|js|javascript)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

/** Extract the first {...} JSON object from a possibly-chatty LLM response. */
function _extractJsonObject(text){
  const s = _stripCodeFences(text);
  if(!s) return null;
  const start = s.indexOf('{');
  if(start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for(let i = start; i < s.length; i++){
    const c = s[i];
    if(inStr){
      if(esc){ esc = false; continue; }
      if(c === '\\'){ esc = true; continue; }
      if(c === '"') inStr = false;
      continue;
    }
    if(c === '"'){ inStr = true; continue; }
    if(c === '{') depth++;
    else if(c === '}'){
      depth--;
      if(depth === 0){
        const json = s.slice(start, i + 1);
        try{ return JSON.parse(json); }catch(_){ return null; }
      }
    }
  }
  return null;
}

function _extractFirstLine(text){
  return String(text || '').replace(/```[\s\S]*?```/g, '').split('\n').map(s => s.trim()).find(Boolean) || '';
}

/** Strips fences, first non-empty line, then caps length — shared by _genTextCall and test hook. */
function _formatGenTextCallOutput(raw){
  const line = _extractFirstLine(_stripCodeFences(raw));
  return line ? line.slice(0, 220) : null;
}

async function _genJsonCall({ system, user, maxTokens = 192, temperature = 0.1, signal }){
  if(!_genReady || !_genPipe) return null;
  try{
    const raw = await genGenerate({
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user   },
      ],
      maxTokens, temperature, signal,
    });
    return _extractJsonObject(raw);
  }catch(e){
    if(String(e && e.message) === 'GEN_ABORTED') return null;
    console.warn('[gen] JSON helper failed', e);
    return null;
  }
}

async function _genTextCall({ system, user, maxTokens = 64, temperature = 0.3, signal }){
  if(!_genReady || !_genPipe) return null;
  try{
    const raw = await genGenerate({
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user   },
      ],
      maxTokens, temperature, signal,
    });
    return _formatGenTextCallOutput(raw);
  }catch(e){
    if(String(e && e.message) === 'GEN_ABORTED') return null;
    console.warn('[gen] text helper failed', e);
    return null;
  }
}

/**
 * Refine a proposed UPDATE_TASK coming from the embedding-kNN pipeline.
 * The LLM is allowed to (a) drop fields it thinks are wrong, (b) keep the
 * rest, and (c) supply a short rationale for the preview card. It may NOT
 * introduce new field values — that would let an unreliable model overwrite
 * high-confidence embedding votes.
 *
 * @param {{name:string,description?:string,tags?:string[]}} task
 * @param {Record<string,any>} proposed   Fields the kNN pipeline wants to set
 * @param {number[]} fieldConfidences     Parallel array of confidences in [0,1]
 * @returns {Promise<{ accept: Record<string,any>, rationale: string } | null>}
 */
async function genRefineTaskUpdate(task, proposed, fieldConfidences){
  if(!_genReady) return null;
  const fields = Object.keys(proposed || {}).filter(k => k !== 'id');
  if(!fields.length) return null;
  const sys = 'You review AI-proposed metadata edits for a single to-do task. '
    + 'Given the task and the proposed field changes, decide which changes to KEEP and which to DROP. '
    + 'You may only keep or drop — never invent new values. '
    + 'Reply with a single JSON object: {"keep":["field1","field2"],"drop":["field3"],"rationale":"one short sentence"}. '
    + 'No prose outside the JSON.';
  const user = 'Task: ' + JSON.stringify({
    name: String(task.name || '').slice(0, 200),
    description: String(task.description || '').slice(0, 280),
    tags: Array.isArray(task.tags) ? task.tags.slice(0, 10) : [],
  })
    + '\nProposed changes: ' + JSON.stringify(proposed)
    + '\nPer-field confidence (0..1): ' + JSON.stringify(fieldConfidences || {});
  const obj = await _genJsonCall({ system: sys, user, maxTokens: 192, temperature: 0.05 });
  if(!obj || !Array.isArray(obj.keep)) return null;
  const keep = new Set(obj.keep.map(x => String(x).trim()));
  const accept = {};
  for(const k of fields) if(keep.has(k)) accept[k] = proposed[k];
  const rationale = typeof obj.rationale === 'string' ? obj.rationale.trim().slice(0, 220) : '';
  return { accept, rationale };
}

/**
 * Adjudicate a suspected-duplicate pair coming from the embedding cosine scan.
 * LLM answers same / different / partial with a one-line reason.
 *
 * @param {{name:string,description?:string}} a
 * @param {{name:string,description?:string}} b
 * @returns {Promise<{ verdict:'same'|'different'|'partial', confidence:number, reason:string } | null>}
 */
async function genDedupeJudge(a, b){
  if(!_genReady) return null;
  const sys = 'You compare two to-do tasks and decide if they describe the SAME underlying work. '
    + 'Respond ONLY with JSON: {"verdict":"same|different|partial","confidence":0..1,"reason":"short"}. '
    + '"same" = identical actionable work. '
    + '"partial" = overlapping but one covers strictly more. '
    + '"different" = unrelated despite textual similarity.';
  const user = 'A: ' + JSON.stringify({ name: String(a.name || '').slice(0, 200), description: String(a.description || '').slice(0, 200) })
    + '\nB: ' + JSON.stringify({ name: String(b.name || '').slice(0, 200), description: String(b.description || '').slice(0, 200) });
  const obj = await _genJsonCall({ system: sys, user, maxTokens: 128, temperature: 0.0 });
  if(!obj) return null;
  const verdict = ['same', 'different', 'partial'].includes(obj.verdict) ? obj.verdict : null;
  if(!verdict) return null;
  const confidence = Math.max(0, Math.min(1, Number(obj.confidence) || 0));
  const reason = typeof obj.reason === 'string' ? obj.reason.trim().slice(0, 200) : '';
  return { verdict, confidence, reason };
}

/**
 * Suggest a handful of tags for a task. Tags must be drawn from
 * existingTags when plausible (avoid tag sprawl); at most 2 new tags.
 *
 * @param {{name:string,description?:string}} task
 * @param {string[]} existingTags
 * @returns {Promise<{ tags:string[], rationale:string } | null>}
 */
async function genSuggestTags(task, existingTags){
  if(!_genReady) return null;
  const sys = 'You suggest 1 to 4 short lowercase tags for a to-do task. '
    + 'Prefer tags already used in this workspace; introduce at most 2 new tags. '
    + 'No spaces, no leading "#", no emojis. '
    + 'Respond ONLY with JSON: {"tags":["tag1","tag2"],"rationale":"why"}.';
  const user = 'Task: ' + JSON.stringify({
    name: String(task.name || '').slice(0, 200),
    description: String(task.description || '').slice(0, 280),
  })
    + '\nExisting tags: ' + JSON.stringify((existingTags || []).slice(0, 40));
  const obj = await _genJsonCall({ system: sys, user, maxTokens: 128, temperature: 0.2 });
  if(!obj || !Array.isArray(obj.tags)) return null;
  const tags = obj.tags.map(t => String(t).toLowerCase().replace(/^#/, '').replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, ''))
    .filter(Boolean).slice(0, 4);
  if(!tags.length) return null;
  const rationale = typeof obj.rationale === 'string' ? obj.rationale.trim().slice(0, 200) : '';
  return { tags, rationale };
}

/**
 * One-sentence explanation of why a task aligns with a Schwartz value.
 * Called after the embedding-based value score crosses a visibility threshold.
 *
 * @param {{name:string,description?:string}} task
 * @param {{key:string,label:string,score:number}} topValue
 * @returns {Promise<string | null>}
 */
async function genValuesNote(task, topValue){
  if(!_genReady || !topValue) return null;
  const sys = 'You explain, in ONE short sentence (max 20 words), why a to-do task aligns with a personal value. '
    + 'Be concrete; reference the task\'s specifics. No preamble, no quotes.';
  const user = 'Task: ' + JSON.stringify({
    name: String(task.name || '').slice(0, 200),
    description: String(task.description || '').slice(0, 200),
  })
    + `\nValue: ${topValue.label} (${topValue.key})`;
  return _genTextCall({ system: sys, user, maxTokens: 48, temperature: 0.3 });
}

/**
 * Parse a single freeform sentence into a task skeleton. Complements the
 * deterministic nlparse for cases the regex pipeline can't handle (e.g.
 * "remind me when i get home to call mom about thanksgiving").
 *
 * @param {string} text
 * @returns {Promise<{ name:string, priority?:string, dueDate?:string, tags?:string[], effort?:string, rationale?:string } | null>}
 */
async function genParseFreeform(text){
  if(!_genReady) return null;
  const s = String(text || '').trim();
  if(!s) return null;
  const sys = 'You extract a structured to-do task from one short freeform user sentence. '
    + 'Respond ONLY with JSON. Shape: '
    + '{"name":"short imperative","priority":"low|normal|high|urgent","dueDate":"YYYY-MM-DD","tags":["t1"],"effort":"xs|s|m|l|xl","rationale":"one short sentence"}. '
    + 'Omit any field you cannot infer confidently. `name` is required.';
  const user = 'Sentence: ' + JSON.stringify(s.slice(0, 500));
  const obj = await _genJsonCall({ system: sys, user, maxTokens: 192, temperature: 0.1 });
  if(!obj || typeof obj.name !== 'string' || !obj.name.trim()) return null;
  const out = { name: obj.name.trim().slice(0, 200) };
  if(['low','normal','high','urgent'].includes(obj.priority)) out.priority = obj.priority;
  if(typeof obj.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(obj.dueDate)) out.dueDate = obj.dueDate;
  if(Array.isArray(obj.tags)){
    const tags = obj.tags.map(t => String(t).toLowerCase().replace(/^#/, '').replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, ''))
      .filter(Boolean).slice(0, 6);
    if(tags.length) out.tags = tags;
  }
  if(['xs','s','m','l','xl'].includes(obj.effort)) out.effort = obj.effort;
  if(typeof obj.rationale === 'string') out.rationale = obj.rationale.trim().slice(0, 200);
  return out;
}

/**
 * Break a vague "epic"-style task into concrete subtasks.
 *
 * @param {{name:string,description?:string}} task
 * @param {{maxSubtasks?:number}} [opts]
 * @returns {Promise<{ subtasks:Array<{name:string,effort?:string}>, rationale:string } | null>}
 */
async function genBreakdownTask(task, opts){
  if(!_genReady) return null;
  const maxN = Math.min(8, Math.max(2, (opts && opts.maxSubtasks) || 5));
  const sys = `You break a large to-do into 2–${maxN} concrete next-action subtasks. `
    + 'Each subtask must start with an imperative verb and fit on one line. '
    + 'Respond ONLY with JSON: {"subtasks":[{"name":"…","effort":"xs|s|m|l|xl"}],"rationale":"why these steps"}.';
  const user = 'Parent task: ' + JSON.stringify({
    name: String(task.name || '').slice(0, 200),
    description: String(task.description || '').slice(0, 400),
  });
  const obj = await _genJsonCall({ system: sys, user, maxTokens: 320, temperature: 0.3 });
  if(!obj || !Array.isArray(obj.subtasks)) return null;
  const subtasks = obj.subtasks
    .map(s => s && typeof s.name === 'string' ? ({
      name: s.name.trim().slice(0, 160),
      effort: ['xs','s','m','l','xl'].includes(s.effort) ? s.effort : undefined,
    }) : null)
    .filter(s => s && s.name)
    .slice(0, maxN);
  if(!subtasks.length) return null;
  const rationale = typeof obj.rationale === 'string' ? obj.rationale.trim().slice(0, 220) : '';
  return { subtasks, rationale };
}

/**
 * Short explanation of why a task is ranked at the top of "what next".
 * Given the embedding ranker's chosen task and a handful of runners-up.
 *
 * @param {{name:string}} topTask
 * @param {Array<{name:string}>} alternatives
 * @returns {Promise<string | null>}
 */
async function genExplainRanking(topTask, alternatives){
  if(!_genReady) return null;
  const sys = 'You explain, in ONE short sentence, why the top task is a good next choice compared to the alternatives. '
    + 'Reference the task specifics. Max 25 words. No preamble.';
  const user = 'Top: ' + JSON.stringify({ name: String(topTask.name || '').slice(0, 160) })
    + '\nAlternatives: ' + JSON.stringify((alternatives || []).slice(0, 5).map(a => ({ name: String(a.name || '').slice(0, 160) })));
  return _genTextCall({ system: sys, user, maxTokens: 48, temperature: 0.3 });
}

/**
 * Short explanation of why auto-organize wants to move a task to a list.
 *
 * @param {{name:string}} task
 * @param {string} listName
 * @returns {Promise<string | null>}
 */
async function genExplainMove(task, listName){
  if(!_genReady) return null;
  const sys = 'You explain, in ONE short sentence (max 18 words), why a to-do belongs on a named list. '
    + 'Reference the task text. No preamble, no quotes.';
  const user = 'Task: ' + JSON.stringify({ name: String(task.name || '').slice(0, 160) })
    + `\nList: ${String(listName || '').slice(0, 60)}`;
  return _genTextCall({ system: sys, user, maxTokens: 40, temperature: 0.3 });
}

// ── Explicit disposal (M1 + M4) ───────────────────────────────────────────────
// Releases the generative pipeline and its GPU/WASM context.  Called
// G-9: Rephrase a task title for clarity / imperative form.
async function genRephrase(task){
  if(!_genReady) return null;
  const sys = 'You rewrite a to-do task title to be a clear, concise imperative. '
    + 'Keep it under 90 characters. Preserve specifics (names, dates, numbers). '
    + 'No preamble, no quotes — return ONLY the rewritten title.';
  const user = 'Original title: ' + JSON.stringify(String(task.name || '').slice(0, 200))
    + (task.description ? '\nDescription (context only): ' + JSON.stringify(String(task.description).slice(0, 300)) : '');
  const out = await _genTextCall({ system: sys, user, maxTokens: 48, temperature: 0.3 });
  if(typeof out !== 'string') return null;
  const cleaned = out.trim().replace(/^['"]|['"]$/g, '').slice(0, 200);
  return cleaned || null;
}

// G-10: Daily-brief — short prose summary using already-ranked top tasks.
async function genDailyBrief(opts){
  if(!_genReady) return null;
  const o = opts || {};
  const sys = 'You write a 3-line daily brief for the user. '
    + 'Line 1: top priority for today (one short sentence). '
    + 'Line 2: anything overdue or blocked. '
    + 'Line 3: a one-sentence pep talk grounded in today\'s actual context. '
    + 'No preamble, no markdown headers, no greetings. Use the user\'s tasks verbatim where you reference them.';
  const user = 'Top tasks (ranked): ' + JSON.stringify((o.topTasks || []).slice(0, 5))
    + '\nDue-today count: ' + (o.dueTodayCount || 0)
    + '\nOverdue count: ' + (o.overdueCount || 0)
    + '\nBlocked count: ' + (o.blockedCount || 0)
    + '\nUpcoming events: ' + JSON.stringify((o.events || []).slice(0, 3));
  return _genTextCall({ system: sys, user, maxTokens: 220, temperature: 0.4 });
}

// G-11: Weekly review — prose summary over the last 7 days.
async function genWeeklyReview(opts){
  if(!_genReady) return null;
  const o = opts || {};
  const sys = 'You write a candid weekly review for the user in 4–6 short bullets. '
    + 'Cover: what got done, what stalled, recurring patterns (e.g. tasks reopened or repeatedly snoozed), '
    + 'and one concrete suggestion for next week. Reference task names verbatim. No preamble.';
  const user = 'Completed this week (' + (o.doneCount || 0) + '): ' + JSON.stringify((o.done || []).slice(0, 12))
    + '\nReopened: ' + JSON.stringify((o.reopened || []).slice(0, 6))
    + '\nStill open & blocked: ' + JSON.stringify((o.blocked || []).slice(0, 6))
    + '\nStill open & untouched 7+ days: ' + JSON.stringify((o.stuck || []).slice(0, 6));
  return _genTextCall({ system: sys, user, maxTokens: 360, temperature: 0.4 });
}

// automatically on tab close but also exposed as `genDispose()` so callers can
// proactively free memory after heavy generation runs on constrained devices.
function genDispose(){
  // Abort any in-flight generation first
  genAbort();
  if(_genPipe && typeof _genPipe.dispose === 'function'){
    try{ _genPipe.dispose(); }catch(_){}
  }
  _genPipe = null;
  _genReady = false;
  _genGenerating = false;
  _genGenInFlight = 0;
  _genDevice = null;
  _genModelId = null;
  _genStoppingCriteria = null;
  _genAbortCtl = null;
  _genActiveAbortCtls.clear(); // (M5)
  _genActiveStoppers.clear();  // (M5)
}

if(typeof window !== 'undefined'){
  window.GEN_MODEL_PRESETS = GEN_MODEL_PRESETS;
  window.GEN_MODEL_ALT_SLUGS = GEN_MODEL_ALT_SLUGS;
  window.getGenPresets = getGenPresets;
  window.getGenCfg = getGenCfg;
  window.saveGenCfg = saveGenCfg;
  window.genLoad = genLoad;
  window.genAbortLoad = genAbortLoad;
  window.genGenerate = genGenerate;
  window.genDispose = genDispose;
  window.parseQwen25ToolCallBlocks = parseQwen25ToolCallBlocks;
  window.isGenModelNativeQwen25Tools = isGenModelNativeQwen25Tools;
  window.genAbort = genAbort;
  window.isGenReady = isGenReady;
  window.isGenLoading = isGenLoading;
  window.isGenGenerating = isGenGenerating;
  window.isGenBusy = isGenBusy;
  window.isGenDownloaded = isGenDownloaded;
  window.markGenDownloaded = markGenDownloaded;
  window.getGenDevice = getGenDevice;
  window.getGenModel = getGenModel;
  window.getGenLastError = getGenLastError;
  window.clearGenLastError = clearGenLastError;
  window.getAskHistory = getAskHistory;
  window.pushAskHistory = pushAskHistory;
  window.clearAskHistory = clearAskHistory;
  window.clearLLMCache = clearLLMCache;
  window._mobileRamHint = _mobileRamHint;
  window.genRefineTaskUpdate = genRefineTaskUpdate;
  window.genDedupeJudge = genDedupeJudge;
  window.genSuggestTags = genSuggestTags;
  window.genValuesNote = genValuesNote;
  window.genParseFreeform = genParseFreeform;
  window.genBreakdownTask = genBreakdownTask;
  window.genExplainRanking = genExplainRanking;
  window.genExplainMove = genExplainMove;
  window.genRephrase = genRephrase;
  window.genDailyBrief = genDailyBrief;
  window.genWeeklyReview = genWeeklyReview;
  window._genExtractJsonObject = _extractJsonObject;
  window._genExtractFirstLine  = _extractFirstLine;
  window._genStripCodeFences   = _stripCodeFences;
  window._formatGenTextCallOutput = _formatGenTextCallOutput;

  // ── Cleanup on tab close (M1) ───────────────────────────────────────────────
  window.addEventListener('beforeunload', () => {
    genDispose();
  });
}
