/**
 * Shared Puppeteer hooks for OdTauLai smoke scripts.
 *
 * Transformers.js probes fp32 ONNX first (`model.onnx`); repos that only ship
 * `model_quantized.onnx` incur a benign same-origin 404. ONNX Runtime WASM
 * also logs yellow warnings via `console.error`, which Puppeteer captures as
 * type "error".
 */
export function installSmoketestGuards(page) {
  const consoleErrors = [];
  const pageErrors = [];
  const unexpected404Urls = [];

  page.on('response', response => {
    if (response.status() !== 404) return;
    let pathname = '';
    try {
      pathname = new URL(response.url()).pathname.replace(/\\/g, '/');
    } catch {
      unexpected404Urls.push(response.url());
      return;
    }
    if (/\/onnx\/model\.onnx$/i.test(pathname)) return;
    unexpected404Urls.push(response.url());
  });

  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const t = msg.text();
    if (/\[W:onnxruntime:/.test(t)) return;
    if (
      unexpected404Urls.length === 0 &&
      t.includes('Failed to load resource') &&
      t.includes('404')
    ) {
      return;
    }
    consoleErrors.push(t);
  });

  page.on('pageerror', err => pageErrors.push(err.message));

  return { consoleErrors, pageErrors, unexpected404Urls };
}
