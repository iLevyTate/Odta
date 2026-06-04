/**
 * Tap-to-set quick-property bar (index.html + js/tasks.js).
 *
 * Due / Priority / List can be set from always-visible pills under the quick-add
 * input — no @ / # / ~ token syntax required. The pills write to the same
 * window._quickAddValues that addTask already merges, so taps and typed tokens
 * combine. These guards lock in the markup and wiring.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tasks = readFileSync(join(root, 'js', 'tasks.js'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');

test('quick-set container sits in the quick-add cluster', () => {
  assert.ok(/id="qaQuickSet"/.test(html), '#qaQuickSet present');
  // It lives inside the relocatable quick-add host (moves to the mobile sheet with the input).
  const host = html.slice(html.indexOf('id="quickAddHost"'), html.indexOf('id="filterBar"'));
  assert.ok(/id="qaQuickSet"/.test(host), '#qaQuickSet inside quickAddHost');
});

test('renderQuickSetBar + the three pickers are defined and exposed', () => {
  for (const fn of ['renderQuickSetBar', 'qaPickDue', 'qaPickPriority', 'qaPickList']) {
    assert.ok(new RegExp(`function ${fn}\\(`).test(tasks), `${fn} defined`);
    assert.ok(new RegExp(`window\\.${fn}\\s*=`).test(tasks), `${fn} exposed on window`);
  }
});

test('pickers write to _quickAddValues via _qaSet (the existing merge path)', () => {
  for (const [fn, key] of [['qaPickPriority', 'priority'], ['qaPickList', 'listId'], ['qaPickDue', 'dueDate']]) {
    const body = tasks.slice(tasks.indexOf(`function ${fn}(`), tasks.indexOf(`function ${fn}(`) + 1200);
    assert.ok(new RegExp(`_qaSet\\('${key}'`).test(body), `${fn} sets ${key} via _qaSet`);
    assert.ok(/renderQuickSetBar\(\)/.test(body), `${fn} refreshes the bar`);
  }
});

test('the pills route through the Dropdown popover utility', () => {
  for (const fn of ['qaPickDue', 'qaPickPriority', 'qaPickList']) {
    const body = tasks.slice(tasks.indexOf(`function ${fn}(`), tasks.indexOf(`function ${fn}(`) + 700);
    assert.ok(/Dropdown\.open\(/.test(body), `${fn} opens a Dropdown popover`);
  }
});

test('the bar is cleared after each add', () => {
  const add = tasks.slice(tasks.indexOf('async function addTask('), tasks.indexOf('async function addTask(') + 3000);
  assert.ok(/window\._quickAddValues=null/.test(add), 'addTask clears _quickAddValues');
  assert.ok(/renderQuickSetBar\(\)/.test(add), 'addTask re-renders the quick-set bar');
});
