/**
 * Regression — js/ui.js:373 was rendering cmd+K palette items with
 *   data-arg="+cur+"
 * (literal string) instead of
 *   data-arg="'+cur+'"
 * (string-concat broken open / closed). Result: every click on a palette
 * item routed cmdkRun("+cur+") → cmdkFilteredItems["+cur+"] === undefined,
 * silent no-op. Only keyboard Enter (which uses cmdkActiveIdx directly) worked.
 *
 * Guard against the exact typo recurring.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'ui.js'), 'utf8');

test('ui.js: cmd+K palette item renders data-arg as interpolated index, not literal', () => {
  assert.ok(
    !/data-arg="\+cur\+"/.test(src),
    'js/ui.js still contains the broken literal `data-arg="+cur+"` — the string concatenation must close+reopen the quotes: `data-arg="\'+cur+\'"`.'
  );
});

test('ui.js: cmd+K palette item renders well-formed data-arg', () => {
  // The render template lives in renderCmdK; assert it emits the corrected form.
  assert.ok(
    /data-arg="'\+cur\+'"/.test(src),
    'Expected `data-arg="\'+cur+\'"` in ui.js renderCmdK template.'
  );
});
