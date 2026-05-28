/**
 * Restore Ask UI + GenAI settings (v2 — line-based splice).
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRE = 'a6fcf48~1'; // first parent of removal commit (has full Ask stack)
const pre = (p) => execSync(`git show ${PRE}:${p}`, { cwd: root, encoding: 'utf8' });

function spliceBetween(src, startMark, endMark, replacement) {
  const s = src.indexOf(startMark);
  const e = src.indexOf(endMark);
  if (s < 0 || e < 0) throw new Error(`markers not found: ${startMark}`);
  return src.slice(0, s) + replacement + src.slice(e);
}

// ── ui.js ────────────────────────────────────────────────────────────────────
const uiOldLines = pre('js/ui.js').split('\n');
const uiStart = uiOldLines.findIndex(l => l.includes("cmdkMode='find'"));
const uiEnd = uiOldLines.findIndex(l => l.includes('// ── Extended undo stack'));
if (uiStart < 0 || uiEnd < 0) throw new Error('ui cmdk bounds');
let cmdk = uiOldLines.slice(uiStart, uiEnd).join('\n');

cmdk = cmdk.replace(
  `function openCmdK(opts){
  const openAsk = opts && opts.ask === true;
  const prefill = (opts && typeof opts.prefill === 'string') ? opts.prefill : '';
  const ov=gid('cmdkOverlay');if(!ov)return;
  _cmdkPrevFocus=document.activeElement;
  ov.classList.add('open');
  cmdkMode=openAsk?'ask':'find';
  _cmdkAskHistoryIdx=-1;_cmdkLastReply=null;_cmdkAskBusy=false;
  _applyCmdkMode();
  const inp=gid('cmdkInput');
  if(inp)inp.value=prefill;
  cmdkActiveIdx=0;renderCmdK();
  if(inp){
    try{inp.focus({preventScroll:true})}catch(_){inp.focus()}
    if(prefill){
      try{inp.setSelectionRange(prefill.length, prefill.length)}catch(_){}
    }
  }
  if(typeof installTabTrap==='function') installTabTrap(ov);
}`,
  `function openCmdK(opts){
  const openAsk = opts && opts.ask === true;
  const prefill = (opts && typeof opts.prefill === 'string') ? opts.prefill : '';
  const ov=gid('cmdkOverlay');if(!ov)return;
  cmdkMode=openAsk?'ask':'find';
  _cmdkAskHistoryIdx=-1;_cmdkLastReply=null;_cmdkAskBusy=false;
  _applyCmdkMode();
  const inp=gid('cmdkInput');
  if(inp)inp.value=prefill;
  cmdkActiveIdx=0;renderCmdK();
  Modal.open('cmdkOverlay', { variant:'palette', focus:'#cmdkInput', skipInitialFocus:true });
  if(inp && prefill){
    requestAnimationFrame(()=>{ try{ inp.setSelectionRange(prefill.length, prefill.length); }catch(_){} });
  }
}`
);

cmdk = cmdk.replace(
  `function closeCmdK(){
  _cmdkAbortAsk();
  if(typeof removeTabTrap==='function') removeTabTrap();
  gid('cmdkOverlay').classList.remove('open');
  if(_cmdkPrevFocus&&_cmdkPrevFocus.focus)try{_cmdkPrevFocus.focus()}catch(_){}
  _cmdkPrevFocus=null;
  // Wipe the conversation when the palette closes. Re-opening should start
  // a fresh chat — keeping stale turns around made the next session look
  // like it had answered a question it never received.
  _cmdkAskTurns = [];
}`,
  `function closeCmdK(){
  _cmdkAbortAsk();
  Modal.close('cmdkOverlay');
  _cmdkAskTurns = [];
}`
);

// Remove stale _cmdkPrevFocus from pre-v48 if present in variable decl
cmdk = 'let cmdkActiveIdx=0,cmdkFilteredItems=[];\n' + cmdk.replace(/^let cmdkActiveIdx=0,cmdkFilteredItems=\[\];\n/, '');

const uiCur = readFileSync(join(root, 'js/ui.js'), 'utf8');
const uiOut = spliceBetween(
  uiCur,
  '// ========== COMMAND PALETTE (Cmd+K) ==========',
  '// ── Extended undo stack',
  '// ========== COMMAND PALETTE (Cmd+K) ==========\n' + cmdk + '\n'
);

const uiExports = `
window.openCmdK=openCmdK;
window.closeCmdK=closeCmdK;
window.cmdkToggleAsk=cmdkToggleAsk;
window.cmdkSetAskMode=cmdkSetAskMode;
window.cmdkAskSubmit=cmdkAskSubmit;
window.cmdkAskStop=cmdkAskStop;
window.openAskMode=openAskMode;
window.syncAskPromoChip=syncAskPromoChip;
window.renderCmdK=renderCmdK;
window.cmdkKeydown=cmdkKeydown;
window.cmdkRun=cmdkRun;
`;

writeFileSync(join(root, 'js/ui.js'), uiOut.replace(
  'window.calToday=calToday;',
  uiExports + 'window.calToday=calToday;'
));

// ── ai.js: chip + gen settings ───────────────────────────────────────────────
const aiOld = pre('js/ai.js');
const aiCur = readFileSync(join(root, 'js/ai.js'), 'utf8');

const chipBlock = aiOld.slice(
  aiOld.indexOf('// Track the two model states'),
  aiOld.indexOf('function syncSemanticSearchUi()')
);

let aiOut = aiCur.replace(
  /\/\/ Tracks the embedding model[\s\S]*?function syncSemanticSearchUi\(\)/,
  chipBlock.trimEnd() + '\n\nfunction syncSemanticSearchUi()'
);

const headerClick = aiOld.slice(
  aiOld.indexOf('function headerAIClick()'),
  aiOld.indexOf('// ═')
);
aiOut = aiOut.replace(/function headerAIClick\(\)\{[\s\S]*?\n\}/, headerClick.trim());

const genBlock = aiOld.slice(
  aiOld.indexOf('let _askLoadError = null'),
  aiOld.indexOf("document.addEventListener('click', function _smartAddTagDelegate")
);

if (!aiOut.includes('function renderGenSettings')) {
  aiOut = aiOut.replace(
    "document.addEventListener('click', function _smartAddTagDelegate",
    genBlock +
    `window.selectGenModelFromSelect = function(){ if(typeof selectGenModel==='function') selectGenModel(this.value); };
window.setGenTimeoutFromInput = function(){ if(typeof setGenTimeout==='function') setGenTimeout(this.value); };
window.genAbortLoad = function(){ if(typeof genAbortLoad==='function') genAbortLoad(); };

document.addEventListener('click', function _smartAddTagDelegate`
  );
}

aiOut = aiOut.replace(
  '// ========== AMBIENT INTELLIGENCE (embeddings + rules — no generative LLM) ==========',
  '// ========== AMBIENT INTELLIGENCE (embeddings + optional generative Ask) =========='
);

if (!aiOut.includes('window.renderGenSettings = renderGenSettings')) {
  aiOut = aiOut.replace(
    'window.intelHardBulkConfirmNeeded = intelHardBulkConfirmNeeded;',
    `window.syncGenChip = syncGenChip;
window.renderGenSettings = renderGenSettings;
window.toggleGenEnabled = toggleGenEnabled;
window.selectGenModel = selectGenModel;
window.setGenTimeout = setGenTimeout;
window.genDownloadClick = genDownloadClick;
window.openGenSettingsFromAsk = openGenSettingsFromAsk;
window.genClearAskHistory = genClearAskHistory;
window.genClearCache = genClearCache;
window.intelHardBulkConfirmNeeded = intelHardBulkConfirmNeeded;`
  );
}

writeFileSync(join(root, 'js/ai.js'), aiOut);

// ── CSS ──────────────────────────────────────────────────────────────────────
const cssCur = readFileSync(join(root, 'css/main.css'), 'utf8');
if (!cssCur.includes('.cmdk-ask-toggle')) {
  const cssOld = pre('css/main.css').split('\n');
  const pick = (a, b) => cssOld.slice(a, b + 1).join('\n');
  const cssAdd = `
/* ── Generative Ask (restored) ── */
${pick(2498, 2514)}
${pick(2683, 2695)}
${pick(3641, 3758)}
`;
  writeFileSync(join(root, 'css/main.css'), cssCur + cssAdd);
}

console.log('restore-ask-merge v2 OK');
