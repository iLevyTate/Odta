/**
 * Ask pipeline recovery paths (js/ask.js) — the class of failures behind the
 * user-visible "Couldn't parse a valid plan. Try rephrasing." dead-end:
 *
 *   - a model reply cut off by max_new_tokens still yields the ops it managed
 *     to finish;
 *   - an unparseable reply earns ONE corrective turn that quotes the failure
 *     (instead of re-sending the identical prompt four times);
 *   - a command whose ops turns collapse entirely falls through to the
 *     write-only retry rather than a parse error;
 *   - QUERY_TASKS can express "overdue" so "clean up overdue tasks" has a
 *     tool path;
 *   - structured-output turns decode greedily (temperature 0).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaSrc = readFileSync(join(root, 'js', 'tool-schema.js'), 'utf8');
const askSrc    = readFileSync(join(root, 'js', 'ask.js'), 'utf8');

const TODAY = '2026-09-06';

/** Sandbox with a scripted generator: `reply(callIndex, messages)` → text. */
function mkSandbox({ tasks = [], lists = [], reply } = {}) {
  const win = {};
  const calls = [];
  const ctx = {
    window: win,
    console,
    tasks,
    lists,
    todayISO: () => TODAY,
    isIntelReady: () => true,
    embedText: async () => new Float32Array(8),
    semanticSearch: async () => [],
    isGenReady: () => true,
    pushAskHistory: () => {},
    getGenCfg: () => ({ timeoutSec: 30 }),
    getUpcomingEvents: () => [],
    getActiveCategories: () => [],
    intelLoad: async () => {},
    findTask: (id) => tasks.find((t) => t.id === id) || null,
    genGenerate: async (o) => {
      calls.push(o);
      const text = reply(calls.length, o.messages, o);
      if (o.onToken) for (const c of text) o.onToken(c);
      return text;
    },
  };
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
  { id: 1, name: 'Pay electric bill', status: 'open', priority: 'normal', dueDate: '2026-08-30', archived: false, lastModified: 3 },
  { id: 2, name: 'Buy milk',          status: 'open', priority: 'normal', dueDate: '2026-09-10', archived: false, lastModified: 2 },
  { id: 3, name: 'Renew passport',    status: 'open', priority: 'high',   dueDate: '2026-09-01', archived: false, lastModified: 1 },
  { id: 4, name: 'Old done thing',    status: 'done', priority: 'low',    dueDate: '2026-08-01', archived: false, lastModified: 0 },
];

test('askRun: reply truncated mid-array still applies the completed ops', async () => {
  const cut = '[\n{"name":"RESCHEDULE","args":{"id":1,"dueDate":"' + TODAY + '"}},\n{"name":"RESCHEDULE","args":{"id":3,"dueDate":"' + TODAY + '"}},\n{"name":"RESCHEDULE","args":{"id":2,"dueDa';
  const { win, calls } = mkSandbox({ tasks: TASKS, reply: () => cut });
  const res = await win.askRun('reschedule everything to today', {});
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.ops.length, 2);
  assert.deepEqual(res.ops.map((o) => o.args.id), [1, 3]);
  assert.equal(calls.length, 1, 'salvaged ops must not trigger a retry');
});

test('askRun: an unparseable first reply gets exactly one corrective turn that quotes the failure', async () => {
  const { win, calls } = mkSandbox({
    tasks: TASKS,
    reply: (n) => (n === 1 ? 'Here you go: {name: MARK_DONE' : '[{"name":"MARK_DONE","args":{"id":1}}]'),
  });
  const res = await win.askRun('mark the electric bill done', {});
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.ops.length, 1);
  assert.equal(res.ops[0].name, 'MARK_DONE');
  assert.equal(calls.length, 2);
  const msgs = calls[1].messages;
  const last = msgs[msgs.length - 1];
  assert.equal(last.role, 'user');
  assert.match(last.content, /not a valid JSON array/i);
  assert.equal(msgs[msgs.length - 2].role, 'assistant', 'the broken reply is echoed back so the model can see what it did');
});

test('askRun: two unparseable ops turns on a command fall through to the write-only retry, never PARSE_FAILED', async () => {
  const { win, calls } = mkSandbox({
    tasks: TASKS,
    reply: (n, messages) => {
      const sys = messages[0].content;
      if (/write-only task assistant/i.test(sys)) return '[{"name":"RESCHEDULE","args":{"id":1,"dueDate":"' + TODAY + '"}}]';
      return '[,';
    },
  });
  const res = await win.askRun('Clean up overdue tasks', {});
  assert.ok(res.ok, JSON.stringify(res));
  assert.notEqual(String(res.reason || ''), 'PARSE_FAILED');
  assert.equal(res.ops.length, 1);
  assert.equal(res.ops[0].args.id, 1);
  assert.equal(calls.length, 3, '2 ops turns (initial + corrective) then the write retry');
});

test('askRun: unparseable turns on a non-command still get a grounded prose answer instead of PARSE_FAILED', async () => {
  const { win } = mkSandbox({
    tasks: TASKS,
    reply: (n, messages) => (/concise on-device assistant/i.test(messages[0].content) ? 'Two tasks are overdue: the electric bill and the passport.' : '[,'),
  });
  const res = await win.askRun('overdue stuff', {});
  assert.ok(res.ok, JSON.stringify(res));
  assert.match(res.chatAnswer || '', /electric bill/);
});

test('askRun: broken JSON fragments are never surfaced to the user as a prose "answer"', async () => {
  const { win } = mkSandbox({
    tasks: TASKS,
    reply: (n, messages) => (/concise on-device assistant/i.test(messages[0].content)
      ? 'Nothing is overdue right now.'
      : '[{"name":"MARK_DONE", "args": {"id": 1,\n"status": open}}\n{"name"'),
  });
  const res = await win.askRun('what is overdue?', {});
  assert.ok(res.ok, JSON.stringify(res));
  assert.ok(res.chatAnswer && !/\{|"name"/.test(res.chatAnswer), 'answer must be prose, got: ' + res.chatAnswer);
});

test('askRun: structured-output turns decode greedily; the corrective retry adds a little temperature', async () => {
  const { win, calls } = mkSandbox({ tasks: TASKS, reply: (n) => (n === 1 ? '???' : '[]') });
  await win.askRun('nevermind', {});
  assert.equal(calls[0].temperature, 0);
  assert.ok(calls[1].temperature > 0 && calls[1].temperature <= 0.3);
});

test('runReadOp QUERY_TASKS: overdue / dueBefore / dueAfter / status / priority / tag filters', () => {
  const tasks = TASKS.concat([{ id: 5, name: 'Tagged', status: 'open', priority: 'urgent', tags: ['home'], archived: false }]);
  const { win } = mkSandbox({ tasks, reply: () => '[]' });
  const overdue = win.runReadOp({ name: 'QUERY_TASKS', args: { overdue: true } });
  assert.deepEqual(overdue.tasks.map((t) => t.id), [1, 3], 'done tasks are not overdue');
  assert.ok(overdue.tasks.every((t) => t.overdue === true));
  const before = win.runReadOp({ name: 'QUERY_TASKS', args: { dueBefore: '2026-09-01' } });
  assert.deepEqual(before.tasks.map((t) => t.id), [1, 3]);
  const after = win.runReadOp({ name: 'QUERY_TASKS', args: { dueAfter: '2026-09-05' } });
  assert.deepEqual(after.tasks.map((t) => t.id), [2]);
  const pri = win.runReadOp({ name: 'QUERY_TASKS', args: { priority: 'high' } });
  assert.deepEqual(pri.tasks.map((t) => t.id), [3]);
  const tag = win.runReadOp({ name: 'QUERY_TASKS', args: { tag: '#home' } });
  assert.deepEqual(tag.tasks.map((t) => t.id), [5]);
  const done = win.runReadOp({ name: 'QUERY_TASKS', args: { status: 'done' } });
  assert.deepEqual(done.tasks.map((t) => t.id), [4]);
  // Relative words work here too — the model copies "today" straight in.
  const rel = win.runReadOp({ name: 'QUERY_TASKS', args: { dueBefore: 'today' } });
  assert.ok(rel.tasks.length >= 1);
});

test('askRun: "clean up overdue tasks" reads with overdue:true, then writes against the returned ids', async () => {
  const { win, calls } = mkSandbox({
    tasks: TASKS,
    reply: (n, messages) => {
      if (n === 1) return '[{"name":"QUERY_TASKS","args":{"overdue":true}}]';
      const toolMsg = messages.find((m) => /^Tool result:/.test(m.content));
      assert.ok(toolMsg, 'tool result must be threaded back');
      const ids = JSON.parse(toolMsg.content.replace(/^Tool result:\n/, '').replace(/\n\nNow return[\s\S]*$/, ''))[0].result.tasks.map((t) => t.id);
      return JSON.stringify(ids.map((id) => ({ name: 'RESCHEDULE', args: { id, dueDate: TODAY } })));
    },
  });
  const res = await win.askRun('clean up my overdue tasks', {});
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.readRounds, 1);
  assert.deepEqual(res.ops.map((o) => o.args.id), [1, 3]);
  assert.equal(calls.length, 2);
});

test('prompt: examples and the user prompt carry concrete ISO dates, never <placeholder> tokens', () => {
  const { win } = mkSandbox({ tasks: TASKS, reply: () => '[]' });
  const sys = win._askSystemPrompt();
  assert.ok(!/<tomorrow>|<friday>|<next monday>|<\+7d>/.test(sys), 'placeholders leaked: ' + sys.slice(0, 200));
  assert.ok(sys.includes('2026-09-07'), 'tomorrow must be spelled out');
  const user = win._askUserPrompt('x', []);
  assert.match(user, /Today: 2026-09-06 \(Sunday\)/);
  assert.match(user, /tomorrow: 2026-09-07/);
  assert.match(user, /next Monday: 2026-09-07/);
  assert.match(user, /next Friday: 2026-09-11/);
});

test('_askIsImperative: covers clean-up verbs and politeness prefixes; questions stay questions', () => {
  const { win } = mkSandbox({ tasks: [], reply: () => '[]' });
  for (const q of ['Clean up overdue tasks', 'please add milk to my list', 'Can you make task 3 urgent?', 'organise my inbox', 'clear out old tasks', 'Could you reschedule the dentist']) {
    assert.ok(win._askIsImperative(q), q + ' should be imperative');
  }
  for (const q of ['what is overdue?', 'show me my tasks', 'Help me figure out what to do', 'summarize my week']) {
    assert.ok(!win._askIsImperative(q), q + ' should not be imperative');
  }
});

test('_askIdleAbort: streaming progress keeps a slow generation alive; silence aborts it', async () => {
  const { win } = mkSandbox({ tasks: [], reply: () => '[]' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Tokens every 10 ms for well past the 40 ms idle limit → never aborts.
  const live = new AbortController();
  const w1 = win._askIdleAbort(40, live);
  for (let i = 0; i < 12; i++) { await sleep(10); w1.touch(); }
  assert.equal(live.signal.aborted, false, 'progress must not be cut off at the old wall-clock limit');
  w1.clear();
  // First-token window is 2× idle (prefill), then a silent stream aborts.
  const stuck = new AbortController();
  const w2 = win._askIdleAbort(40, stuck);
  await sleep(50);
  assert.equal(stuck.signal.aborted, false, 'prefill gets 2× the idle budget');
  await sleep(60);
  assert.equal(stuck.signal.aborted, true, 'no tokens for the idle budget → abort');
  w2.clear();
  // clear() disarms everything.
  const cleared = new AbortController();
  const w3 = win._askIdleAbort(20, cleared);
  w3.clear();
  await sleep(80);
  assert.equal(cleared.signal.aborted, false);
});
