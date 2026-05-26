/**
 * One-shot browser smoke test: load the page, capture console errors, click
 * each main nav tab, screenshot, and report.
 *
 * Usage: node scripts/smoke-check.mjs
 *   (assumes a server is already running on localhost:8080)
 */
import puppeteer from 'puppeteer';
import { filterSmokeConsoleErrors, gotoSmokeStable, smokePuppeteerLaunchOptions } from './smoke-console-utils.mjs';

const URL = process.env.SMOKE_URL || 'http://localhost:8080/';
const browser = await puppeteer.launch(smokePuppeteerLaunchOptions());
const page = await browser.newPage();

const consoleErrors = [];
const pageErrors = [];

page.on('console', msg => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', err => pageErrors.push(err.message));

console.log(`Loading ${URL}...`);
await gotoSmokeStable(page, URL);

const counts = await page.evaluate(() => ({
  dataAction: document.querySelectorAll('[data-action]').length,
  navTab: document.querySelectorAll('.nav-tab').length,
  svChip: document.querySelectorAll('.sv-chip').length,
}));
const dataActionCount = counts.dataAction;
const navTabCount = counts.navTab;
const svChipCount = counts.svChip;

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
  let visible = false;
  try {
    visible = await page.$eval(`[data-tab="${t}"]`, el => el.style.display !== 'none');
  } catch (e) {
    console.log(`  click ${t}: visibility check FAILED (${e.message})`);
  }
  console.log(`  click ${t}: tab pane visible = ${visible}`);
}

await page.screenshot({ path: 'tests/screenshots/smoke-after-h2-migration.png', fullPage: true });

const actionableConsole = filterSmokeConsoleErrors(consoleErrors);
console.log(`\nConsole errors (${consoleErrors.length} raw → ${actionableConsole.length} actionable):`);
actionableConsole.slice(0, 10).forEach(e => console.log(`  ${e}`));
console.log(`\nPage errors (${pageErrors.length}):`);
pageErrors.slice(0, 10).forEach(e => console.log(`  ${e}`));

await browser.close();
process.exit(actionableConsole.length + pageErrors.length > 0 ? 1 : 0);
