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
  // Read filters: `overdue:true` = open tasks whose dueDate is before today;
  // `dueBefore`/`dueAfter` are inclusive ISO-date bounds; `includeDone` /
  // `includeArchived` widen the pool for retrospective questions.
  QUERY_TASKS:    { required:[],        optional:['filter','overdue','dueBefore','dueAfter','status','priority','tag','listId','includeDone','includeArchived','limit'], destructive:false, readOnly:true },
  GET_TASK_DETAIL:{ required:['id'],   optional:[], destructive:false, readOnly:true },
  GET_CALENDAR_EVENTS: { required:[], optional:['fromDate','toDate','limit'], destructive:false, readOnly:true },
  LIST_CATEGORIES: { required:[],     optional:[], destructive:false, readOnly:true },
  LIST_LISTS:     { required:[],      optional:[], destructive:false, readOnly:true },
  SNOOZE_TASK:    { required:['id','untilDate'], optional:[], destructive:false, readOnly:false },
  RESCHEDULE:     { required:['id','dueDate'], optional:['remindAt'], destructive:false, readOnly:false },
  SPLIT_TASK:     { required:['id','parts'], optional:[], destructive:false, readOnly:false },
  CLASSIFY_TASK:  { required:['id'], optional:[], destructive:false, readOnly:false },
  CREATE_FROM_EVENT: { required:['feedId','eventUid'], optional:['eventDate'], destructive:false, readOnly:false },
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

function _pad2(n){ return String(n).padStart(2, '0'); }
function _localISODate(d){ return d.getFullYear() + '-' + _pad2(d.getMonth() + 1) + '-' + _pad2(d.getDate()); }

const _WEEKDAY_IDX = { sun:0, mon:1, tue:2, wed:3, thu:4, fri:5, sat:6 };

/**
 * Resolve a handful of relative date words to a local ISO date. Small
 * on-device models routinely copy the prompt's relative phrasing straight
 * into an argument ("tomorrow", "next monday", "+7d", or a literal
 * "<tomorrow>" placeholder) instead of doing the calendar arithmetic; without
 * this the validator silently dropped the field and the op landed without a
 * date. Deliberately word-based — locale numeric formats (12/31/2026) stay
 * rejected because their day/month order is ambiguous.
 * @returns {string|null}
 */
function _naturalDateISO(raw, now){
  let s = String(raw == null ? '' : raw).trim().toLowerCase();
  s = s.replace(/^[<\[{(]+|[>\]})]+$/g, '').replace(/\s+/g, ' ').trim();
  if(!s) return null;
  const base = now instanceof Date ? new Date(now.getTime()) : new Date();
  base.setHours(0, 0, 0, 0);
  const addDays = (n) => { const d = new Date(base.getTime()); d.setDate(d.getDate() + n); return _localISODate(d); };
  const addMonths = (n) => {
    const d = new Date(base.getTime());
    const day = d.getDate();
    d.setDate(1); d.setMonth(d.getMonth() + n);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
    return _localISODate(d);
  };
  if(s === 'today' || s === 'now' || s === 'tonight') return addDays(0);
  if(s === 'tomorrow' || s === 'tmrw' || s === 'tmr') return addDays(1);
  if(s === 'yesterday') return addDays(-1);
  if(s === 'next week' || s === 'in a week' || s === 'in 1 week') return addDays(7);
  if(s === 'next month' || s === 'in a month' || s === 'in 1 month') return addMonths(1);
  let m = s.match(/^(?:in\s+|\+)?(\d{1,3})\s*(d|day|days|w|wk|wks|week|weeks|mo|month|months)$/);
  if(m){
    const n = parseInt(m[1], 10);
    if(/^d/.test(m[2])) return addDays(n);
    if(/^w/.test(m[2])) return addDays(n * 7);
    return addMonths(n);
  }
  m = s.match(/^(?:next|this|on|coming)?\s*(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/);
  if(m){
    const target = _WEEKDAY_IDX[m[1]];
    let ahead = (target - base.getDay() + 7) % 7;
    if(ahead === 0) ahead = 7; // a bare weekday name means the upcoming one
    return addDays(ahead);
  }
  return null;
}

function _coerceDate(v){
  if(!v) return null;
  if(typeof v !== 'string') return null;
  const s = v.trim();
  if(_ISO_DATE_RE.test(s)) return s.slice(0, 10);
  if(_ISO_DT_RE.test(s)) return s.slice(0, 10);
  return _naturalDateISO(s);
}

// Clock phrases the model may attach to a relative date: "9am", "9:30 pm",
// "17:00", "at noon". Returns "HH:MM" or null.
function _coerceClock(raw){
  const s = String(raw == null ? '' : raw).trim().toLowerCase().replace(/^at\s+/, '');
  if(!s) return null;
  if(s === 'noon' || s === 'midday') return '12:00';
  if(s === 'midnight') return '00:00';
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if(!m) return null;
  let h = parseInt(m[1], 10);
  const mm = m[2] ? parseInt(m[2], 10) : 0;
  if(!Number.isFinite(h) || h > 24 || mm > 59) return null;
  if(m[3] === 'pm' && h < 12) h += 12;
  if(m[3] === 'am' && h === 12) h = 0;
  if(!m[3] && !m[2] && h > 23) return null;
  if(h === 24) h = 0;
  return _pad2(h) + ':' + _pad2(mm);
}

function _coerceDateTime(v){
  if(!v) return null;
  if(typeof v !== 'string') return null;
  const s = v.trim();
  if(_ISO_DT_RE.test(s)) return s.slice(0, 16);
  if(_ISO_DATE_RE.test(s)) return s + 'T09:00';
  // Relative date with an optional clock: "<tomorrow>T09:00", "tomorrow at
  // 9am", "next monday 17:30", "friday". Date-only resolves to 09:00 like
  // the ISO-date branch above.
  const stripped = s.replace(/^[<\[{(]+|[>\]})]+$/g, '');
  const parts = stripped.match(/^(.+?)(?:\s*T\s*|\s+at\s+|\s+@\s*|\s+)(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midday|midnight)$/i);
  if(parts){
    const d = _naturalDateISO(parts[1]);
    const c = _coerceClock(parts[2]);
    if(d && c) return d + 'T' + c;
  }
  const dOnly = _naturalDateISO(stripped);
  return dOnly ? dOnly + 'T09:00' : null;
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
  if(key === 'fromDate' || key === 'toDate' || key === 'untilDate' || key === 'dueBefore' || key === 'dueAfter' || key === 'eventDate') return _coerceDate(raw);
  if(key === 'overdue' || key === 'includeDone' || key === 'includeArchived'){ const b = _coerceBool(raw); return b == null ? null : b; }
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

// ── Tolerant op-JSON parsing ─────────────────────────────────────────────────
// Small on-device models (135M–1.5B) are unreliable JSON emitters. The
// failure modes seen in practice, each of which used to surface to the user
// as "Couldn't parse a valid plan":
//   - the array is cut off by max_new_tokens mid-element (pretty-printed
//     multi-op plans hit this constantly);
//   - a single {...} op object instead of an array, or an {"ops":[…]} wrapper;
//   - Python-style literals ('single quotes', True/False/None), trailing
//     commas, smart quotes, `//` comments;
//   - ops wrapped in <tool_call>…</tool_call> (chat templates with tools);
//   - OpenAI-style {"function":{"name","arguments"}} or "arguments" instead
//     of "args", or the args flattened onto the op ({"name":"MARK_DONE","id":3}).
// Every recovery below is *structural* — it never invents ops or args; it
// only finds ops the model actually emitted. validateOps stays authoritative.

/** Best-effort fixups for almost-JSON; applied only after strict parsing fails. */
function _repairJson(s){
  let t = String(s || '');
  t = t.replace(/[“”″]/g, '"').replace(/[‘’′]/g, "'");
  // Python literals (outside of obvious string context is hard to know; these
  // tokens essentially never appear bare inside our arg strings).
  t = t.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null');
  // Single-quoted keys/strings → double-quoted, but only when the text has no
  // double quotes at all (otherwise the apostrophe in "mom's" would be mangled).
  if(t.indexOf('"') < 0 && t.indexOf("'") >= 0){
    t = t.replace(/'((?:[^'\\]|\\.)*)'/g, (_, inner) => '"' + inner.replace(/"/g, '\\"') + '"');
  }
  // Line comments the model sometimes appends after an op.
  t = t.replace(/^\s*\/\/[^\n]*$/gm, '');
  // Trailing commas before a closer.
  t = t.replace(/,\s*([\]}])/g, '$1');
  // Unquoted keys: {name: "X"} → {"name": "X"}
  t = t.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');
  return t;
}

function _tryParseJson(s){
  try{ return { ok: true, value: JSON.parse(s) }; }catch(e){}
  try{ return { ok: true, value: JSON.parse(_repairJson(s)) }; }catch(e){ return { ok: false, error: e }; }
}

/**
 * Scan forward from `open` (which must point at `[` or `{`) and return the
 * index just past the matching closer, or -1 if the text ends first.
 */
function _matchBracket(s, open){
  const opener = s[open];
  const closer = opener === '[' ? ']' : '}';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for(let i = open; i < s.length; i++){
    const c = s[i];
    if(inStr){
      if(esc){ esc = false; continue; }
      if(c === '\\'){ esc = true; continue; }
      if(c === '"') inStr = false;
      continue;
    }
    if(c === '"'){ inStr = true; continue; }
    if(c === '[' || c === '{'){ depth++; continue; }
    if(c === ']' || c === '}'){
      depth--;
      if(depth === 0) return c === closer ? i + 1 : -1;
    }
  }
  return -1;
}

/**
 * Walk the elements of an array body (text after the opening `[`), parsing
 * each complete `{…}` object independently. Used when the array as a whole
 * won't parse — typically because generation stopped mid-element — so the
 * complete ops that precede the damage are still recovered.
 * @returns {Array<object>} the parseable elements, in order
 */
function _salvageArrayElements(s, open){
  const out = [];
  let i = open + 1;
  while(i < s.length){
    const c = s[i];
    if(c === '{'){
      const end = _matchBracket(s, i);
      if(end < 0) break; // incomplete trailing element — stop here
      const r = _tryParseJson(s.slice(i, end));
      if(r.ok && r.value && typeof r.value === 'object') out.push(r.value);
      i = end;
      continue;
    }
    if(c === ']') break;
    i++;
  }
  return out;
}

/** Collect JSON payloads from <tool_call>…</tool_call> blocks (any model). */
function _extractToolCallBlocks(s){
  const rx = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/gi;
  const out = [];
  let m;
  while((m = rx.exec(s)) !== null){
    const inner = (m[1] || '').trim();
    if(!inner) continue;
    const r = _tryParseJson(inner);
    if(!r.ok) continue;
    if(Array.isArray(r.value)) out.push(...r.value);
    else if(r.value && typeof r.value === 'object') out.push(r.value);
  }
  return out;
}

const _OP_NAME_KEYS = ['name', 'op', 'tool', 'action', 'operation', 'tool_name', 'function_name', 'type'];
const _OP_ARGS_KEYS = ['args', 'arguments', 'parameters', 'params', 'input', 'inputs'];
const _OP_META_KEYS = new Set([..._OP_NAME_KEYS, ..._OP_ARGS_KEYS, 'function', '_rationale', 'rationale', '_preview', 'reason', 'description_of_change']);

/**
 * Coerce one raw model-emitted op into the canonical {name, args} shape that
 * validateOps expects. Purely structural: aliases for the name/args keys,
 * OpenAI-style nesting, stringified args, and flattened args are folded in;
 * nothing is invented. Non-objects pass through untouched so validateOps can
 * reject them with its usual reason.
 */
function normalizeProposedOp(raw){
  if(!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  let src = raw;
  // OpenAI tool-call shape: {"type":"function","function":{"name","arguments"}}
  if(raw.function && typeof raw.function === 'object' && !Array.isArray(raw.function)){
    src = { ...raw, ...raw.function };
    delete src.function;
    if(raw.type === 'function') delete src.type;
  }
  let name = null;
  for(const k of _OP_NAME_KEYS){
    if(typeof src[k] === 'string' && src[k].trim()){ name = src[k]; break; }
  }
  if(name == null) return raw;
  name = String(name).trim().toUpperCase().replace(/[\s-]+/g, '_').replace(/[^A-Z0-9_]/g, '');
  let args;
  for(const k of _OP_ARGS_KEYS){
    if(src[k] !== undefined && src[k] !== null){ args = src[k]; break; }
  }
  if(typeof args === 'string'){
    const r = _tryParseJson(args);
    args = (r.ok && r.value && typeof r.value === 'object' && !Array.isArray(r.value)) ? r.value : undefined;
  }
  if(args !== undefined && (typeof args !== 'object' || Array.isArray(args))) args = undefined;
  // Flattened form: every non-meta key on the op itself is an argument.
  const flat = {};
  let flatCount = 0;
  for(const k of Object.keys(src)){
    if(_OP_META_KEYS.has(k)) continue;
    flat[k] = src[k];
    flatCount++;
  }
  if(args === undefined){
    if(flatCount) args = flat;
  } else if(flatCount){
    // {"name":"MARK_DONE","id":3,"args":{}} — fold top-level extras in
    // without overriding anything the args object already states.
    for(const k of Object.keys(flat)) if(args[k] === undefined) args[k] = flat[k];
  }
  const out = { name };
  if(args !== undefined) out.args = args;
  const rat = src._rationale != null ? src._rationale : src.rationale;
  if(typeof rat === 'string') out._rationale = rat;
  if(src._preview && typeof src._preview === 'object') out._preview = src._preview;
  return out;
}

function normalizeProposedOps(arr){
  if(!Array.isArray(arr)) return arr;
  return arr.map(normalizeProposedOp);
}

/**
 * Tolerant parser: strip code fences, locate the op payload (array, bare
 * object, {"ops":[…]} wrapper, or <tool_call> blocks), repair near-JSON,
 * salvage complete elements from a truncated array, and return a normalised
 * Array of {name, args} — or throw when the text contains no ops at all.
 * Throws: NOT_STRING | NO_ARRAY | UNBALANCED_ARRAY | the JSON.parse error.
 */
function parseOpsJson(text){
  if(typeof text !== 'string') throw new Error('NOT_STRING');
  let s = text;
  // Prefer the body of the first fenced block when one exists anywhere in
  // the text (the model often narrates before/after the fence).
  const fence = s.match(/```(?:json|javascript|js)?\s*([\s\S]*?)```/i);
  if(fence && /[\[{]/.test(fence[1])) s = fence[1];
  s = s.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');

  if(/<tool_call>/i.test(s)){
    const calls = _extractToolCallBlocks(s);
    if(calls.length) return normalizeProposedOps(calls);
  }

  // Locate the first array. Prefer a line that *starts* with `[` (the
  // common "here is the plan:\n[…]" shape) over a `[` buried in prose.
  let open = -1;
  let offset = 0;
  for(const line of s.split('\n')){
    const t = line.replace(/^\s+/, '');
    if(t.charAt(0) === '['){ open = offset + (line.length - t.length); break; }
    offset += line.length + 1;
  }
  if(open < 0) open = s.indexOf('[');

  const firstObj = s.indexOf('{');
  // A bare object that comes before any array: either a single op or a
  // wrapper such as {"ops":[…]} / {"operations":[…]} / {"actions":[…]}.
  if(firstObj >= 0 && (open < 0 || firstObj < open)){
    const end = _matchBracket(s, firstObj);
    if(end > 0){
      const r = _tryParseJson(s.slice(firstObj, end));
      if(r.ok && r.value && typeof r.value === 'object' && !Array.isArray(r.value)){
        const obj = r.value;
        for(const k of ['ops', 'operations', 'actions', 'tool_calls', 'calls', 'plan', 'steps']){
          if(Array.isArray(obj[k])) return normalizeProposedOps(obj[k]);
        }
        return normalizeProposedOps([obj]);
      }
    }
    if(open < 0) throw new Error('NO_ARRAY');
  }
  if(open < 0) throw new Error('NO_ARRAY');

  const end = _matchBracket(s, open);
  if(end < 0){
    // Truncated mid-array: keep every complete element that precedes the cut.
    const salvaged = _salvageArrayElements(s, open);
    if(salvaged.length) return normalizeProposedOps(salvaged);
    throw new Error('UNBALANCED_ARRAY');
  }
  const slice = s.slice(open, end);
  const r = _tryParseJson(slice);
  if(r.ok){
    if(Array.isArray(r.value)) return normalizeProposedOps(r.value);
    return r.value;
  }
  const salvaged = _salvageArrayElements(s, open);
  if(salvaged.length) return normalizeProposedOps(salvaged);
  throw r.error;
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
  window.normalizeProposedOp = normalizeProposedOp;
  window.normalizeProposedOps = normalizeProposedOps;
  window.naturalDateISO = _naturalDateISO;
  window.buildOpenAIToolsFromToolSchema = buildOpenAIToolsFromToolSchema;
  window.ASK_MAX_OPS = ASK_MAX_OPS;
  window.coerceToolArg = _coerceArg;
}
