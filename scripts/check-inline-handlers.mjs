#!/usr/bin/env node
/**
 * Static guard against re-introducing inline event handlers in index.html.
 *
 * History: dropping CSP 'unsafe-inline' from script-src required migrating
 * every onclick="..." / onchange="..." in index.html to data-action +
 * event-delegation. Any new inline handler would silently force us to put
 * 'unsafe-inline' back, gutting CSP protection.
 *
 * This check fails CI when an `on<event>=` attribute appears in index.html.
 * (Dynamic strings inside js/*.js are out of scope — those execute in JS
 * context, not via HTML parser, so CSP isn't involved.)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

// Match to the closing quote of the SAME type — [^"']* would fail to span an
// embedded quote of the other type, letting e.g. onclick="fn('x')" evade the
// guard entirely.
const ON_ATTR_RE = /\s(on[a-z]+)\s*=\s*("[^"]*"|'[^']*')/gi;
const matches = [...html.matchAll(ON_ATTR_RE)];

if(matches.length === 0){
  console.log('No inline event handlers in index.html — CSP script-src can stay strict.');
  process.exit(0);
}

console.error(`Found ${matches.length} inline on*= handler(s) in index.html:`);
for(const m of matches){
  const before = html.slice(0, m.index);
  const line = before.split('\n').length;
  const ctx = html.slice(m.index, m.index + 90).replace(/\n/g, ' ');
  console.error(`  index.html:${line}  ${m[1]}=  …${ctx}…`);
}
console.error('');
console.error('Inline handlers force CSP script-src \'unsafe-inline\', which neutralises CSP.');
console.error('Migrate to data-action="fnName" and let js/event-delegation.js dispatch.');
process.exit(1);
