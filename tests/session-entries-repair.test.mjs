/**
 * sessionEntries must survive _repairTask / saveState — previously they were
 * shoved into _ext and the detail modal only showed one new session after reload.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const storageSrc = readFileSync(join(root, 'js', 'storage.js'), 'utf8').replace(/\r\n/g, '\n');

test('_repairTask declares sessionEntries as a first-class field', () => {
  const idx = storageSrc.indexOf('function _repairTask');
  assert.ok(idx > 0);
  const end = storageSrc.indexOf('\nfunction migrateState', idx);
  const body = storageSrc.slice(idx, end > idx ? end : idx + 12000);
  assert.match(body, /sessionEntries:/, 'must repair sessionEntries on the task object');
  assert.match(body, /_ext\.sessionEntries/, 'must hoist legacy sessionEntries from _ext');
});

test('saveState change detection includes sessionEntries', () => {
  assert.match(storageSrc, /'sessionEntries'/, 'sessionEntries must be in fieldsToCompare');
});
