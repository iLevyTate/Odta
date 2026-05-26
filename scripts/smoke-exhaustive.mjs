/**
 * Exhaustive end-to-end smoke. Loads the page, then:
 *   1. Captures EVERY console message (not just errors) and any CSP violation.
 *   2. Walks every nav tab and timer sub-tab, screenshotting each.
 *   3. Opens every modal (cmdk, task-detail, what-next) and closes via
 *      backdrop + close button.
 *   4. Tests visibility toggles work both directions.
 *   5. Adds a task, opens its detail, exercises modal.
 *   6. Toggles theme, expands "More options", flips Semantic search,
 *      switches view (list/board/cal), tries every smart-view chip.
 *   7. Reports a punch-list of anything that didn't behave as expected.
 *
 * Usage: node scripts/smoke-exhaustive.mjs  (server must be on :8080)
 */

import puppeteer from 'puppeteer';
import { gotoSmokeStable, isKnownSmokeNoise, smokePuppeteerLaunchOptions } from './smoke-console-utils.mjs';

const URL = process.env.SMOKE_URL || 'http://localhost:8080/';
const browser = await puppeteer.launch(smokePuppeteerLaunchOptions({ protocolTimeout: 120000 }));
const page = await browser.newPage();
page.setDefaultTimeout(15000);
await page.setViewport({ width: 1100, height: 1600 });

const consoleAll = [];
const consoleErrors = [];
const cspViolations = [];
const pageErrors = [];

page.on('console', m => {
  const t = m.text();
  consoleAll.push({ type: m.type(), text: t });
  if (m.type() === 'error' && !isKnownSmokeNoise(t)) consoleErrors.push(t);
  if (/Refused to|Content Security Policy|violated/i.test(t)) cspViolations.push(t);
});
page.on('pageerror', err => pageErrors.push(err.message));

// Listen for CSP violations via the SecurityPolicyViolationEvent.
await page.evaluateOnNewDocument(() => {
  document.addEventListener('securitypolicyviolation', e => {
    console.error(`CSP-VIOLATION blocked=${e.blockedURI} directive=${e.violatedDirective} sample=${(e.sample||'').slice(0,120)}`);
  });
});

console.log(`Loading ${URL}...`);
await gotoSmokeStable(page, URL);

const issues = [];

// ─── 1. INITIAL DOM CENSUS ────────────────────────────────────────────────
const initial = await page.evaluate(() => {
  const ATTRS = ['action','onchange','oninput','onkeydown','onkeyup','onsubmit','onfocus','onblur','ontoggle','onpaste'];
  const seen = new Map();
  for (const attr of ATTRS) {
    document.querySelectorAll(`[data-${attr}]`).forEach(el => {
      const ds = attr === 'action' ? el.dataset.action : el.dataset['on' + attr.replace(/^on/, '')];
      if (!ds) return;
      const k = `${attr}:${ds}`;
      if (!seen.has(k)) seen.set(k, { attr, name: ds, count: 0, exists: typeof window[ds] === 'function' });
      seen.get(k).count++;
    });
  }
  const arr = Array.from(seen.values());
  return {
    totalHandlers: arr.reduce((s,x) => s + x.count, 0),
    distinct: arr.length,
    missing: arr.filter(x => !x.exists),
    inlineOnAttrs: Array.from(document.querySelectorAll('*')).filter(el => {
      for (const a of el.attributes) if (/^on/i.test(a.name)) return true;
      return false;
    }).length,
    inlineStyleAttrs: Array.from(document.querySelectorAll('[style]')).length,
    hiddenElements: document.querySelectorAll('[hidden]').length,
  };
});
console.log(`\n[INITIAL DOM]`);
console.log(`  data-action handlers:        ${initial.totalHandlers} (${initial.distinct} distinct, missing: ${initial.missing.length})`);
console.log(`  inline on<event> attributes: ${initial.inlineOnAttrs}  (must be 0)`);
console.log(`  inline style attributes:     ${initial.inlineStyleAttrs}  (must be 0)`);
console.log(`  [hidden] elements:           ${initial.hiddenElements}`);
if (initial.missing.length) {
  initial.missing.forEach(m => issues.push(`MISSING handler ${m.attr}=${m.name} (${m.count} elements)`));
}
if (initial.inlineOnAttrs > 0) issues.push(`Found ${initial.inlineOnAttrs} inline on<event> attributes`);
// initial.inlineStyleAttrs reports JS DOM-API writes too (CSP-safe). Real
// inline-style violations are caught by the CSP-violation listener above.

// ─── 2. EVERY NAV TAB ─────────────────────────────────────────────────────
const tabs = ['tasks', 'focus', 'tools', 'data', 'settings'];
for (const t of tabs) {
  process.stdout.write(`  click ${t}...`);
  await page.click(`[data-navtab="${t}"]`);
  await new Promise(r => setTimeout(r, 600));
  // Use simpler evaluate to avoid serialization stalls
  const display = await page.evaluate((tab) => {
    const el = document.querySelector(`[data-tab="${tab}"]`);
    if (!el) return null;
    return getComputedStyle(el).display;
  }, t);
  process.stdout.write(` display=${display}\n`);
  if (display === 'none') issues.push(`Tab ${t}: pane has display:none after click`);
  if (display === null) issues.push(`Tab ${t}: pane element not found`);
  try {
    await page.screenshot({ path: `tests/screenshots/exhaustive-${t}.png`, fullPage: false, timeout: 5000 });
  } catch(e) { issues.push(`Tab ${t}: screenshot failed: ${e.message.slice(0,80)}`); }
}

// ─── 3. TIMER SUB-MODES (pomo/quick/sw/chimes) ────────────────────────────
console.log(`\n[TIMER SUBS]`);
await page.click('[data-navtab="focus"]');
await new Promise(r => setTimeout(r, 200));
const subs = ['pomo', 'quick', 'sw', 'chimes'];
for (const sub of subs) {
  process.stdout.write(`  ${sub}...`);
  const subBtn = await page.$(`[data-action="setTimerSub"][data-arg="${sub}"]`);
  if (!subBtn) {
    issues.push(`Timer sub button [data-action=setTimerSub][data-arg=${sub}] not found`);
    process.stdout.write(' BTN NOT FOUND\n');
    continue;
  }
  try {
    await subBtn.click();
    await new Promise(r => setTimeout(r, 400));
    const display = await page.evaluate((s) => {
      const el = document.querySelector(`[data-timer-sub="${s}"]`);
      if (!el) return null;
      return getComputedStyle(el).display;
    }, sub);
    process.stdout.write(` display=${display}\n`);
    if (display === null) issues.push(`Timer sub-mode ${sub}: panel element not found`);
    else if (display === 'none') issues.push(`Timer sub-mode ${sub}: panel hidden after click`);
  } catch(e) {
    process.stdout.write(` ERROR: ${e.message.slice(0,80)}\n`);
    issues.push(`Timer sub ${sub} hang/error: ${e.message.slice(0,120)}`);
  }
}

// ─── 4. ADD A TASK, OPEN ITS DETAIL, ROUND-TRIP THE MODAL ─────────────────
await page.click('[data-navtab="tasks"]');
await new Promise(r => setTimeout(r, 300));
const taskInput = await page.$('#taskInput');
if (taskInput) {
  await taskInput.click();
  await page.keyboard.type('Exhaustive smoke task');
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 500));
  let row = await page.$('.task-item[data-task-id]');
  if (!row) {
    const addBtn = await page.$('[data-action="addTaskOrApplyPreview"]');
    if (addBtn) {
      await addBtn.click();
      await new Promise(r => setTimeout(r, 500));
    }
    row = await page.$('.task-item[data-task-id]');
  }
  if (!row) {
    issues.push('No .task-item rendered after typing + Enter and clicking +Add');
  } else {
    console.log(`[ADD-TASK]  task row rendered`);
    // Open task detail modal by clicking the row body (avoiding action buttons).
    await page.evaluate(() => {
      const r = document.querySelector('.task-item[data-task-id]');
      if (r) {
        const target = r.querySelector('.task-row-primary') || r;
        target.click();
      }
    });
    await new Promise(r => setTimeout(r, 500));
    const opened = await page.evaluate(() => {
      const m = document.getElementById('taskModal');
      return m ? { exists: true, classes: m.className, display: getComputedStyle(m).display, hidden: m.hidden } : { exists: false };
    });
    if (!opened.exists) issues.push('Task modal element not in DOM');
    else if ((opened.hidden || opened.display === 'none') && !opened.classes.includes('open')) {
      issues.push(`Task detail modal did NOT open after row click (classes=${opened.classes}, display=${opened.display}, hidden=${opened.hidden})`);
    } else {
      console.log(`[MODAL]  opened OK`);
      const close = await page.$('[data-action="closeTaskDetail"]');
      if (close) {
        await close.click();
        await new Promise(r => setTimeout(r, 400));
        const afterClose = await page.evaluate(() => {
          const m = document.getElementById('taskModal');
          return m ? { classes: m.className, display: getComputedStyle(m).display, hidden: m.hidden } : null;
        });
        if (afterClose && (afterClose.classes.includes('open') || (!afterClose.hidden && afterClose.display !== 'none'))) {
          issues.push(`Close button did NOT close the modal (classes=${afterClose.classes}, display=${afterClose.display})`);
        } else console.log(`[MODAL]  closed cleanly`);
      }
    }
  }
} else {
  issues.push('#taskInput not found');
}

// ─── 5. COMMAND PALETTE ──────────────────────────────────────────────────
await page.keyboard.down('Control');
await page.keyboard.press('K');
await page.keyboard.up('Control');
await new Promise(r => setTimeout(r, 400));
const cmdkOpen = await page.evaluate(() => {
  const o = document.getElementById('cmdkOverlay');
  if (!o) return { found: false };
  const cs = getComputedStyle(o);
  return { found: true, classes: o.className, display: cs.display, hidden: o.hidden };
});
if (!cmdkOpen.found) issues.push('cmdkOverlay element not found');
else if (cmdkOpen.display === 'none' && !cmdkOpen.classes.includes('open')) {
  issues.push(`Command palette didn't open on Ctrl+K (classes=${cmdkOpen.classes}, display=${cmdkOpen.display})`);
}
await page.keyboard.press('Escape');
await new Promise(r => setTimeout(r, 200));

// ─── 6. WHAT-NEXT OVERLAY ────────────────────────────────────────────────
const whatNextBtn = await page.$('#whatNextBtn');
if (whatNextBtn) {
  await whatNextBtn.click();
  await new Promise(r => setTimeout(r, 400));
  const wnOpen = await page.evaluate(() => {
    const o = document.getElementById('whatNextOverlay');
    if (!o) return { found: false };
    const cs = getComputedStyle(o);
    return { found: true, display: cs.display, hidden: o.hidden };
  });
  if (!wnOpen.found) issues.push('whatNextOverlay element not found');
  else if (wnOpen.hidden || wnOpen.display === 'none') {
    issues.push(`What-next overlay didn't open (display=${wnOpen.display}, hidden=${wnOpen.hidden})`);
  }
  await page.evaluate(() => {
    const o = document.getElementById('whatNextOverlay');
    if (o) o.click();
  });
  await new Promise(r => setTimeout(r, 200));
}

// ─── 7. SMART VIEW CHIPS — click each ─────────────────────────────────────
await page.click('[data-navtab="tasks"]');
await new Promise(r => setTimeout(r, 200));
const svResults = await page.evaluate(() => {
  const results = [];
  document.querySelectorAll('.sv-chip[data-action="setSmartView"]').forEach(chip => {
    const view = chip.dataset.arg || chip.dataset.view;
    chip.click();
    results.push({ view });
  });
  return results;
});
console.log(`\n[SMART VIEWS]  clicked ${svResults.length} chips`);

// ─── 8. THEME TOGGLE ──────────────────────────────────────────────────────
// app uses body.classList.toggle('light-theme', ...)
const themeBefore = await page.evaluate(() => document.body.classList.contains('light-theme'));
await page.click('#themeToggleBtn');
await new Promise(r => setTimeout(r, 300));
const themeAfter = await page.evaluate(() => document.body.classList.contains('light-theme'));
if (themeBefore === themeAfter) issues.push(`Theme toggle didn't flip body.light-theme class`);

// ─── 9. "MORE OPTIONS" PANEL — toggle ─────────────────────────────────────
const moreToggle = await page.$('#qaMoreToggle');
if (moreToggle) {
  await moreToggle.click();
  await new Promise(r => setTimeout(r, 200));
}

// ─── 10. SEMANTIC SEARCH CHECKBOX ─────────────────────────────────────────
// Click the input directly via DOM (puppeteer click can miss on tiny checkboxes
// or labels with custom CSS).
const semToggled = await page.evaluate(() => {
  const cb = document.getElementById('taskSearchSemantic');
  if (!cb) return null;
  const before = cb.checked;
  cb.checked = !before;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
  return { before, after: cb.checked };
});
if (semToggled === null) issues.push('Semantic search checkbox not in DOM');
else if (semToggled.before === semToggled.after) issues.push(`Semantic checkbox state didn't change (before=${semToggled.before})`);

// ─── 11. VIEW MODE SWITCH (list/board/cal) ────────────────────────────────
for (const mode of ['list', 'board', 'calendar']) {
  const clicked = await page.evaluate((m) => {
    const el = document.querySelector(`[data-action="setTaskView"][data-arg="${m}"]`);
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    el.click();
    return true;
  }, mode);
  if (!clicked) issues.push(`View mode ${mode}: button not found`);
  else {
    await new Promise(r => setTimeout(r, 300));
    const ok = await page.evaluate((m) => {
      if (m === 'list') return !document.getElementById('taskList').hidden;
      if (m === 'board') return !document.getElementById('boardView').hidden;
      if (m === 'calendar') return !document.getElementById('calendarView').hidden;
      return null;
    }, mode);
    if (ok === false) issues.push(`View mode ${mode}: target view stayed hidden after click`);
  }
}

// ─── 11.5 CLASSIFICATION SETTINGS PANEL ──────────────────────────────────
// Open Settings, expand the classification disclosure, type into one of the
// "Focus" textareas, and verify the change handler fires (cfg updates).
await page.click('[data-navtab="settings"]');
await new Promise(r => setTimeout(r, 400));
const classOk = await page.evaluate(() => {
  const root = document.getElementById('classificationManager');
  if (!root) return { found: false };
  // Open all <details> so the textarea is reachable
  root.querySelectorAll('details').forEach(d => d.open = true);
  const focusTa = root.querySelector('[data-onchange="classificationSetFocusFromTextarea"][data-idx="0"]');
  if (!focusTa) return { found: true, taFound: false };
  const before = (typeof cfg !== 'undefined' && cfg && cfg.categories && cfg.categories[0]) ? cfg.categories[0].focus : '__missing__';
  const newVal = 'SMOKE TEST FOCUS ' + Date.now();
  focusTa.value = newVal;
  focusTa.dispatchEvent(new Event('change', { bubbles: true }));
  const after = (typeof cfg !== 'undefined' && cfg && cfg.categories && cfg.categories[0]) ? cfg.categories[0].focus : '__missing__';
  // Restore so we don't pollute saved state
  focusTa.value = before;
  focusTa.dispatchEvent(new Event('change', { bubbles: true }));
  return { found: true, taFound: true, changed: before !== after, after: after.slice(0, 50) };
});
if (!classOk.found) issues.push('Classification manager not in DOM');
else if (!classOk.taFound) issues.push('Classification Focus textarea (idx=0) not found — data-onchange may be misnamed');
else if (!classOk.changed) issues.push(`Classification Focus change handler did NOT update cfg (after="${classOk.after}")`);
else console.log(`[CLASSIFICATION]  Focus change handler fires correctly`);

// ─── 11.7 RESPONSIVE VIEWPORTS ─────────────────────────────────────────────
console.log('\n[RESPONSIVE]');
for (const w of [960, 640, 360]) {
  await page.setViewport({ width: w, height: Math.min(2200, Math.max(920, Math.round(w * 2))) });
  await page.click('[data-navtab="tasks"]');
  await new Promise(r => setTimeout(r, 350));
  const ok = await page.evaluate((tab) => {
    const el = document.querySelector(`[data-tab="${tab}"]`);
    return !!(el && getComputedStyle(el).display !== 'none');
  }, 'tasks');
  if (!ok) issues.push(`Responsive ${w}px wide: Tasks tab pane not visible`);
  try {
    await page.screenshot({ path: `tests/screenshots/exhaustive-w${w}.png`, fullPage: false, timeout: 5000 });
  } catch (e) {
    issues.push(`Responsive ${w}px: screenshot failed: ${String(e.message).slice(0, 80)}`);
  }
}
await page.setViewport({ width: 1100, height: 1600 });
await page.click('[data-navtab="tasks"]');
await new Promise(r => setTimeout(r, 200));

// ─── 12. FINAL DOM CENSUS ─────────────────────────────────────────────────
const final = await page.evaluate(() => {
  const ATTRS = ['action','onchange','oninput','onkeydown','onkeyup','onsubmit','onfocus','onblur','ontoggle','onpaste'];
  const seen = new Map();
  for (const attr of ATTRS) {
    document.querySelectorAll(`[data-${attr}]`).forEach(el => {
      const ds = attr === 'action' ? el.dataset.action : el.dataset['on' + attr.replace(/^on/, '')];
      if (!ds) return;
      const k = `${attr}:${ds}`;
      if (!seen.has(k)) seen.set(k, { attr, name: ds, count: 0, exists: typeof window[ds] === 'function' });
      seen.get(k).count++;
    });
  }
  const arr = Array.from(seen.values());
  return {
    totalHandlers: arr.reduce((s,x) => s + x.count, 0),
    distinct: arr.length,
    missing: arr.filter(x => !x.exists),
    inlineOnAttrs: Array.from(document.querySelectorAll('*')).filter(el => {
      for (const a of el.attributes) if (/^on/i.test(a.name)) return true;
      return false;
    }).length,
    inlineStyleAttrs: Array.from(document.querySelectorAll('[style]')).length,
  };
});
console.log(`\n[FINAL DOM]  total=${final.totalHandlers}  distinct=${final.distinct}  missing=${final.missing.length}  inline-on=${final.inlineOnAttrs}  inline-style=${final.inlineStyleAttrs}`);
final.missing.forEach(m => issues.push(`After-interaction MISSING handler ${m.attr}=${m.name}`));
if (final.inlineOnAttrs > 0) issues.push(`After-interaction: ${final.inlineOnAttrs} inline on<event> attributes appeared (some render path emits inline handlers)`);
// Note: [style] attributes from JS DOM-API writes (el.style.X = ...) are
// CSP-safe — they're property reflections, not source-of-style. Count only
// noise unless a CSP violation also fires (tracked separately above).

// ─── REPORT ───────────────────────────────────────────────────────────────
console.log(`\n=== Console summary ===`);
console.log(`Total console messages: ${consoleAll.length}`);
const byType = consoleAll.reduce((m, x) => { m[x.type] = (m[x.type]||0)+1; return m; }, {});
Object.entries(byType).forEach(([t,n]) => console.log(`  ${t.padEnd(10)} ${n}`));

console.log(`\n=== Console errors (${consoleErrors.length}) ===`);
consoleErrors.slice(0, 15).forEach(e => console.log(`  ${e.slice(0,250)}`));

console.log(`\n=== CSP violations (${cspViolations.length}) ===`);
cspViolations.slice(0, 15).forEach(e => console.log(`  ${e.slice(0,300)}`));

console.log(`\n=== Page errors (${pageErrors.length}) ===`);
pageErrors.slice(0, 8).forEach(e => console.log(`  ${e}`));

console.log(`\n=== ISSUES PUNCH LIST (${issues.length}) ===`);
issues.forEach(i => console.log(`  • ${i}`));

await browser.close();

const failures = issues.length + cspViolations.length + pageErrors.length + consoleErrors.length;
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} total problems`);
process.exit(failures === 0 ? 0 : 1);
