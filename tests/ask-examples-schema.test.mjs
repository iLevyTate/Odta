/**
 * The few-shot examples in _askSystemPrompt (js/ask.js) must only use
 * op names and argument keys that TOOL_SCHEMA actually accepts.
 *
 * validateOps silently drops unknown args, so an example that teaches the
 * model a nonexistent key trains it to emit ops that quietly do nothing —
 * e.g. the old `CREATE_TASK{listName}` / `UPDATE_TASK{listName}` examples
 * made "add X to my Work list" land in the wrong list and "move X to
 * Personal" a no-op (the real path is CREATE_TASK{listId} / CHANGE_LIST).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const askSrc = readFileSync(join(root, 'js', 'ask.js'), 'utf8');
const schemaSrc = readFileSync(join(root, 'js', 'tool-schema.js'), 'utf8');

function loadSchema() {
  const win = {};
  new Function('window', schemaSrc)(win);
  return win.TOOL_SCHEMA;
}

// Every {"name":"OP","args":{...}} literal in ask.js's prompt strings. The
// example args objects are flat (arrays but no nested objects), so a lazy
// match up to `}}` captures the full args body.
function extractExampleOps(src) {
  const out = [];
  for (const m of src.matchAll(/\{"name":"([A-Z_]+)","args":\{(.*?)\}\}/g)) {
    if (m[1] === 'OP_NAME') continue; // the generic shape rule, not an example
    if (m[1] === 'NOOP') continue; // synthetic write-retry placeholder, filtered before validateOps
    const keys = [...m[2].matchAll(/"([A-Za-z_]+)"\s*:/g)].map((k) => k[1]);
    out.push({ name: m[1], keys });
  }
  return out;
}

test('ask.js example ops exist in TOOL_SCHEMA with only accepted arg keys', () => {
  const schema = loadSchema();
  const ops = extractExampleOps(askSrc);
  assert.ok(ops.length >= 5, `expected several example ops, found ${ops.length}`);
  for (const op of ops) {
    const entry = schema[op.name];
    assert.ok(entry, `example op ${op.name} is not in TOOL_SCHEMA`);
    const accepted = new Set([...(entry.required || []), ...(entry.optional || [])]);
    for (const k of op.keys) {
      assert.ok(accepted.has(k), `${op.name} example uses arg "${k}" which the schema drops`);
    }
  }
});

test('ask.js never teaches the nonexistent listName argument', () => {
  assert.ok(!askSrc.includes('listName'), 'listName is not a schema arg — use listId / CHANGE_LIST');
});
