import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRE = 'a6fcf48~1';

const files = [
  'js/gen.js',
  'js/ask.js',
  'tests/ask-pipeline.test.mjs',
  'tests/gen-cfg.test.mjs',
  'tests/tasks-input-ask-prefix.test.mjs',
  'tests/gen-autoload.test.mjs',
  'tests/gen-native-tools.test.mjs',
  'tests/hybrid-ai.test.mjs',
];

for (const f of files) {
  try {
    const buf = execSync(`git show ${PRE}:${f}`, { encoding: 'buffer' });
    writeFileSync(join(root, f), buf);
    console.log('OK', f, buf.length);
  } catch (e) {
    console.error('SKIP', f, e.message?.split('\n')[0]);
  }
}
