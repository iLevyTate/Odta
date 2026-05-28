// ========== ASK — natural-language intent → op batch (preview + apply) ==========
// Retrieval-augmented: embed the query, pick top-k semantically similar tasks
// as context, run the local LLM, tolerant-parse the JSON, validate against
// TOOL_SCHEMA, and hand the valid ops to acceptProposedOps() so the existing
// pending-ops preview + undo pipeline handles everything else.

const ASK_CONTEXT_MAX_TASKS = 10;
const ASK_RECENT_MAX_TASKS = 20;
const ASK_CONTEXT_MAX_CHARS = 1800;
const ASK_TASK_LINE_MAX = 200;

// (M3) Strip C0 control characters + DEL from user-supplied text before it
// enters the LLM prompt.  Prevents theoretical prompt injection via embedded
// control sequences in task names, categories, or the query itself.
const _askStripCtrl = s => String(s || '').replace(/[\u0000-\u001F\u007F]/g, '');

// Uses todayISO() from tasks.js / todayKey() from utils.js — no local re-implementation
function _askToday(){
  return (typeof todayISO === 'function') ? todayISO() : (typeof todayKey === 'function' ? todayKey() : new Date().toISOString().slice(0, 10));
}

function _askListName(id){
  if(typeof lists === 'undefined' || id == null) return null;
  const l = lists.find(x => x.id === id);
  return l ? l.name : null;
}

function _askSerializeTask(t){
  const line = {
    id: t.id,
    name: _askStripCtrl(t.name).slice(0, 80),
    status: t.status || 'open',
    priority: t.priority || 'none',
  };
  if(t.dueDate) line.due = t.dueDate;
  if(t.listId != null){ const n = _askListName(t.listId); if(n) line.list = n; }
  if(Array.isArray(t.tags) && t.tags.length) line.tags = t.tags.slice(0, 6).map(x => _askStripCtrl(x));
  if(t.effort) line.effort = t.effort;
  if(t.category) line.category = _askStripCtrl(t.category);
  if(t.starred) line.starred = true;
  if(t.archived) line.archived = true;
  let s = JSON.stringify(line);
  if(s.length > ASK_TASK_LINE_MAX) s = s.slice(0, ASK_TASK_LINE_MAX - 1) + '…';
  return s;
}

/**
 * Pick context tasks: top-k semantic matches + recently-modified open tasks, deduped.
 * Will lazily kick off embedding model load if the user enabled Ask but never
 * opened Tools — but won't block the Ask turn on that (retrieval is best-effort).
 */
// Detect retrospective / archive-aware queries. When the user asks "what did
// I finish this week?" or "show me completed accounting tasks", filtering the
// context down to open + non-archived tasks (the default for the daily ops
// pipeline) silently returns wrong answers. This heuristic widens the
// context for those queries to include done + archived.
function _askIsRetrospective(q){
  if(typeof q !== 'string') return false;
  const s = q.toLowerCase();
  return /\b(complete|completed|finish|finished|done|archived|history|last week|last month|yesterday|recent(ly)?|past)\b/.test(s);
}

async function _askBuildContext(query){
  const out = [];
  const seen = new Set();
  const retro = _askIsRetrospective(query);

  // Kick off embedding load in the background if it's missing. We briefly
  // await it (short timeout) so first-ever Ask turns get semantic retrieval
  // if the model loads quickly enough.
  if(typeof isIntelReady === 'function' && !isIntelReady() && typeof intelLoad === 'function'){
    try{
      await Promise.race([
        intelLoad(),
        new Promise(res => setTimeout(res, 2000)),
      ]);
    }catch(e){ /* best-effort */ }
  }

  if(typeof semanticSearch === 'function' && typeof isIntelReady === 'function' && isIntelReady()){
    try{
      const ranked = await semanticSearch(query, ASK_CONTEXT_MAX_TASKS);
      for(const r of ranked){
        if(!r || !r.t) continue;
        if(seen.has(r.t.id)) continue;
        seen.add(r.t.id);
        out.push(r.t);
      }
    }catch(e){ /* retrieval is best-effort */ }
  }

  if(typeof tasks !== 'undefined' && Array.isArray(tasks)){
    const recents = tasks
      // Retrospective queries see done + archived; everyday queries don't, so
      // a normal "make X urgent" prompt isn't drowned in stale history.
      .filter(t => retro ? true : (!t.archived && t.status !== 'done'))
      .slice()
      .sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0))
      .slice(0, ASK_RECENT_MAX_TASKS);
    for(const t of recents){
      if(seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
      if(out.length >= ASK_CONTEXT_MAX_TASKS + ASK_RECENT_MAX_TASKS) break;
    }
  }

  const lines = [];
  let used = 0;
  for(const t of out){
    const line = _askSerializeTask(t);
    if(used + line.length + 1 > ASK_CONTEXT_MAX_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines;
}

function _askListsBlock(){
  if(typeof lists === 'undefined' || !Array.isArray(lists) || !lists.length) return '';
  return lists.slice(0, 20)
    .map(l => '{"id":' + l.id + ',"name":' + JSON.stringify(_askStripCtrl(l.name).slice(0, 40)) + '}')
    .join('\n');
}

function _askSystemPrompt(){
  const schema = (typeof toolSchemaPromptBlock === 'function') ? toolSchemaPromptBlock() : '';
  return [
    'You convert a user request into a JSON array of task operations for a local task manager.',
    'Return ONLY a JSON array. No prose, no code fences, no explanation.',
    'If the request is ambiguous, unsafe, or you cannot match it to the ops below, return [].',
    '',
    'Allowed ops (name(required,optional?)):',
    schema,
    '',
    'Rules:',
    '- Each element is {"name":"OP_NAME","args":{...}}.',
    '- "id" values must come from the Context below. Do not invent ids.',
    '- priority ∈ {urgent,high,normal,low,none}. status ∈ {open,progress,review,blocked,done}.',
    '- effort ∈ {xs,s,m,l,xl}. energyLevel ∈ {high,low}. recur ∈ {daily,weekdays,weekly,monthly}.',
    '- Dates use YYYY-MM-DD. Reminders use YYYY-MM-DDTHH:MM.',
    '- Prefer UPDATE_TASK for edits. Use CREATE_TASK only when the user asks to create.',
    '- Never output DELETE_TASK unless the user explicitly says "delete forever".',
    '- Keep the array short — only the ops that clearly satisfy the request.',
    '- Read-only ops (QUERY_TASKS, GET_TASK_DETAIL, GET_CALENDAR_EVENTS, LIST_CATEGORIES, LIST_LISTS) are for gathering facts; you will receive tool results and can then output write ops. Do not try to open UI modals.',
    '',
    'Examples:',
    'User: make task 12 urgent\n→ [{"name":"UPDATE_TASK","args":{"id":12,"priority":"urgent"}}]',
    'User: create a task "buy milk" due tomorrow tagged shopping\n→ [{"name":"CREATE_TASK","args":{"name":"buy milk","dueDate":"<tomorrow>","tags":["shopping"]}}]',
    'User: remind me to call mom tomorrow at 9am\n→ [{"name":"CREATE_TASK","args":{"name":"Call mom","dueDate":"<tomorrow>","remindAt":"<tomorrow>T09:00"}}]',
    'User: add "submit expenses" to my Work list, due friday, high priority\n→ [{"name":"CREATE_TASK","args":{"name":"Submit expenses","listName":"Work","dueDate":"<friday>","priority":"high"}}]',
    'User: schedule the dentist next monday\n→ [{"name":"CREATE_TASK","args":{"name":"Dentist","dueDate":"<next monday>"}}]',
    'User: move the rent task to Personal\n→ [{"name":"UPDATE_TASK","args":{"id":<id>,"listName":"Personal"}}]',
    'User: snooze task 7 for a week\n→ [{"name":"UPDATE_TASK","args":{"id":7,"hiddenUntil":"<+7d>"}}]',
    'User: mark all my #errands as done\n→ [{"name":"MARK_DONE","args":{"id":<id>}}, ...]',
    'User: archive everything already completed last week\n→ [{"name":"ARCHIVE_TASK","args":{"id":<id>}}, ...]',
    'User: what should I do next?\n→ []',
    'User: nevermind\n→ []',
  ].join('\n');
}

// Detect imperative / write-intent queries — "remind me to X", "add X",
// "schedule Y", "create a task", etc. These should produce ops; if the ops
// pipeline returns [] for one we owe the user a retry pass rather than
// silently giving up. Mutually exclusive with _askIsQuestionLike in practice
// but we let question take precedence at the call site.
function _askIsImperative(q){
  if(typeof q !== 'string') return false;
  const s = q.trim();
  if(!s) return false;
  // Leading-verb match — covers the common phrasings without being too
  // greedy ("show me" stays a question, "find the X" stays a question).
  return /^(remind|add|create|make|schedule|move|archive|delete|complete|finish|done|mark|set|tag|untag|star|unstar|rename|update|change|reschedule|snooze|unsnooze|prioriti[sz]e|deprioriti[sz]e|assign|note|note that|cancel|reopen|undo|note|book|plan|put|drop)\b/i.test(s);
}

// Stronger second-pass prompt for imperatives the ops pipeline missed.
// The original system prompt is conservative ("return [] if ambiguous"); a
// retry replaces that with an aggressive "you MUST produce a CREATE_TASK or
// explain what's missing" instruction so the user actually gets the task or
// a clear blocker. Date placeholders are rendered concrete in the user
// message body so the LLM doesn't have to do that arithmetic itself.
function _askWriteRetrySystemPrompt(){
  const schema = (typeof toolSchemaPromptBlock === 'function') ? toolSchemaPromptBlock() : '';
  return [
    'You are a write-only task assistant. The user asked you to make a change.',
    'You MUST return a JSON array containing one or more write operations from the schema below, or, if you truly cannot, an explanation in this exact form:',
    '  [{"name":"NOOP","args":{"reason":"<one short sentence: what info is missing>"}}]',
    'Default to CREATE_TASK if the user is asking to add / remind / schedule something new. Default to UPDATE_TASK if they refer to an existing task in the Context.',
    'Return ONLY the JSON array. No prose, no code fences.',
    '',
    'Allowed write ops:',
    schema,
    '',
    'Rules:',
    '- Each element is {"name":"OP_NAME","args":{...}}.',
    '- Use ISO dates (YYYY-MM-DD) and ISO-local datetimes (YYYY-MM-DDTHH:MM).',
    '- Pull task ids from the Context block. Do not invent ids.',
    '- Never DELETE_TASK unless the user explicitly says "delete forever".',
    '- If the user said "remind me to X", create the task with name=X and set remindAt to the named time.',
  ].join('\n');
}

function _askCalendarBlock(){
  if(typeof getUpcomingEvents !== 'function') return '';
  const evs = getUpcomingEvents(7, 20, { strictFuture: false });
  if(!evs || !evs.length) return '';
  const lines = evs.map(e => {
    const tim = (e.time || (e.allDay ? 'all day' : '')) || '';
    const loc = e.location ? ' @' + String(e.location).replace(/\n/g, ' ').slice(0, 40) : '';
    return (e.dateISO || '') + ' ' + String(tim).padEnd(8, ' ') + ' ' + (e.title || '(event)') + loc;
  });
  return ('Calendar (next 7 days):\n' + lines.join('\n')).slice(0, 600);
}

function _askUserPrompt(query, contextLines){
  const parts = [];
  parts.push('Today: ' + _askToday());
  const listBlock = _askListsBlock();
  if(listBlock) parts.push('Lists:\n' + listBlock);
  const calB = (typeof _askCalendarBlock === 'function') ? _askCalendarBlock() : '';
  if(calB) parts.push(calB);
  if(contextLines.length) parts.push('Context (relevant tasks):\n' + contextLines.join('\n'));
  parts.push('Request: ' + _askStripCtrl(query).slice(0, 600));
  parts.push('JSON array:');
  return parts.join('\n\n');
}

function _askCtx(){
  const tasksById = new Map();
  const listsById = new Map();
  if(typeof tasks !== 'undefined' && Array.isArray(tasks)) tasks.forEach(t => tasksById.set(t.id, t));
  if(typeof lists !== 'undefined' && Array.isArray(lists)) lists.forEach(l => listsById.set(l.id, l));
  return { tasksById, listsById };
}

// ---- Cognitask: multi-turn read then write (same module so tests can load ask.js alone) ----
const COGNITASK_MAX_READ_ROUNDS = 3;
const COGNITASK_MAX_TURNS = COGNITASK_MAX_READ_ROUNDS + 1;

function _readArgCtx(){
  if(typeof _askCtx === 'function') return _askCtx();
  return { tasksById: new Map(), listsById: new Map() };
}

function _coerceReadKey(key, raw){
  if(typeof window !== 'undefined' && typeof window.coerceToolArg === 'function'){
    return window.coerceToolArg(key, raw, _readArgCtx());
  }
  if(key === 'id'){
    if(raw == null) return null;
    const n = (typeof raw === 'number' && Number.isFinite(raw)) ? Math.trunc(raw) : parseInt(String(raw), 10);
    return Number.isFinite(n) ? n : null;
  }
  if(key === 'limit') return Math.min(100, Math.max(1, _coerceCognitaskInt(raw, 20)));
  if(key === 'fromDate' || key === 'toDate' || key === 'untilDate') return raw == null ? null : String(raw).slice(0, 10);
  if(key === 'filter') return raw == null ? null : String(raw).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, 200) || null;
  return raw;
}

/**
 * @param {Array<object>} evs - from getUpcomingEvents (have _startMs)
 * @param {string|null} fromDate ISO y-m-d
 * @param {string|null} toDate
 */
function _filterCalEventsByDateRange(evs, fromDate, toDate){
  if(!Array.isArray(evs) || !evs.length) return evs || [];
  const fromT = fromDate ? new Date(String(fromDate).slice(0, 10) + 'T00:00:00').getTime() : null;
  const toT = toDate ? new Date(String(toDate).slice(0, 10) + 'T23:59:59.999').getTime() : null;
  if(fromT == null && toT == null) return evs;
  return evs.filter(ev => {
    const ms = ev && ev._startMs;
    if(typeof ms !== 'number' || !Number.isFinite(ms)) return false;
    if(fromT != null && !Number.isFinite(fromT)) return false;
    if(toT != null && !Number.isFinite(toT)) return false;
    if(fromT != null && ms < fromT) return false;
    if(toT != null && ms > toT) return false;
    return true;
  });
}

/** Days of lookahead for getUpcomingEvents so filtering by toDate is not pre-truncated (cap 365). */
function _calendarFetchWindowDays(fromDate, toDate){
  if(!toDate) return 30;
  const anchor = fromDate
    ? new Date(String(fromDate).slice(0, 10) + 'T00:00:00')
    : new Date();
  anchor.setHours(0, 0, 0, 0);
  const end = new Date(String(toDate).slice(0, 10) + 'T23:59:59.999');
  if(!Number.isFinite(anchor.getTime()) || !Number.isFinite(end.getTime())) return 30;
  const diffMs = end - anchor;
  const days = Math.ceil(diffMs / 86400000);
  if(!Number.isFinite(days)) return 30;
  return Math.min(365, Math.max(1, days));
}

/**
 * @param {{ name: string, args: object }} op
 * @returns {object} JSON-serializable result
 */
function runReadOp(op){
  const rawA = (op && op.args) || {};
  const n = (op && op.name) || '';
  const a = { ...rawA };
  try{
    if(n === 'QUERY_TASKS'){
      const limR = a.limit != null && a.limit !== undefined ? _coerceReadKey('limit', a.limit) : 20;
      const lim = Math.min(100, Math.max(1, typeof limR === 'number' && Number.isFinite(limR) ? limR : 20));
      const f = (a.filter != null && a.filter !== '')
        ? String(_coerceReadKey('filter', a.filter) || '').toLowerCase()
        : '';
      // Honour an `includeArchived`/`includeDone` flag so the LLM can opt in
      // to retrospective queries ("what did I finish last week?"). Default
      // stays narrow so everyday ops don't accidentally hit done/archived ids.
      const wantDone     = a.includeDone     === true || a.includeDone     === 'true' || a.status === 'done';
      const wantArchived = a.includeArchived === true || a.includeArchived === 'true';
      const pool = (typeof tasks !== 'undefined' && Array.isArray(tasks))
        ? tasks.filter(t => {
            if(!t) return false;
            if(t.archived && !wantArchived) return false;
            if(t.status === 'done' && !wantDone) return false;
            return true;
          }) : [];
      const picked = f
        ? pool.filter(t => {
            const desc = String(t.description || '').slice(0, 5000);
            return (String(t.name || '') + ' ' + desc).toLowerCase().includes(f);
          })
        : pool;
      return { tasks: picked.slice(0, lim).map(t => ({ id: t.id, name: t.name, dueDate: t.dueDate, status: t.status, priority: t.priority, completedAt: t.completedAt || null, archived: !!t.archived })) };
    }
    if(n === 'GET_TASK_DETAIL'){
      const id = _coerceReadKey('id', a.id);
      if(id == null || !Number.isFinite(id)) return { error: 'bad_id' };
      const t = (typeof findTask === 'function') ? findTask(id) : null;
      if(!t) return { error: 'not_found' };
      return { task: {
        id: t.id, name: t.name, description: (t.description || '').slice(0, 800),
        dueDate: t.dueDate, startDate: t.startDate, category: t.category, tags: t.tags, status: t.status, priority: t.priority, effort: t.effort, energyLevel: t.energyLevel, remindAt: t.remindAt,
      } };
    }
    if(n === 'GET_CALENDAR_EVENTS'){
      if(typeof getUpcomingEvents !== 'function') return { events: [] };
      const limV = _coerceReadKey('limit', a.limit);
      const lim = Math.min(500, Math.max(1, typeof limV === 'number' && Number.isFinite(limV) ? limV : 30));
      const fromD = _coerceReadKey('fromDate', a.fromDate);
      const toD = _coerceReadKey('toDate', a.toDate);
      const windowDays = _calendarFetchWindowDays(fromD, toD);
      let evs = getUpcomingEvents(windowDays, 500, { strictFuture: false });
      evs = _filterCalEventsByDateRange(evs, fromD, toD);
      return { events: evs.slice(0, lim).map(e => ({ title: e.title, dateISO: e.dateISO, time: e.time, location: (e.location || '').slice(0, 80), feed: e.feedLabel })) };
    }
    if(n === 'LIST_CATEGORIES'){
      const rows = (typeof getActiveCategories === 'function') ? getActiveCategories() : [];
      return { categories: rows.map(c => ({ id: c.id, label: c.label, focus: (c.focus != null) ? c.focus : (c.description || '') })) };
    }
    if(n === 'LIST_LISTS'){
      const L = (typeof lists !== 'undefined' && Array.isArray(lists)) ? lists : [];
      return { lists: L.map(l => ({ id: l.id, name: l.name })) };
    }
  }catch(e){
    return { error: (e && e.message) || 'read_failed' };
  }
  return { error: 'unknown_read' };
}

function _coerceCognitaskInt(v, d){
  const n = (typeof v === 'number' && Number.isFinite(v)) ? v : parseInt(String(v), 10);
  if(!Number.isFinite(n)) return d;
  return Math.trunc(n);
}

function _schemaReadOnly(name){
  const s = (typeof TOOL_SCHEMA !== 'undefined' && TOOL_SCHEMA) ? TOOL_SCHEMA[name] : null;
  return !!(s && s.readOnly);
}

// Pull a human-readable answer out of accumulated LLM output. Strips code
// fences, drops bare JSON / tool-call blocks, collapses whitespace, and
// caps length so a runaway generation doesn't blow up the UI. Returns ''
// when nothing usable remains (caller falls back to PARSE_FAILED).
function _extractProseAnswer(raw){
  if(typeof raw !== 'string' || !raw) return '';
  let s = raw;
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, ' ');
  s = s.replace(/^\s*\[[\s\S]*?\]\s*$/m, ' ');
  const lines = s.split('\n')
    .map(l => l.trim())
    .filter(l => l && !/^[\[\]\{\},]+$/.test(l) && !/^"[^"]*"\s*:/.test(l));
  const joined = lines.join('\n').trim();
  if(joined.length < 4) return '';
  return joined.length > 1200 ? joined.slice(0, 1200) + '…' : joined;
}

// Heuristic: does the user's query read as a question or info request rather
// than a write instruction? The op-only system prompt teaches the LLM to
// answer "what's overdue?" / "summarise my week" with `[]`, which is correct
// for the ops pipeline but leaves the user staring at "No actionable changes."
// When this returns true and ops come back empty we run a second, prose
// answer turn so the user actually gets a reply.
function _askIsQuestionLike(q){
  if(typeof q !== 'string') return false;
  const s = q.trim();
  if(!s) return false;
  if(s.endsWith('?') || s.endsWith('？')) return true;
  // Leading-word match. Kept conservative: only words that strongly imply a
  // request for information, not a command. "Find X" stays a command path
  // because it's plausibly a write-side operation (filter/select).
  return /^(what|who|when|where|why|how|which|whose|is\b|are\b|do\b|does\b|can\b|could\b|should\b|tell\b|show\b|list\b|summari[sz]e|explain|describe|count|give|name\b)/i.test(s);
}

// Build a prose-answer prompt that runs in addition to the ops pipeline when
// the user asks a question (no write ops produced). Mirrors the same task /
// list / calendar context the ops prompt sees so the answer is grounded in
// the user's actual data — not a generic LLM hallucination.
function _askProseSystemPrompt(){
  return [
    'You are a concise on-device assistant for the user\'s task manager.',
    'Answer the user\'s question in plain English using ONLY the Context below.',
    'Rules:',
    '- 1-4 sentences, or a short bullet list (max 8 bullets) when listing items.',
    '- Never invent task names, ids, dates, or counts. If the Context is silent on something, say so.',
    '- Do not output JSON, code fences, tool calls, or any kind of operation. Plain prose only.',
    '- Refer to tasks by name (not by id) so the answer reads naturally.',
  ].join('\n');
}

/**
 * @param {string} query
 * @param {{ onToken?:(t:string)=>void, onReadRound?:(summary:object)=>void, signal?:AbortSignal }} [opts]
 * @returns {Promise<{ ok:boolean, ops:Array, rejected:Array, destructiveLevel:string, rawText:string, truncated:boolean, readRounds?:number, reason?:string }>}
 */
async function cognitaskRun(query, opts){
  opts = opts || {};
  const q = String(query || '').trim();
  if(!q) return { ok: false, ops: [], rejected: [], destructiveLevel: 'none', rawText: '', truncated: false, readRounds: 0, reason: 'EMPTY_QUERY' };
  if(typeof isGenReady !== 'function' || !isGenReady()){
    return { ok: false, ops: [], rejected: [], destructiveLevel: 'none', rawText: '', truncated: false, readRounds: 0, reason: 'GEN_NOT_READY' };
  }
  if(typeof parseOpsJson !== 'function' || typeof validateOps !== 'function' || typeof genGenerate !== 'function'){
    return { ok: false, ops: [], rejected: [], destructiveLevel: 'none', rawText: '', truncated: false, readRounds: 0, reason: 'SCHEMA_UNAVAILABLE' };
  }
  if(typeof _askBuildContext !== 'function' || typeof _askUserPrompt !== 'function' || typeof _askSystemPrompt !== 'function'){
    return { ok: false, ops: [], rejected: [], destructiveLevel: 'none', rawText: '', truncated: false, readRounds: 0, reason: 'ASK_HELPERS_MISSING' };
  }

  const contextLines = await _askBuildContext(q);
  const useNativeQwenTools = typeof isGenModelNativeQwen25Tools === 'function' && isGenModelNativeQwen25Tools()
    && typeof buildOpenAIToolsFromToolSchema === 'function';
  const cognitaskOpenAITools = useNativeQwenTools ? buildOpenAIToolsFromToolSchema() : null;

  const systemJson = _askSystemPrompt() + '\n\nIf you use read-only ops, output ONLY them first; the system will return results, then you output write ops. Do not include prose outside the JSON array.';
  const systemNativeQwen = 'You are a local task assistant. Use only the provided function tools. '
    + 'Call read tools first if you need tasks, calendar, lists, or categories. '
    + 'Use task ids that appear in the user context. Answer with tool call(s) in the required <tool_call> format; do not add other text.';
  const user = _askUserPrompt(q, contextLines);
  // Conversation context: prior user/assistant exchanges from the chat
  // sheet, sanitised + capped, so follow-up turns like "now archive those"
  // can resolve relative references against the previous answer. Each
  // entry is { user:string, assistant:string }. Failures are silently
  // ignored — best-effort threading, not a load-bearing path.
  const priorMsgs = [];
  if(opts && Array.isArray(opts.priorTurns)){
    for(const pt of opts.priorTurns){
      if(!pt) continue;
      const pu = _askStripCtrl(pt.user || '').slice(0, 600);
      const pa = _askStripCtrl(pt.assistant || '').slice(0, 600);
      if(!pu) continue;
      priorMsgs.push({ role: 'user', content: pu });
      if(pa) priorMsgs.push({ role: 'assistant', content: pa });
    }
  }
  const messages = useNativeQwenTools
    ? [ { role: 'system', content: systemNativeQwen }, ...priorMsgs, { role: 'user', content: user } ]
    : [ { role: 'system', content: systemJson },     ...priorMsgs, { role: 'user', content: user } ];

  const cfg = (typeof getGenCfg === 'function') ? getGenCfg() : { timeoutSec: 30 };
  const timeoutMs = Math.max(5000, (cfg.timeoutSec || 30) * 1000);
  const timeoutCtl = new AbortController();
  const timer = setTimeout(() => timeoutCtl.abort(), timeoutMs);
  const mergedSignal = (() => {
    const ctl = new AbortController();
    const bail = () => ctl.abort();
    if(opts.signal){
      if(opts.signal.aborted) bail();
      else opts.signal.addEventListener('abort', bail, { once: true });
    }
    timeoutCtl.signal.addEventListener('abort', bail, { once: true });
    return ctl.signal;
  })();

  let allRaw = '';
  let lastError = null;
  let readRounds = 0;
  let lastFinal = null;
  let gotParse = false;
  let cognitaskTerminalInjected = false;

  const runOnce = async (temp) => {
    let rawText = '';
    const full = await genGenerate({
      messages,
      maxTokens: 512,
      temperature: temp,
      tools: cognitaskOpenAITools || undefined,
      onToken: (t) => {
        rawText += t;
        if(typeof opts.onToken === 'function'){ try{ opts.onToken(t); }catch(e){} }
      },
      signal: mergedSignal,
    });
    if(!rawText) rawText = full || '';
    return rawText;
  };

  try{
    for(let turn = 0; turn < COGNITASK_MAX_TURNS; turn++){
      if(mergedSignal && mergedSignal.aborted) break;
      if(readRounds >= COGNITASK_MAX_READ_ROUNDS && !cognitaskTerminalInjected){
        messages.push({ role: 'user', content: 'This is your last turn — return only a JSON array of write operations or []. Do not call read-only tools.' });
        cognitaskTerminalInjected = true;
      }
      const temp = turn === 0 ? 0.2 : 0.1;
      const raw = await runOnce(temp);
      allRaw += (allRaw ? '\n' : '') + raw;
      let parsed = null;
      if(useNativeQwenTools && typeof parseQwen25ToolCallBlocks === 'function'){
        const tco = parseQwen25ToolCallBlocks(raw);
        if(tco != null) parsed = tco;
      }
      if(parsed == null){
        try{ parsed = parseOpsJson(raw); }catch(e){ lastError = e; }
      }
      if(!parsed || !Array.isArray(parsed)) continue;

      const reads = [];
      const writes = [];
      for(const op of parsed){
        if(!op || !op.name) continue;
        const nm = String(op.name).toUpperCase();
        if(_schemaReadOnly(nm)) reads.push({ name: nm, args: op.args && typeof op.args === 'object' ? op.args : {} });
        else writes.push({ name: nm, args: op.args && typeof op.args === 'object' ? op.args : {} });
      }

      if(reads.length && !writes.length){
        if(readRounds >= COGNITASK_MAX_READ_ROUNDS){
          lastFinal = [];
          gotParse = true;
          break;
        }
        const results = reads.map(r => ({ op: r.name, result: runReadOp(r) }));
        readRounds++;
        if(typeof opts.onReadRound === 'function'){ try{ opts.onReadRound({ results, readRounds }); }catch(e){} }
        messages.push({ role: 'assistant', content: raw });
        const fullJson = JSON.stringify(results);
        const wasTruncated = fullJson.length > 6000;
        const payload = wasTruncated ? (fullJson.slice(0, 6000) + ' …[TRUNCATED]') : fullJson;
        messages.push({ role: 'user', content: 'Tool result:\n' + payload + '\n\nNow return ONLY a JSON array of write operations (or [] if no changes), using task ids from context.' });
        continue;
      }

      if(writes.length){
        lastFinal = writes;
        gotParse = true;
        break;
      }
      lastFinal = parsed;
      gotParse = true;
      break;
    }
  }catch(e){
    lastError = e;
  }finally{
    clearTimeout(timer);
  }

  if(mergedSignal && mergedSignal.aborted){
    return { ok: false, ops: [], rejected: [], destructiveLevel: 'none', rawText: allRaw, truncated: false, readRounds, reason: timeoutCtl.signal.aborted ? 'TIMEOUT' : 'ABORTED' };
  }

  if(!gotParse || lastFinal == null){
    // Free-form chat fallback: if the model produced prose instead of a
    // tool-call JSON array, treat the prose as the answer rather than a
    // parse failure. Op-style queries still flow through validateOps below;
    // this only kicks in for "what's overdue?" / "summarize my week" style
    // questions that have no write operations to apply. Without it the UI
    // throws away a perfectly good answer and reports "Couldn't parse."
    const chatAnswer = _extractProseAnswer(allRaw);
    if(chatAnswer){
      if(typeof pushAskHistory === 'function') pushAskHistory(q);
      return { ok: true, ops: [], rejected: [], destructiveLevel: 'none', rawText: allRaw, truncated: false, readRounds, chatAnswer };
    }
    return { ok: false, ops: [], rejected: [], destructiveLevel: 'none', rawText: allRaw, truncated: false, readRounds, reason: 'PARSE_FAILED:' + (lastError && lastError.message ? lastError.message : 'no_ops') };
  }

  const writeOnly = lastFinal.filter(op => op && op.name && !_schemaReadOnly(String(op.name).toUpperCase()));
  if(!writeOnly.length){
    // Imperative write-retry. The ops pipeline is conservative ("return []
    // if ambiguous"); when the user clearly asked for a write — "remind me
    // to call mom tomorrow", "schedule the dentist next monday" — and the
    // first pass gave us nothing, run a second pass with a stronger
    // system prompt that REQUIRES either a write op or an explicit NOOP
    // explaining what's missing. Without this, imperatives silently
    // produce "no changes" and the user wonders if Ask is broken.
    if(_askIsImperative(q) && !_askIsQuestionLike(q)){
      try{
        const retryMsgs = [
          { role: 'system', content: _askWriteRetrySystemPrompt() },
          ...priorMsgs,
          { role: 'user',   content: _askUserPrompt(q, contextLines) },
        ];
        const retryTimeoutMs = Math.max(8000, (cfg.timeoutSec || 30) * 1000);
        const retryTimeoutCtl = new AbortController();
        const retryTimer = setTimeout(() => retryTimeoutCtl.abort(), retryTimeoutMs);
        const retrySignal = (() => {
          const ctl = new AbortController();
          const bail = () => ctl.abort();
          if(opts.signal){
            if(opts.signal.aborted) bail();
            else opts.signal.addEventListener('abort', bail, { once: true });
          }
          retryTimeoutCtl.signal.addEventListener('abort', bail, { once: true });
          return ctl.signal;
        })();
        let retryRaw = '';
        try{
          const full = await genGenerate({
            messages: retryMsgs,
            maxTokens: 384,
            temperature: 0.1,
            onToken: (t) => {
              retryRaw += t;
              if(typeof opts.onToken === 'function'){ try{ opts.onToken(t); }catch(e){} }
            },
            signal: retrySignal,
          });
          if(!retryRaw) retryRaw = full || '';
        }finally{ clearTimeout(retryTimer); }

        let retryParsed = null;
        try{ retryParsed = parseOpsJson(retryRaw); }catch(_){}
        if(Array.isArray(retryParsed)){
          // Filter out the synthetic NOOP placeholder we instructed the model
          // to emit when it's stuck. If we get one, surface its reason as a
          // chat-style explanation so the user knows what to add.
          const noop = retryParsed.find(o => o && String(o.name).toUpperCase() === 'NOOP');
          const real = retryParsed.filter(o => o && o.name && String(o.name).toUpperCase() !== 'NOOP' && !_schemaReadOnly(String(o.name).toUpperCase()));
          if(real.length){
            const ctx = (typeof _askCtx === 'function') ? _askCtx() : { tasksById: new Map(), listsById: new Map() };
            const val = validateOps(real, ctx);
            if(val.valid.length){
              if(typeof pushAskHistory === 'function') pushAskHistory(q);
              return {
                ok: true,
                ops: val.valid,
                rejected: val.rejected,
                destructiveLevel: val.destructiveLevel,
                rawText: allRaw + '\n--- write-retry ---\n' + retryRaw,
                truncated: !!val.truncated,
                readRounds,
              };
            }
          }
          if(noop){
            // Reason is the canonical field but some models drop it. Fall
            // back to a generic chat answer rather than letting the path
            // return ops:[] with no answer, which the UI renders as a
            // bare "No actionable changes" and confuses the user.
            const reason = (noop.args && typeof noop.args.reason === 'string' && noop.args.reason.trim())
              ? String(noop.args.reason).slice(0, 300)
              : '';
            const msg = reason
              ? ('I couldn\'t create that yet — ' + reason + ' Try rephrasing with the missing detail.')
              : 'I couldn\'t figure out enough detail to create that — try adding a name or due date (e.g. "remind me to call mom tomorrow at 9am").';
            if(typeof pushAskHistory === 'function') pushAskHistory(q);
            return {
              ok: true, ops: [], rejected: [], destructiveLevel: 'none',
              rawText: allRaw + '\n--- write-retry ---\n' + retryRaw,
              truncated: false, readRounds, chatAnswer: msg,
            };
          }
        }
        // Last resort prose pass: just surface what the retry model said.
        const retryProse = _extractProseAnswer(retryRaw);
        if(retryProse){
          if(typeof pushAskHistory === 'function') pushAskHistory(q);
          return { ok: true, ops: [], rejected: [], destructiveLevel: 'none', rawText: allRaw + '\n' + retryRaw, truncated: false, readRounds, chatAnswer: retryProse };
        }
      }catch(e){ /* write-retry is best-effort */ }
    }
    // The ops pipeline correctly returned [] for a non-write query, but if
    // the user actually asked a question ("what's overdue?", "summarise my
    // week") we owe them a real answer instead of "No actionable changes."
    // Run a second, prose-only pass on the same context. Best-effort —
    // failures fall through to the original empty result. Independent
    // timeout so a slow prose turn can't trip the op-pipeline timeout.
    if(_askIsQuestionLike(q)){
      try{
        const proseMsgs = [
          { role: 'system', content: _askProseSystemPrompt() },
          ...priorMsgs,
          { role: 'user',   content: _askUserPrompt(q, contextLines) },
        ];
        const proseTimeoutMs = Math.max(10000, (cfg.timeoutSec || 30) * 1000);
        const proseTimeoutCtl = new AbortController();
        const proseTimer = setTimeout(() => proseTimeoutCtl.abort(), proseTimeoutMs);
        const proseSignal = (() => {
          const ctl = new AbortController();
          const bail = () => ctl.abort();
          if(opts.signal){
            if(opts.signal.aborted) bail();
            else opts.signal.addEventListener('abort', bail, { once: true });
          }
          proseTimeoutCtl.signal.addEventListener('abort', bail, { once: true });
          return ctl.signal;
        })();
        let proseText = '';
        try{
          const full = await genGenerate({
            messages: proseMsgs,
            maxTokens: 384,
            temperature: 0.4,
            onToken: (t) => {
              proseText += t;
              if(typeof opts.onToken === 'function'){ try{ opts.onToken(t); }catch(e){} }
            },
            signal: proseSignal,
          });
          if(!proseText) proseText = full || '';
        }finally{
          clearTimeout(proseTimer);
        }
        const chatAnswer = _extractProseAnswer(proseText);
        if(chatAnswer){
          if(typeof pushAskHistory === 'function') pushAskHistory(q);
          return { ok: true, ops: [], rejected: [], destructiveLevel: 'none', rawText: allRaw + (allRaw ? '\n' : '') + proseText, truncated: false, readRounds, chatAnswer };
        }
      }catch(e){ /* prose pass is best-effort */ }
    }
    return { ok: true, ops: [], rejected: [], destructiveLevel: 'none', rawText: allRaw, truncated: false, readRounds };
  }

  const ctx = (typeof _askCtx === 'function') ? _askCtx() : { tasksById: new Map(), listsById: new Map() };
  const val = validateOps(writeOnly, ctx);
  if(typeof pushAskHistory === 'function') pushAskHistory(q);
  return {
    ok: true,
    ops: val.valid,
    rejected: val.rejected,
    destructiveLevel: val.destructiveLevel,
    rawText: allRaw,
    truncated: !!val.truncated,
    readRounds,
  };
}

/**
 * @param {string} query
 * @param {{ onToken?:(t:string)=>void, onReadRound?:(o:object)=>void, signal?:AbortSignal }} [opts]
 */
async function askRun(query, opts){
  return cognitaskRun(query, opts);
}

if(typeof window !== 'undefined'){
  window.askRun = askRun;
  window.cognitaskRun = cognitaskRun;
  window.runReadOp = runReadOp;
  window.ASK_CONTEXT_MAX_TASKS = ASK_CONTEXT_MAX_TASKS;
  window._askBuildContext = _askBuildContext;
  window._askUserPrompt = _askUserPrompt;
  window._askSystemPrompt = _askSystemPrompt;
  window._askProseSystemPrompt = _askProseSystemPrompt;
  window._askWriteRetrySystemPrompt = _askWriteRetrySystemPrompt;
  window._askIsQuestionLike = _askIsQuestionLike;
  window._askIsImperative = _askIsImperative;
  window._askCtx = _askCtx;
  window._askCalendarBlock = _askCalendarBlock;
}
