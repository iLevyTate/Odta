// ========== GENERATIVE LLM PIPELINE ENGINE ==========
// The actual Transformers.js text-generation pipeline (load + inference). This
// module is deliberately free of DOM / window access so the SAME code runs in
// two places:
//   1. js/gen-worker.js — a module Web Worker (the default), so heavy inference
//      never blocks the main UI thread.
//   2. js/gen.js — the main thread, as a fallback when a Worker can't be
//      created (old browser, no module-worker / WebGPU-in-worker support).
//
// All side effects flow through injected callbacks (onProgress / onToken) and
// the returned method handles; storage and UI concerns stay in js/gen.js.

// WebGPU session creation (shader compile + weight upload) emits no progress
// and, on some drivers / integrated GPUs, hangs indefinitely even after the
// device probe succeeds — leaving the UI stuck on "Initializing model…". Cap
// the GPU init phase so a hung build falls back to WASM (CPU) instead of
// hanging forever. Legitimate GPU init for these small models is a few seconds
// to ~15s, so this ceiling only trips on a genuine stall.
const GEN_WEBGPU_INIT_TIMEOUT_MS = 45000;

function _isMissingFileError(e){
  const m = String((e && e.message) || e || '');
  return /Unauthorized|status:\s*40[134]|404|\bnot found\b/i.test(m);
}

/**
 * Race a promise against a timeout. On timeout the returned promise rejects
 * with `new Error(label)`. The underlying promise keeps running (we can't
 * cancel a native ONNX session build), but its late result is discarded.
 */
function _withTimeout(promise, ms, label){
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label || 'TIMEOUT')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// A model load that stops reporting progress for this long is treated as
// wedged (stalled fetch, hung WASM instantiation). Progress events reset it,
// so a slow-but-alive 300 MB download on a poor connection is never cut off.
const GEN_LOAD_IDLE_TIMEOUT_MS = 90000;

/**
 * Race a load against (a) the caller's abort signal and (b) an idle watchdog
 * that only fires when no progress has arrived for `idleMs`. Neither can stop
 * the native work already in flight, but both make the *promise* settle so
 * the UI can leave "Loading…" — previously a WASM load could hang forever and
 * "Cancel download" was a no-op.
 * @returns {{ promise: Promise<any>, touch: () => void }}
 */
function _watchLoad(promise, { signal, idleMs } = {}){
  let idleTimer = null;
  let settle;
  const guard = new Promise((_, reject) => { settle = reject; });
  const arm = () => {
    if(!idleMs) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => settle(new Error('LOAD_STALLED: no progress for ' + Math.round(idleMs / 1000) + 's')), idleMs);
  };
  const onAbort = () => settle(new Error('LOAD_ABORTED'));
  if(signal){
    if(signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  arm();
  const out = Promise.race([promise, guard]).finally(() => {
    clearTimeout(idleTimer);
    if(signal) signal.removeEventListener('abort', onAbort);
  });
  return { promise: out, touch: arm };
}

/**
 * Pre-flight check: verify the runtime can actually create a WebGPU device.
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
    return false;
  }
}

/**
 * Create a generative-LLM engine bound to a Transformers.js build.
 *
 * @param {{
 *   transformersUrl: string,
 *   wasmDir: string,
 *   onProgress?: (ev: { progress?:number, status?:string, file?:string }) => void,
 *   onToken?: (reqId: (number|string), text: string) => void,
 * }} cfg
 */
export function createGenEngine(cfg){
  const transformersUrl = cfg.transformersUrl;
  const wasmDir = cfg.wasmDir;
  const onProgress = typeof cfg.onProgress === 'function' ? cfg.onProgress : () => {};
  const onToken    = typeof cfg.onToken === 'function' ? cfg.onToken : () => {};

  let mod = null;
  let pipe = null;
  let device = null;
  // reqId -> InterruptableStoppingCriteria, so abort(reqId) can halt decoding
  // for one specific in-flight generation without touching the others.
  const stoppers = new Map();

  let importGen = 0;
  async function _import(){
    if(!mod){
      // The module registry caches by resolved URL, so a plain re-import after
      // a crash hands back the same poisoned ONNX Runtime instance. A query
      // string forces a genuinely fresh module (and runtime) on retries.
      const url = importGen === 0 ? transformersUrl
        : transformersUrl + (transformersUrl.indexOf('?') >= 0 ? '&' : '?') + 'ortgen=' + importGen;
      mod = await import(url);
    }
    return mod;
  }
  // A fatal WASM Aborted() crash poisons the ONNX Runtime instance; dropping
  // the cached module (and bumping the cache-buster) forces a fresh import
  // for the next attempt. Callers must re-apply _configureEnv on the new module.
  function _resetModule(){ mod = null; importGen++; }
  function _configureEnv(env){
    if(!env) return;
    env.allowLocalModels = false;
    try{ env.backends.onnx.wasm.wasmPaths = wasmDir; }catch(_){}
    env.useBrowserCache = true;
  }

  /**
   * Load the text-generation pipeline, trying WebGPU first (with a hard init
   * timeout) and falling back to WASM (CPU). Retries an alternate namespace
   * when the primary slug 401/403/404s.
   * @returns {Promise<string>} the slug that actually resolved
   */
  async function load({ modelId, dtype, altSlug, signal } = {}){
    if(!modelId) throw new Error('GEN_NO_MODEL');
    let pipeline, env;
    try{
      const m = await _import();
      pipeline = m.pipeline;
      env = m.env;
    }catch(e){
      throw new Error('TRANSFORMERS_IMPORT_FAILED: ' + ((e && e.message) || e));
    }
    _configureEnv(env);

    // On WebGPU we prefer q4f16 (int4 weights + fp16 activations) when the
    // caller's stored dtype is plain q4; on WASM we use q4 (fp16 activations
    // aren't supported). This mirrors what works across Transformers.js v3.
    const webgpuDtype = dtype === 'q4' ? 'q4f16' : (dtype || 'q4f16');
    const wasmDtype   = dtype === 'q4f16' ? 'q4' : (dtype || 'q4');

    const tryPipeline = async (slug) => {
      // ---- WebGPU attempt (only if the device probe succeeds) ----
      const gpuOk = await _probeWebGPU();
      if(gpuOk){
        try{
          if(signal && signal.aborted) throw new Error('LOAD_ABORTED');
          // Cap the GPU init phase: a hung shader compile / session build must
          // fall back to WASM rather than leave the UI on "Initializing model…"
          // forever (the native build emits no progress and can't be aborted).
          pipe = await _watchLoad(_withTimeout(
            pipeline('text-generation', slug, {
              device: 'webgpu',
              dtype: webgpuDtype,
              progress_callback: onProgress,
            }),
            GEN_WEBGPU_INIT_TIMEOUT_MS,
            'WEBGPU_INIT_TIMEOUT'
          ), { signal }).promise;
          device = 'webgpu';
          return;
        }catch(e){
          if(signal && signal.aborted) throw new Error('LOAD_ABORTED');
          if(String(e && e.message) === 'WEBGPU_INIT_TIMEOUT'){
            console.warn('[gen] WebGPU init timed out — falling back to WASM (CPU)');
          } else {
            console.warn('[gen] WebGPU pipeline failed, falling back to WASM', e);
          }
          _resetModule();
          try{
            const fresh = await _import();
            pipeline = fresh.pipeline;
            _configureEnv(fresh.env);
          }catch(reErr){
            console.error('[gen] Failed to re-import Transformers.js after WebGPU crash', reErr);
          }
        }
      } else {
        console.info('[gen] WebGPU not available — loading with WASM (CPU)');
      }
      // ---- WASM (CPU) fallback ----
      if(signal && signal.aborted) throw new Error('LOAD_ABORTED');
      try{ onProgress({ status: 'Loading with WASM (CPU)', file: slug, progress: undefined }); }catch(_){}
      let watch = null;
      const progressTouch = (ev) => { if(watch) watch.touch(); onProgress(ev); };
      watch = _watchLoad(
        pipeline('text-generation', slug, {
          device: 'wasm',
          dtype: wasmDtype,
          progress_callback: progressTouch,
        }),
        { signal, idleMs: GEN_LOAD_IDLE_TIMEOUT_MS }
      );
      pipe = await watch.promise;
      device = 'wasm';
    };

    let finalSlug = modelId;
    try{
      await tryPipeline(modelId);
    }catch(e){
      if(String(e && e.message) === 'LOAD_ABORTED') throw e;
      if(altSlug && _isMissingFileError(e)){
        console.warn('[gen] primary slug failed, retrying alternate:', altSlug);
        try{ onProgress({ status: 'retry', file: altSlug, progress: 0 }); }catch(_){}
        finalSlug = altSlug;
        await tryPipeline(altSlug);
      } else {
        throw e;
      }
    }
    return finalSlug;
  }

  /**
   * Generate text for one request. Streams tokens via onToken(reqId, text).
   * @returns {Promise<string>} full generated text (prompt excluded)
   */
  async function generate({ reqId, messages, tools, prompt, maxTokens, temperature, signal } = {}){
    if(!pipe) throw new Error('GEN_NOT_READY');
    const m = await _import();
    const tokenizer = pipe.tokenizer;

    let inputs;
    if(Array.isArray(messages) && typeof tokenizer.apply_chat_template === 'function'){
      const tplOpts = { tokenize: false, add_generation_prompt: true };
      if(Array.isArray(tools) && tools.length) tplOpts.tools = tools;
      inputs = tokenizer.apply_chat_template(messages, tplOpts);
    } else if(typeof prompt === 'string'){
      inputs = prompt;
    } else {
      throw new Error('GEN_NO_INPUT');
    }

    let streamer = null;
    let stopping = null;
    try{
      if(m && m.TextStreamer){
        streamer = new m.TextStreamer(tokenizer, {
          skip_prompt: true,
          skip_special_tokens: true,
          callback_function: (t) => { try{ onToken(reqId, t); }catch(_){} },
        });
      }
      if(m && m.InterruptableStoppingCriteria){
        stopping = new m.InterruptableStoppingCriteria();
        stoppers.set(reqId, stopping);
        // If abort already fired (signal pre-aborted), interrupt immediately so
        // a pre-decode abort still halts instead of running to max_new_tokens.
        if(signal && signal.aborted){ try{ stopping.interrupt(); }catch(_){} }
      }
    }catch(_){
      // streaming / stopping criteria are best-effort; generation still works.
    }

    if(signal && !signal.aborted){
      signal.addEventListener('abort', () => {
        if(stopping && typeof stopping.interrupt === 'function'){
          try{ stopping.interrupt(); }catch(_){}
        }
      }, { once: true });
    }

    // temperature ≤ 0 means greedy. Never hand 0 to the library: its
    // TemperatureLogitsWarper divides logits by the value. (This vendored
    // build never applies that warper — only the do_sample boolean changes
    // decoding — but an upgrade that honours temperature would NaN out.)
    const generateOpts = {
      max_new_tokens: maxTokens,
      do_sample: temperature > 0,
      temperature: temperature > 0 ? temperature : 1,
      return_full_text: false,
      streamer,
    };
    if(stopping) generateOpts.stopping_criteria = stopping;

    try{
      const out = await pipe(inputs, generateOpts);
      if(signal && signal.aborted) throw new Error('GEN_ABORTED');
      if(Array.isArray(out) && out.length){
        const first = out[0];
        if(first && typeof first.generated_text === 'string') return first.generated_text;
      }
      return '';
    } finally {
      stoppers.delete(reqId);
    }
  }

  function abort(reqId){
    const sc = stoppers.get(reqId);
    if(sc && typeof sc.interrupt === 'function'){ try{ sc.interrupt(); }catch(_){} }
  }
  function abortAll(){
    for(const sc of stoppers.values()){
      if(sc && typeof sc.interrupt === 'function'){ try{ sc.interrupt(); }catch(_){} }
    }
  }
  function dispose(){
    abortAll();
    if(pipe && typeof pipe.dispose === 'function'){ try{ pipe.dispose(); }catch(_){} }
    pipe = null;
    device = null;
    stoppers.clear();
  }

  return { load, generate, abort, abortAll, dispose, getDevice: () => device };
}
