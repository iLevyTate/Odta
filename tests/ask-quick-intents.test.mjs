/**
 * Instant intents in js/ask.js (askQuickIntent): creation requests and the
 * common lookups are answered from the data before any model runs. On a
 * phone the 135M model needs ~30 s to read the ops prompt and still answers
 * "add a task to buy milk tomorrow" with a loop; the quick-add parser gets it
 * right in a millisecond. These pin the contract: which phrasings are
 * handled, that creation goes through validateOps like any op, that quickOnly
 * misses report GEN_NOT_READY without touching the generator, and that
 * everything else still reaches the model.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaSrc = readFileSync(join(root, 'js', 'tool-schema.js'), 'utf8');
const askSrc    = readFileSync(join(root, 'js', 'ask.js'), 'utf8');

const TODAY = '2026-09-10';

/** Minimal stand-in for tasks.js parseQuickAdd / nlparse.js parseQuickAddAsync. */
function stubParseQuickAdd(raw) {
  let text = String(raw);
  const props = {};
  const pr = text.match(/\s@(urgent|high|normal|low)\b/i);
  if (pr) { props.priority = pr[1].toLowerCase(); text = text.replace(pr[0], ''); }
  const tags = []; text = text.replace(/\s#([^\s#]+)/g, (_, t) => { tags.push(t); return ''; });
  if (tags.length) props.tags = tags;
  if (/\btomorrow\b/i.test(text)) { props.dueDate = '2026-09-11'; text = text.replace(/\s*\btomorrow\b/i, ''); }
  const at = text.match(/\s+at\s+(\d{1,2})(am|pm)\b/i);
  if (at) { const h = (Number(at[1]) % 12) + (at[2].toLowerCase() === 'pm' ? 12 : 0); props.remindAt = (props.dueDate || TODAY) + 'T' + String(h).padStart(2, '0') + ':00'; text = text.replace(at[0], ''); }
  return { name: text.trim(), props };
}

function mkSandbox({ tasks = [], lists = [], genReady = true, withParser = true } = {}) {
  const win = {};
  const calls = [];
  const ctx = {
    window: win, console, tasks, lists,
    todayISO: () => TODAY,
    isIntelReady: () => true,
    embedText: async () => new Float32Array(8),
    semanticSearch: async () => [],
    isGenReady: () => genReady,
    pushAskHistory: () => {},
    getGenCfg: () => ({ timeoutSec: 30 }),
    getUpcomingEvents: () => [],
    getActiveCategories: () => [],
    intelLoad: async () => {},
    findTask: (id) => tasks.find((t) => t.id === id) || null,
    genGenerate: async (o) => { calls.push(o); return '[]'; },
  };
  if (withParser) {
    ctx.parseQuickAdd = stubParseQuickAdd;
    ctx.parseQuickAddAsync = async (raw) => stubParseQuickAdd(raw);
  }
  new Function(...Object.keys(ctx), schemaSrc)(...Object.values(ctx));
  ctx.TOOL_SCHEMA = win.TOOL_SCHEMA;
  ctx.validateOps = win.validateOps;
  ctx.parseOpsJson = win.parseOpsJson;
  ctx.normalizeProposedOps = win.normalizeProposedOps;
  ctx.toolSchemaPromptBlock = win.toolSchemaPromptBlock;
  new Function(...Object.keys(ctx), askSrc)(...Object.values(ctx));
  return { win, calls };
}

const TASKS = [
  { id: 1, name: 'Pay electric bill', status: 'open', priority: 'urgent', dueDate: '2026-09-09', archived: false, starred: true, lastModified: 3 },
  { id: 2, name: 'Buy milk',          status: 'open', priority: 'normal', dueDate: '2026-09-10', archived: false, lastModified: 2 },
  { id: 3, name: 'Renew passport',    status: 'open', priority: 'high',   dueDate: '2026-09-14', archived: false, lastModified: 1 },
  { id: 4, name: 'Old done thing',    status: 'done', priority: 'low',    dueDate: '2026-08-01', archived: false, lastModified: 0 },
  { id: 5, name: 'Archived late',     status: 'open', priority: 'low',    dueDate: '2026-01-01', archived: true, lastModified: 0 },
];

test('quick intent: "add a task …" becomes a validated CREATE_TASK without calling the model', async () => {
  const { win, calls } = mkSandbox({ tasks: TASKS });
  const res = await win.askRun('add a task to buy milk tomorrow @high #shopping', {});
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(calls.length, 0, 'no generation');
  assert.equal(res.quick, 'create');
  assert.equal(res.ops.length, 1);
  assert.equal(res.ops[0].name, 'CREATE_TASK');
  assert.equal(res.ops[0].args.name, 'Buy milk');
  assert.equal(res.ops[0].args.dueDate, '2026-09-11');
  assert.equal(res.ops[0].args.priority, 'high');
  assert.deepEqual(res.ops[0].args.tags, ['shopping']);
});

test('quick intent: "remind me to … tomorrow at 9am" carries the reminder', async () => {
  const { win, calls } = mkSandbox({ tasks: TASKS });
  const res = await win.askRun('Remind me to call mom tomorrow at 9am', {});
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(calls.length, 0);
  assert.equal(res.ops[0].args.name, 'Call mom');
  assert.equal(res.ops[0].args.dueDate, '2026-09-11');
  assert.equal(res.ops[0].args.remindAt, '2026-09-11T09:00');
});

test('quick intent: a compound creation ("… and then mark …") is left to the model', async () => {
  const { win, calls } = mkSandbox({ tasks: TASKS });
  const res = await win.askRun('add a task to buy milk and then mark the electric bill done', {});
  assert.ok(res.ok);
  assert.ok(calls.length >= 1, 'the model was consulted');
  assert.notEqual(res.quick, 'create');
});

test('quick intent: overdue / today / tomorrow / this week / how many / starred are answered from the data', async () => {
  const { win, calls } = mkSandbox({ tasks: TASKS });
  const ask = (q) => win.askRun(q, {});
  let r = await ask('what is overdue?');
  assert.equal(r.quick, 'lookup');
  assert.match(r.chatAnswer, /1 task overdue/);
  assert.match(r.chatAnswer, /Pay electric bill/);
  assert.ok(!/Archived late|Old done thing/.test(r.chatAnswer), 'archived and done tasks are not overdue');
  r = await ask("what's due today?");
  assert.match(r.chatAnswer, /1 task due today[\s\S]*Buy milk/);
  r = await ask('anything due tomorrow?');
  assert.equal(r.chatAnswer, 'Nothing is due tomorrow.');
  r = await ask('what is due this week?');
  assert.match(r.chatAnswer, /2 tasks due in the next 7 days/);
  r = await ask('how many tasks do I have?');
  assert.match(r.chatAnswer, /3 open tasks, 1 task done\./);
  r = await ask('which tasks are starred?');
  assert.match(r.chatAnswer, /1 starred task[\s\S]*Pay electric bill/);
  assert.equal(calls.length, 0, 'none of these touched the model');
});

test('quick intent: a lookup that also asks for an edit goes to the model', async () => {
  const { win, calls } = mkSandbox({ tasks: TASKS });
  await win.askRun('what is overdue? mark it all done', {});
  assert.ok(calls.length >= 1);
});

test('quickOnly: a miss reports GEN_NOT_READY without running the generator; a hit works with no model', async () => {
  const { win, calls } = mkSandbox({ tasks: TASKS, genReady: false });
  const miss = await win.askRun('rewrite my week so I finish the report first', { quickOnly: true });
  assert.equal(miss.ok, false);
  assert.equal(miss.reason, 'GEN_NOT_READY');
  const hit = await win.askRun('what is overdue?', { quickOnly: true });
  assert.ok(hit.ok && /Pay electric bill/.test(hit.chatAnswer));
  const create = await win.askRun('add a task to renew the car insurance', { quickOnly: true });
  assert.ok(create.ok && create.ops[0].name === 'CREATE_TASK' && create.ops[0].args.name === 'Renew the car insurance');
  assert.equal(calls.length, 0);
});

test('quick intent: without the quick-add parser present, creation falls through to the model', async () => {
  const { win, calls } = mkSandbox({ tasks: TASKS, withParser: false });
  await win.askRun('add a task to buy milk', {});
  assert.ok(calls.length >= 1, 'no parser → model path (keeps the older sandboxes honest)');
});
