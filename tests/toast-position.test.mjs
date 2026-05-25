/**
 * Static contract guards on toast positioning.
 *
 * .export-toast (plain auto-dismiss notices) anchors bottom-RIGHT on desktop
 * and bottom-LEFT on mobile (≤640px) — the FAB owns the bottom-right on
 * mobile, so a centred toast collided with it. It lifts above the mini-timer
 * pill and the modal sticky footer when those are present.
 *
 * .action-toast (the "Task done" Undo pill) anchors TOP-CENTRE
 * (top:calc(...); left:50%; transform:translateX(-50%)) on every breakpoint.
 * It reads as a completion confirmation and stays clear of the bottom-right
 * FAB / mini-timer stack, so it needs none of the bottom-offset collision
 * hacks the export-toast carries.
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

test('.action-toast anchors top-center', () => {
  const body = ruleBody('.action-toast');
  assert.ok(body, '.action-toast rule not found');
  assert.match(body, /top:\s*calc\(/, 'must anchor top with safe-area inset');
  assert.match(body, /left:\s*50%/, 'must centre horizontally with left:50%');
  assert.match(body, /transform:[^;}]*translateX\(-50%\)/, 'must translateX(-50%) to centre');
  assert.match(body, /bottom:\s*auto/, 'must clear bottom so it does not anchor to the bottom edge');
  assert.doesNotMatch(body, /bottom:\s*calc\(/, 'must not bottom-anchor (it is top-centre now)');
});

test('mini-timer presence lifts the bottom export-toast above its corner', () => {
  // The export-toast is bottom-anchored, so it must lift above the mini-timer
  // pill. The action-toast is top-centre and never enters that corner, so it
  // needs no such lift.
  assert.match(css, /body:has\(\.mini-timer\.visible\)\s*\.export-toast\s*\{[^}]*bottom:/, 'export-toast missing mini-timer lift rule');
  assert.doesNotMatch(css, /body:has\(\.mini-timer\.visible\)\s*\.action-toast\s*\{/, 'action-toast must not carry a mini-timer bottom lift (it is top-centre)');
});

test('mobile (max-width:640px): export-toast bottom-left (clear of FAB), action-toast top-center', () => {
  // The FAB sits at bottom-right on mobile (56px circle at right:20px). The
  // export-toast anchors bottom-LEFT, stacked above the save indicator dot.
  // The action-toast stays top-centre on mobile too.
  const idx = css.indexOf('@media (max-width:640px)');
  assert.ok(idx > 0, '@media (max-width:640px) block not found');
  assert.match(
    css,
    /@media \(max-width:640px\)\s*\{[^]*?\.export-toast\s*\{[^}]*left:\s*calc\([^}]*right:\s*auto[^}]*\}[^]*?\}/,
    'mobile breakpoint must anchor .export-toast bottom-left (left: calc(...); right: auto)'
  );
  assert.match(
    css,
    /@media \(max-width:640px\)\s*\{[^]*?\.action-toast\s*\{[^}]*left:\s*50%[^}]*transform:[^;}]*translateX\(-50%\)[^}]*\}[^]*?\}/,
    'mobile breakpoint must keep .action-toast top-centre (left:50%; translateX(-50%))'
  );
  // Negative regression: the bottom-anchored export-toast must NOT re-introduce
  // the bottom-middle anchor that collided with the central interaction column.
  assert.doesNotMatch(
    css,
    /@media \(max-width:640px\)\s*\{[^]*?\.export-toast\s*\{[^}]*left:\s*50%[^}]*\}[^]*?\}/,
    'mobile breakpoint must not centre .export-toast (regression)'
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
