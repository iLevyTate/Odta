/**
 * parseOpsJson / normalizeProposedOp tolerance (js/tool-schema.js).
 *
 * Small on-device models are unreliable JSON emitters. Each case below is a
 * real-world reply shape that used to throw and surface as "Couldn't parse a
 * valid plan" even though the ops were right there in the text. The parser
 * must recover the ops the model actually emitted — and never invent any.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'tool-schema.js'), 'utf8');

function loadSchema() {
  const win = {};
  new Function('window', src)(win);
  return win;
}

test('parseOpsJson: truncated pretty-printed array salvages every complete op before the cut', () => {
  const { parseOpsJson } = loadSchema();
  const cut = '[\n  {\n    "name": "MARK_DONE",\n    "args": { "id": 12 }\n  },\n  {\n    "name": "RESCHEDULE",\n    "args": { "id": 7, "dueDate": "2026-09-08" }\n  },\n  {\n    "name": "MARK_DONE",\n    "args": { "id": 1';
  const ops = parseOpsJson(cut);
  assert.deepEqual(ops, [
    { name: 'MARK_DONE', args: { id: 12 } },
    { name: 'RESCHEDULE', args: { id: 7, dueDate: '2026-09-08' } },
  ]);
});

test('parseOpsJson: a bare op object is wrapped into an array', () => {
  const { parseOpsJson } = loadSchema();
  assert.deepEqual(parseOpsJson('{"name":"MARK_DONE","args":{"id":3}}'), [{ name: 'MARK_DONE', args: { id: 3 } }]);
});

test('parseOpsJson: {"ops":[…]} / {"operations":[…]} wrappers are unwrapped', () => {
  const { parseOpsJson } = loadSchema();
  assert.deepEqual(parseOpsJson('{"ops":[{"name":"MARK_DONE","args":{"id":3}}]}'), [{ name: 'MARK_DONE', args: { id: 3 } }]);
  assert.deepEqual(parseOpsJson('{"operations":[{"name":"REOPEN","args":{"id":4}}]}'), [{ name: 'REOPEN', args: { id: 4 } }]);
});

test('parseOpsJson: Python-style literals and trailing commas are repaired', () => {
  const { parseOpsJson } = loadSchema();
  assert.deepEqual(parseOpsJson("[{'name': 'UPDATE_TASK', 'args': {'id': 3, 'starred': True}}]"),
    [{ name: 'UPDATE_TASK', args: { id: 3, starred: true } }]);
  assert.deepEqual(parseOpsJson('[{"name":"MARK_DONE","args":{"id":3,},},]'), [{ name: 'MARK_DONE', args: { id: 3 } }]);
});

test('parseOpsJson: <tool_call> blocks are parsed for any model, "arguments" aliased to args', () => {
  const { parseOpsJson } = loadSchema();
  const ops = parseOpsJson('<tool_call>\n{"name": "QUERY_TASKS", "arguments": {"overdue": true}}\n</tool_call>');
  assert.deepEqual(ops, [{ name: 'QUERY_TASKS', args: { overdue: true } }]);
});

test('parseOpsJson: fenced JSON inside chatty prose is preferred over the prose', () => {
  const { parseOpsJson } = loadSchema();
  const ops = parseOpsJson('Sure! Here is the plan:\n```json\n[{"name":"mark done","id":3}]\n```\nLet me know if that works.');
  // lower-case name with a space → MARK_DONE; flattened id → args.id
  assert.deepEqual(ops, [{ name: 'MARK_DONE', args: { id: 3 } }]);
});

test('parseOpsJson: OpenAI-style function-call shape with stringified arguments', () => {
  const { parseOpsJson } = loadSchema();
  const ops = parseOpsJson('[{"type":"function","function":{"name":"CREATE_TASK","arguments":"{\\"name\\":\\"buy milk\\"}"}}]');
  assert.deepEqual(ops, [{ name: 'CREATE_TASK', args: { name: 'buy milk' } }]);
});

test('parseOpsJson: still throws when the text has no ops at all', () => {
  const { parseOpsJson } = loadSchema();
  assert.throws(() => parseOpsJson('Sorry, I cannot help with that.'), /NO_ARRAY/);
  assert.throws(() => parseOpsJson('[,'), /UNBALANCED_ARRAY/);
  assert.throws(() => parseOpsJson(42), /NOT_STRING/);
  assert.deepEqual(parseOpsJson('[]'), []);
});

test('normalizeProposedOp: never invents args — a bare {"name":…} stays args-less so validateOps rejects it', () => {
  const { normalizeProposedOp, validateOps } = loadSchema();
  const op = normalizeProposedOp({ name: 'CREATE_TASK' });
  assert.equal(op.args, undefined);
  const r = validateOps([op], { tasksById: new Map(), listsById: new Map() });
  assert.equal(r.valid.length, 0);
  assert.match(r.rejected[0].reason, /MISSING_OR_INVALID_ARGS/);
});

test('normalizeProposedOp: top-level extras fold into args without overriding explicit args', () => {
  const { normalizeProposedOp } = loadSchema();
  assert.deepEqual(normalizeProposedOp({ name: 'UPDATE_TASK', id: 3, args: { priority: 'high' } }),
    { name: 'UPDATE_TASK', args: { priority: 'high', id: 3 } });
  assert.deepEqual(normalizeProposedOp({ op: 'UPDATE_TASK', args: { id: 9 }, id: 3 }).args.id, 9);
  // Non-objects pass through untouched (validateOps reports NOT_AN_OBJECT).
  assert.equal(normalizeProposedOp('x'), 'x');
  assert.equal(normalizeProposedOp(null), null);
});

test('date coercion: relative words and copied placeholders resolve to real local dates', () => {
  const { validateOps, naturalDateISO } = loadSchema();
  const ctx = { tasksById: new Map([[2, { id: 2 }]]), listsById: new Map() };
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const plus = (n) => { const d = new Date(now); d.setDate(d.getDate() + n); return iso(d); };
  const r = validateOps([
    { name: 'RESCHEDULE', args: { id: 2, dueDate: '<tomorrow>' } },
    { name: 'UPDATE_TASK', args: { id: 2, hiddenUntil: '+7d' } },
    { name: 'SET_REMINDER', args: { id: 2, remindAt: 'tomorrow at 9am' } },
    { name: 'SET_REMINDER', args: { id: 2, remindAt: '<tomorrow>T17:30' } },
    { name: 'RESCHEDULE', args: { id: 2, dueDate: 'in 2 weeks' } },
  ], ctx);
  assert.equal(r.valid.length, 5, JSON.stringify(r.rejected));
  assert.equal(r.valid[0].args.dueDate, plus(1));
  assert.equal(r.valid[1].args.hiddenUntil, plus(7));
  assert.equal(r.valid[2].args.remindAt, plus(1) + 'T09:00');
  assert.equal(r.valid[3].args.remindAt, plus(1) + 'T17:30');
  assert.equal(r.valid[4].args.dueDate, plus(14));
  // Weekday names resolve to the *upcoming* one (never today).
  const fri = naturalDateISO('next friday', new Date('2026-09-06T12:00:00')); // a Sunday
  assert.equal(fri, '2026-09-11');
  assert.equal(naturalDateISO('sunday', new Date('2026-09-06T12:00:00')), '2026-09-13');
  // Locale numeric formats stay rejected — day/month order is ambiguous.
  assert.equal(naturalDateISO('12/31/2026'), null);
  assert.equal(naturalDateISO('someday'), null);
});

test('QUERY_TASKS schema accepts structured filters and coerces them', () => {
  const { validateOps, TOOL_SCHEMA } = loadSchema();
  for (const k of ['overdue', 'dueBefore', 'dueAfter', 'status', 'priority', 'tag', 'listId', 'includeDone', 'includeArchived']) {
    assert.ok(TOOL_SCHEMA.QUERY_TASKS.optional.includes(k), 'QUERY_TASKS must advertise ' + k);
  }
  const r = validateOps([{ name: 'QUERY_TASKS', args: { overdue: 'true', dueBefore: '2026-01-05', limit: '5', status: 'OPEN', includeDone: 1 } }],
    { tasksById: new Map(), listsById: new Map() });
  assert.equal(r.valid.length, 1);
  assert.deepEqual(r.valid[0].args, { overdue: true, dueBefore: '2026-01-05', status: 'open', includeDone: true, limit: 5 });
});
