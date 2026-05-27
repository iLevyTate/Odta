/**
 * Tests for the pure-logic helper in js/dropdown.js (_resolveAnchor).
 *
 * The DOM-heavy parts (open/close lifecycle, keyboard nav) are covered
 * by the smoke suite once the utility is wired into a real page. Here
 * we verify the anchor-flip math in isolation by slicing the helper
 * out and evaluating it in a vm context.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'dropdown.js'), 'utf8');

// Slice _resolveAnchor out of the IIFE so we can call it without
// initialising the rest of the module.
const sIdx = src.indexOf('function _resolveAnchor');
if (sIdx < 0) throw new Error('_resolveAnchor not found in js/dropdown.js');
const eIdx = src.indexOf('\n  }', sIdx);
if (eIdx < 0) throw new Error('end of _resolveAnchor not found');
const block = src.slice(sIdx, eIdx + 4);

function loadResolveAnchor() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(block + '\n_resolveAnchor;', sandbox);
  // _resolveAnchor returned by the script
  return vm.runInContext('_resolveAnchor', sandbox);
}

test('flip above when not enough room below', () => {
  const fn = loadResolveAnchor();
  // trigger at y=600 in an 800px viewport; dropdown wants 250px.
  // Below: 800 - 640 = 160 (less than 250). Above: 600 (room).
  assert.equal(fn({ top: 600, bottom: 640 }, 800, 250), 'above');
});

test('open below when room available', () => {
  const fn = loadResolveAnchor();
  assert.equal(fn({ top: 100, bottom: 140 }, 800, 250), 'below');
});

test("explicit anchor 'above' overrides the auto choice", () => {
  const fn = loadResolveAnchor();
  assert.equal(fn({ top: 100, bottom: 140 }, 800, 250, 'above'), 'above');
});

test("explicit anchor 'below' overrides even when room is tight", () => {
  const fn = loadResolveAnchor();
  assert.equal(fn({ top: 600, bottom: 640 }, 800, 250, 'below'), 'below');
});

test('cramped on both sides falls back to whichever has more room', () => {
  const fn = loadResolveAnchor();
  // 200px viewport, dropdown wants 300. Room above=50, room below=80.
  assert.equal(fn({ top: 50, bottom: 120 }, 200, 300), 'below');
  // Same vp, trigger near the bottom: room above=180, below=20.
  assert.equal(fn({ top: 180, bottom: 200 }, 200, 300), 'above');
});
