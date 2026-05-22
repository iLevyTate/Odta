/**
 * Ambient intelligence — single embedding model (Xenova/bge-small-en-v1.5),
 * 384-dim, ~33 MB quantized. Runs on WebGPU when available, WASM (CPU) as
 * fallback. No generative LLM in this app.
 *
 * Library code is vendored same-origin (see config.js). Model weights load
 * from MODEL_BASE_PATH first; if the files aren't there (a fresh clone
 * without `npm run fetch-models`), transformers.js falls back to the
 * Hugging Face hub for that one load — the browser caches the result, the
 * service worker pins it on next sweep, and subsequent loads stay offline.
 * Commit the files under assets/models/ to remove the HF round-trip
 * entirely.
 */
const _C = window.ODTAULAI_CONFIG || {};
const TRANSFORMERS_URL      = _C.TRANSFORMERS_URL      || './js/vendor/transformers/transformers.min.mjs';
const TRANSFORMERS_WASM_DIR = _C.TRANSFORMERS_WASM_DIR || './js/vendor/transformers/';
const MODEL_BASE_PATH       = _C.MODEL_BASE_PATH       || './assets/models/';
const EMBED_MODEL           = _C.EMBED_MODEL           || 'Xenova/bge-small-en-v1.5';
const EMBED_DIM             = _C.EMBED_DIM             || 384;
/** Version string for IndexedDB migration — must change when embed model or dim changes */
const EMBED_MODEL_VER       = _C.EMBED_MODEL_VER       || 'bge-small-en-v1.5-unified-v3';

let _extractor = null;
let _intelReady = false;
let _intelLoading = false;
let _intelDevice = null;
let _intelLoadPromise = null;

function getIntelDevice(){ return _intelDevice; }
function isIntelReady(){ return _intelReady; }
function getEmbedDim(){ return EMBED_DIM; }
function getActiveEmbedModelId(){ return EMBED_MODEL; }

/**
 * @param {(progress: { progress?: number, status?: string }) => void} [onProgress]
 */
async function intelLoad(onProgress){
  if (_intelReady) return;
  if (_intelLoadPromise) return _intelLoadPromise;

  _intelLoading = true;
  _intelLoadPromise = (async () => {
    let pipeline;
    let env;
    try{
      const mod = await import(TRANSFORMERS_URL);
      pipeline = mod.pipeline;
      env = mod.env;
    }catch(e){
      console.warn('[intel] transformers import failed', e);
      throw e;
    }
    // Local-first: transformers.js tries MODEL_BASE_PATH first and only
    // reaches out to the Hugging Face hub if the same-origin files 404.
    // For fully-offline installs, commit the weights via `npm run
    // fetch-models`; the remote fallback then stays dormant.
    env.allowLocalModels  = true;
    env.allowRemoteModels = true;
    env.localModelPath    = MODEL_BASE_PATH;
    env.useBrowserCache   = true;
    // Point the ONNX Runtime backend at the vendored WASM binary so the
    // library doesn't try to fetch ort-wasm-* from a CDN on first use.
    if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
      env.backends.onnx.wasm.wasmPaths = TRANSFORMERS_WASM_DIR;
    }

    const cb = typeof onProgress === 'function' ? onProgress : () => {};
    const tryWebGPU = typeof navigator !== 'undefined' && !!navigator.gpu;

    try{
      if(tryWebGPU){
        try{
          _extractor = await pipeline('feature-extraction', EMBED_MODEL, {
            device: 'webgpu',
            progress_callback: cb,
          });
          _intelDevice = 'webgpu';
        }catch(e){
          console.warn('[intel] WebGPU pipeline failed, falling back to WASM', e);
          _extractor = await pipeline('feature-extraction', EMBED_MODEL, {
            device: 'wasm',
            progress_callback: cb,
          });
          _intelDevice = 'wasm';
        }
      } else {
        _extractor = await pipeline('feature-extraction', EMBED_MODEL, {
          device: 'wasm',
          progress_callback: cb,
        });
        _intelDevice = 'wasm';
      }
      _intelReady = true;
    }catch(e){
      _extractor = null;
      _intelReady = false;
      _intelDevice = null;
      throw e;
    }
  })();

  try{
    await _intelLoadPromise;
  }finally{
    _intelLoading = false;
    _intelLoadPromise = null;
  }
}

/**
 * @param {string} text
 * @returns {Promise<Float32Array>} L2-normalized embedding, length EMBED_DIM
 */
async function embedText(text){
  if(!_extractor) throw new Error('Intelligence engine not loaded');
  const t = (text || '').trim();
  if(!t) throw new Error('Empty text');
  const out = await _extractor(t.slice(0, 8000), { pooling: 'mean', normalize: true });
  const raw = out && out.data !== undefined ? out.data : out;
  let data = raw;
  if(raw && typeof raw === 'object' && typeof raw.length === 'number' && !(raw instanceof Float32Array)){
    data = new Float32Array(raw);
  }
  if(!(data instanceof Float32Array)){
    throw new Error('Unexpected embedding output');
  }
  if(data.length !== EMBED_DIM){
    throw new Error('[intel] unexpected embedding dim ' + data.length + ' expected ' + EMBED_DIM);
  }
  return data;
}

/** Unit-normalized vectors → dot product equals cosine similarity */
function cosine(a, b){
  if(!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for(let i = 0; i < a.length; i++) s += a[i] * b[i];
  if(!Number.isFinite(s)) return 0;
  return s;
}

window.intelLoad = intelLoad;
window.embedText = embedText;
window.cosine = cosine;
window.getIntelDevice = getIntelDevice;
window.isIntelReady = isIntelReady;
window.getEmbedDim = getEmbedDim;
window.getActiveEmbedModelId = getActiveEmbedModelId;
window.INTEL_EMBED_DIM = EMBED_DIM;
window.INTEL_EMBED_MODEL = EMBED_MODEL;
window.INTEL_EMBED_MODEL_VER = EMBED_MODEL_VER;

// Release the embedding pipeline on tab close so long-lived PWA windows
// don't hold orphaned GPU/WASM contexts.
window.addEventListener('beforeunload', () => {
  if (_extractor && typeof _extractor.dispose === 'function') {
    try { _extractor.dispose(); } catch (_) {}
  }
  _extractor = null;
  _intelReady = false;
});
