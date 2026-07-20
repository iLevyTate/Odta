/**
 * CSV export → import must round-trip to identity for cells that trigger the
 * formula-injection guard. _csvEscape prepends ' to cells starting with
 * = + - @ tab/CR (so Excel/Sheets won't execute them); the import side must
 * strip that same guard or every round-trip accretes a literal apostrophe
 * onto task names like "@home water plants" or "+1 review".
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'storage.js'), 'utf8');

function fnBlock(name) {
  const s = src.indexOf(`function ${name}(`);
  assert.ok(s >= 0, `${name} found`);
  const e = src.indexOf('\nfunction ', s + 1);
  return src.slice(s, e > s ? e : undefined);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fnBlock('_csvEscape') + '\nthis._csvEscape = _csvEscape;', sandbox);

// The import-side inverse, as wired in _importTasksFromCSV.
const m = src.match(/const unguard = ([^;]+);/);

test('import defines the unguard inverse of the export formula guard', () => {
  assert.ok(m, '_importTasksFromCSV strips the export-side apostrophe guard');
});

test('export guard → import unguard round-trips to identity', () => {
  const unguard = vm.runInContext('(' + m[1] + ')', sandbox);
  for (const v of ['@home water plants', '=SUM(A1)', '+1 review', '-tidy desk', 'plain name', "'already quoted"]) {
    // Simulate export: escape, then remove the CSV quoting layer the parser
    // would remove (quotes only wrap when the cell contains , " or newline).
    let cell = sandbox._csvEscape(v);
    if (cell.startsWith('"') && cell.endsWith('"')) cell = cell.slice(1, -1).replace(/""/g, '"');
    assert.strictEqual(unguard(cell), v, `round-trip identity for ${JSON.stringify(v)}`);
  }
});
