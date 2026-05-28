import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let a = readFileSync(join(root, 'js/ask.js'), 'utf8');
a = a.replace(
  /'User: archive everything already completed last week[\s\S]*?ARCHIVE_TASK[\s\S]*?\]/,
  "'User: mark everything already completed last week as done\\n→ [{\"name\":\"MARK_DONE\",\"args\":{\"id\":<id>}}, ...]'",
);
a = a.replace(
  /'User: mark everything already completed last week as done\\n→ \[\{"name":"MARK_DONE","args":\{"id":<id>\}\}, \.\.\.\]'',/,
  "'User: mark everything already completed last week as done\\n→ [{\"name\":\"MARK_DONE\",\"args\":{\"id\":<id>}}, ...]',",
);
writeFileSync(join(root, 'js/ask.js'), a);
