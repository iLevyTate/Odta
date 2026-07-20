// ========== TOOL SCHEMA (proposed ops → executeIntelOp input) ==========
// Mirrors every branch of executeIntelOp() in js/ai.js. Harmonize,
// auto-organize, dedupe, and other embedding-driven proposers funnel through
// validateOps which filters/coerces before they reach the existing
// _pendingOps preview.

const ASK_MAX_OPS = 50;

const TOOL_SCHEMA = {
  CREATE_TASK:    { required:['name'], optional:['priority','category','dueDate','remindAt','effort','tags','listId','description','type','parentId'], destructive:false, readOnly:false },
  UPDATE_TASK:    { required:['id'],   optional:['name','priority','status','dueDate','startDate','hiddenUntil','effort','energyLevel','category','description','url','estimateMin','starred','type','valuesAlignment','valuesNote','tags'], destructive:false, readOnly:false },
  MARK_DONE:      { required:['id'],   optional:['completionNote'], destructive:false, readOnly:false },
  REOPEN:         { required:['id'],   optional:[], destructive:false, readOnly:false },
  TOGGLE_STAR:    { required:['id'],   optional:[], destructive:false, readOnly:false },
  DELETE_TASK:    { required:['id'],   optional:[], destructive:'always', readOnly:false },
  DUPLICATE_TASK: { required:['id'],   optional:[], destructive:false, readOnly:false },
  MOVE_TASK:      { required:['id'],   optional:['newParentId'], destructive:false, readOnly:false },
  CHANGE_LIST:    { required:['id','listId'], optional:[], destructive:'mass', readOnly:false },
  ADD_NOTE:       { required:['id','text'], optional:[], destructive:false, readOnly:false },
  ADD_CHECKLIST:  { required:['id','text'], optional:[], destructive:false, readOnly:false },
  TOGGLE_CHECK:   { required:['id','checkId'], optional:[], destructive:false, readOnly:false },
  REMOVE_CHECK:   { required:['id','checkId'], optional:[], destructive:false, readOnly:false },
  ADD_TAG:        { required:['id','tag'], optional:[], destructive:false, readOnly:false },
  REMOVE_TAG:     { required:['id','tag'], optional:[], destructive:false, readOnly:false },
  ADD_BLOCKER:    { required:['id','blockerId'], optional:[], destructive:false, readOnly:false },
  REMOVE_BLOCKER: { required:['id','blockerId'], optional:[], destructive:false, readOnly:false },
  SET_REMINDER:   { required:['id','remindAt'], optional:[], destructive:false, readOnly:false },
  SET_RECUR:      { required:['id'],   optional:['recur'], destructive:false, readOnly:false },
  QUERY_TASKS:    { required:[],        optional:['filter','limit'], destructive:false, readOnly:true },
  GET_TASK_DETAIL:{ required:['id'],   optional:[], destructive:false, readOnly:true },
  GET_CALENDAR_EVENTS: { required:[], optional:['fromDate','toDate','limit'], destructive:false, readOnly:true },
  LIST_CATEGORIES: { required:[],     optional:[], destructive:false, readOnly:true },
  LIST_LISTS:     { required:[],      optional:[], destructive:false, readOnly:true },
  SNOOZE_TASK:    { required:['id','untilDate'], optional:[], destructive:false, readOnly:false },
  RESCHEDULE:     { required:['id','dueDate'], optional:['remindAt'], destructive:false, readOnly:false },
  SPLIT_TASK:     { required:['id','parts'], optional:[], destructive:false, readOnly:false },
  CLASSIFY_TASK:  { required:['id'], optional:[], destructive:false, readOnly:false },
  CREATE_FROM_EVENT: { required:['feedId','eventUid'], optional:[], destructive:false, readOnly:false },
};

/** Task id is not used by these ops (GET_TASK_DETAIL still has id — validated below) */
const OPS_WITHOUT_TASK_ID = new Set(['QUERY_TASKS','GET_CALENDAR_EVENTS','LIST_CATEGORIES','LIST_LISTS']);

const ENUM_FIELDS = {
  priority: ['urgent','high','normal','low','none'],
  status:   ['open','progress','review','blocked','done'],
  effort:   ['xs','s','m','l','xl'],
  energyLevel: ['high','low'],
  type:     ['task','bug','idea','errand','waiting'],
  recur:    ['daily','weekdays','weekly','monthly','every2d','after1d','after3d','after7d','after14d','after30d'],
};

function _coerceInt(v){
  if(typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if(typeof v === 'string' && /^-?\d+$/.test(v.trim())) return parseInt(v, 10);
  return null;
}

function _coerceBool(v){
  if(typeof v === 'boolean') return v;
  if(v === 1 || v === '1' || v === 'true') return true;
  if(v === 0 || v === '0' || v === 'false') return false;
  return null;
}

function _coerceTags(v){
  if(Array.isArray(v)) return v.map(x => String(x).replace(/^#/, '').trim()).filter(Boolean);
  if(typeof v === 'string') return v.split(/[,\s]+/).map(x => x.replace(/^#/, '').trim()).filter(Boolean);
  return null;
}

function _coerceStrArr(v){
  if(Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  if(typeof v === 'string') return v.split(/,\s*/).map(x => x.trim()).filter(Boolean);
  return null;
}

const _ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const _ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function _coerceDate(v){
  if(!v) return null;
  if(typeof v !== 'string') return null;
  const s = v.trim();
  if(_ISO_DATE_RE.test(s)) return s.slice(0, 10);
  if(_ISO_DT_RE.test(s)) return s.slice(0, 10);
  return null;
}

function _coerceDateTime(v){
  if(!v) return null;
  if(typeof v !== 'string') return null;
  const s = v.trim();
  if(_ISO_DT_RE.test(s)) return s.slice(0, 16);
  if(_ISO_DATE_RE.test(s)) return s + 'T09:00';
  return null;
}

function _coerceArg(key, raw, ctx){
  if(raw == null) return null;
  if(key === 'parts'){
    if(!Array.isArray(raw) || raw.length < 2) return null;
    const out = raw.map(p => (p && p.name != null)
      ? { name: String(p.name).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, 500) }
      : null,
    ).filter(x => x && x.name);
    return out.length >= 2 ? out.slice(0, 8) : null;
  }
  if(key === 'filter'){
    const s = String(raw).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
    return s.slice(0, 200) || null;
  }
  if(key === 'limit'){
    const n = _coerceInt(raw);
    if(n == null) return 20;
    return Math.max(1, Math.min(100, n));
  }
  if(key === 'fromDate' || key === 'toDate' || key === 'untilDate') return _coerceDate(raw);
  if(key === 'feedId' || key === 'eventUid'){
    return String(raw).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, 500) || null;
  }
  if(key === 'id' || key === 'blockerId' || key === 'newParentId' || key === 'listId' || key === 'parentId'){
    return _coerceInt(raw);
  }
  if(key === 'checkId'){
    if(typeof raw === 'number') return raw;
    const s = String(raw);
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  }
  if(key === 'tags') return _coerceTags(raw);
  if(key === 'valuesAlignment') return _coerceStrArr(raw);
  if(key === 'starred'){ const b = _coerceBool(raw); return b == null ? null : b; }
  if(key === 'dueDate' || key === 'startDate' || key === 'hiddenUntil') return _coerceDate(raw);
  if(key === 'remindAt') return _coerceDateTime(raw);
  if(key === 'priority' || key === 'status' || key === 'effort' || key === 'energyLevel' || key === 'type' || key === 'recur'){
    const s = String(raw).toLowerCase().trim();
    return ENUM_FIELDS[key].includes(s) ? s : null;
  }
  if(key === 'estimateMin'){ const n = _coerceInt(raw); return (n != null && n >= 0) ? n : null; }
  if(key === 'tag'){ const s = String(raw).replace(/^#/, '').trim(); return s || null; }
  // plain text fields — clamp + strip control chars (preserve CR like other branches)
  return String(raw).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, 2000);
}

/** BFS child task ids (direct + nested) under `rootId` for batch validation simulation. Cycle-safe (sync/import corruption). */
function _descendantIdsForBatchSim(rootId, tasksById){
  const out = [];
  const seen = new Set();
  const queue = [rootId];
  while(queue.length){
    const pid = queue.shift();
    for(const [tid, t] of tasksById){
      if(!t) continue;
      if((t.parentId || null) !== pid) continue;
      if(seen.has(tid)) continue;
      seen.add(tid);
      out.push(tid);
      queue.push(tid);
    }
  }
  return out;
}

/** @param {Map<number, { id?:number, parentId?:number|null, archived?:boolean }>} simTasksById */
function _simTaskExists(id, simTasksById){
  if(id == null || !simTasksById) return false;
  return simTasksById.has(id);
}

function _listExists(id, ctx){
  if(id == null) return false;
  return !!(ctx.listsById && ctx.listsById.has(id));
}

/**
 * Validate a JSON array of proposed ops (from embedding-driven proposers).
 * @param {any} raw - Parsed JSON (should be Array).
 * @param {{ tasksById: Map<number,object>, listsById: Map<number,object> }} ctx
 * @returns {{ valid: Array, rejected: Array<{op:any, reason:string}>, destructiveLevel: 'none'|'warn'|'hard', truncated: boolean }}
 */
function validateOps(raw, ctx){
  const out = { valid: [], rejected: [], destructiveLevel: 'none', truncated: false };
  if(!Array.isArray(raw)){
    out.rejected.push({ op: raw, reason: 'NOT_AN_ARRAY' });
    return out;
  }
  let arr = raw;
  if(arr.length > ASK_MAX_OPS){
    out.truncated = true;
    for(let i = ASK_MAX_OPS; i < raw.length; i++){
      out.rejected.push({ op: raw[i], reason: 'BATCH_LIMIT' });
    }
    arr = arr.slice(0, ASK_MAX_OPS);
  }

  const destructiveCounts = { DELETE_TASK: 0, CHANGE_LIST: 0 };
  const simTasksById = new Map();
  let simNextId = 1;
  if(ctx.tasksById && typeof ctx.tasksById.forEach === 'function'){
    ctx.tasksById.forEach((t, id) => {
      const nid = typeof id === 'number' ? id : parseInt(String(id), 10);
      if(Number.isFinite(nid) && nid >= simNextId) simNextId = nid + 1;
      if(t && typeof t === 'object'){
        simTasksById.set(id, {
          id: t.id != null ? t.id : id,
          parentId: t.parentId != null ? t.parentId : null,
        });
      }else{
        simTasksById.set(id, { id, parentId: null });
      }
    });
  }

  for(const rawOp of arr){
    if(!rawOp || typeof rawOp !== 'object' || Array.isArray(rawOp)){
      out.rejected.push({ op: rawOp, reason: 'NOT_AN_OBJECT' });
      continue;
    }
    const name = String(rawOp.name || rawOp.op || '').toUpperCase();
    const schema = TOOL_SCHEMA[name];
    if(!schema){
      out.rejected.push({ op: rawOp, reason: 'UNKNOWN_OP:' + name });
      continue;
    }
    // Require a plain args object; never fall back to the whole op (avoids
    // reading op metadata like name:"CREATE_TASK" as a task field).
    const rawArgs = rawOp.args && typeof rawOp.args === 'object' && !Array.isArray(rawOp.args) ? rawOp.args : null;
    if(!rawArgs){
      out.rejected.push({ op: rawOp, reason: 'MISSING_OR_INVALID_ARGS' });
      continue;
    }
    const args = {};
    let missing = null;
    const allowed = new Set([...schema.required, ...schema.optional]);
    for(const k of schema.required){
      const v = _coerceArg(k, rawArgs[k], ctx);
      if(v == null || v === ''){ missing = k; break; }
      args[k] = v;
    }
    if(missing){
      out.rejected.push({ op: rawOp, reason: 'MISSING_REQUIRED:' + missing });
      continue;
    }
    for(const k of schema.optional){
      if(rawArgs[k] === undefined) continue;
      const v = _coerceArg(k, rawArgs[k], ctx);
      if(v == null) continue;
      args[k] = v;
    }

    // Cross-field integrity: any id / listId / blockerId / newParentId / parentId must resolve (simTasksById includes prior CREATE_TASK in batch).
    if(args.id != null && name !== 'CREATE_TASK' && !OPS_WITHOUT_TASK_ID.has(name) && !_simTaskExists(args.id, simTasksById)){
      out.rejected.push({ op: rawOp, reason: 'UNKNOWN_TASK_ID:' + args.id });
      continue;
    }
    if(args.blockerId != null && !_simTaskExists(args.blockerId, simTasksById)){
      out.rejected.push({ op: rawOp, reason: 'UNKNOWN_BLOCKER_ID:' + args.blockerId });
      continue;
    }
    if(args.newParentId != null && !_simTaskExists(args.newParentId, simTasksById)){
      out.rejected.push({ op: rawOp, reason: 'UNKNOWN_PARENT_ID:' + args.newParentId });
      continue;
    }
    if(args.parentId != null && !_simTaskExists(args.parentId, simTasksById)){
      out.rejected.push({ op: rawOp, reason: 'UNKNOWN_PARENT_ID:' + args.parentId });
      continue;
    }
    if(name === 'MOVE_TASK' && args.newParentId != null && _descendantIdsForBatchSim(args.id, simTasksById).includes(args.newParentId)){
      out.rejected.push({ op: rawOp, reason: 'MOVE_WOULD_CYCLE' });
      continue;
    }
    if(args.listId != null && !_listExists(args.listId, ctx)){
      out.rejected.push({ op: rawOp, reason: 'UNKNOWN_LIST_ID:' + args.listId });
      continue;
    }

    if(destructiveCounts[name] != null) destructiveCounts[name]++;
    const validated = { name, args };
    // Optional passthrough: _rationale is metadata surfaced to preview cards
    // (e.g. "marked urgent because description mentions 'asap'"). It's never
    // read by executeIntelOp so it can't affect task state — but we still
    // coerce to string and clamp so a 10 KB injection can't bloat storage.
    const rawRat = rawOp._rationale != null ? rawOp._rationale : rawOp.rationale;
    if(typeof rawRat === 'string' && rawRat.trim()){
      validated._rationale = rawRat.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim().slice(0, 240);
    }
    if(rawOp._preview && typeof rawOp._preview === 'object' && !Array.isArray(rawOp._preview)){
      validated._preview = {
        taskName: String(rawOp._preview.taskName || '').trim().slice(0, 120),
        fromList: String(rawOp._preview.fromList || '').trim().slice(0, 80),
        toList: String(rawOp._preview.toList || '').trim().slice(0, 80),
      };
    }
    out.valid.push(validated);

    if(name === 'CREATE_TASK'){
      const nid = simNextId++;
      simTasksById.set(nid, { id: nid, parentId: args.parentId != null ? args.parentId : null });
    }
    if(name === 'MOVE_TASK'){
      const st = simTasksById.get(args.id);
      if(st) st.parentId = args.newParentId != null ? args.newParentId : null;
    }
  }

  // Aggregate destructive level. Delete is permanent, so any delete is hard.
  const massThreshold = 5;
  if(destructiveCounts.DELETE_TASK > 0) out.destructiveLevel = 'hard';
  else if(destructiveCounts.CHANGE_LIST >= massThreshold) out.destructiveLevel = 'hard';
  else if(destructiveCounts.CHANGE_LIST > 0) out.destructiveLevel = 'warn';

  return out;
}

/**
 * Render a short human-readable schema block that the LLM system prompt
 * enumerates. Generated once at load time from TOOL_SCHEMA above.
 */
function toolSchemaPromptBlock(){
  const lines = [];
  Object.keys(TOOL_SCHEMA).forEach(name => {
    const s = TOOL_SCHEMA[name];
    const req = s.required.length ? s.required.join(',') : '';
    const opt = s.optional.length ? s.optional.map(x => x + '?').join(',') : '';
    const args = [req, opt].filter(Boolean).join(',');
    lines.push('- ' + name + '(' + args + ')');
  });
  return lines.join('\n');
}

/**
 * Tolerant parser: strip code fences, find first balanced [...] block,
 * return parsed Array or throw.
 */
function parseOpsJson(text){
  if(typeof text !== 'string') throw new Error('NOT_STRING');
  let s = text;
  s = s.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  let open = -1;
  let offset = 0;
  for(const line of s.split('\n')){
    const t = line.replace(/^\s+/, '');
    if(t.charAt(0) === '['){ open = offset + (line.length - t.length); break; }
    offset += line.length + 1;
  }
  if(open < 0) open = s.indexOf('[');
  if(open < 0) throw new Error('NO_ARRAY');
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for(let i = open; i < s.length; i++){
    const c = s[i];
    if(inStr){
      if(esc){ esc = false; continue; }
      if(c === '\\'){ esc = true; continue; }
      if(c === '"') inStr = false;
      continue;
    }
    if(c === '"'){ inStr = true; continue; }
    if(c === '['){ depth++; continue; }
    if(c === ']'){ depth--; if(depth === 0){ end = i + 1; break; } }
  }
  if(end < 0) throw new Error('UNBALANCED_ARRAY');
  const slice = s.slice(open, end);
  return JSON.parse(slice);
}

/**
 * OpenAI / Qwen2.5-style tool list for native tool-calling models.
 * Parameter types are a best-effort hint; validateOps is still authoritative.
 */
function buildOpenAIToolsFromToolSchema(){
  const out = [];
  for(const name of Object.keys(TOOL_SCHEMA)){
    const def = TOOL_SCHEMA[name];
    const required = (def && Array.isArray(def.required)) ? def.required.slice() : [];
    const optional = (def && Array.isArray(def.optional)) ? def.optional : [];
    const seen = new Set();
    const properties = {};
    for(const k of required.concat(optional)){
      if(seen.has(k)) continue;
      seen.add(k);
      if(k === 'parts'){
        properties[k] = {
          type: 'array',
          description: 'Subtasks, each { name, effort? }',
          items: { type: 'object', additionalProperties: true },
        };
        continue;
      }
      let t = 'string';
      if(k === 'id' || k === 'listId' || k === 'newParentId' || k === 'parentId' || k === 'checkId' || k === 'blockerId' || k === 'limit' || k === 'estimateMin')
        t = 'integer';
      properties[k] = { type: t, description: k };
    }
    out.push({
      type: 'function',
      function: {
        name: name,
        description: 'Task manager operation: ' + name,
        parameters: { type: 'object', properties, required: required.length ? required : [] },
      },
    });
  }
  return out;
}

if(typeof window !== 'undefined'){
  window.TOOL_SCHEMA = TOOL_SCHEMA;
  window.validateOps = validateOps;
  window.toolSchemaPromptBlock = toolSchemaPromptBlock;
  window.parseOpsJson = parseOpsJson;
  window.buildOpenAIToolsFromToolSchema = buildOpenAIToolsFromToolSchema;
  window.ASK_MAX_OPS = ASK_MAX_OPS;
  window.coerceToolArg = _coerceArg;
}
