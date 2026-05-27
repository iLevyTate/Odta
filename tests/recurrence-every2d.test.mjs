import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tasksSrc = readFileSync(join(root, 'js', 'tasks.js'), 'utf8');
const storageSrc = readFileSync(join(root, 'js', 'storage.js'), 'utf8');

test('every2d recurrence is wired through parser, advance, and schema', () => {
  assert.match(tasksSrc, /every2d/, 'parseQuickAdd should recognize every2d');
  assert.match(tasksSrc, /recurType==='every2d'/, 'advanceRecurringDate should handle every2d');
  assert.match(storageSrc, /'every2d'/, 'schema repair must allow every2d');
});
