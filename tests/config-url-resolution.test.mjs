/**
 * Regression — js/config.js used to expose relative paths like
 *   TRANSFORMERS_URL: './js/vendor/transformers/transformers.min.mjs'
 * which broke at runtime: in classic <script src="js/foo.js"> files, the
 * browser resolves dynamic `import()` specifiers against the *script's*
 * URL, not the document base. So `import('./js/vendor/…')` from inside
 * `js/intel.js` produced `<origin>/js/js/vendor/…` and 404'd.
 *
 * The fix resolves each path against `document.baseURI` at config-load
 * time, so every consumer gets the same absolute URL. This test pins the
 * resolved values for a representative deploy base (GitHub Pages
 * subpath), proving the doubled-segment never recurs.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src  = readFileSync(join(root, 'js', 'config.js'), 'utf8');

/** Execute config.js in a sandbox that mimics being served from a sub-path. */
function loadConfigAt(baseURI) {
  const fakeWindow = {};
  const fakeDocument = { baseURI };
  // location is referenced as a fallback only — must still be defined.
  const fakeLocation = { href: baseURI };
  const fn = new Function('window', 'document', 'location', src);
  fn(fakeWindow, fakeDocument, fakeLocation);
  return fakeWindow.ODTAULAI_CONFIG;
}

test('config: vendor URLs resolve against document base (no js/js/ doubling)', () => {
  const cfg = loadConfigAt('https://ilevytate.github.io/Odta/');
  assert.strictEqual(
    cfg.TRANSFORMERS_URL,
    'https://ilevytate.github.io/Odta/js/vendor/transformers/transformers.min.mjs',
  );
  assert.strictEqual(
    cfg.CHRONO_URL,
    'https://ilevytate.github.io/Odta/js/vendor/chrono-node.min.mjs',
  );
  assert.strictEqual(
    cfg.TRANSFORMERS_WASM_DIR,
    'https://ilevytate.github.io/Odta/js/vendor/transformers/',
  );
  assert.strictEqual(
    cfg.MODEL_BASE_PATH,
    'https://ilevytate.github.io/Odta/assets/models/',
  );
  // The specific failure mode the user reported: ensure the resolved URL
  // never contains a doubled `js/js/` segment.
  for (const k of ['TRANSFORMERS_URL', 'CHRONO_URL', 'TRANSFORMERS_WASM_DIR', 'MODEL_BASE_PATH']) {
    assert.ok(!/\/js\/js\//.test(cfg[k]), `${k} doubles js/: ${cfg[k]}`);
  }
});

test('config: works for a root-served deploy too', () => {
  const cfg = loadConfigAt('https://example.com/');
  assert.strictEqual(cfg.TRANSFORMERS_URL, 'https://example.com/js/vendor/transformers/transformers.min.mjs');
  assert.strictEqual(cfg.MODEL_BASE_PATH, 'https://example.com/assets/models/');
});

test('config: degrades gracefully when document.baseURI is missing', () => {
  // Strip both document.baseURI and location.href so the try/catch fallback
  // returns the raw relative path. Behaviour is "no worse than before".
  const fakeWindow = {};
  const fn = new Function('window', 'document', 'location', src);
  fn(fakeWindow, { /* no baseURI */ }, { /* no href */ });
  assert.ok(fakeWindow.ODTAULAI_CONFIG.TRANSFORMERS_URL, 'must still produce some value');
});
