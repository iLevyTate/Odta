/**
 * Phase 4: the FAB opens a thumb-zone add sheet by relocating the single
 * #quickAddHost node into #quickAddSheet (no duplicate #taskInput), and the
 * bulk-action bar moved off the bottom so it can't collide with the FAB +
 * mini-timer stack. These guards pin the structure and wiring.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const ui = readFileSync(join(root, 'js', 'ui.js'), 'utf8');
const modal = readFileSync(join(root, 'js', 'modal.js'), 'utf8');
const css = readFileSync(join(root, 'css', 'main.css'), 'utf8');

test('the add-task cluster is wrapped once for relocation, with a single input', () => {
  assert.strictEqual((html.match(/id="quickAddAnchor"/g) || []).length, 1, 'one anchor');
  assert.strictEqual((html.match(/id="quickAddHost"/g) || []).length, 1, 'one host');
  assert.strictEqual((html.match(/id="taskInput"/g) || []).length, 1, 'still a single #taskInput');
});

test('the quick-add sheet exists with a relocation slot', () => {
  assert.match(html, /id="quickAddSheet"[^>]*class="[^"]*sheet|class="[^"]*sheet[^"]*"[^>]*id="quickAddSheet"/, 'sheet present');
  assert.match(html, /id="quickAddSheetSlot"/, 'relocation slot present');
});

test('the quick-add sheet is outside tab panels so it is not clipped by [hidden]', () => {
  const tasksPanel = html.match(/<div class="panel panel--tasks" data-tab="tasks">[\s\S]*?<\/div>\s*\n\s*<div class="timer-subnav"/);
  assert.ok(tasksPanel, 'tasks panel block found');
  assert.doesNotMatch(tasksPanel[0], /id="quickAddSheet"/, 'sheet must not live inside the tasks tab panel');
});

test('the FAB opens the sheet on mobile and relocation handlers exist', () => {
  assert.match(ui, /matchMedia\('\(max-width:640px\)'\)\.matches\)\s*\{\s*openQuickAddSheet\(\)/, 'FAB routes to sheet on mobile');
  assert.match(ui, /window\.openQuickAddSheet\s*=/, 'openQuickAddSheet exported');
  assert.match(ui, /function _restoreQuickAddHost/, 'restore-on-close present');
  assert.match(ui, /id==='quickAddSheet'.*_restoreQuickAddHost/s, 'closeSheet restores the host');
});

test('sheet swipe dismiss routes through onRequestClose when registered', () => {
  assert.match(modal, /bindSheetSwipe\(el, function\(\)\{[\s\S]*?onRequestClose/s, 'swipe uses onRequestClose hook');
});

test('the inline anchor is hidden on mobile so it does not double up', () => {
  assert.match(css, /#quickAddAnchor\{display:none\}/, 'anchor hidden in a mobile rule');
});

test('the bulk-action bar is anchored to the top (off the FAB/timer corner)', () => {
  const bulk = css.slice(css.indexOf('.bulk-bar{'));
  const decl = bulk.slice(0, bulk.indexOf('}'));
  assert.match(decl, /top:/, 'bulk bar positioned from the top');
  assert.match(decl, /bottom:auto/, 'bulk bar no longer bottom-anchored');
});
