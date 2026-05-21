/**
 * Static contract guards on toast positioning. Pre-fix, .export-toast and
 * .action-toast were anchored `left:50%; transform:translateX(-50%)` near
 * the bottom centre — on desktop with the empty Tasks state the pill
 * landed directly over the welcome card / "+ Add your first task" button,
 * blocking taps on the central interaction column. Toasts now anchor
 * bottom-right on desktop and bottom-LEFT on mobile (≤640px) — the FAB
 * owns the bottom-right on mobile, so a centred toast collided with it on
 * narrow viewports. Both anchors lift above the mini-timer when it's
 * visible.
 *
 * Modals (.modal-overlay, .cmdk-overlay, .what-next-overlay) are NOT
 * toasts and must remain centred — the negative-regression block below
 * locks that explicitly.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'css', 'main.css'), 'utf8');

/** Slice the CSS body of the first rule whose selector list starts with `selector`. */
function ruleBody(selector){
  const idx = css.indexOf(selector + '{');
  if (idx < 0) return null;
  const end = css.indexOf('}', idx);
  return end < 0 ? null : css.slice(idx, end + 1);
}

test('.export-toast anchors bottom-right at default breakpoint', () => {
  const body = ruleBody('.export-toast');
  assert.ok(body, '.export-toast rule not found');
  assert.match(body, /right:\s*calc\(/, 'must use right: calc(...) for safe-area-aware corner anchor');
  assert.match(body, /left:\s*auto/, 'must explicitly clear left so it does not centre');
  assert.doesNotMatch(body, /left:\s*50%/, 'must not anchor left:50% at default breakpoint');
  assert.doesNotMatch(body, /transform:[^;}]*translateX\(-50%\)/, 'must not translateX(-50%) at default breakpoint');
});

test('.action-toast anchors bottom-right and stacks above .export-toast', () => {
  const body = ruleBody('.action-toast');
  assert.ok(body, '.action-toast rule not found');
  assert.match(body, /right:\s*calc\(/, 'must anchor right with safe-area inset');
  assert.match(body, /left:\s*auto/, 'must clear left');
  // The action-toast carries the Undo button — it must sit above .export-toast
  // (bottom:16px) so users can reach Undo without it being occluded.
  const m = body.match(/bottom:\s*calc\(\s*(\d+)px/);
  assert.ok(m, 'action-toast must use calc(Npx + safe-area-inset-bottom)');
  assert.ok(parseInt(m[1], 10) >= 48, `action-toast bottom must be ≥48px (was ${m[1]}px) — should sit above .export-toast`);
});

test('mini-timer presence lifts both toasts above its corner', () => {
  // body:has(.mini-timer.visible) selectors must exist for both toasts so
  // the toast doesn't land behind the mini-timer pill.
  assert.match(css, /body:has\(\.mini-timer\.visible\)\s*\.export-toast\s*\{[^}]*bottom:/, 'export-toast missing mini-timer lift rule');
  assert.match(css, /body:has\(\.mini-timer\.visible\)\s*\.action-toast\s*\{[^}]*bottom:/, 'action-toast missing mini-timer lift rule');
});

test('mobile (max-width:640px) anchors toasts bottom-left (clear of FAB)', () => {
  // The FAB sits at bottom-right on mobile (56px circle at right:20px). A
  // centred toast (the previous design) extended into the FAB column on
  // narrow viewports, blocking taps. Toasts now anchor bottom-LEFT, stacked
  // above the save indicator dot.
  const idx = css.indexOf('@media (max-width:640px)');
  assert.ok(idx > 0, '@media (max-width:640px) block not found');
  assert.match(
    css,
    /@media \(max-width:640px\)\s*\{[^]*?\.export-toast\s*\{[^}]*left:\s*calc\([^}]*right:\s*auto[^}]*\}[^]*?\}/,
    'mobile breakpoint must anchor .export-toast bottom-left (left: calc(...); right: auto)'
  );
  assert.match(
    css,
    /@media \(max-width:640px\)\s*\{[^]*?\.action-toast\s*\{[^}]*left:\s*calc\([^}]*right:\s*auto[^}]*\}[^]*?\}/,
    'mobile breakpoint must anchor .action-toast bottom-left (left: calc(...); right: auto)'
  );
  // Negative regression: must NOT re-introduce the bottom-middle anchor.
  assert.doesNotMatch(
    css,
    /@media \(max-width:640px\)\s*\{[^]*?\.export-toast\s*\{[^}]*left:\s*50%[^}]*\}[^]*?\}/,
    'mobile breakpoint must not centre .export-toast (regression)'
  );
  assert.doesNotMatch(
    css,
    /@media \(max-width:640px\)\s*\{[^]*?\.action-toast\s*\{[^}]*left:\s*50%[^}]*\}[^]*?\}/,
    'mobile breakpoint must not centre .action-toast (regression)'
  );
});

test('modal overlays remain centred (negative regression)', () => {
  // The toast move must not have leaked into modal selectors. Modals are
  // a different surface and must keep their existing centred layout.
  for (const sel of ['.modal-overlay', '.cmdk-overlay', '.what-next-overlay']) {
    const body = ruleBody(sel);
    assert.ok(body, sel + ' rule not found');
    // Each of these overlays must still claim the full viewport (top:0;left:0;
    // right:0;bottom:0 OR inset:0) and centre their content via flex.
    const fullViewport = /(?:top:\s*0\b[^}]*left:\s*0\b)|(?:inset:\s*0\b)/;
    assert.match(body, fullViewport, sel + ' must still cover the viewport');
    assert.match(body, /justify-content:\s*center/, sel + ' must still centre horizontally');
  }
});
