/**
 * Regression: migrateEmbedRuntimeIfNeeded() swallowed a failed
 * clearAllEmbeddings() but still advanced the runtime meta. On the next boot
 * migration was skipped, and ensure() never re-embedded unchanged-text tasks —
 * so the store kept vectors from the OLD model/dim and semantic search / kNN /
 * dedupe silently compared incompatible vectors. The migration must NOT advance
 * meta when the purge fails; it should defer (didPurge:false) and retry later.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'embed-store.js'), 'utf8');

function buildHarness() {
  const s = src.indexOf('async migrateEmbedRuntimeIfNeeded(){');
  const e = src.indexOf('getCatCentroidsKey(){', s);
  assert.ok(s >= 0 && e > s, 'slice migrateEmbedRuntimeIfNeeded');
  const methodSrc = src.slice(s, e); // includes trailing "},\n" — valid as last prop

  return new Function('opts', `
    const META_EMBED_RUNTIME_KEY = 'embed_runtime';
    const META_SCHWARTZ_KEY = 'schwartz_vecs_v1';
    const META_CAT_CENTROIDS_KEY = 'cat_centroids_v1';
    const EMBED_SCHEMA_VER = 'ver-NEW';
    function getActiveEmbedModelId(){ return 'model-NEW'; }
    function getEmbedDim(){ return 384; }
    const calls = { cleared: 0, setMeta: 0 };
    let metaStore = { ...(opts.initialMeta || {}) };
    const embedStore = {
      async clearAllEmbeddings(){ calls.cleared++; if(opts.purgeThrows) throw new Error('IDB quota'); },
      async getMeta(k){ return metaStore[k] != null ? metaStore[k] : null; },
      async setMeta(k, v){ calls.setMeta++; metaStore[k] = v; },
      async deleteMeta(k){ delete metaStore[k]; },
      ${methodSrc}
    };
    return {
      run: () => embedStore.migrateEmbedRuntimeIfNeeded(),
      calls,
      runtimeMeta: () => metaStore[META_EMBED_RUNTIME_KEY] || null,
    };
  `);
}

test('migration defers (no meta advance) when clearAllEmbeddings throws', async () => {
  const h = buildHarness()({ purgeThrows: true, initialMeta: {} });
  const res = await h.run();
  assert.equal(res.didPurge, false, 'a failed purge must report didPurge:false');
  assert.equal(h.calls.cleared, 1, 'it did attempt the purge');
  assert.equal(h.calls.setMeta, 0, 'it must NOT advance the runtime meta after a failed purge');
  assert.equal(h.runtimeMeta(), null, 'runtime meta stays unset so migration retries next boot');
});

test('migration advances meta on a successful purge', async () => {
  const h = buildHarness()({ purgeThrows: false, initialMeta: {} });
  const res = await h.run();
  assert.equal(res.didPurge, true, 'a clean purge completes the migration');
  assert.ok(h.calls.setMeta >= 1, 'runtime meta is advanced');
  const meta = h.runtimeMeta();
  assert.ok(meta && meta.modelId === 'model-NEW' && meta.dim === 384 && meta.schemaVer === 'ver-NEW');
});

test('migration is a no-op when runtime meta already matches', async () => {
  const h = buildHarness()({
    purgeThrows: false,
    initialMeta: { embed_runtime: { schemaVer: 'ver-NEW', modelId: 'model-NEW', dim: 384 } },
  });
  const res = await h.run();
  assert.equal(res.didPurge, false, 'matching meta short-circuits');
  assert.equal(h.calls.cleared, 0, 'no purge when nothing changed');
});
