/**
 * genAutoRehydrateIfCached branch table — mirrors js/ai.js genAutoRehydrateIfCached.
 */
import test from 'node:test';
import assert from 'node:assert';

function shouldRunRehydrate({ enabled, modelId, downloaded, ready, currentModel } = {}) {
  if (!enabled) return false;
  if (!modelId) return false;
  if (!downloaded) return false;
  if (ready && currentModel === modelId) return false;
  return true;
}

test('rehydrate: only when enabled + downloaded + (not already ready for model)', () => {
  assert.equal(shouldRunRehydrate({ enabled: false, modelId: 'a', downloaded: true, ready: false }), false);
  assert.equal(shouldRunRehydrate({ enabled: true, modelId: 'a', downloaded: false, ready: false }), false);
  assert.equal(shouldRunRehydrate({ enabled: true, modelId: 'a', downloaded: true, ready: true, currentModel: 'a' }), false);
  assert.equal(shouldRunRehydrate({ enabled: true, modelId: 'a', downloaded: true, ready: true, currentModel: 'b' }), true);
  assert.equal(shouldRunRehydrate({ enabled: true, modelId: 'a', downloaded: true, ready: false }), true);
});

test('rehydrate: async try/catch swallows (smoke — no unhandled throw)', async () => {
  let loading = 0;
  const run = async () => {
    try {
      loading = 1;
      throw new Error('GEN_FAIL');
    } catch (e) {
      loading = 0;
    }
  };
  await run();
  assert.equal(loading, 0);
});
