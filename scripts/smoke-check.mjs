/**
 * One-shot browser smoke test: load the page, capture console errors, click
 * each main nav tab, screenshot, and report.
 *
 * Usage: node scripts/smoke-check.mjs
 *   (assumes a server is already running on localhost:8080)
 */
import puppeteer from 'puppeteer';
import { installSmoketestGuards } from './smoke-guards.mjs';

const URL = process.env.SMOKE_URL || 'http://localhost:8080/';
const browser = await puppeteer.launch({ headless: 'new' });
const page = await browser.newPage();
const { consoleErrors, pageErrors, unexpected404Urls } = installSmoketestGuards(page);

console.log(`Loading ${URL}...`);
await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });

const dataActionCount = await page.$$eval('[data-action]', els => els.length);
const navTabCount = await page.$$eval('.nav-tab', els => els.length);
const svChipCount = await page.$$eval('.sv-chip', els => els.length);

console.log(`\nDOM census after load:`);
console.log(`  [data-action] elements: ${dataActionCount}`);
console.log(`  .nav-tab elements:      ${navTabCount}`);
console.log(`  .sv-chip elements:      ${svChipCount}`);

const tabs = ['focus', 'tools', 'data', 'settings', 'tasks'];
for (const t of tabs) {
  const sel = `[data-navtab="${t}"]`;
  const el = await page.$(sel);
  if (!el) { console.log(`  click ${t}: NO ELEMENT`); continue; }
  await el.click();
  await new Promise(r => setTimeout(r, 100));
  const visible = await page.$eval(`[data-tab="${t}"]`, el => el.style.display !== 'none');
  console.log(`  click ${t}: tab pane visible = ${visible}`);
}

await page.screenshot({ path: 'tests/screenshots/smoke-after-h2-migration.png', fullPage: true });

console.log(`\nConsole errors (${consoleErrors.length}):`);
consoleErrors.slice(0, 10).forEach(e => console.log(`  ${e}`));
console.log(`\nPage errors (${pageErrors.length}):`);
pageErrors.slice(0, 10).forEach(e => console.log(`  ${e}`));
console.log(`\nUnexpected HTTP 404s (${unexpected404Urls.length}):`);
unexpected404Urls.slice(0, 10).forEach(u => console.log(`  ${u}`));

await browser.close();
process.exit(consoleErrors.length + pageErrors.length + unexpected404Urls.length > 0 ? 1 : 0);
