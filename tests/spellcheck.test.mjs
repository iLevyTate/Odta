/**
 * spellcheck.js — offline task-title spelling hints for quick add.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'spellcheck.js'), 'utf8');

function loadSpellcheck({ parseQuickAdd, tasks = [], lists = [] } = {}) {
  const window = {};
  const document = {
    createElement() {
      return { type: '', className: '', title: '', textContent: '', dataset: {} };
    },
  };
  const fn = new Function(
    'window', 'document', 'parseQuickAdd', 'tasks', 'lists', 'getCategoryDef', 'CLASSIFICATION_CATEGORIES',
    `${src}\nreturn window;`,
  );
  return fn(
    window,
    document,
    parseQuickAdd || ((raw) => ({ name: raw, props: {} })),
    tasks,
    lists,
    undefined,
    undefined,
  );
}

test('spellcheck: module exports checkTaskSpelling and applySpellSuggestion', () => {
  assert.match(src, /window\.checkTaskSpelling\s*=\s*checkTaskSpelling/);
  assert.match(src, /window\.applySpellSuggestion\s*=\s*applySpellSuggestion/);
  assert.match(src, /window\._qpcSpellChip\s*=\s*_qpcSpellChip/);
});

test('spellcheck: suggests fix for common task typos', () => {
  const { checkTaskSpelling } = loadSpellcheck();
  const issues = checkTaskSpelling('buy grocceries tomorrow');
  const hit = issues.find(i => i.word.toLowerCase() === 'grocceries');
  assert.ok(hit, 'grocceries should be flagged');
  assert.ok(hit.suggestions.includes('groceries'), 'should suggest groceries');
});

test('spellcheck: TOKEN_FIXES map handles urgnet → urgent', () => {
  const { checkTaskSpelling } = loadSpellcheck();
  const issues = checkTaskSpelling('pay bill urgnet');
  const hit = issues.find(i => i.word.toLowerCase() === 'urgnet');
  assert.ok(hit);
  assert.equal(hit.suggestions[0], 'urgent');
});

test('spellcheck: ignores known words and quick-add tokens stripped from title', () => {
  const parseQuickAdd = (raw) => ({
    name: raw.replace(/\s@urgent\b/i, '').trim(),
    props: { priority: 'urgent' },
  });
  const { checkTaskSpelling } = loadSpellcheck({ parseQuickAdd });
  assert.deepEqual(checkTaskSpelling('buy milk @urgent'), []);
});

test('spellcheck: learns words from existing tasks and tags', () => {
  const tasks = [{ name: 'Call Zorgblatt', tags: ['zorgblatt'] }];
  const { checkTaskSpelling } = loadSpellcheck({ tasks });
  assert.deepEqual(checkTaskSpelling('email zorgblatt'), []);
});

test('spellcheck: skips very short input', () => {
  const { checkTaskSpelling } = loadSpellcheck();
  assert.deepEqual(checkTaskSpelling('hi'), []);
});

test('spellcheck: no false positives on common valid task phrases', () => {
  const { checkTaskSpelling } = loadSpellcheck();
  const ok = [
    'buy coffee', 'make lunch', 'take out trash', 'water plants', 'pick up kids',
    'pay rent', 'walk dog', 'get gas', 'schedule dentist', 'clean dishes', 'buy milk',
    'tomo sushi',
  ];
  ok.forEach(phrase => assert.deepEqual(checkTaskSpelling(phrase), [], phrase));
});

test('spellcheck: _qpcSpellChip wires applySpellSuggestion action', () => {
  const { _qpcSpellChip } = loadSpellcheck();
  const btn = _qpcSpellChip('grocceries', 'groceries');
  assert.equal(btn.dataset.action, 'applySpellSuggestion');
  assert.deepEqual(JSON.parse(btn.dataset.args), ['grocceries', 'groceries']);
  assert.match(btn.className, /qpc--spell/);
});

test('nlparse: live preview includes spell chips when checkTaskSpelling is available', () => {
  const nlp = readFileSync(join(root, 'js', 'nlparse.js'), 'utf8');
  assert.match(nlp, /checkTaskSpelling\(raw\)/, 'scheduleLiveParsePreview should call spell check');
  assert.match(nlp, /_qpcSpellChip/, 'spell chips use _qpcSpellChip');
});

test('tasks: updateLiveParsePreview includes spell chips', () => {
  const tasksSrc = readFileSync(join(root, 'js', 'tasks.js'), 'utf8');
  assert.match(tasksSrc, /checkTaskSpelling\(raw\)/, 'sync preview path should spell-check');
});

test('index: spellcheck.js loaded after tasks.js and before nlparse.js', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const tasksIdx = html.indexOf('js/tasks.js');
  const spellIdx = html.indexOf('js/spellcheck.js');
  const nlpIdx = html.indexOf('js/nlparse.js');
  assert.ok(tasksIdx >= 0 && spellIdx > tasksIdx && nlpIdx > spellIdx, 'script order');
});

test('sw: precaches spellcheck.js', () => {
  const sw = readFileSync(join(root, 'sw.js'), 'utf8');
  assert.match(sw, /'\.\/js\/spellcheck\.js'/);
});
