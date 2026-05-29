/**
 * Regression: migrateState declared step(8) before step(7). The `step` helper
 * refuses a target when `reached < target - 1`, so a v6 state hit step(8) while
 * reached was still 6 (6 < 7) and skipped it — only self-healing on the NEXT
 * reload. That left attachments/calMode/timerDock unset for a whole session.
 * Steps must be declared in ascending order so a v6 state reaches v8 in one pass.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'storage.js'), 'utf8');

function loadMigrate() {
  const i = src.indexOf('function migrateState(s){');
  const e = src.indexOf('// ── State validation', i);
  assert.ok(i >= 0 && e > i, 'slice migrateState');
  const fnSrc = src.slice(i, e);
  return new Function(`
    function _int(v, d){ const n = parseInt(v, 10); return Number.isFinite(n) ? n : (d || 0); }
    function _arr(v){ return Array.isArray(v) ? v : []; }
    function _obj(v){ return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }
    function _str(v, d){ return typeof v === 'string' ? v : (d || ''); }
    function _repairTask(t){ return t; } // identity — isolates step-8's own work
    ${fnSrc}
    return migrateState;
  `)();
}

test('step(7) is declared before step(8) in source', () => {
  const i7 = src.indexOf('step(7,');
  const i8 = src.indexOf('step(8,');
  assert.ok(i7 > 0 && i8 > 0, 'both steps present');
  assert.ok(i7 < i8, 'step(7) must precede step(8) so migration is monotonic');
});

test('a v6 state migrates all the way to v8 in a single pass', () => {
  const migrate = loadMigrate();
  const out = migrate({ v: 6, date: '2026-05-28', tasks: [{ id: 1, name: 'a' }], cfg: {} });
  assert.equal(out.v, 8, 'must reach v8 in one pass');
  assert.ok(Array.isArray(out.tasks[0].attachments), 'step 8 added the attachments field');
  assert.equal(out.cfg.calMode, 'month', 'step 8 set the calMode default');
  assert.equal(typeof out.cfg.timerDock, 'object', 'step 8 set the timerDock default');
});

test('archived tasks are still dropped (step 7) during the v6 -> v8 upgrade', () => {
  const migrate = loadMigrate();
  const out = migrate({
    v: 6, date: '2026-05-28',
    tasks: [{ id: 1, name: 'keep' }, { id: 2, name: 'old', archived: true }],
    cfg: {},
  });
  assert.deepEqual(out.tasks.map(t => t.id), [1], 'archived task removed by step 7');
});

test('an already-current v8 state is left at v8', () => {
  const migrate = loadMigrate();
  const out = migrate({ v: 8, date: '2026-05-28', tasks: [{ id: 1, name: 'a', attachments: [] }], cfg: { calMode: 'week' } });
  assert.equal(out.v, 8);
  assert.equal(out.cfg.calMode, 'week', 'existing cfg is not clobbered');
});
