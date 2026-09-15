/**
 * Bottom-sheet open jitter: opening the quick-add sheet used to run three
 * animations on top of each other — the sheet's slide-up transform, the soft
 * keyboard's visualViewport resize (which drives the sheet's own padding and
 * max-height through --kb-inset / --vv-height), and a smooth scrollIntoView.
 * These guards pin the ordering that separates them.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const ui = read('js', 'ui.js');
const modal = read('js', 'modal.js');
const utils = read('js', 'utils.js');

test('sheets focus only after the open transition, palettes still focus immediately', () => {
  assert.match(modal, /const deferFocus\s*=.*variant === 'sheet'/, 'sheet variant defers focus by default');
  assert.match(modal, /if\(!deferFocus\) applyFocus\(\);/, 'non-deferred variants focus in the open rAF');
  assert.match(modal, /if\(deferFocus\) applyFocus\(\);/, 'deferred variants focus when the transition settles');
  assert.match(modal, /function applyFocus\(\)\{[\s\S]*?classList\.contains\('open'\)/,
    'applyFocus bails if the modal closed while it waited');
});

test('the quick-add sheet hands its focus target to Modal instead of racing it', () => {
  const fn = ui.slice(ui.indexOf('function openQuickAddSheet()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /openSheet\('quickAddSheet',\s*\{[^}]*focus:\s*'#taskInput'/, 'focus passed through openSheet');
  assert.doesNotMatch(body, /requestAnimationFrame/, 'no competing rAF focus in openQuickAddSheet');
  assert.match(ui, /function openSheet\(id,\s*opts\)/, 'openSheet accepts a focus override');
});

test('the body scroll lock cancels an in-flight smooth scroll before capturing scrollY', () => {
  const lock = modal.slice(modal.indexOf('function _lockBody()'));
  const body = lock.slice(0, lock.indexOf('\n  }'));
  const cancel = body.indexOf("behavior: 'auto'");
  const capture = body.indexOf('_scrollY = window.scrollY');
  assert.ok(cancel > -1, 'an instant scrollTo cancels the pending smooth scroll');
  assert.ok(cancel < capture, 'the cancel happens before scrollY is captured');
});

test('visualViewport writes are coalesced to one per animation frame', () => {
  assert.match(utils, /const update = \(\) => \{\s*\n\s*if\(pendingFrame\) return;\s*\n\s*pendingFrame = requestAnimationFrame\(commit\);/,
    'resize/scroll schedule a single rAF commit');
  assert.match(utils, /vv\.addEventListener\('resize', update\)/, 'resize still tracked');
  assert.match(utils, /vv\.addEventListener\('scroll', update\)/, 'scroll still tracked');
  assert.match(utils, /\n  commit\(\);/, 'initial values written synchronously, not via rAF');
});

test('the focusin rescue scroll only fires for a field the keyboard actually covers', () => {
  const handler = utils.slice(utils.indexOf("document.addEventListener('focusin'"));
  const body = handler.slice(0, handler.indexOf('}, 160);'));
  assert.match(body, /getBoundingClientRect/, 'measures the field');
  assert.match(body, /const top = vv\.offsetTop, bottom = vv\.offsetTop \+ vv\.height;/,
    'visible band comes from the visual viewport, in layout-viewport coords');
  assert.match(body, /if\(rect\.top >= top && rect\.bottom <= bottom\) return;/,
    'an already-visible field is left alone \u2014 no scroll layered on the sheet');
  assert.match(body, /closest\('\.modal-overlay, \.cmdk-overlay, \.what-next-overlay'\)/,
    'overlay membership decides the scroll behavior');
  assert.match(body, /behavior: inOverlay \? 'auto' : 'smooth'/,
    'inside an overlay the rescue jumps instantly instead of animating');
});

test('the newly added task is not scroll-revealed while a sheet covers the list', () => {
  const hit = ui.slice(ui.indexOf('window._lastAddedTaskId===t.id'));
  const body = hit.slice(0, hit.indexOf('\n  }'));
  assert.match(body, /document\.querySelector\('\.modal-overlay\.open, \.cmdk-overlay\.open'\)/, 'checks for a covering overlay');
  assert.match(body, /if\(!covered\) requestAnimationFrame/, 'reveal scroll is gated on nothing covering the list');
});

test('the quick-add host is restored after the close fade, guarded against a reopen', () => {
  const fn = ui.slice(ui.indexOf('function closeSheet(id)'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /setTimeout\(\(\)=>\{ if\(!Modal\.isOpen\('quickAddSheet'\)\) _restoreQuickAddHost\(\); \}, 280\)/,
    'restore deferred past the fade-out and skipped if the sheet reopened');
});
