// Boot the page in headless Chrome, then for every data-action /
// data-on<event> attribute in the DOM check that window[name] is a
// function. Reports any orphans the human dispatcher would silently no-op.
import puppeteer from 'puppeteer';
import { installSmoketestGuards } from './smoke-guards.mjs';

const URL = process.env.SMOKE_URL || 'http://localhost:8080/';
const browser = await puppeteer.launch({ headless: 'new' });
const page = await browser.newPage();
const { consoleErrors, pageErrors, unexpected404Urls } = installSmoketestGuards(page);
await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });

const report = await page.evaluate(() => {
  const ATTRS = ['action', 'onchange', 'oninput', 'onkeydown', 'onkeyup', 'onsubmit', 'onfocus', 'onblur', 'ontoggle', 'onpaste'];
  const seen = new Map(); // name -> { count, attr }
  for (const attr of ATTRS) {
    document.querySelectorAll(`[data-${attr}]`).forEach(el => {
      const name = el.dataset[attr === 'action' ? 'action' : 'on' + attr.replace(/^on/, '')];
      if (!name) return;
      const k = `${attr}:${name}`;
      seen.set(k, (seen.get(k) || { attr, name, count: 0, exists: typeof window[name] === 'function' }));
      seen.get(k).count++;
    });
  }
  const arr = Array.from(seen.values());
  return {
    total:    arr.reduce((s, x) => s + x.count, 0),
    distinct: arr.length,
    missing:  arr.filter(x => !x.exists),
    present:  arr.filter(x => x.exists).length,
  };
});

console.log(`Total handler attributes:     ${report.total}`);
console.log(`Distinct (attr + fn) pairs:   ${report.distinct}`);
console.log(`Resolved on window:           ${report.present}`);
console.log(`MISSING:                      ${report.missing.length}`);
report.missing.forEach(m => console.log(`  ${m.attr.padEnd(10)} ${m.name}  (${m.count} elements)`));

console.log(`\nConsole errors: ${consoleErrors.length}`);
consoleErrors.slice(0, 5).forEach(e => console.log(`  ${e}`));
console.log(`Page errors:    ${pageErrors.length}`);
pageErrors.slice(0, 5).forEach(e => console.log(`  ${e}`));
if (unexpected404Urls.length) {
  console.log(`\nUnexpected HTTP 404s (${unexpected404Urls.length}):`);
  unexpected404Urls.slice(0, 8).forEach(u => console.log(`  ${u}`));
}

await browser.close();
process.exit(
  report.missing.length || consoleErrors.length || pageErrors.length || unexpected404Urls.length ? 1 : 0,
);
