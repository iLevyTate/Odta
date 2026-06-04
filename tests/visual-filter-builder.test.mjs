/**
 * Visual filter builder (index.html + js/tasks.js).
 *
 * "+ Filter" opens a two-step picker (dimension → value) that appends a search
 * operator (tag:/priority:/status:/due:/is:) to the search input. The existing
 * parse + filter pipeline applies it and #activeFiltersBar renders a removable
 * chip — so operators are discoverable without typing the syntax. These guards
 * lock in the markup, the wiring, and that only valid operator values are built.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tasks = readFileSync(join(root, 'js', 'tasks.js'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');

test('the + Filter trigger lives in the filter bar and routes to openFilterBuilder', () => {
  const bar = html.slice(html.indexOf('id="filterBar"'), html.indexOf('id="searchBarWrap"'));
  assert.ok(/id="fbAddFilter"[^>]*data-action="openFilterBuilder"/.test(bar), '#fbAddFilter → openFilterBuilder in the filter bar');
});

test('builder + helpers are defined; openFilterBuilder is exposed', () => {
  for (const fn of ['openFilterBuilder', '_openFilterValueMenu', '_afAppendOperator', '_allTaskTags']) {
    assert.ok(new RegExp(`function ${fn}\\(`).test(tasks), `${fn} defined`);
  }
  assert.ok(/window\.openFilterBuilder\s*=/.test(tasks), 'openFilterBuilder exposed on window');
});

test('_afAppendOperator feeds the existing search pipeline (no new filter engine)', () => {
  const body = tasks.slice(tasks.indexOf('function _afAppendOperator('), tasks.indexOf('function _afAppendOperator(') + 700);
  assert.ok(/getElementById\? *|gid\('taskSearch'\)/.test(body) || /gid\('taskSearch'\)/.test(body), 'writes to #taskSearch');
  assert.ok(/updateTaskFilters\(\)/.test(body), 'triggers updateTaskFilters');
  assert.ok(/dupRe/.test(body), 'de-dupes an already-present operator');
});

test('dimension menu offers tag/priority/status/due/flag; flag maps to is:', () => {
  const open = tasks.slice(tasks.indexOf('function openFilterBuilder('), tasks.indexOf('function _openFilterValueMenu('));
  for (const d of ['tag', 'priority', 'status', 'due', 'flag']) {
    assert.ok(new RegExp(`value:'${d}'`).test(open), `dimension "${d}" offered`);
  }
  const val = tasks.slice(tasks.indexOf('function _openFilterValueMenu('), tasks.indexOf('function _openFilterValueMenu(') + 1400);
  assert.ok(/dim === 'flag'\) \? 'is' : dim/.test(val), "flag dimension maps to the is: operator");
});

test('only valid operator values are generated', () => {
  const val = tasks.slice(tasks.indexOf('function _openFilterValueMenu('), tasks.indexOf('function _openFilterValueMenu(') + 1400);
  // priority values
  assert.ok(/'urgent','high','normal','low','none'/.test(val), 'valid priority values');
  // due keywords accepted by the due: operator
  assert.ok(/\['today'.*\['tomorrow'.*\['week'.*\['overdue'.*\['none'/s.test(val), 'valid due values');
  // flag → is: values (overdue/starred/recurring/snoozed)
  assert.ok(/\['overdue'.*\['starred'.*\['recurring'.*\['snoozed'/s.test(val), 'valid is/flag values');
});
