/**
 * IndexedDB store for task embeddings + meta (Schwartz value vectors).
 * DB: stupind_intel (legacy name; retains existing IndexedDB through rebrands to OdTauLai then Odta)
 */
const _EC = window.ODTAULAI_CONFIG || {};
const INTEL_DB = (_EC.IDB && _EC.IDB.INTEL_DB) || 'stupind_intel';
const INTEL_DB_VER = 1;
const STORE_EMB = 'embeddings';
const STORE_META = 'meta';

const META_SCHWARTZ_KEY = 'schwartz_vecs_v1';
/** Bumped with embedding model upgrade — invalidates cached Schwartz value vectors */
const SCHWARTZ_MODEL_VER = _EC.EMBED_MODEL_VER || 'bge-small-en-v1.5-unified-v3';
const META_EMBED_RUNTIME_KEY = 'embed_runtime';
const META_CAT_CENTROIDS_KEY = 'cat_centroids_v1';
/** Must match `EMBED_MODEL_VER` in js/config.js (single source of truth) */
const EMBED_SCHEMA_VER = _EC.EMBED_MODEL_VER || 'bge-small-en-v1.5-unified-v3';

/** Canonical Map from last IDB read; updated incrementally on put/purge for fast embedStore.all() */
let _embedAllCache = null;
/** Serialize IndexedDB puts per taskId so concurrent put()s cannot leave the cache on a stale write. */
const _embedPutByTask = new Map();

function _openDb(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(INTEL_DB, INTEL_DB_VER);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if(!db.objectStoreNames.contains(STORE_EMB)) db.createObjectStore(STORE_EMB, { keyPath: 'taskId' });
      if(!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'key' });
    };
  });
}

function _tx(db, stores, mode){
  return db.transaction(stores, mode);
}

/** djb2-ish hash for change detection */
function hashTaskText(name, description){
  const s = String(name || '') + '\n' + String(description || '').slice(0, 2000);
  let h = 5381;
  for(let i = 0; i < s.length; i++){
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

const embedStore = {
  async put(taskId, textHash, vec){
    const prev = _embedPutByTask.get(taskId) || Promise.resolve();
    const p = prev.catch(() => {}).then(() => this._putNow(taskId, textHash, vec));
    _embedPutByTask.set(taskId, p);
    // Drop the map entry once this put settles so the per-task chain
    // doesn't leak references for the lifetime of the page. Skip the
    // delete if a newer put has already overwritten our slot.
    p.then(() => { if(_embedPutByTask.get(taskId) === p) _embedPutByTask.delete(taskId); },
           () => { if(_embedPutByTask.get(taskId) === p) _embedPutByTask.delete(taskId); });
    return p;
  },

  async _putNow(taskId, textHash, vec){
    const f32 = vec instanceof Float32Array ? vec : new Float32Array(vec);
    const db = await _openDb();
    await new Promise((resolve, reject) => {
      const tx = _tx(db, [STORE_EMB], 'readwrite');
      const st = tx.objectStore(STORE_EMB);
      const rec = { taskId, textHash, vec: f32.buffer ? f32.buffer.slice(f32.byteOffset, f32.byteOffset + f32.byteLength) : f32 };
      st.put(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    if(_embedAllCache){
      _embedAllCache.set(taskId, { textHash, vec: new Float32Array(f32) });
    }
  },

  async get(taskId){
    const db = await _openDb();
    const rec = await new Promise((resolve, reject) => {
      const tx = _tx(db, [STORE_EMB], 'readonly');
      const rq = tx.objectStore(STORE_EMB).get(taskId);
      rq.onsuccess = () => resolve(rq.result || null);
      rq.onerror = () => reject(rq.error);
    });
    db.close();
    if(!rec || !rec.vec) return null;
    return { textHash: rec.textHash, vec: new Float32Array(rec.vec) };
  },

  /** @returns {Promise<Map<number, {vec: Float32Array, textHash: string}>>} */
  async all(){
    if(_embedAllCache){
      const c = new Map();
      for(const [k, v] of _embedAllCache){
        c.set(k, { textHash: v.textHash, vec: new Float32Array(v.vec) });
      }
      return c;
    }
    const db = await _openDb();
    const map = new Map();
    try {
      await new Promise((resolve, reject) => {
        const tx = _tx(db, [STORE_EMB], 'readonly');
        const rq = tx.objectStore(STORE_EMB).openCursor();
        rq.onsuccess = e => {
          const cur = e.target.result;
          if(!cur){
            resolve();
            return;
          }
          const r = cur.value;
          if(r && r.vec) map.set(r.taskId, { vec: new Float32Array(r.vec), textHash: r.textHash });
          cur.continue();
        };
        rq.onerror = () => reject(rq.error);
      });
      _embedAllCache = map;
      return new Map(_embedAllCache);
    } catch(err) {
      // Cursor failed (page-hide mid-iteration, IDB error). Leave the cache
      // null so the next call rebuilds from scratch instead of returning a
      // partial map that masks corruption.
      _embedAllCache = null;
      throw err;
    } finally {
      try { db.close(); } catch(_) {}
    }
  },

  async ensure(task){
    if(typeof embedText !== 'function') return;
    if(typeof isIntelReady === 'function' && !isIntelReady()) return;
    if(!task || task.archived) return;
    const composite = `${task.name || ''}\n${(task.description || '').slice(0, 2000)}`.trim();
    if(!composite) return;
    const h = hashTaskText(task.name, task.description);
    const cur = await embedStore.get(task.id);
    if(cur && cur.textHash === h) return;
    const vec = await embedText(`${task.name}\n${(task.description || '').slice(0, 2000)}`);
    await embedStore.put(task.id, h, vec);
  },

  async purge(taskIds){
    if(!taskIds || !taskIds.length) return;
    const db = await _openDb();
    await new Promise((resolve, reject) => {
      const tx = _tx(db, [STORE_EMB], 'readwrite');
      const st = tx.objectStore(STORE_EMB);
      taskIds.forEach(id => st.delete(id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    if(_embedAllCache){
      taskIds.forEach(id => _embedAllCache.delete(id));
    }
  },

  async cleanOrphans(){
    if(typeof tasks === 'undefined' || !Array.isArray(tasks)) return;
    const alive = new Set(tasks.map(t => t.id));
    const db = await _openDb();
    const toDelete = [];
    await new Promise((resolve, reject) => {
      const tx = _tx(db, [STORE_EMB], 'readonly');
      const rq = tx.objectStore(STORE_EMB).openCursor();
      rq.onsuccess = e => {
        const cur = e.target.result;
        if(!cur){
          resolve();
          return;
        }
        if(!alive.has(cur.value.taskId)) toDelete.push(cur.value.taskId);
        cur.continue();
      };
      rq.onerror = () => reject(rq.error);
    });
    db.close();
    if(toDelete.length) await embedStore.purge(toDelete);
  },

  async getMeta(key){
    const db = await _openDb();
    const rec = await new Promise((resolve, reject) => {
      const tx = _tx(db, [STORE_META], 'readonly');
      const rq = tx.objectStore(STORE_META).get(key);
      rq.onsuccess = () => resolve(rq.result ? rq.result.value : null);
      rq.onerror = () => reject(rq.error);
    });
    db.close();
    return rec;
  },

  async setMeta(key, value){
    const db = await _openDb();
    await new Promise((resolve, reject) => {
      const tx = _tx(db, [STORE_META], 'readwrite');
      tx.objectStore(STORE_META).put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  },

  async getSchwartzEmbeddings(){
    const cached = await embedStore.getMeta(META_SCHWARTZ_KEY);
    if(cached && cached.model === SCHWARTZ_MODEL_VER && cached.vecs) return cached.vecs;
    return null;
  },

  async setSchwartzEmbeddings(vecs){
    await embedStore.setMeta(META_SCHWARTZ_KEY, { model: SCHWARTZ_MODEL_VER, vecs });
  },

  async deleteMeta(key){
    const db = await _openDb();
    await new Promise((resolve, reject) => {
      const tx = _tx(db, [STORE_META], 'readwrite');
      tx.objectStore(STORE_META).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  },

  /** Remove every task embedding (used on model / dim change). */
  async clearAllEmbeddings(){
    const db = await _openDb();
    await new Promise((resolve, reject) => {
      const tx = _tx(db, [STORE_EMB], 'readwrite');
      tx.objectStore(STORE_EMB).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    _embedAllCache = null;
  },

  /**
   * After intelLoad(): if schema version, active model, or dim changed, clear embeddings
   * and value/category caches so everything re-indexes with the new vectors.
   * @returns {Promise<{ didPurge: boolean }>}
   */
  async migrateEmbedRuntimeIfNeeded(){
    const ver = (typeof window !== 'undefined' && window.INTEL_EMBED_MODEL_VER) || EMBED_SCHEMA_VER;
    const modelId = (typeof getActiveEmbedModelId === 'function') ? getActiveEmbedModelId() : '';
    const dim = (typeof getEmbedDim === 'function') ? getEmbedDim() : 0;
    if(!modelId || !dim) return { didPurge: false };
    const prev = await embedStore.getMeta(META_EMBED_RUNTIME_KEY);
    if(prev && prev.schemaVer === ver && prev.modelId === modelId && prev.dim === dim){
      return { didPurge: false };
    }
    try{
      await embedStore.clearAllEmbeddings();
    }catch(e){
      console.warn('[embedStore] clearAllEmbeddings', e);
    }
    try{ await embedStore.deleteMeta(META_SCHWARTZ_KEY); }catch(e){}
    try{ await embedStore.deleteMeta(META_CAT_CENTROIDS_KEY); }catch(e){}
    try{ await embedStore.deleteMeta('list_vecs_v1'); }catch(e){}
    const meta = { schemaVer: ver, modelId, dim };
    try{ await embedStore.setMeta(META_EMBED_RUNTIME_KEY, meta); }
    catch(e2){
      console.warn('[embedStore] setMeta failed after model migration', e2);
      try{ await embedStore.setMeta(META_EMBED_RUNTIME_KEY, meta); }catch(e3){ console.warn('[embedStore] setMeta retry failed', e3); }
    }
    return { didPurge: true };
  },

  getCatCentroidsKey(){ return META_CAT_CENTROIDS_KEY; },

  /**
   * Re-embed every non-archived task (after model change or user action).
   * @param {(done: number, total: number) => void} [onProgress]
   */
  async reindexAllOpenTasks(onProgress){
    if(typeof tasks === 'undefined' || !Array.isArray(tasks)) return;
    if(typeof isIntelReady === 'function' && !isIntelReady()) return;
    if(typeof embedText !== 'function') return;
    const list = tasks.filter(t => t && !t.archived);
    const total = list.length;
    for(let i = 0; i < list.length; i++){
      try{ await embedStore.ensure(list[i]); }catch(e){ /* one bad task */ }
      if(typeof onProgress === 'function') onProgress(i + 1, total);
      // Yield to the event loop so the progress callback's DOM write
      // actually paints. Without this, the banner sits on "Re-indexing
      // tasks…" with no number until the entire loop completes — which
      // can be tens of seconds on a large vault.
      await new Promise(r => setTimeout(r, 0));
    }
  },
};

window.embedStore = embedStore;
window.hashTaskText = hashTaskText;
window.EMBED_SCHEMA_VER = EMBED_SCHEMA_VER;
