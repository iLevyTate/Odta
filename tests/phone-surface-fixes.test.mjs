/**
 * Phone-surface regressions found by driving the app in a 390×844 viewport:
 *   - the first-run CTA focused an input that only exists inside the quick-add
 *     sheet on a phone, so the button did nothing;
 *   - the row's primary tap target had shrunk below the WCAG 2.5.5 minimum;
 *   - the task title was squeezed to ~67px by the row's fixed furniture;
 *   - engine-level model errors were sliced mid-sentence into three surfaces;
 *   - the undo toast advertised Ctrl+Z on devices with no keyboard.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

const tasksSrc = read('js', 'tasks.js');
const utilsSrc = read('js', 'utils.js');
const appSrc = read('js', 'app.js');
const aiSrc = read('js', 'ai.js');
const uiSrc = read('js', 'ui.js');
const css = read('css', 'main.css');
const html = read('index.html');

/* ── empty state ─────────────────────────────────────────────────────────── */

test('the first-run CTA opens the quick-add sheet instead of focusing a hidden input', () => {
  const i = tasksSrc.indexOf("btn.textContent = '+ Add your first task'");
  assert.ok(i > 0, 'first-task button still exists');
  const block = tasksSrc.slice(i, i + 700);
  assert.match(block, /quickAddFabClick/, 'must route through the FAB handler, which picks sheet vs inline form');
  const fallback = block.indexOf("gid('taskInput')");
  assert.ok(fallback > block.indexOf('quickAddFabClick'), 'direct focus stays only as the desktop fallback');
});

test('first-run copy matches the surface the reader is actually looking at', () => {
  const start = tasksSrc.indexOf('const touchUI =');
  const i = tasksSrc.indexOf("h.textContent = 'Welcome to Odta'", start);
  assert.ok(start > 0 && i > start);
  const block = tasksSrc.slice(start, i + 1600);
  assert.match(block, /matchMedia\('\(max-width:640px\)'\)/, 'copy branches on viewport');
  assert.match(block, /Tap \+ to add a task/, 'touch copy points at the FAB');
  assert.match(block, /Type a task above/, 'desktop copy still points at the inline form');
});

/* ── row layout + tap targets ────────────────────────────────────────────── */

function mobileBlocks() {
  // Every `@media (max-width: N)` block with N <= 640, in source order.
  const out = [];
  const re = /@media\s*\(max-width:\s*(\d+)px\)\s*\{/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    if (Number(m[1]) > 640) continue;
    let depth = 1, i = re.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    out.push(css.slice(re.lastIndex, i - 1));
  }
  return out;
}

test('the phone checkbox meets the 24px minimum tap target', () => {
  const decls = mobileBlocks()
    .flatMap(b => [...b.matchAll(/\.task-row-primary\s+\.task-checkbox\s*\{([^}]*)\}/g)])
    .map(m => m[1]);
  assert.ok(decls.length, 'mobile blocks still size the row checkbox');
  for (const d of decls) {
    const w = /width:\s*(\d+)px/.exec(d);
    assert.ok(w, 'checkbox rule declares a width: ' + d);
    assert.ok(Number(w[1]) >= 24, 'checkbox is at least 24px wide on a phone, got ' + w[1] + 'px');
  }
});

test('the task title gets the row to itself on a phone', () => {
  const blocks = mobileBlocks().join('\n');
  assert.match(blocks, /\.task-main\{[^}]*flex-wrap:\s*wrap/, 'the title/signals cluster wraps');
  assert.match(blocks, /\.task-main\s+\.task-signals\{[^}]*flex:\s*1\s+0\s+100%/,
    'date/recurrence chips take their own line so the name is not squeezed');
  assert.match(blocks, /\.task-main\s+\.task-name\{flex:\s*1\s+1\s+0/,
    'a 0 basis keeps the name on the pin star’s line');
});

/* ── model-load errors ───────────────────────────────────────────────────── */

test('friendlyModelError turns engine text into an instruction', () => {
  const s = utilsSrc.indexOf('function friendlyModelError');
  assert.ok(s > 0, 'helper exists in utils.js');
  const e = utilsSrc.indexOf('/** Allow only simple hex', s);
  assert.ok(e > s, 'helper body is bounded by the next declaration');
  const fn = new Function(utilsSrc.slice(s, e) + '\nreturn friendlyModelError;')();

  const webgpu = fn(new Error('no available backend found. ERR: [webgpu] Error: Failed to get GPU adapter. You may need to enable flag "--enable-unsafe-webgpu"'));
  assert.match(webgpu, /browser/i);
  assert.doesNotMatch(webgpu, /webgpu|ERR:|adapter/i, 'no engine jargon reaches the user');

  assert.match(fn(new Error('QuotaExceededError: storage full')), /storage/i);
  assert.match(fn(new Error('Failed to fetch')), /connection/i);
  assert.match(fn(new Error('404 not found')), /missing/i);
  assert.match(fn(''), /could not load/i, 'empty error still yields a sentence');
  for (const msg of ['', 'boom', 'no available backend found']) {
    assert.ok(/retry/i.test(fn(msg)), 'every message tells the user what to do next');
  }
});

test('the load-failure handler shows the friendly copy and keeps the raw text for reports', () => {
  const i = appSrc.indexOf("console.error('[intel] load failed'");
  assert.ok(i > 0);
  const block = appSrc.slice(i, i + 900);
  assert.match(block, /friendlyModelError\(err\)/, 'user-facing string comes from the translator');
  assert.match(block, /_intelLoadErrorDetail\s*=\s*raw/, 'engine text is kept for the chip title');
  assert.doesNotMatch(block, /showExportToast\('Embedding model failed to load/, 'toast no longer pastes the raw error');
});

test('the AI chip and the Tools banner stop truncating the message mid-sentence', () => {
  assert.doesNotMatch(aiSrc, /String\(msg\)\.slice\(0,\s*100\)\s*\+\s*'\. Tap to retry\.'/,
    'chip no longer cuts at 100 chars and bolts a second sentence on');
  assert.doesNotMatch(aiSrc, /String\(_embedChipMsg\)\.slice\(0,\s*64\)/,
    'Tools status no longer cuts at 64 chars');
  assert.match(aiSrc, /window\._intelLoadErrorDetail/, 'chip title carries the engine detail');
  assert.match(aiSrc, /\$\{esc\(statusText\)\}/, 'status text is escaped before innerHTML');
});

/* ── toasts, icons, header ───────────────────────────────────────────────── */

test('the undo toast hides its keyboard hint where there is no keyboard', () => {
  const i = utilsSrc.indexOf('action-toast-kbd-hint');
  assert.ok(i > 0);
  const block = utilsSrc.slice(i - 500, i + 400);
  assert.match(block, /matchMedia\('\(pointer: coarse\)'\)/, 'hint is gated on pointer type');
  assert.match(block, /\\u2318Z|⌘Z/, 'Apple keyboards get the command glyph');
});

test('the filter bar uses the shared icon set, not an emoji', () => {
  const bar = html.slice(html.indexOf('class="filter-bar"'), html.indexOf('</div>', html.indexOf('fbAddFilter')));
  assert.doesNotMatch(bar, /[\u{1F300}-\u{1FAFF}]/u, 'no emoji in the filter bar');
  assert.match(bar, /id="fbSearch"[\s\S]*data-icon="search"/, 'search trigger renders the stroke icon');
});

test('the header date is short enough for a phone header', () => {
  const i = utilsSrc.indexOf('function setHeaderDate');
  const block = utilsSrc.slice(i, i + 500);
  assert.match(block, /matchMedia\('\(max-width:480px\)'\)/);
  assert.match(block, /weekday:'short'/, 'phones get "Wed, Sep 16" instead of the full sentence');
});

test('the task detail meta row draws separators in CSS so they cannot orphan', () => {
  assert.match(css, /\.modal-stat\s*>\s*span\s*\+\s*span::before\{content:'· '/,
    'separator belongs to the item that follows it');
  const i = uiSrc.indexOf("gid('mdStats').innerHTML");
  const block = uiSrc.slice(i, i + 500);
  assert.doesNotMatch(block, /<\/span> · <span>/, 'no literal separator text nodes between flex items');
  assert.match(block, /pathStr\s*\?/, 'the Path line only renders when there is a parent path');
  assert.doesNotMatch(uiSrc, /badge\.textContent = ' · #'/, 'the id badge relies on the CSS separator too');
});

test('the search row does not say "Semantic" twice', () => {
  const i = tasksSrc.indexOf("const semPill=gid('taskSearchSemanticPill')");
  assert.ok(i > 0, 'the pill is still wired');
  const block = tasksSrc.slice(i, i + 700);
  assert.match(block, /offsetParent/, 'visibility of the labelled control decides');
  assert.match(block, /semPill\.hidden = labelVisible \|\|/,
    'the pill only stands in for a label that is off screen');
});
