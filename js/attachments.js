/**
 * Task attachments (images + voice notes) in a dedicated IndexedDB store.
 * Blobs stay out of localStorage JSON — only attachment ids live on tasks.
 */
const ATTACH_DB = 'odtaulai_attachments';
const ATTACH_STORE = 'files';
const ATTACH_DB_VER = 1;
const ATTACH_MAX_IMAGES = 10;
const ATTACH_MAX_AUDIO = 5;

let _attachDb = null;

function _openAttachDb(){
  if(_attachDb) return Promise.resolve(_attachDb);
  return new Promise((res, rej) => {
    const req = indexedDB.open(ATTACH_DB, ATTACH_DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if(!db.objectStoreNames.contains(ATTACH_STORE)){
        const st = db.createObjectStore(ATTACH_STORE, { keyPath: 'id' });
        st.createIndex('taskId', 'taskId', { unique: false });
      }
    };
    req.onsuccess = e => { _attachDb = e.target.result; res(_attachDb); };
    req.onerror = () => rej(req.error);
  });
}

function _newAttachId(){
  return 'a_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

function _attachPut(rec){
  return _openAttachDb().then(db => new Promise((res, rej) => {
    const tx = db.transaction(ATTACH_STORE, 'readwrite');
    tx.objectStore(ATTACH_STORE).put(rec);
    tx.oncomplete = () => res(rec);
    tx.onerror = () => rej(tx.error);
  }));
}

function _attachGet(id){
  return _openAttachDb().then(db => new Promise((res, rej) => {
    const tx = db.transaction(ATTACH_STORE, 'readonly');
    const r = tx.objectStore(ATTACH_STORE).get(id);
    r.onsuccess = () => res(r.result || null);
    r.onerror = () => rej(r.error);
  })).catch(() => null);
}

function _attachDelete(id){
  return _openAttachDb().then(db => new Promise((res, rej) => {
    const tx = db.transaction(ATTACH_STORE, 'readwrite');
    tx.objectStore(ATTACH_STORE).delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  })).catch(() => {});
}

function _attachByTask(taskId){
  return _openAttachDb().then(db => new Promise((res, rej) => {
    const tx = db.transaction(ATTACH_STORE, 'readonly');
    const idx = tx.objectStore(ATTACH_STORE).index('taskId');
    const r = idx.getAll(taskId);
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  })).catch(() => []);
}

function getTaskAttachmentIds(t){
  if(!t || !Array.isArray(t.attachments)) return [];
  return t.attachments.filter(x => typeof x === 'string' && x.length > 0);
}

function countAttachmentsByKind(recs, kind){
  return recs.filter(r => r && r.kind === kind).length;
}

async function listTaskAttachments(taskId){
  const rows = await _attachByTask(taskId);
  return rows.sort((a, b) => (a.created || 0) - (b.created || 0));
}

async function addImageAttachment(taskId, file){
  const t = typeof findTask === 'function' ? findTask(taskId) : null;
  if(!t) return null;
  const existing = await listTaskAttachments(taskId);
  if(countAttachmentsByKind(existing, 'image') >= ATTACH_MAX_IMAGES){
    if(typeof toast === 'function') toast('Max ' + ATTACH_MAX_IMAGES + ' photos per task');
    return null;
  }
  const id = _newAttachId();
  const rec = {
    id, taskId, kind: 'image', mime: file.type || 'image/jpeg',
    created: Date.now(), blob: file,
  };
  await _attachPut(rec);
  if(!Array.isArray(t.attachments)) t.attachments = [];
  if(!t.attachments.includes(id)) t.attachments.push(id);
  if(typeof saveState === 'function') saveState('user');
  return rec;
}

async function addAudioAttachment(taskId, blob, mime){
  const t = typeof findTask === 'function' ? findTask(taskId) : null;
  if(!t) return null;
  const existing = await listTaskAttachments(taskId);
  if(countAttachmentsByKind(existing, 'audio') >= ATTACH_MAX_AUDIO){
    if(typeof toast === 'function') toast('Max ' + ATTACH_MAX_AUDIO + ' voice notes per task');
    return null;
  }
  const id = _newAttachId();
  const rec = {
    id, taskId, kind: 'audio', mime: mime || 'audio/webm',
    created: Date.now(), blob,
  };
  await _attachPut(rec);
  if(!Array.isArray(t.attachments)) t.attachments = [];
  if(!t.attachments.includes(id)) t.attachments.push(id);
  if(typeof saveState === 'function') saveState('user');
  return rec;
}

async function removeAttachment(taskId, attachId){
  const t = typeof findTask === 'function' ? findTask(taskId) : null;
  await _attachDelete(attachId);
  if(t && Array.isArray(t.attachments)){
    t.attachments = t.attachments.filter(x => x !== attachId);
    if(typeof saveState === 'function') saveState('user');
  }
}

async function deleteAttachmentsForTask(taskId){
  const rows = await _attachByTask(taskId);
  await Promise.all(rows.map(r => _attachDelete(r.id)));
}

function attachmentObjectUrl(rec){
  if(!rec || !rec.blob) return null;
  return URL.createObjectURL(rec.blob);
}

window.getTaskAttachmentIds = getTaskAttachmentIds;
window.listTaskAttachments = listTaskAttachments;
window.addImageAttachment = addImageAttachment;
window.addAudioAttachment = addAudioAttachment;
window.removeAttachment = removeAttachment;
window.deleteAttachmentsForTask = deleteAttachmentsForTask;
window._attachGet = _attachGet;
window.attachmentObjectUrl = attachmentObjectUrl;
