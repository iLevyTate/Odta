/**
 * Stacking-order contract for the app's layered surfaces.
 *
 * History: layers were a mix of :root tokens and hardcoded magic numbers
 * (100, 900, 1200, 5000, 5001, 8500, 9000), and the two sets had drifted into
 * each other. Two surfaces were provably broken:
 *
 *   - .dropdown-popover sat at --z-popover (100) while .modal-overlay sits at
 *     --z-modal (1000). js/dropdown.js appends the popover to <body>, and
 *     ui.js opens it anchored to #mdPillStatus / #mdPillPriority / #mdPillDue
 *     — pills INSIDE the task detail modal. On desktop the Status, Priority
 *     and Due pickers therefore rendered behind the modal: invisible and
 *     unclickable. (The mobile .dropdown-sheet variant only worked because it
 *     tied --z-modal and won on DOM order.)
 *   - The persistent system strips (offline / update / quota / sync-incoming)
 *     sat at 5000-8500, painting over any open modal — including its header,
 *     its close button and its sticky footer.
 *
 * These tests pin the ordering, not the spelling: every layer resolves
 * through the :root token table so a future refactor can renumber freely.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'css', 'main.css'), 'utf8');

const tokens = Object.create(null);
for (const m of css.matchAll(/--(z-[a-z-]+):\s*(\d+)/g)) tokens['--' + m[1]] = Number(m[2]);

function resolveZ(expr) {
  let e = String(expr).trim();
  const calc = e.match(/^calc\((.*)\)$/);
  if (calc) e = calc[1];
  e = e.replace(/var\(\s*(--[a-z-]+)\s*(?:,\s*([^)]+))?\)/g, (_, name, fb) => {
    if (name in tokens) return String(tokens[name]);
    return fb != null ? fb.trim() : 'NaN';
  });
  if (!/^[-+*/()\d\s.]+$/.test(e)) return NaN;
  try { return Function('"use strict";return (' + e + ')')(); } catch { return NaN; }
}

function zIndexOf(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = css.match(new RegExp(esc + '\\s*\\{([^}]*)\\}'));
  if (!rule) return NaN;
  const decl = rule[1].match(/z-index:\s*([^;}]+)/);
  if (!decl) return NaN;
  return resolveZ(decl[1]);
}

test('every layer token is defined and numeric', () => {
  for (const name of ['--z-sticky', '--z-popover', '--z-fab', '--z-banner', '--z-modal',
    '--z-toast', '--z-overlay', '--z-cmdk', '--z-dropdown', '--z-dialog', '--z-skip-link']) {
    assert.ok(Number.isFinite(tokens[name]), `missing token ${name}`);
  }
});

test('anchored dropdowns out-rank every surface they can be opened from', () => {
  const zPopover = zIndexOf('.dropdown-popover');
  const zSheet = zIndexOf('.dropdown-sheet');
  assert.ok(Number.isFinite(zPopover), 'missing .dropdown-popover z-index');
  assert.ok(Number.isFinite(zSheet), 'missing .dropdown-sheet z-index');
  // ui.js anchors these to pills inside the task modal, tasks.js anchors the
  // filter builder at page level, and the Cmd+K palette is the highest host.
  for (const [label, z] of [['popover', zPopover], ['sheet', zSheet]]) {
    assert.ok(z > tokens['--z-modal'], `dropdown ${label} must clear --z-modal`);
    assert.ok(z > tokens['--z-overlay'], `dropdown ${label} must clear --z-overlay`);
    assert.ok(z > tokens['--z-cmdk'], `dropdown ${label} must clear --z-cmdk`);
  }
  // ...but a confirm dialog still interrupts a dropdown.
  assert.ok(tokens['--z-dialog'] > zPopover, 'confirm dialog must out-rank a dropdown');
});

test('the quick-add syntax cheatsheet clears the sheet that launches it', () => {
  // openQuickAddSheet() reparents #quickAddHost — which owns #taskSyntaxHintBtn
  // — into #quickAddSheet, so the popover is opened from inside a modal.
  const z = zIndexOf('.task-syntax-popover');
  assert.ok(Number.isFinite(z), 'missing .task-syntax-popover z-index');
  assert.ok(z > tokens['--z-modal'], 'syntax popover must clear --z-modal');
});

test('persistent system banners stay below open modals', () => {
  assert.ok(Number.isFinite(tokens['--z-banner']), 'missing --z-banner token');
  assert.ok(tokens['--z-banner'] > tokens['--z-fab'],
    'banners must sit above the FAB / bottom nav');
  for (const sel of ['.offline-indicator', '.update-banner', '.quota-warning', '.sync-incoming-bar']) {
    const z = zIndexOf(sel);
    assert.ok(Number.isFinite(z), `missing ${sel} z-index`);
    assert.ok(z < tokens['--z-modal'],
      `${sel} (${z}) must not paint over an open modal (${tokens['--z-modal']})`);
    assert.ok(z >= tokens['--z-banner'], `${sel} should be on the banner layer`);
  }
});

test('banner strips keep their relative order', () => {
  // A quota warning is more urgent than an update prompt; the sync-incoming
  // bar is a live handshake and tops both.
  assert.ok(zIndexOf('.quota-warning') > zIndexOf('.update-banner'));
  assert.ok(zIndexOf('.sync-incoming-bar') > zIndexOf('.quota-warning'));
});

test('no layered surface reintroduces a hardcoded four-digit z-index', () => {
  // Tokens are declared as bare integers on :root; everything else should
  // compose them. Catch a regression that pastes a raw 5000 back in.
  const offenders = [];
  for (const m of css.matchAll(/z-index:\s*(\d{4,})/g)) {
    offenders.push(m[1]);
  }
  assert.deepStrictEqual(offenders, [],
    `hardcoded z-index values found: ${offenders.join(', ')} — use a --z-* token`);
});
