/**
 * Quick-add #tags must accept hyphens and dots (not only \w+).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tasksSrc = readFileSync(join(root, 'js', 'tasks.js'), 'utf8').replace(/\r\n/g, '\n');

test('parseQuickAdd tag regex allows hyphens', () => {
  const idx = tasksSrc.indexOf('function parseQuickAdd');
  assert.ok(idx > 0);
  const body = tasksSrc.slice(idx, idx + 1200);
  assert.ok(body.includes('tagRe=/\\s#([^\\s#]+)/g'), 'tag capture must allow hyphens (not \\w-only)');
  assert.ok(body.includes("text.replace(/\\s#[^\\s#]+/g,'')"), 'strip pass must match the same charset');
  assert.ok(!body.includes('tagRe=/\\s#(\\w+)/g'), 'must not use legacy \\w-only tag pattern');
});
