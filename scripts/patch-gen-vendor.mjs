import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let g = readFileSync(join(root, 'js/gen.js'), 'utf8');

g = g.replace(
  "const GEN_TRANSFORMERS_CDN = _GC.TRANSFORMERS_CDN || 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.1';",
  `const _gabs = (rel) => { try { return new URL(rel, (typeof document !== 'undefined' && document.baseURI) || (typeof location !== 'undefined' ? location.href : '')).href; } catch (_) { return rel; } };
const GEN_TRANSFORMERS_URL = _GC.TRANSFORMERS_URL || _gabs('js/vendor/transformers/transformers.min.mjs');
const GEN_TRANSFORMERS_WASM_DIR = _GC.TRANSFORMERS_WASM_DIR || _gabs('js/vendor/transformers/');`,
);

g = g.replace(
  '_genTransformersMod = await import(GEN_TRANSFORMERS_CDN);',
  '_genTransformersMod = await import(GEN_TRANSFORMERS_URL);',
);

if (!g.includes('env.backends.onnx.wasm.wasmPaths')) {
  g = g.replace(
    'env.useBrowserCache = true;',
    'env.backends.onnx.wasm.wasmPaths = GEN_TRANSFORMERS_WASM_DIR;\n  env.useBrowserCache = true;',
  );
}

writeFileSync(join(root, 'js/gen.js'), g);
console.log('patched', !g.includes('cdn.jsdelivr.net'));
