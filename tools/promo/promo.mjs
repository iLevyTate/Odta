#!/usr/bin/env node
/**
 * Odta's promo film: the desktop app in a browser window and the phone app
 * beside it, running one walkthrough in lockstep, at 1920x1080.
 *
 *   node tools/promo/promo.mjs                # tools/promo/odta-wide-1920x1080.mp4
 *   node tools/promo/promo.mjs --fps 10       # a rough preview, a few minutes
 *   node tools/promo/promo.mjs --from 14 --to 22
 *
 * The walkthrough: a seeded week of tasks, a task typed in plain language and
 * parsed into chips as it is typed, smart-add routing it to a list from the
 * on-device embeddings, Board and Calendar, the focus timer, and the command
 * palette finding the new task. Everything runs offline: the embedding
 * weights come from assets/models, and every other request is refused.
 *
 * The recorder is film.mjs beside this file; it needs playwright and ffmpeg.
 * Playwright is not in package.json, since nothing else here uses it:
 *
 *   npm i --no-save playwright
 *   PROMO_PLAYWRIGHT=/path/to/playwright/index.mjs node tools/promo/promo.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { record } from './film.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Runs in each page before the app does. Seeds a week of tasks relative to
 * the page's clock, which is the film's fixed moment, and sets the flags that
 * would otherwise put onboarding over the first frame: the welcome card, the
 * swipe tip, the today banner, and the one-time "Re-indexing complete." banner
 * that a fresh profile shows once the model loads.
 */
function seed() {
  const p2 = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const now = new Date();
  const day = (n) => iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n, 12));
  const T = Date.now();
  const L = { personal: 1, work: 2, home: 3, finance: 4, health: 5, learning: 6, shopping: 7, side: 8 };
  let id = 0;
  const t = (name, o) => ({
    id: ++id, name, status: 'open', priority: 'none', tags: [], dueDate: null, startDate: null,
    estimateMin: 0, description: '', starred: false, completedAt: null, listId: L.personal, archived: false,
    recur: null, order: id * 1000, remindAt: null, reminderFired: false, type: 'task', effort: null,
    energyLevel: null, blockedBy: [], checklist: [], notes: [], url: null, completionNote: null, category: null,
    valuesAlignment: [], valuesNote: null, completions: [], totalSec: 0, sessions: 0,
    created: `${day(-3)} 09:00`, parentId: null, collapsed: false, lastModified: T - 86400000, ...o,
  });
  const tasks = [
    t('Ship v2 onboarding flow', { listId: L.work, priority: 'urgent', dueDate: day(0), tags: ['launch'], starred: true, status: 'progress', effort: 'l', estimateMin: 90, category: 'jobLearningFinances' }),
    t('Review Q4 roadmap with design', { listId: L.work, priority: 'high', dueDate: day(1), tags: ['planning'], status: 'review', estimateMin: 45, category: 'jobLearningFinances' }),
    t('Write release notes', { listId: L.work, priority: 'normal', dueDate: day(2), tags: ['launch', 'docs'], estimateMin: 30, category: 'jobLearningFinances' }),
    t('Fix flaky sync test', { listId: L.work, priority: 'high', dueDate: day(-1), tags: ['bug'], type: 'bug', status: 'blocked', category: 'jobLearningFinances' }),
    t('Pay rent', { listId: L.finance, priority: 'high', dueDate: day(3), tags: ['bills'], category: 'jobLearningFinances' }),
    t('Book dentist appointment', { listId: L.health, priority: 'normal', dueDate: day(4), tags: ['health'], category: 'bodyMindSpirit' }),
    t('Morning run 5k', { listId: L.health, priority: 'low', dueDate: day(0), tags: ['fitness'], category: 'bodyMindSpirit', effort: 's' }),
    t('Groceries for the week', { listId: L.home, priority: 'normal', dueDate: day(5), tags: ['errands'] }),
    t('Call Mom', { listId: L.personal, priority: 'normal', dueDate: day(2), tags: ['family'], category: 'relationships' }),
    t('Finish TypeScript course module 4', { listId: L.learning, priority: 'low', dueDate: day(6), tags: ['study'], category: 'jobLearningFinances' }),
    t('Prototype habit tracker widget', { listId: L.side, priority: 'normal', dueDate: day(8), tags: ['idea'], type: 'idea', category: 'interests' }),
    t('Renew passport', { listId: L.personal, priority: 'high', status: 'done', dueDate: day(-1), completedAt: `${day(-1)}T16:20:00`, tags: ['admin'] }),
    t('Send invoice to Acme', { listId: L.finance, priority: 'normal', status: 'done', dueDate: day(0), completedAt: `${day(0)}T08:40:00`, tags: ['bills'], category: 'jobLearningFinances' }),
  ];
  const lists = [
    [1, 'Personal', '#1a8cff'], [2, 'Work', '#18d4e6'], [3, 'Home & Errands', '#ffb02e'], [4, 'Finance', '#9b7bff'],
    [5, 'Health', '#2ecf73'], [6, 'Learning', '#6aa6d6'], [7, 'Shopping', '#ff5247'], [8, 'Side Projects', '#ff66b3'],
  ].map(([id, name, color]) => ({ id, name, color, description: '', lastModified: T - 86400000 }));
  const state = {
    v: 9, date: iso(now), tasks, taskIdCtr: id, activeTaskId: null, lists, listIdCtr: 8,
    activeListId: null, showAllLists: true, taskView: 'list', smartView: 'all', taskSortBy: 'smart',
    theme: 'dark', activeTab: 'tasks', goals: [], goalIdCtr: 0, timeLog: [], logIdCtr: 0,
    // Newer than anything in the IndexedDB mirror, so loadState keeps this.
    stateEpoch: T - 60000,
  };
  localStorage.setItem('stupind_state', JSON.stringify(state));
  localStorage.setItem('stupind_welcomed', '1');
  localStorage.setItem('odtaulai_swipe_tip_dismissed', '1');
  localStorage.setItem('odtaulai_tb_snooze', iso(now));
  localStorage.setItem('odtaulai_v48_migrated', '1');
  // The re-index banner follows a purge that only runs when this record is
  // missing or stale. Writing it first means there is nothing to purge.
  const open = indexedDB.open('stupind_intel', 1);
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains('embeddings')) db.createObjectStore('embeddings', { keyPath: 'taskId' });
    if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
  };
  open.onsuccess = () => {
    const db = open.result;
    const tx = db.transaction(['meta'], 'readwrite');
    tx.objectStore('meta').put({
      key: 'embed_runtime',
      value: { schemaVer: 'bge-small-en-v1.5-unified-v3', modelId: 'Xenova/bge-small-en-v1.5', dim: 384 },
    });
    tx.oncomplete = () => db.close();
  };
}

/** The desktop glides onto `desk` and clicks it on the beat's last frame; the phone taps `phone` then. */
const press = (desk, phone = desk) => ({
  desktop: async (c) => {
    await c.aim(desk);
    await c.click(null, { at: c.n - 1 });
  },
  phone: (c) => c.click(phone, { at: c.n - 1 }),
});

/** Waits, in real time, for work the fake clock does not drive: model inference, a parse. */
const until = (fn) => (c) => c.once(() => c.page.waitForFunction(fn, null, { timeout: 30000 }));

const TASK = 'Prep investor demo friday 3pm @high #launch';
// `tasks` is a top-level let in the app's scripts: global, but not on window.
// eslint-disable-next-line no-undef
const added = () => typeof tasks !== 'undefined' && tasks.some((t) => /investor/i.test(t.name));

const beats = [
  // The seeded week, still.
  { seconds: 3.0 },
  // Into the add field: the desktop's is always there, the phone's is a sheet.
  press('#taskInput', '#quickAddFab'),
  { seconds: 0.5 },
  // Plain language, parsed as it is typed: the title, @high, #launch, Friday, 3pm.
  { seconds: 4.0, both: (c) => c.type(TASK) },
  { seconds: 1.4 },
  // Desktop: ask the embeddings where it belongs. The phone does this on Enter.
  { seconds: 1.0, desktop: press('#taskEnhanceBtn').desktop },
  { seconds: 1.6, desktop: until(() => window._smartAddPreview) },
  {
    seconds: 1.6,
    desktop: (c) => c.once(async () => {
      await c.page.focus('#taskInput');
      await c.page.keyboard.press('Enter');
      await c.page.waitForFunction(added, null, { timeout: 30000 });
    }),
    phone: (c) => c.once(async () => {
      await c.page.keyboard.press('Enter');
      await c.page.waitForFunction(added, null, { timeout: 30000 });
    }),
  },
  { seconds: 1.2, phone: (c) => c.click('#quickAddSheet .modal-close', { at: Math.round(0.3 * c.fps) }) },
  { seconds: 1.2 },
  // The same week as a board, then as a month.
  { seconds: 1.0, ...press('#viewBoard') },
  { seconds: 2.8 },
  { seconds: 1.0, ...press('#viewCal') },
  { seconds: 3.0 },
  // The focus timer, started.
  { seconds: 1.0, ...press('#navTab-focus', '.bn-btn[data-navtab="focus"]') },
  { seconds: 0.6 },
  { seconds: 1.0, ...press('#ctrls .btn-primary') },
  { seconds: 3.0 },
  // The command palette finds the new task from one word.
  {
    seconds: 0.6,
    desktop: (c) => c.press('Control+k'),
    phone: (c) => c.click('#cmdKBtn'),
  },
  { seconds: 1.0, both: (c) => c.type('demo') },
  { seconds: 1.8 },
  { seconds: 0.5, both: (c) => c.press('Escape') },
  // Back to the list, with the timer still running in the dock.
  { seconds: 1.0, ...press('#navTab-tasks', '.bn-btn[data-navtab="tasks"]') },
  { seconds: 0.4 },
  { seconds: 1.0, ...press('#viewList') },
  { seconds: 2.2 },
].map((b) => ({ seconds: 1.0, ...b }));

const SANS = '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const MONO = '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace';
// The app's own dark slate and its brand gradient, from css/main.css.
const GROUND = [
  'radial-gradient(60% 50% at 46% 44%, rgba(26,140,255,.16), rgba(26,140,255,0) 70%)',
  'radial-gradient(44% 44% at 96% 96%, rgba(24,212,230,.12), rgba(24,212,230,0) 72%)',
  'radial-gradient(40% 40% at 4% 100%, rgba(155,123,255,.10), rgba(155,123,255,0) 72%)',
  'radial-gradient(120% 90% at 50% 45%, #111a27 0%, #0a1019 50%, #05080d 100%)',
].join(',');

await record({
  name: 'Odta',
  script: 'tools/promo/promo.mjs',
  out: resolve(HERE, 'odta-wide-1920x1080.mp4'),
  root: resolve(HERE, '../..'),
  // A Thursday morning, so "friday" means tomorrow.
  now: '2026-10-01T09:30:00-04:00',
  timezone: 'America/New_York',
  colorScheme: 'dark',
  seed,
  // The model loads over WASM from assets/models in a few seconds; chrono is
  // imported up front so the first parse does not race a dynamic import.
  async settle(page) {
    await page.waitForFunction(() => typeof isIntelReady === 'function' && isIntelReady(), null, { timeout: 90000 });
    await page.evaluate(() => loadChrono());
    await page.waitForTimeout(1500);
  },
  bootMs: 30000,
  beats,
  addresses: [{ at: 0, text: 'odta.app' }],
  look: {
    accent: '#1a8cff',
    sans: SANS,
    mono: MONO,
    ground: GROUND,
    chrome: {
      page: '#0a1019',
      edge: 'rgba(233,239,247,.10)',
      glow: '0 0 220px -40px rgba(26,140,255,.30)',
      bar: 'linear-gradient(180deg, #172233, #111a27)',
      rule: 'rgba(0,0,0,.55)',
      dots: '#2a3a52',
      pill: '#0a1019',
      pillEdge: 'rgba(233,239,247,.08)',
      host: '#e9eff7',
      path: '#aab8cc',
      phoneGlow: '0 0 120px -20px rgba(26,140,255,.25)',
    },
  },
  card: {
    css: `
      .wrap { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
      .wrap img { width: 168px; height: 168px; border-radius: 38px; box-shadow: 0 30px 80px -20px rgba(26,140,255,.45); }
      h1 { margin-top: 34px; font-size: 136px; font-weight: 700; letter-spacing: -.04em; line-height: 1;
        background: linear-gradient(135deg, #1a8cff, #14b4e0 50%, #18d4e6); -webkit-background-clip: text; background-clip: text; color: transparent; padding-bottom: .06em; }
      .tag { margin-top: 22px; font-size: 38px; color: #e9eff7; letter-spacing: -.01em; }
      .sub { margin-top: 14px; font-size: 27px; color: #aab8cc; }
      .url { margin-top: 44px; padding: 18px 40px; border-radius: 999px; font-size: 30px; color: #18d4e6;
        background: rgba(17,26,39,.8); border: 1px solid rgba(233,239,247,.10); }`,
    html: `
      <div class="ground"></div>
      <div class="wrap">
        <img src="/icons/icon.svg" alt="">
        <h1>Odta</h1>
        <p class="tag">A task manager and focus timer that understands meaning.</p>
        <p class="sub">On your device, offline. No account, no telemetry.</p>
        <div class="url mono">odta.app</div>
      </div>`,
  },
}, process.argv.slice(2));
