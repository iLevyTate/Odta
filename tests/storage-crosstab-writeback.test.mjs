/**
 * Cross-tab storage-event handling must not ping-pong.
 *
 * Every apply/merge used to queue an autosave, which minted a fresh
 * stateEpoch; the other tab saw "newer", applied, re-saved … a full save plus
 * renderAll() in both tabs every ~450 ms for as long as both stayed open. The
 * handler now writes back only when the LWW merge kept something local, judged
 * on a key-order-insensitive fingerprint of the synced entities.
 *
 * Also covered: lastModified stamps are monotonic per task (clock-skew
 * safety), encrypted backups are re-wrapped for importData, and the stale
 * localStorage mirror is superseded by a newer IndexedDB copy at boot.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'storage.js'), 'utf8');

function fnBlock(name) {
  const s = src.indexOf(`function ${name}(`);
  assert.ok(s >= 0, `${name} found`);
  const e = src.indexOf('\nfunction ', s + 1);
  return src.slice(s, e > s ? e : undefined);
}

function load() {
  const sandbox = { JSON, Array, Object, Date, Number, Math };
  vm.createContext(sandbox);
  vm.runInContext(
    fnBlock('_canonJson') + '\n' + fnBlock('_mergeFingerprint') + '\n' + fnBlock('_nextLastModified') +
    '\nthis.canon=_canonJson; this.fp=_mergeFingerprint; this.nextLm=_nextLastModified;',
    sandbox,
  );
  return sandbox;
}

test('fingerprint ignores object key order and array order of id-keyed entities', () => {
  const { fp } = load();
  const a = { tasks: [{ id: 2, name: 'b', tags: ['x'] }, { id: 1, name: 'a' }], lists: [], goals: [], timeLog: [], intervals: [], sessionHistory: [], syncTaskDels: {} };
  const b = { tasks: [{ name: 'a', id: 1 }, { tags: ['x'], name: 'b', id: 2 }], lists: [], goals: [], timeLog: [], intervals: [], sessionHistory: [], syncTaskDels: {} };
  assert.strictEqual(fp(a), fp(b));
  const c = { ...b, tasks: [{ name: 'a', id: 1 }, { tags: ['x'], name: 'B', id: 2 }] };
  assert.notStrictEqual(fp(a), fp(c));
});

test('undefined-valued keys do not distinguish otherwise equal objects', () => {
  const { canon } = load();
  assert.strictEqual(canon({ a: 1, b: undefined }), canon({ a: 1 }));
});

test('the storage handler only writes back when the merge kept local state', () => {
  const s = src.indexOf('function _onStorageFromOtherTab(');
  assert.ok(s > 0, 'cross-tab storage handler found');
  const merge = src.indexOf('ok = _mergeRemoteStateLww(remote);', s);
  assert.ok(merge > s, 'cross-tab merge call found');
  const handler = src.slice(s, src.indexOf('resetTaskSnapshotBaseline();', merge));
  assert.ok(!/if\(!ok\) return;\s*if\(typeof queueAutoSave === 'function'\) queueAutoSave\(\);/.test(handler), 'unconditional write-back removed');
  assert.match(handler, /if\(dirty && _lastCrossTabMergeKeptLocal && typeof queueAutoSave === 'function'\) queueAutoSave\(\);/);
  assert.match(fnBlock('_mergeRemoteStateLww'), /_lastCrossTabMergeKeptLocal = _mergeFingerprint\(/);
});

test('_nextLastModified is monotonic per task even when the clock lags an earlier stamp', () => {
  const { nextLm } = load();
  const future = Date.now() + 3600_000;
  assert.strictEqual(nextLm({ lastModified: future }, { lastModified: future }), future + 1);
  assert.strictEqual(nextLm({ lastModified: 10 }, { lastModified: future }), future + 1, 'previous snapshot stamp counts too');
  const now = Date.now();
  assert.ok(nextLm({ lastModified: 10 }, { lastModified: 20 }) >= now, 'falls back to the clock when it is ahead');
  assert.ok(src.includes('t.lastModified = _nextLastModified(t, p);'), 'saveState comparator uses it');
});

test('encrypted restore re-wraps the decrypted payload for importData', () => {
  const body = fnBlock('importDataEncrypted');
  assert.match(body, /payload\.state/, 'state is unwrapped from the encrypted envelope');
  assert.match(body, /wrapped = \{ export: JSON\.stringify\(state\) \}/);
  assert.match(body, /new File\(\[JSON\.stringify\(wrapped\)\]/);
});

test('boot checks IndexedDB for a newer epoch after the localStorage fast path', () => {
  assert.match(fnBlock('loadState'), /_recoverNewerIdbState\(/);
  const body = fnBlock('_recoverNewerIdbState');
  assert.match(body, /idbEpoch > \(lsEpoch \|\| 0\)/);
  assert.match(body, /window\._stateDirty/, 'never overwrites live user edits');
});

test('manual order is part of the change comparator', () => {
  const m = src.match(/const fieldsToCompare = \[([\s\S]*?)\];/);
  const listed = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(listed.includes('order'));
});
