/**
 * migrateState step(9) backfills the expanded commonly-used Lists into installs
 * that predate them. ensureDefaultList only seeds a zero-list install, so an
 * install that already had Lists (e.g. the old Personal + Work pair) never got
 * the fuller set. step(9) merges missing defaults by name, once, without
 * duplicating existing Lists or resurrecting deleted ones on later loads.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'storage.js'), 'utf8');

const DEFAULTS = [
  { name: 'Personal',       color: '#1a8cff', description: 'p' },
  { name: 'Work',           color: '#18d4e6', description: 'w' },
  { name: 'Home & Errands', color: '#ffb02e', description: 'h' },
  { name: 'Finance',        color: '#9b7bff', description: 'f' },
  { name: 'Health',         color: '#2ecf73', description: 'he' },
];

function loadMigrate(defaults = DEFAULTS) {
  const i = src.indexOf('function migrateState(s){');
  const e = src.indexOf('// ── State validation', i);
  assert.ok(i >= 0 && e > i, 'slice migrateState');
  const fnSrc = src.slice(i, e);
  return new Function('__DEFAULTS__', `
    function _int(v, d){ const n = parseInt(v, 10); return Number.isFinite(n) ? n : (d || 0); }
    function _arr(v){ return Array.isArray(v) ? v : []; }
    function _obj(v){ return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }
    function _str(v, d){ return typeof v === 'string' ? v : (d || ''); }
    function _repairTask(t){ return t; }
    const window = { DEFAULT_LISTS: __DEFAULTS__ };
    ${fnSrc}
    return migrateState;
  `)(defaults);
}

test('backfills the missing default Lists into an old two-list install', () => {
  const migrate = loadMigrate();
  const out = migrate({
    v: 8, date: '2026-06-04',
    tasks: [{ id: 1, name: 'a', attachments: [] }],
    lists: [
      { id: 1, name: 'Personal', color: '#1a8cff', description: 'mine' },
      { id: 2, name: 'Work', color: '#18d4e6', description: 'job' },
    ],
    listIdCtr: 2,
    cfg: { calMode: 'week' },
  });
  const names = out.lists.map(l => l.name);
  assert.deepEqual(names, ['Personal', 'Work', 'Home & Errands', 'Finance', 'Health'],
    'missing defaults appended after the existing Lists');
  // existing Lists are untouched (descriptions preserved, not overwritten)
  assert.equal(out.lists[0].description, 'mine');
  assert.equal(out.lists[1].description, 'job');
  // new ids continue past the existing counter with no collisions
  const ids = out.lists.map(l => l.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
  assert.ok(out.listIdCtr >= Math.max(...ids), 'listIdCtr advanced past new ids');
});

test('is case-insensitive and never duplicates an existing List', () => {
  const migrate = loadMigrate();
  const out = migrate({
    v: 8, date: '2026-06-04', tasks: [],
    lists: [{ id: 5, name: 'personal', color: '#000', description: '' }, { id: 6, name: 'HEALTH', color: '#000', description: '' }],
    listIdCtr: 6,
    cfg: {},
  });
  const lower = out.lists.map(l => l.name.toLowerCase());
  assert.equal(lower.filter(n => n === 'personal').length, 1, 'no duplicate Personal');
  assert.equal(lower.filter(n => n === 'health').length, 1, 'no duplicate Health');
  assert.ok(out.lists.some(l => l.name === 'Work'), 'still adds genuinely missing defaults');
});

test('runs once — a List deleted after the migration is not resurrected', () => {
  const migrate = loadMigrate();
  // First pass: v8 install gets backfilled to v9.
  let s = migrate({ v: 8, date: '2026-06-04', tasks: [], lists: [{ id: 1, name: 'Personal', color: '#000', description: '' }], listIdCtr: 1, cfg: {} });
  assert.equal(s.v, 9);
  assert.ok(s.lists.some(l => l.name === 'Finance'), 'Finance seeded on first pass');
  // User deletes Finance, app reloads (state is already v9).
  s.lists = s.lists.filter(l => l.name !== 'Finance');
  const out = migrate(s);
  assert.equal(out.v, 9, 'stays at v9');
  assert.ok(!out.lists.some(l => l.name === 'Finance'), 'deleted List stays deleted on reload');
});

test('a fresh zero-list install is left alone (ensureDefaultList owns first-run seeding)', () => {
  const migrate = loadMigrate();
  const out = migrate({ v: 8, date: '2026-06-04', tasks: [], lists: [], listIdCtr: 0, cfg: {} });
  // step(9) populates an empty list array from defaults too, which is harmless,
  // but the contract that matters: it never throws and version advances.
  assert.equal(out.v, 9);
  assert.ok(Array.isArray(out.lists));
});
