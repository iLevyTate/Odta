/**
 * P2P merge must not drop this device's time log when the peer's epoch is
 * newer (logs are append-only; union them like the cross-tab path does), the
 * id-less sessionHistory must not double on every merge, and a replaced
 * connection's close event must not tear down its successor.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'sync.js'), 'utf8');

function fnBlock(name) {
  const s = src.indexOf(`function ${name}(`);
  assert.ok(s >= 0, `${name} found`);
  const e = src.indexOf('\nfunction ', s + 1);
  return src.slice(s, e > s ? e : undefined);
}

test('_syncMergeSessionHist treats a prefix copy as the same history', () => {
  const sandbox = { JSON, Array, _SYNC_MAX_SH_MERGE: 400 };
  vm.createContext(sandbox);
  vm.runInContext(fnBlock('_syncMergeSessionHist') + '\nthis.f=_syncMergeSessionHist;', sandbox);
  const a = [{ type: 'work' }, { type: 'short' }];
  const b = [{ type: 'work' }, { type: 'short' }, { type: 'work' }];
  assert.deepEqual(sandbox.f(a, b), b, 'longer list wins when the shorter is its prefix');
  assert.deepEqual(sandbox.f(b, a), b);
  assert.deepEqual(sandbox.f(a, a), a, 'identical histories do not double');
  const c = [{ type: 'long' }];
  assert.deepEqual(sandbox.f(a, c), [...a, ...c], 'divergent histories concatenate');
});

test('a newer remote epoch unions the logs instead of replacing them', () => {
  const body = fnBlock('_mergeState');
  const branch = body.slice(body.indexOf('if (re > le || _remoteWinsExact) {'), body.indexOf('} else if (re === le && re > 0 && rn === ln) {'));
  assert.match(branch, /timeLog = _syncMergeTimeLogsById\(timeLog, remote\.timeLog\)/);
  assert.match(branch, /sessionHistory = _syncMergeSessionHist\(sessionHistory, remote\.sessionHistory\)/);
  assert.match(branch, /intervals = _syncMergeIntervalsById\(intervals, remote\.intervals\)/);
  assert.ok(!/timeLog = remote\.timeLog;/.test(branch), 'wholesale replace removed');
});

test('close / error handlers ignore a connection that has already been replaced', () => {
  const s = src.indexOf("conn.on('close', () => {");
  const block = src.slice(s, s + 1800);
  // `_conn !== conn` alone is the stricter form: it also ignores a close that
  // arrives while _conn is null mid-swap (the simultaneous-dial tie-break).
  assert.match(block, /if \((_conn && )?_conn !== conn\) return;/);
  const errIdx = block.indexOf("conn.on('error'");
  assert.ok(errIdx > 0);
  assert.match(block.slice(errIdx), /if \((_conn && )?_conn !== conn\) return;/);
});

test('merged checklist / note ids reseed the allocators', () => {
  assert.match(fnBlock('_mergeState'), /reseedChecklistAndNoteIdCtrs\(\)/);
});
