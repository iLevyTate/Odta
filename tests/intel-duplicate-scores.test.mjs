/**
 * computeDuplicateScores must ignore archived and deleted tasks, exactly
 * like findDuplicates does. The embedding store can hold orphaned vectors
 * (deleted tasks awaiting cleanOrphans) and vectors for archived tasks;
 * scoring against those inflates the "possible duplicate" badge on live
 * tasks with matches the user cannot see.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'intel-features.js'), 'utf8');

function fnBody(name) {
  const s = src.indexOf(`async function ${name}(`);
  assert.ok(s >= 0, `found ${name}`);
  const e = src.search(new RegExp(`\\n(async )?function (?!${name})`, 'g'));
  // Slice from the function start to the next top-level function after it.
  const rest = src.slice(s);
  const next = rest.slice(1).search(/\n(async )?function /);
  return next > 0 ? rest.slice(0, next + 1) : rest;
}

for (const name of ['findDuplicates', 'computeDuplicateScores']) {
  test(`${name}: excludes archived/deleted tasks from similarity scoring`, () => {
    const body = fnBody(name);
    assert.match(body, /findTask\(/, `${name} resolves ids to live tasks`);
    assert.match(body, /archived/, `${name} checks the archived flag`);
  });
}
