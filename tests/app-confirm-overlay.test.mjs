/**
 * App confirm / prompt overlay stacking and markup guards.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'css', 'main.css'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const ui = readFileSync(join(root, 'js', 'ui.js'), 'utf8');

/**
 * Resolve a rule's z-index to a number. Layers are declared as :root tokens
 * and composed with calc(), so scraping a literal integer out of the
 * declaration stopped working the moment a layer was expressed as
 * `calc(var(--z-banner) + 2)`. Resolve the token table instead, so these
 * tests keep asserting the ORDERING contract rather than the spelling.
 */
export function zIndexOf(selector){
  const tokens = Object.create(null);
  for(const m of css.matchAll(/--(z-[a-z-]+):\s*(\d+)/g)) tokens['--' + m[1]] = Number(m[2]);
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = css.match(new RegExp(esc + '\\s*\\{([^}]*)\\}'));
  if(!rule) return NaN;
  const decl = rule[1].match(/z-index:\s*([^;}]+)/);
  if(!decl) return NaN;
  return resolveZ(decl[1].trim(), tokens);
}
function resolveZ(expr, tokens){
  let e = expr.trim();
  const calc = e.match(/^calc\((.*)\)$/);
  if(calc) e = calc[1];
  // var(--token[, fallback]) -> the token's value, else the fallback.
  e = e.replace(/var\(\s*(--[a-z-]+)\s*(?:,\s*([^)]+))?\)/g, (_, name, fb) => {
    if(name in tokens) return String(tokens[name]);
    return fb != null ? fb.trim() : 'NaN';
  });
  if(!/^[-+*/()\d\s.]+$/.test(e)) return NaN;
  try { return Function('"use strict";return (' + e + ')')(); } catch { return NaN; }
}

test('app confirm message host is a div (import delta uses block children)', () => {
  assert.match(html, /id="appConfirmMessage"[^>]*class="[^"]*app-dlg-msg--body/);
  assert.doesNotMatch(html, /<p id="appConfirmMessage"/);
});

test('app confirm overlay stacks above sync-incoming bar and export toasts', () => {
  const zDialog = zIndexOf('.app-dlg-overlay');
  assert.ok(Number.isFinite(zDialog), 'missing --z-dialog token');
  const zSync = zIndexOf('.sync-incoming-bar');
  assert.ok(Number.isFinite(zSync), 'missing .sync-incoming-bar z-index');
  const zExport = zIndexOf('.export-toast');
  assert.ok(Number.isFinite(zExport), 'missing .export-toast z-index');
  assert.ok(zDialog > zSync, 'dialog must sit above sync-incoming bar');
  assert.ok(zDialog > zExport, 'dialog must sit above export toast');
});

test('destructive confirms style the OK button and reset on close', () => {
  assert.match(ui, /function _resetAppConfirmChrome\(/);
  assert.match(ui, /mfoot-del/);
  assert.match(ui, /closeAppConfirm[\s\S]*?_resetAppConfirmChrome\(\)/);
  assert.match(ui, /showImportConfirm[\s\S]*?_applyAppConfirmChrome\(\{ destructive: true, okLabel: 'Restore' \}\)/);
});
