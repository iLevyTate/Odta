/**
 * Regression: auto-classification gated only on hasClassificationCategory(), so
 * it could assign a category the user had explicitly HIDDEN — the category is
 * still valid (manual assignments stay intact) but the user removed it from
 * their working set, so the classifier must not pick it. isAssignableCategory()
 * is the stricter gate used at every automatic assignment site.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const intelSrc = readFileSync(join(root, 'js', 'intel-features.js'), 'utf8');
const aiSrc = readFileSync(join(root, 'js', 'ai.js'), 'utf8');

function loadGates(cfg) {
  const start = intelSrc.indexOf('function hasClassificationCategory(cat){');
  const end = intelSrc.indexOf('function getCategoryDef(', start);
  assert.ok(start >= 0 && end > start, 'slice classification helpers');
  const body = intelSrc.slice(start, end);
  const factory = new Function('cfg', `
    const LIFE_CATS = ['health', 'work', 'family'];
    function ensureClassificationConfig(){}
    ${body}
    return { hasClassificationCategory, isAssignableCategory };
  `);
  return factory(cfg);
}

test('built-in life categories are assignable', () => {
  const { isAssignableCategory } = loadGates({ categories: [] });
  assert.equal(isAssignableCategory('work'), true);
});

test('a visible custom category is assignable', () => {
  const { isAssignableCategory } = loadGates({ categories: [{ id: 'side-biz', hidden: false }] });
  assert.equal(isAssignableCategory('side-biz'), true);
});

test('a hidden custom category is NOT auto-assignable but is still valid', () => {
  const cfg = { categories: [{ id: 'side-biz', hidden: true }] };
  const { hasClassificationCategory, isAssignableCategory } = loadGates(cfg);
  assert.equal(hasClassificationCategory('side-biz'), true, 'still a valid category (manual values survive)');
  assert.equal(isAssignableCategory('side-biz'), false, 'auto-classification must skip a hidden category');
});

test('an unknown category is neither valid nor assignable', () => {
  const { hasClassificationCategory, isAssignableCategory } = loadGates({ categories: [] });
  assert.equal(hasClassificationCategory('nope'), false);
  assert.equal(isAssignableCategory('nope'), false);
});

test('every automatic assignment site gates on isAssignableCategory', () => {
  // _sanitizeMergedCategory + the KNN pickDiscrete validator + the two op
  // builders must all use the stricter gate.
  assert.match(intelSrc, /function _sanitizeMergedCategory[\s\S]{0,400}!isAssignableCategory\(merged\.category\)/,
    'merged-category sanitizer must use isAssignableCategory');
  const autoSites = (intelSrc.match(/isAssignableCategory\(/g) || []).length;
  assert.ok(autoSites >= 4, `expected >=4 isAssignableCategory uses in intel-features, found ${autoSites}`);
});

test('ai.js classify paths no longer auto-assign via the looser gate', () => {
  // The classify-preview/apply paths and the suggestion cleaner must gate on
  // isAssignableCategory, not the looser hasClassificationCategory.
  assert.doesNotMatch(aiSrc, /!hasClassificationCategory\(nextCat\)/,
    'classify paths must not gate category auto-assign on hasClassificationCategory');
  assert.ok((aiSrc.match(/isAssignableCategory\(/g) || []).length >= 3,
    'ai.js classify/suggestion sites must use isAssignableCategory');
});
