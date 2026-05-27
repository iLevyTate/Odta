/**
 * Tests for the duration: operator added to parseTaskSearchQuery.
 *
 * The parser block is sliced from js/tasks.js and evaluated in an
 * isolated vm context. This mirrors the existing
 * tests/search-operators.test.mjs pattern, but uses node:vm rather than
 * the Function constructor so it's friendlier to source scanners.
 *
 * Accepted forms:
 *   duration:90       -> 90 minutes (bare integer interpreted as minutes)
 *   duration:2h       -> 7200s
 *   duration:30m      -> 1800s
 *   duration:45s      -> 45s
 *   duration:1h30m    -> 5400s (compound)
 *   duration:>2h      -> { op:'>',  seconds:7200 }
 *   duration:<=30m    -> { op:'<=', seconds:1800 }
 *   duration:>=0      -> { op:'>=', seconds:0   }
 *   duration:=0       -> { op:'=',  seconds:0   }
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const full = readFileSync(join(root, 'js', 'tasks.js'), 'utf8');

const sIdx = full.indexOf('// ── Search operator parser');
const eMark = "if(typeof window !== 'undefined') window.parseTaskSearchQuery = parseTaskSearchQuery;";
const eIdx = full.indexOf(eMark);
if (sIdx < 0 || eIdx < 0) throw new Error('parser markers not found in js/tasks.js');
const block = full.slice(sIdx, eIdx + eMark.length);

function loadParser() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(block, sandbox);
  return sandbox.parseTaskSearchQuery;
}

test('duration: bare integer interpreted as minutes', () => {
  const r = loadParser()('duration:90 hello');
  assert.deepEqual(r.ops.duration, [{ op: '=', seconds: 90 * 60 }]);
  assert.equal(r.text, 'hello');
});

test('duration: h/m/s suffixes parse independently', () => {
  const r = loadParser()('duration:2h duration:30m duration:45s');
  assert.deepEqual(r.ops.duration, [
    { op: '=', seconds: 7200 },
    { op: '=', seconds: 1800 },
    { op: '=', seconds: 45 },
  ]);
});

test('duration: compound 1h30m', () => {
  const r = loadParser()('duration:1h30m');
  assert.deepEqual(r.ops.duration, [{ op: '=', seconds: 5400 }]);
});

test('duration: compound 2h15m30s', () => {
  const r = loadParser()('duration:2h15m30s');
  assert.deepEqual(r.ops.duration, [{ op: '=', seconds: 2 * 3600 + 15 * 60 + 30 }]);
});

test('duration: compare prefixes', () => {
  const r = loadParser()('duration:>2h duration:<=30m duration:>=0m duration:=0');
  assert.deepEqual(r.ops.duration, [
    { op: '>',  seconds: 7200 },
    { op: '<=', seconds: 1800 },
    { op: '>=', seconds: 0    },
    { op: '=',  seconds: 0    },
  ]);
});

test('duration: invalid value is dropped, text falls through', () => {
  const r = loadParser()('duration:banana keep this');
  assert.equal((r.ops.duration || []).length, 0);
  // The token "duration:banana" matches the operator regex and gets consumed
  // even though _parseDurationVal returns null - so it disappears from text.
  // That matches the existing behaviour for unknown @priority values.
  assert.equal(r.text, 'keep this');
});

test('duration: AND-stacks with other operators', () => {
  const r = loadParser()('is:done duration:>2h tag:work');
  assert.deepEqual(r.ops.duration, [{ op: '>', seconds: 7200 }]);
  assert.deepEqual(r.ops.is, ['done']);
  assert.deepEqual(r.ops.tag, ['work']);
});
