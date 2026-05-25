/**
 * Static contract guards on persistent-banner stacking.
 *
 * History: .update-banner (z:5000) and .quota-warning (z:5001) both anchor
 * bottom-center on desktop and top:110px on mobile. Without explicit stacking
 * rules they overlap pixel-for-pixel when both surface together (e.g. storage
 * full + new SW available). These tests pin the lift rules so the fix can't
 * quietly regress.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'css', 'main.css'), 'utf8');

test('update + quota: quota lifts above the update banner when both visible (desktop)', () => {
  assert.match(
    css,
    /body:has\(\.update-banner\)\s*\.quota-warning\s*\{[^}]*bottom:\s*calc\(/,
    'missing body:has(.update-banner) .quota-warning lift rule',
  );
});

test('modal-open: the bottom export-toast lifts above the modal sticky footer', () => {
  // The modal foot is sticky at the viewport bottom inside .modal-overlay; the
  // bottom-anchored #exportToast at z:9000 sits ABOVE the modal but in the same
  // screen area, so it needs an extra bottom offset when a modal is open. The
  // #actionToast is top-center (see toast-position.test.mjs) and no longer
  // competes for the bottom, so it has no modal-open lift.
  assert.match(
    css,
    /body:has\(\.modal-overlay\.open\)[\s\S]*?#exportToast\s*,[\s\S]*?#exportToast\s*\{[^}]*bottom:\s*calc\(/,
    'modal-open should lift #exportToast',
  );
});

test('mobile: update + quota + sync-incoming bar stack vertically without overlapping', () => {
  // Mobile flips update/quota to top:110px — the sync-incoming bar at top:0
  // would sit underneath them without an extra offset.
  assert.match(
    css,
    /@media \(max-width:640px\)[\s\S]*?body:has\(\.update-banner\)[\s\S]*?\.quota-warning[\s\S]*?top:\s*calc\(/,
    'mobile must stack quota below update',
  );
  assert.match(
    css,
    /@media \(max-width:640px\)[\s\S]*?body:has\(\.sync-incoming-bar\)[\s\S]*?\.update-banner[\s\S]*?top:\s*calc\(/,
    'mobile must push update banner below the sync-incoming bar',
  );
});
