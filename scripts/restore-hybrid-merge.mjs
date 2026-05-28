import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRE = 'a6fcf48~1';
const pre = (p) => execSync(`git show ${PRE}:${p}`, { cwd: root, encoding: 'utf8' });
const aiOld = pre('js/ai.js');
let ai = readFileSync(join(root, 'js/ai.js'), 'utf8');

function sb(start, end) {
  const s = aiOld.indexOf(start);
  const e = aiOld.indexOf(end, s + start.length);
  if (s < 0 || e < 0) throw new Error(`bad slice: ${start} -> ${end} (s=${s}, e=${e})`);
  return aiOld.slice(s, e);
}

if (!ai.includes('function _llmWithTimeout(')) {
  ai = ai.replace(
    'async function aiAlign()',
    sb('function _llmWithTimeout(promise, ms){', 'async function aiAlign()') + 'async function aiAlign()',
  );
}

if (!ai.includes('genValuesNote')) {
  let align = sb('async function aiAlign(){', 'function aiToggleValue(key)').trim();
  align = align.replace(
    `_pendingOps = ops;
    _renderPendingOps();
    _setIntelStatus('ready', \`Review \${ops.length} proposed updates\`);`,
    "await acceptProposedOps(ops, { source: 'align-values', destructiveLevel: 'none' });",
  );
  ai = ai.replace(
    /async function aiAlign\(\)\{[\s\S]*?\n\}\n\nfunction aiToggleValue\(key\)/,
    align + '\n\nfunction aiToggleValue(key)',
  );
}

if (!ai.includes('async function runMdBreakdown(')) {
  ai = ai.replace(
    'async function intelFindDuplicatesUI(){',
    sb('async function runMdBreakdown(){', 'async function intelFindDuplicatesUI(){') +
      'async function intelFindDuplicatesUI(){',
  );
}

if (!ai.includes('genDedupeJudge')) {
  const dup = sb('async function intelFindDuplicatesUI(){', 'function intelMergeDuplicatePair(idA, idB)')
    .trim()
    .replace(/Archive 2nd/g, 'Delete 2nd');
  ai = ai.replace(
    /async function intelFindDuplicatesUI\(\)\{[\s\S]*?\n\}\n\nfunction intelMergeDuplicatePair\(idA, idB\)/,
    dup + '\n\nfunction intelMergeDuplicatePair(idA, idB)',
  );
}

if (!ai.includes('_refineOpsWithLLM(ops)')) {
  let h = sb('async function intelHarmonizeFields(){', 'async function intelAutoOrganize(){').trim();
  h = h.replace(
    `_pendingOps = filtered;
    _renderPendingOps();
    _setIntelStatus('ready', \`Review \${filtered.length} proposed update\${filtered.length === 1 ? '' : 's'}\`);`,
    "await acceptProposedOps(filtered, { source: 'harmonize', destructiveLevel: 'none' });",
  );
  ai = ai.replace(
    /async function intelHarmonizeFields\(\)\{[\s\S]*?\n\}\n\nasync function intelAutoOrganize\(\)/,
    h + '\n\nasync function intelAutoOrganize()',
  );
}

if (!ai.includes('genExplainMove')) {
  ai = ai.replace(
    /(destructiveLevel = v\.destructiveLevel;\s*\}\s*)(await acceptProposedOps\(ops, \{ source: 'auto-organize', destructiveLevel \}\);)/,
    `$1    if(typeof isGenReady === 'function' && isGenReady() && typeof genExplainMove === 'function'){
      _setIntelStatus('working', 'Explaining moves with LLM…');
      const listById = new Map(lists.map(l => [l.id, l]));
      const MAX = 8;
      for(let i = 0; i < Math.min(MAX, ops.length); i++){
        const op = ops[i];
        const t = findTask(op.args.id);
        const dest = listById.get(op.args.listId);
        if(!t || !dest) continue;
        const note = await _llmWithTimeout(genExplainMove({ name: t.name }, dest.name || ''), 8000);
        if(note) op._rationale = note;
      }
    }
    $2`,
  );
}

if (!ai.includes('taskParseBtn')) {
  const maybe = sb("function maybeShowEnhanceBtn(){", "document.addEventListener('visibilitychange'");
  ai = ai.replace(/function maybeShowEnhanceBtn\(\)\{[\s\S]*?\n\}/, maybe.trim());
}

if (!ai.includes('async function smartAddParseWithLLM(')) {
  ai = ai.replace(
    'function _renderSmartAddChips(s){',
    sb('async function smartAddParseWithLLM(){', 'function _renderSmartAddChips(s){') +
      'function _renderSmartAddChips(s){',
  );
}

if (!ai.includes('genExplainRanking')) {
  ai = ai.replace(
    /(Modal\.open\('whatNextOverlay',[\s\S]*?\}\);\s*)\n\}/,
    `$1
  if(ranked.length >= 1 && typeof isGenReady === 'function' && isGenReady() && typeof genExplainRanking === 'function'){
    const top = ranked[0].t;
    const alts = ranked.slice(1).map(x => ({ name: x.t.name }));
    _llmWithTimeout(genExplainRanking({ name: top.name }, alts), 9000).then(note => {
      if(!note) return;
      const el = document.getElementById('wnWhy');
      if(el){ el.textContent = note; el.hidden = false; }
    }).catch(() => {});
  }
}`,
  );
}

if (!ai.includes('window.smartAddParseWithLLM')) {
  ai = ai.replace(
    'window.smartAddEnhance = smartAddEnhance;',
    'window.smartAddEnhance = smartAddEnhance;\nwindow.smartAddParseWithLLM = smartAddParseWithLLM;',
  );
}

if (!ai.includes('window.runMdBreakdown')) {
  ai = ai.replace(
    'window.intelFindDuplicatesUI = intelFindDuplicatesUI;',
    'window.runMdBreakdown = runMdBreakdown;\nwindow.acceptMdBreakdown = acceptMdBreakdown;\nwindow.intelFindDuplicatesUI = intelFindDuplicatesUI;',
  );
}

ai = ai.replace(
  /\nwindow\.genAbortLoad = function\(\)\{ if\(typeof genAbortLoad==='function'\) genAbortLoad\(\); \};\n/,
  '\n',
);

writeFileSync(join(root, 'js/ai.js'), ai);
console.log('restore-hybrid-merge OK');
