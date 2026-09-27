/**
 * The delegated dispatcher only calls handler names in its HANDLERS set
 * (js/event-delegation.js). This pins that set to the sources both ways:
 * every data-action / data-on* name the markup can emit must be listed (or
 * the control goes dead), and every listed name must still be emitted
 * somewhere (or the list slowly grows back into "any global").
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const jsFiles = readdirSync(join(root, 'js')).filter((f) => f.endsWith('.js')).map((f) => 'js/' + f);
const sources = ['index.html', ...jsFiles].map((p) => [p, read(p)]);

const IDENT = /^[A-Za-z_$][\w$]*$/;

function emittedNames() {
  const names = new Set();
  const nonLiteral = [];
  for (const [p, src] of sources) {
    for (const m of src.matchAll(/data-(?:action|on[a-z]+)\s*=\s*\\?["']([^"'\\]*)/g)) {
      if (IDENT.test(m[1])) names.add(m[1]);
      else nonLiteral.push(`${p}: ${src.slice(m.index, m.index + 60)}`);
    }
    for (const m of src.matchAll(/dataset\.(?:action|on[A-Z][a-z]+)\s*=\s*([^;\n]+)/g)) {
      const lit = m[1].trim().match(/^['"]([A-Za-z_$][\w$]*)['"]$/);
      if (lit) names.add(lit[1]);
      else if (!(p === 'js/tasks.js' && m[1].trim() === 'd.action')) nonLiteral.push(`${p}: ${m[0].slice(0, 80)}`);
    }
  }
  // renderQuickSetBar assigns b.dataset.action = d.action from a static defs table.
  const tasks = read('js/tasks.js');
  const i = tasks.indexOf('function renderQuickSetBar(');
  assert.ok(i >= 0, 'renderQuickSetBar not found');
  for (const m of tasks.slice(i, i + 1500).matchAll(/\baction:'([A-Za-z_$][\w$]*)'/g)) names.add(m[1]);
  return { names, nonLiteral };
}

function allowlisted() {
  const src = read('js/event-delegation.js');
  const m = src.match(/const HANDLERS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(m, 'HANDLERS set not found in js/event-delegation.js');
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}

test('every handler name the markup emits is allowlisted', () => {
  const { names } = emittedNames();
  const allow = allowlisted();
  const missing = [...names].filter((n) => !allow.has(n)).sort();
  assert.deepStrictEqual(missing, [], 'add these to HANDLERS in js/event-delegation.js');
});

test('every allowlisted name is still emitted somewhere', () => {
  const { names } = emittedNames();
  const stale = [...allowlisted()].filter((n) => !names.has(n)).sort();
  assert.deepStrictEqual(stale, [], 'remove these from HANDLERS in js/event-delegation.js');
});

test('handler names are written as literals the scan can see', () => {
  assert.deepStrictEqual(emittedNames().nonLiteral, []);
});

test('the gadgets named in the audit are not allowlisted', () => {
  const allow = allowlisted();
  for (const n of ['syncConnect', '_applyState', 'importData', 'registerDelegatedHandler', 'syncAcceptInbound', 'eval']) {
    assert.ok(!allow.has(n), `${n} must not be reachable from markup`);
  }
});
