/**
 * intelHardBulkConfirmNeeded: when Apply should use the hard bulk confirm dialog
 * (vs DELETE checkbox path) — js/ai.js.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadIntelHardBulkConfirmNeeded() {
  const src = readFileSync(join(root, 'js', 'ai.js'), 'utf8');
  const start = src.indexOf('function intelHardBulkConfirmNeeded(');
  const end = src.indexOf('async function intelApplyPending(', start);
  assert.ok(start >= 0 && end > start, 'slice intelHardBulkConfirmNeeded');
  return new Function(src.slice(start, end) + '\n return intelHardBulkConfirmNeeded;\n')();
}

test('hard bulk confirm: needed for hard + no DELETE', () => {
  const f = loadIntelHardBulkConfirmNeeded();
  assert.equal(
    f(
      [{ name: 'CHANGE_LIST', args: { id: 1, listId: 9 } }],
      'hard',
    ),
    true,
  );
});

test('hard bulk confirm: not needed when DELETE is present (checkbox path)', () => {
  const f = loadIntelHardBulkConfirmNeeded();
  assert.equal(
    f(
      [{ name: 'DELETE_TASK', args: { id: 1 } }, { name: 'CHANGE_LIST', args: { id: 2, listId: 9 } }],
      'hard',
    ),
    false,
  );
});

test('hard bulk confirm: not for warn/none', () => {
  const f = loadIntelHardBulkConfirmNeeded();
  assert.equal(f([{ name: 'CHANGE_LIST', args: { id: 1, listId: 9 } }], 'warn'), false);
  assert.equal(f([{ name: 'CHANGE_LIST', args: { id: 1, listId: 9 } }], 'none'), false);
});

test('hard bulk confirm: empty ops', () => {
  const f = loadIntelHardBulkConfirmNeeded();
  assert.equal(f([], 'hard'), false);
});
