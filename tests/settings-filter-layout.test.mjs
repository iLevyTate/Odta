/**
 * Settings navigation bar layout (#settingsFilter).
 *
 * Two defects, both measured in a real browser before the fix:
 *
 *  1. The input carried `class="sinput set-nav-filter-input"`. `.sinput` is
 *     the 56px-wide, centre-aligned stepper used by the Focus/Short/Long/Cycle
 *     duration fields, and its mobile rule is `width:72px!important`. So on
 *     every phone the settings search box rendered as a 72px stub with its
 *     text centred — the reported "extremely small widthwise". On desktop the
 *     wrapper's `flex:0 0 220px` pinned it to 220x28 no matter how wide the
 *     pane got, while `.set-nav-jump{flex:1}` soaked up all 1014px of slack.
 *  2. At phone width `.set-nav` is a COLUMN flex container with
 *     `flex-wrap:wrap`. A wrapped flex line takes the cross size of its widest
 *     item, so the jump strip's ~394px of nowrap pills widened the line past
 *     the 314px panel and put the whole Settings page into a 38px horizontal
 *     scroll.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'css', 'main.css'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');

function rule(selector, hay = css) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = hay.match(new RegExp(esc + '\\s*\\{([^}]*)\\}'));
  return m ? m[1] : null;
}

/**
 * The mobile settings-nav block, located by its own content rather than by
 * slicing at the first `@media (max-width:640px)` — there are several, and
 * which one comes first is not something these tests should depend on.
 */
function mobileNavBlock() {
  const i = css.search(/\.set-nav\{[^}]*flex-direction:column/);
  assert.ok(i > -1, 'cannot locate the mobile .set-nav rule');
  return css.slice(i, i + 1600);
}

test('the settings filter does not inherit the duration-stepper styling', () => {
  const input = html.match(/<input[^>]*id="settingsFilter"[^>]*>/);
  assert.ok(input, 'missing #settingsFilter');
  assert.doesNotMatch(input[0], /class="[^"]*\bsinput\b/,
    '.sinput is the 56px centre-aligned stepper — its mobile width:72px!important ' +
    'collapses this search field on every phone');
  assert.match(input[0], /class="[^"]*\bset-nav-filter-input\b/);
  assert.match(input[0], /type="search"/);
  assert.match(input[0], /aria-label="Filter settings"/);
});

test('.sinput still carries the rule that made sharing it a bug', () => {
  // If this ever stops being true the guard above is merely cosmetic — but it
  // should stay true, because the duration steppers genuinely want it.
  assert.match(css, /\.sinput\{[^}]*width:72px!important/,
    'the mobile .sinput override is the reason #settingsFilter must not use it');
});

test('the filter field grows with the pane instead of a fixed 220px', () => {
  const wrap = rule('.set-nav-filter');
  assert.ok(wrap, 'missing .set-nav-filter');
  assert.doesNotMatch(wrap, /flex:0 0 220px/, 'must not be pinned to 220px');
  assert.match(wrap, /flex:1 1 /, 'the search field takes the slack');
  const jump = rule('.set-nav-jump');
  assert.ok(jump, 'missing .set-nav-jump');
  assert.match(jump, /flex:0 1 auto/, 'pills size to content so the field can grow');
  assert.match(jump, /min-width:0/, 'without this the strip cannot shrink to let overflow-x work');
});

test('the field is tall enough to sit beside the 40px jump pills', () => {
  const input = rule('.set-nav-filter-input');
  assert.ok(input, 'missing .set-nav-filter-input');
  const h = input.match(/min-height:(\d+)px/);
  assert.ok(h && Number(h[1]) >= 40, `filter must be >= 40px tall, got ${h && h[1]}`);
  assert.match(input, /text-align:start/, 'a search field is not centre-aligned');
  assert.match(input, /box-sizing:border-box/, 'width:100% plus padding must not overflow');
});

test('mobile keeps a 44px target and a 16px font (no iOS zoom-on-focus)', () => {
  const input = rule('.set-nav-filter-input', mobileNavBlock());
  assert.ok(input, 'missing mobile .set-nav-filter-input rule');
  assert.match(input, /min-height:44px/);
  assert.match(input, /font-size:16px/, 'anything under 16px makes iOS Safari zoom the viewport');
});

test('the settings nav cannot push the page into a horizontal scroll', () => {
  const block = mobileNavBlock();
  const nav = rule('.set-nav', block);
  assert.ok(nav, 'missing mobile .set-nav rule');
  assert.match(nav, /flex-direction:column/);
  assert.match(nav, /flex-wrap:nowrap/,
    'a wrapped COLUMN line takes the cross size of its widest item — that is ' +
    'what widened the nav past the panel');
  const jump = rule('.set-nav-jump', block);
  assert.ok(jump, 'missing mobile .set-nav-jump rule');
  assert.match(jump, /overflow-x:auto/);
  assert.match(jump, /max-width:100%/, 'keeps overflow-x:auto honest');
});

test('the clear button is a real touch target', () => {
  const clear = rule('.set-nav-filter-clear');
  assert.ok(clear, 'missing .set-nav-filter-clear');
  const w = clear.match(/width:(\d+)px/);
  const h = clear.match(/height:(\d+)px/);
  assert.ok(w && Number(w[1]) >= 28, 'clear button needs a real hit area');
  assert.ok(h && Number(h[1]) >= 28, 'clear button needs a real hit area');
  // The input's right padding must clear it, or the × overlaps typed text.
  const input = rule('.set-nav-filter-input');
  const pad = input.match(/padding:\d+px (\d+)px/);
  assert.ok(pad && Number(pad[1]) > Number(w[1]) * 0.8,
    'right padding must leave room for the clear button');
});

test('the notification permission CTA is a real target too', () => {
  // It is the single most consequential button in Settings; 22px tall was not
  // enough to hit reliably.
  const btn = rule('.notif-status-btn');
  assert.ok(btn, 'missing .notif-status-btn');
  const h = btn.match(/min-height:(\d+)px/);
  assert.ok(h && Number(h[1]) >= 32, `Allow-notifications CTA must be >= 32px, got ${h && h[1]}`);
});
