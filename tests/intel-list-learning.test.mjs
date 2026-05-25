/**
 * Auto-organize "learns from manual sorting": _getListVectors blends each list's
 * name/description embedding with the centroid of the tasks the user has filed
 * under it. We verify the observable effect through the exported predictListId —
 * when two lists have identical (uninformative) names, routing is driven entirely
 * by where similar tasks already live.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function cosine(a, b){
  let d = 0;
  const n = Math.min(a.length, b.length);
  for(let i = 0; i < n; i++) d += a[i] * b[i];
  return d;
}

// Deterministic text→vector map. Both list names map to the SAME vector so the
// list names carry no routing signal — only manual placement (members) can.
const VECMAP = {
  L1: [1, 0, 0, 0],
  L2: [1, 0, 0, 0],
  queryA: [0, 1, 0, 0], // matches list-1 members
  queryB: [0, 0, 1, 0], // matches list-2 members
};
function vec(txt){ return Float32Array.from(VECMAP[txt] || [0, 0, 0, 1]); }

function loadIntel(){
  const win = {};
  const lists = [
    { id: 1, name: 'L1', description: '' },
    { id: 2, name: 'L2', description: '' },
  ];
  // Tasks 11/12 filed in list 1 (vector e1); 21/22 filed in list 2 (vector e2).
  const taskMeta = {
    11: { listId: 1, v: [0, 1, 0, 0] },
    12: { listId: 1, v: [0, 1, 0, 0] },
    21: { listId: 2, v: [0, 0, 1, 0] },
    22: { listId: 2, v: [0, 0, 1, 0] },
  };
  const store = new Map(
    Object.entries(taskMeta).map(([id, m]) => [Number(id), { vec: Float32Array.from(m.v), textHash: 'h' + id }]),
  );
  const findTask = (id) => {
    const m = taskMeta[id];
    if(!m) return null;
    return { id: Number(id), listId: m.listId, archived: false, status: 'open' };
  };
  const embedStore = {
    get: async () => null,
    all: async () => store,
    getMeta: async () => null,
    setMeta: async () => {},
  };
  const ctx = {
    window: win,
    console,
    cfg: { categories: [] },
    lists,
    tasks: Object.keys(taskMeta).map((id) => findTask(id)),
    findTask,
    embedText: async (txt) => vec(txt),
    embedStore,
    isIntelReady: () => true,
    hashTaskText: (a, b) => String(a || '') + '|' + String(b || ''),
    cosine,
  };
  const src = readFileSync(join(root, 'js', 'intel-features.js'), 'utf8');
  new Function(...Object.keys(ctx), src)(...Object.values(ctx));
  return win;
}

test('predictListId routes by manual placement when list names are uninformative', async () => {
  const win = loadIntel();
  assert.equal(typeof win.predictListId, 'function');
  // A task that looks like the things already filed in list 2 routes to list 2.
  const toB = await win.predictListId('queryB');
  assert.equal(toB, 2, 'should route toward the list whose members it resembles');
  // And the symmetric case routes to list 1.
  const toA = await win.predictListId('queryA');
  assert.equal(toA, 1);
});

test('predictListId returns null when names match and there are no members to learn from', async () => {
  // Rebuild with an empty store so the only signal is the (identical) names.
  const win = {};
  const lists = [
    { id: 1, name: 'L1', description: '' },
    { id: 2, name: 'L2', description: '' },
  ];
  const ctx = {
    window: win,
    console,
    cfg: { categories: [] },
    lists,
    tasks: [],
    findTask: () => null,
    embedText: async (txt) => vec(txt),
    embedStore: { get: async () => null, all: async () => new Map(), getMeta: async () => null, setMeta: async () => {} },
    isIntelReady: () => true,
    hashTaskText: (a, b) => String(a || '') + '|' + String(b || ''),
    cosine,
  };
  const src = readFileSync(join(root, 'js', 'intel-features.js'), 'utf8');
  new Function(...Object.keys(ctx), src)(...Object.values(ctx));
  const out = await win.predictListId('queryB');
  assert.equal(out, null, 'identical names + no members gives no routing signal');
});
