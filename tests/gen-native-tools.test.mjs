/**
 * Qwen2.5 native <tool_call> parsing and isGenModelNativeQwen25Tools (js/gen.js).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadQwenToolHelpers(modelId) {
  const src = readFileSync(join(root, 'js', 'gen.js'), 'utf8');
  const start = src.indexOf('function parseQwen25ToolCallBlocks');
  const end = src.indexOf('function _stripCodeFences', start);
  assert.ok(start >= 0 && end > start, 'slice gen.js parseQwen25 / isGenModelNativeQwen25Tools');
  const slice = src.slice(start, end);
  const mod = new Function('modelId', `
    let _genModelId = modelId;
    ${slice}
    return { parseQwen25ToolCallBlocks, isGenModelNativeQwen25Tools };
  `);
  return mod(modelId);
}

test('parseQwen25ToolCallBlocks: null when no tool_call tags', () => {
  const { parseQwen25ToolCallBlocks } = loadQwenToolHelpers(null);
  assert.strictEqual(parseQwen25ToolCallBlocks('[{"name":"MARK_DONE","args":{"id":1}}]'), null);
});

test('parseQwen25ToolCallBlocks: single object with arguments', () => {
  const { parseQwen25ToolCallBlocks } = loadQwenToolHelpers(null);
  const raw = 'Hi\n<tool_call>\n{"name": "query_tasks", "arguments": {"filter": "milk", "limit": 3}}\n</tool_call>\n';
  const o = parseQwen25ToolCallBlocks(raw);
  assert.equal(o.length, 1);
  assert.equal(o[0].name, 'QUERY_TASKS');
  assert.deepEqual(o[0].args, { filter: 'milk', limit: 3 });
});

test('parseQwen25ToolCallBlocks: arguments as JSON string', () => {
  const { parseQwen25ToolCallBlocks } = loadQwenToolHelpers(null);
  const raw = '<tool_call>{"name":"get_task_detail","arguments":"{\\"id\\":5}"}</tool_call>';
  const o = parseQwen25ToolCallBlocks(raw);
  assert.equal(o[0].name, 'GET_TASK_DETAIL');
  assert.equal(o[0].args.id, 5);
});

test('parseQwen25ToolCallBlocks: broken inner JSON returns null (fallback to parseOpsJson)', () => {
  const { parseQwen25ToolCallBlocks } = loadQwenToolHelpers(null);
  const raw = '<tool_call>{broken json}</tool_call>';
  assert.strictEqual(parseQwen25ToolCallBlocks(raw), null);
});

test('parseQwen25ToolCallBlocks: </tool_call> inside JSON value breaks extract → null (regex hazard)', () => {
  const { parseQwen25ToolCallBlocks } = loadQwenToolHelpers(null);
  const raw = '<tool_call>{"name":"x","arguments":{"text":"a</tool_call>b"}}</tool_call>';
  const o = parseQwen25ToolCallBlocks(raw);
  assert.strictEqual(o, null);
});

test('isGenModelNativeQwen25Tools matches Qwen2.5 * Instruct slugs', () => {
  const a = loadQwenToolHelpers('onnx-community/Qwen2.5-1.5B-Instruct');
  assert.equal(a.isGenModelNativeQwen25Tools(), true);
  const c = loadQwenToolHelpers('onnx-community/Qwen2.5-0.5B-Instruct');
  assert.equal(c.isGenModelNativeQwen25Tools(), true);
  const b = loadQwenToolHelpers('HuggingFaceTB/SmolLM2-360M-Instruct');
  assert.equal(b.isGenModelNativeQwen25Tools(), false);
});

test('buildOpenAIToolsFromToolSchema lists every op', () => {
  const schemaSrc = readFileSync(join(root, 'js', 'tool-schema.js'), 'utf8');
  const win = {};
  new Function('window', schemaSrc)(win);
  const { buildOpenAIToolsFromToolSchema, TOOL_SCHEMA } = win;
  const tools = buildOpenAIToolsFromToolSchema();
  assert.equal(tools.length, Object.keys(TOOL_SCHEMA).length);
  assert.equal(tools[0].type, 'function');
  assert.ok(tools[0].function.parameters.properties);
});
