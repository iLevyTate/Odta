#!/usr/bin/env node
/**
 * Odta's promo film: the desktop app in a browser window and the phone app
 * beside it, running one walkthrough in lockstep, at 1920x1080, 35.5 seconds.
 *
 *   node tools/promo/promo.mjs --audio narration.mov   # tools/promo/odta-wide-1920x1080.mp4
 *   node tools/promo/promo.mjs --fps 8                 # a rough, silent preview
 *   node tools/promo/promo.mjs --from 12 --to 22       # one stretch of the walkthrough
 *
 * The beats follow the phone film's narration word for word, so its
 * soundtrack lays straight under this one: a title card, then a task typed
 * the way you would say it ("date, priority, tag"), one ticked off, List,
 * Board and Calendar, the on-device model in Tools, a semantic search for
 * "money" that finds "Review Q3 budget", the Pomodoro timer started, two
 * devices pairing with a code, a task's details, and the end card.
 *
 * Everything runs offline. The embedding weights come from assets/models.
 * Sync's signalling server is out of reach in an offline recording, so PeerJS
 * is replaced by a stand-in that connects to nothing and then waits, which is
 * the screen a device shows until its partner dials in.
 *
 * The recorder is film.mjs beside this file; it needs playwright and ffmpeg.
 * Playwright is not in package.json, since nothing else here uses it:
 *
 *   npm i --no-save playwright
 *   PROMO_PLAYWRIGHT=/path/to/playwright/index.mjs node tools/promo/promo.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cue, record } from './film.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Runs in each page before the app does: the phone film's Personal list,
 * dated from the page's clock, and the flags that would otherwise put
 * onboarding over the first frame (the welcome card, the swipe tip, the today
 * banner, and the one-time "Re-indexing complete." banner a fresh profile
 * shows once the model loads).
 */
function seed() {
  const p2 = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const now = new Date();
  const day = (n) => iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n, 12));
  const T = Date.now();
  let id = 0;
  const t = (name, o) => ({
    id: ++id, name, status: 'open', priority: 'none', tags: [], dueDate: null, startDate: null,
    estimateMin: 0, description: '', starred: false, completedAt: null, listId: 1, archived: false,
    recur: null, order: id * 1000, remindAt: null, reminderFired: false, type: 'task', effort: null,
    energyLevel: null, blockedBy: [], checklist: [], notes: [], url: null, completionNote: null, category: null,
    valuesAlignment: [], valuesNote: null, completions: [], totalSec: 0, sessions: 0,
    created: `${day(0)} 03:11`, parentId: null, collapsed: false, lastModified: T - 3600000, ...o,
  });
  const tasks = [
    t('Ship the v78 release notes', { priority: 'high', dueDate: day(4), tags: ['work'], starred: true, category: 'jobLearningFinances' }),
    t('Read 20 pages of Dune', { dueDate: day(0), tags: ['learning'], category: 'jobLearningFinances' }),
    t('Review Q3 budget', { dueDate: day(1), tags: ['finance'], category: 'jobLearningFinances' }),
    t('Call mom', { dueDate: day(6), tags: ['family'], category: 'relationships' }),
    t('Book flights for the Lisbon trip', { dueDate: day(7), tags: ['travel'], category: 'interests' }),
    t('Water the plants', { status: 'done', dueDate: day(0), completedAt: `${day(0)}T08:05:00`, tags: ['home'] }),
  ];
  const lists = [
    [1, 'Personal', '#1a8cff'], [2, 'Work', '#18d4e6'], [3, 'Home & Errands', '#ffb02e'], [4, 'Finance', '#9b7bff'],
    [5, 'Health', '#2ecf73'], [6, 'Learning', '#6aa6d6'], [7, 'Shopping', '#ff5247'], [8, 'Side Projects', '#ff66b3'],
  ].map(([id, name, color]) => ({ id, name, color, description: '', lastModified: T - 86400000 }));
  localStorage.setItem('stupind_state', JSON.stringify({
    v: 9, date: iso(now), tasks, taskIdCtr: id, activeTaskId: null, lists, listIdCtr: 8,
    activeListId: 1, showAllLists: false, taskView: 'list', smartView: 'all', taskSortBy: 'smart',
    theme: 'dark', activeTab: 'tasks', goals: [], goalIdCtr: 0, timeLog: [], logIdCtr: 0,
    // Newer than anything in the IndexedDB mirror, so loadState keeps this.
    stateEpoch: T - 60000,
  }));
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

/** Opens, then waits: what a device shows before its partner connects. */
const PEER = `window.Peer = class Peer {
  constructor(id) { this.id = id; this.handlers = {}; this.open = false;
    setTimeout(() => { this.open = true; this.emit('open', id); }, 400); }
  on(e, f) { (this.handlers[e] ||= []).push(f); return this; }
  off() { return this; }
  emit(e, ...a) { (this.handlers[e] || []).forEach((f) => f(...a)); }
  connect() { return { on() { return this; }, close() {}, send() {} }; }
  disconnect() {} reconnect() {} destroy() {}
};`;

/** The desktop glides onto `desk` and clicks it on the beat's last frame; the phone taps `phone` then. */
const press = (desk, phone = desk) => ({
  desktop: async (c) => {
    await c.aim(desk);
    await c.click(null, { at: c.n - 1 });
  },
  phone: (c) => c.click(phone, { at: c.n - 1 }),
});
const nav = (tab) => press(`#navTab-${tab}`, `.bn-btn[data-navtab="${tab}"]`);

/** Waits, in real time, for work the fake clock does not drive: model inference, a parse. */
const until = (fn) => (c) => c.once(() => c.page.waitForFunction(fn, null, { timeout: 30000 }));

const TASK = 'Call the dentist tomorrow 3pm @high #health';
// `tasks` is a top-level let in the app's scripts: global, but not on window.
// eslint-disable-next-line no-undef
const added = () => typeof tasks !== 'undefined' && tasks.some((t) => /dentist/i.test(t.name));
const found = () => [...document.querySelectorAll('.task-name')].some((e) => e.offsetParent && /Review Q3 budget/.test(e.textContent));

// Walkthrough seconds. The film's clock is these plus the 2 s title card, so
// "date" at 4.84 s in the narration is 2.84 here.
const beats = cue([
  [0.0, {}],
  // "Type it out the way you'd say it: date, priority, tag."
  [0.9, press('#taskInput', '#quickAddFab')],
  [1.4, {}],
  [1.8, { both: (c) => c.type(TASK, { share: 0.95 }) }],
  [4.6, {}],
  [5.1, {
    desktop: (c) => c.once(async () => {
      await c.page.focus('#taskInput');
      await c.page.keyboard.press('Enter');
      await c.page.waitForFunction(added, null, { timeout: 30000 });
    }),
    phone: (c) => c.once(async () => {
      await c.page.keyboard.press('Enter');
      await c.page.waitForFunction(added, null, { timeout: 30000 });
    }),
  }],
  [5.5, { phone: (c) => c.click('#quickAddSheet .modal-close', { at: Math.round(0.15 * c.fps) }) }],
  [5.9, {}],
  // One ticked off.
  [6.3, press('[data-action="toggleTaskDoneQuick"][data-arg="2"]')],
  [6.8, {}],
  // "List, board, calendar."
  [7.9, press('#viewBoard')],
  [8.4, {}],
  [8.9, press('#viewCal')],
  [9.35, {}],
  [10.05, press('#viewList')],
  [10.5, {}],
  // "The tiny embedding model runs on the device."
  [10.7, nav('tools')],
  [11.15, {}],
  [13.0, nav('tasks')],
  // "Type money. Up comes Review Q3 budget."
  [13.45, press('#fbSearch')],
  [13.9, press('.task-search-semantic')],
  [14.3, press('#taskSearch')],
  [14.65, { both: (c) => c.type('money', { share: 0.9 }) }],
  [15.35, { both: until(found) }],
  [17.3, press('#taskSearchClear')],
  [17.65, press('#fbSearch')],
  // "Pomodoro timer running while you work."
  [18.0, nav('focus')],
  [18.4, {}],
  [18.6, press('#ctrls .btn-primary')],
  [19.0, {}],
  [20.4, nav('tasks')],
  [20.8, {}],
  // "Two devices pair with a code. No server in the middle."
  [21.5, nav('settings')],
  [21.9, {}],
  [22.1, press('[data-action="jumpToSettingsSection"][data-arg="set-integrations"]')],
  [22.5, { both: (c) => c.bring('[data-action="syncEnable"]') }],
  [22.9, press('[data-action="syncEnable"]')],
  [23.3, {}],
  // "Free, open source." Then a task's details.
  [25.2, nav('tasks')],
  [25.6, {}],
  [25.8, press('.task-name:text-is("Ship the v78 release notes")')],
  [26.3, {}],
  [29.7, press('#taskModal .mfoot-save')],
  [30.1, {}],
], 30.5);

const SANS = '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const MONO = '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace';
// The app's own dark slate and its brand gradient, from css/main.css.
const GROUND = [
  'radial-gradient(60% 50% at 46% 44%, rgba(26,140,255,.16), rgba(26,140,255,0) 70%)',
  'radial-gradient(44% 44% at 96% 96%, rgba(24,212,230,.12), rgba(24,212,230,0) 72%)',
  'radial-gradient(40% 40% at 4% 100%, rgba(155,123,255,.10), rgba(155,123,255,0) 72%)',
  'radial-gradient(120% 90% at 50% 45%, #111a27 0%, #0a1019 50%, #05080d 100%)',
].join(',');
// Title and end card share one centred stack.
const CARD = `
  .wrap { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
  .wrap img { width: 150px; height: 150px; border-radius: 34px; box-shadow: 0 30px 80px -20px rgba(26,140,255,.45); }
  h1 { margin-top: 30px; font-size: 128px; font-weight: 700; letter-spacing: -.04em; line-height: 1; color: #e9eff7; }
  .tag { margin-top: 24px; font-size: 34px; color: #aab8cc; max-width: 900px; line-height: 1.35; }
  .chips { margin-top: 34px; display: flex; gap: 14px; justify-content: center; }
  .chips span { padding: 10px 22px; border-radius: 999px; font-size: 24px; font-weight: 600; color: #e9eff7;
    background: rgba(17,26,39,.9); border: 1px solid rgba(233,239,247,.12); }
  .url { margin-top: 30px; font-size: 34px; font-weight: 600; color: #1a8cff; }`;

await record({
  name: 'Odta',
  script: 'tools/promo/promo.mjs',
  out: resolve(HERE, 'odta-wide-1920x1080.mp4'),
  root: resolve(HERE, '../..'),
  // The phone film's Monday, so "tomorrow" is Tuesday the 22nd as it was there.
  now: '2026-09-21T09:30:00-04:00',
  timezone: 'America/New_York',
  colorScheme: 'dark',
  seed,
  replace: { '/js/vendor/peerjs.min.js': { type: 'text/javascript; charset=utf-8', body: PEER } },
  // The model loads over WASM from assets/models in a few seconds. Chrono is
  // imported up front so the first parse does not race a dynamic import, and
  // every task is embedded so semantic search has something to rank.
  async settle(page) {
    await page.waitForFunction(() => typeof isIntelReady === 'function' && isIntelReady(), null, { timeout: 90000 });
    await page.evaluate(async () => {
      loadChrono();
      // eslint-disable-next-line no-undef
      for (const t of tasks.filter((x) => !x.archived)) await embedStore.ensure(t);
    });
    await page.waitForTimeout(1500);
  },
  bootMs: 30000,
  beats,
  fade: { in: 0.6, out: 0.8 },
  dip: 0.6,
  intro: {
    seconds: 2.0,
    css: CARD,
    html: `
      <div class="ground"></div>
      <div class="wrap">
        <img src="/icons/icon.svg" alt="">
        <h1>Odta</h1>
        <p class="tag">Tasks, focus timer and a calendar that live entirely on your phone.</p>
      </div>`,
  },
  // 35.46 s of narration: 2 s of title, 30.5 s of walkthrough, this.
  outro: 2.96,
  card: {
    css: CARD,
    html: `
      <div class="ground"></div>
      <div class="wrap">
        <img src="/icons/icon.svg" alt="">
        <h1>Odta</h1>
        <div class="chips"><span>No account</span><span>No cloud</span><span>Works offline</span><span>Open source</span></div>
        <div class="url">odta.app</div>
      </div>`,
  },
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
}, process.argv.slice(2));
