/**
 * Ensures palette literals stay centralized in `:root` / `body.light-theme`.
 * Prevents duplicated #hex in component styles.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cssPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'css', 'main.css');

function stripBlockComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Remove every balanced `{ … }` block whose opening matched `openingRe`.
 * Matches nested `:root` inside `@media` as well (those blocks must avoid raw hex too).
 */
function removeBlocks(css, openingRe) {
  let out = css;
  for (;;) {
    openingRe.lastIndex = 0;
    const m = openingRe.exec(out);
    if (!m) break;
    const braceIdx = m.index + m[0].length - 1;
    if (out[braceIdx] !== '{') {
      throw new Error(`Expected { after token block match: ${JSON.stringify(m[0])}`);
    }
    let depth = 0;
    let end = braceIdx;
    for (; end < out.length; end++) {
      if (out[end] === '{') depth++;
      else if (out[end] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) throw new Error(`Unclosed CSS block for /${openingRe.source}/`);
    out = `${out.slice(0, m.index)}\n${out.slice(end + 1)}`;
  }
  return out;
}

function stripTokenBlocks(cssRaw) {
  let css = stripBlockComments(cssRaw);
  css = removeBlocks(css, /\b:root\s*\{/g);
  css = removeBlocks(css, /\bbody\.light-theme\s*\{/g);
  return css;
}

test('CSS: no stray hex literals outside :root / body.light-theme', () => {
  const raw = readFileSync(cssPath, 'utf8');
  const sans = stripTokenBlocks(raw);
  const bad = [...sans.matchAll(/\b#[0-9a-fA-F]{3,8}\b/g)];
  assert.equal(bad.length, 0,
    bad.length === 0
      ? ''
      : `Unexpected bare hex (${bad.length} hits): ${bad.slice(0, 12).map(x => x[0]).join(', ')}`,
  );
});
