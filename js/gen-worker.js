// ========== GENERATIVE LLM WEB WORKER ==========
// Hosts the Transformers.js pipeline (js/gen-pipeline.js) on a dedicated thread
// so on-device inference never blocks the main UI thread. A long multi-round
// Ask analysis used to freeze the page (and the Stop button) because the model
// ran on the main thread; here it runs here instead, and the main thread stays
// free to render and to post an `abort` the instant the user hits Stop.
//
// Protocol (see js/gen.js for the main-thread side):
//   main -> worker:  load | generate | abort | abort-all | abort-load | dispose
//   worker -> main:  progress | loaded | load-error | token | result | gen-error

import { createGenEngine } from './gen-pipeline.js';

let engine = null;
let loadCtl = null;                 // AbortController for the in-flight load
const genCtls = new Map();          // reqId -> AbortController for each generation

function post(msg){ self.postMessage(msg); }

self.onmessage = async (e) => {
  const msg = e.data || {};
  switch(msg.type){
    case 'load': {
      // Dispose any previously loaded model before loading another so switching
      // presets doesn't leak the old pipeline's weights (WASM heap / WebGPU
      // buffers). createGenEngine itself allocates nothing heavy until load().
      if(engine){ try{ engine.dispose(); }catch(_){} engine = null; }
      engine = createGenEngine({
        transformersUrl: msg.transformersUrl,
        wasmDir: msg.wasmDir,
        onProgress: (ev) => post({ type: 'progress', ev }),
        onToken: (reqId, text) => post({ type: 'token', reqId, text }),
      });
      loadCtl = new AbortController();
      const eng = engine; // 'dispose' may null the shared ref mid-load
      try{
        const finalSlug = await eng.load({
          modelId: msg.modelId,
          dtype: msg.dtype,
          altSlug: msg.altSlug,
          signal: loadCtl.signal,
        });
        if(engine !== eng){ post({ type: 'load-error', message: 'LOAD_ABORTED' }); break; }
        post({ type: 'loaded', device: eng.getDevice(), modelId: msg.modelId, finalSlug });
      }catch(err){
        post({ type: 'load-error', message: (err && err.message) || String(err) });
      }finally{
        loadCtl = null;
      }
      break;
    }

    case 'abort-load': {
      if(loadCtl){ try{ loadCtl.abort(); }catch(_){} }
      break;
    }

    case 'generate': {
      if(!engine){ post({ type: 'gen-error', reqId: msg.reqId, message: 'GEN_NOT_READY' }); break; }
      const ctl = new AbortController();
      genCtls.set(msg.reqId, ctl);
      try{
        const text = await engine.generate({
          reqId: msg.reqId,
          messages: msg.messages,
          tools: msg.tools,
          prompt: msg.prompt,
          maxTokens: msg.maxTokens,
          temperature: msg.temperature,
          signal: ctl.signal,
        });
        post({ type: 'result', reqId: msg.reqId, text });
      }catch(err){
        post({ type: 'gen-error', reqId: msg.reqId, message: (err && err.message) || String(err) });
      }finally{
        genCtls.delete(msg.reqId);
      }
      break;
    }

    case 'abort': {
      const ctl = genCtls.get(msg.reqId);
      if(ctl){ try{ ctl.abort(); }catch(_){} }
      if(engine) engine.abort(msg.reqId);
      break;
    }

    case 'abort-all': {
      for(const ctl of genCtls.values()){ try{ ctl.abort(); }catch(_){} }
      if(engine) engine.abortAll();
      break;
    }

    case 'dispose': {
      if(engine) engine.dispose();
      engine = null;
      break;
    }

    default:
      break;
  }
};
