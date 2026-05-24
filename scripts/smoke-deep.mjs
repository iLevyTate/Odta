// Deeper smoke: navigate every tab, type a task, open the task detail modal,
// open Settings classification panel, and verify every data-action across
// each rendered surface has a window function. Reports total handlers seen
// (initial + after-dynamic-render) and any orphans.
import puppeteer from 'puppeteer';
import { installSmoketestGuards } from './smoke-guards.mjs';

const URL = process.env.SMOKE_URL || 'http://localhost:8080/';
const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 240_000 });
const page = await browser.newPage();
const { consoleErrors, pageErrors, unexpected404Urls } = installSmoketestGuards(page);
await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });

async function audit(label){
  const r = await page.evaluate(() => {
    const ATTRS = ['action','onchange','oninput','onkeydown','onkeyup','onsubmit','onfocus','onblur','ontoggle','onpaste'];
    const seen = new Map();
    for (const attr of ATTRS) {
      document.querySelectorAll(`[data-${attr}]`).forEach(el => {
        const name = el.dataset[attr === 'action' ? 'action' : 'on' + attr.replace(/^on/, '')];
        if (!name) return;
        const k = `${attr}:${name}`;
        if (!seen.has(k)) seen.set(k, { attr, name, count: 0, exists: typeof window[name] === 'function' });
        seen.get(k).count++;
      });
    }
    const arr = Array.from(seen.values());
    return {
      total: arr.reduce((s, x) => s + x.count, 0),
      distinct: arr.length,
      missing: arr.filter(x => !x.exists),
    };
  });
  console.log(`\n[${label}]  total=${r.total}  distinct=${r.distinct}  missing=${r.missing.length}`);
  r.missing.forEach(m => console.log(`  MISSING ${m.attr} → ${m.name} (${m.count} els)`));
  return r;
}

await audit('initial');

// Type a task and submit so list rendering kicks in.
await page.click('#taskInput');
await page.keyboard.type('Smoke check task');
await page.keyboard.press('Enter');
await new Promise(r => setTimeout(r, 300));
await audit('after-add-task');

// Open task detail modal — clicks the row body.
const card = await page.$('[data-task-id].task-item, .task-item.clickable');
if (card) {
  await card.click();
  await new Promise(r => setTimeout(r, 300));
  await audit('after-open-task-detail');
  // Close
  const close = await page.$('[data-action="closeTaskDetail"]');
  if (close) { await close.click(); await new Promise(r => setTimeout(r, 200)); }
}

// Open Settings tab — exercises classification render.
await page.click('[data-navtab="settings"]');
await new Promise(r => setTimeout(r, 400));
await audit('after-settings-tab');

// Open Tools tab — calfeeds render lives there.
await page.click('[data-navtab="tools"]');
await new Promise(r => setTimeout(r, 400));
await audit('after-tools-tab');

// Open command palette via Ctrl+K
await page.keyboard.down('Control');
await page.keyboard.press('K');
await page.keyboard.up('Control');
await new Promise(r => setTimeout(r, 300));
await audit('after-cmdk-open');
await page.keyboard.press('Escape');

await page.screenshot({ path: 'tests/screenshots/smoke-deep.png', fullPage: true });

console.log(`\n=== Errors ===`);
console.log(`Console: ${consoleErrors.length}`);
consoleErrors.slice(0, 8).forEach(e => console.log(`  ${e}`));
console.log(`Page:    ${pageErrors.length}`);
pageErrors.slice(0, 8).forEach(e => console.log(`  ${e}`));
console.log(`HTTP 404: ${unexpected404Urls.length}`);
unexpected404Urls.slice(0, 6).forEach(u => console.log(`  ${u}`));

await browser.close();
process.exit((consoleErrors.length || pageErrors.length || unexpected404Urls.length) ? 1 : 0);
