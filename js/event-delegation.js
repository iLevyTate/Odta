/**
 * Single-document delegated event dispatcher.
 *
 * Replaces inline `onclick="fn(arg)"` / `onchange="fn()"` etc. attributes,
 * which require CSP `script-src 'unsafe-inline'`. With every handler going
 * through this dispatcher, the CSP can drop `'unsafe-inline'` and gain real
 * XSS protection.
 *
 * Markup conventions:
 *
 *   <button data-action="fnName" data-args='["a", 1]'>     → fnName('a', 1)
 *   <button data-action="fnName" data-arg="single">        → fnName('single')
 *   <button data-action="fnName">                          → fnName()
 *
 *   <select data-onchange="fnName">    → fnName.call(el, event) on change
 *   <input data-oninput="fnName">      → fnName.call(el, event) on input
 *   <input data-onkeydown="fnName">    → fnName.call(el, event) on keydown
 *   <details data-ontoggle="fnName">   → fnName.call(el, event) on toggle
 *
 *   <div data-action="fnName" data-stop-prop="1">  → calls e.stopPropagation()
 *
 * Handler resolution: looks up `window[name]`, but only for names in
 * HANDLERS below. If the function isn't defined yet, the click is silently
 * no-op'd (matches the legacy `typeof fn === 'function'` guards scattered
 * through inline handlers today).
 */
(function setupEventDelegation(){
  // The names the app's own markup uses, and nothing else. resolve() used to
  // call any window[name], and every top-level function in a classic script
  // is on window, so a single injected element (a quote out of an attribute,
  // an unescaped note id from an import) was "call syncConnect('<attacker>')
  // on click": the initiator then shipped the whole task database to that
  // peer. tests/event-delegation-allowlist.test.mjs pins this set to the
  // sources, so a new data-action / data-on* name fails CI until it's added.
  // Kept in this closure, never on window, so markup can't clobber it.
  const HANDLERS = new Set([
    'acceptMdBreakdown', 'addInterval', 'addList', 'addQuickPreset', 'addQuickTimer',
    'addTaskOrApplyPreview', 'aiAlign', 'aiToggleValue', 'aiUndo', 'appPromptInputKey',
    'applyPhasePresetFromSelect', 'applySpellSuggestion', 'calDayNav', 'calFeedModeFromButton',
    'calFocusDay', 'calNav', 'calToday', 'checklistAddFromButton', 'checklistAddOnEnter',
    'classificationAdd', 'classificationMove', 'classificationResetDetails',
    'classificationSetColorFromSelect', 'classificationSetCoreValuesFromTextarea',
    'classificationSetExamplesFromTextarea', 'classificationSetFocusFromTextarea',
    'classificationSetIconFromSelect', 'classificationSetLabelFromInput',
    'classificationToggleEdit', 'classificationToggleHidden', 'clearArchive', 'clearLog',
    'clearSettingsFilter', 'clearTaskSearch', 'closeAppConfirm', 'closeAppConfirmOnBackdrop',
    'closeAppPrompt', 'closeAppPromptOnBackdrop', 'closeBulkImportModal',
    'closeBulkImportModalOnBackdrop', 'closeCmdKOnBackdrop', 'closeQuickAddSheet',
    'closeQuickAddSheetOnBackdrop', 'closeSidebar', 'closeTagsSheet',
    'closeTagsSheetOnBackdrop', 'closeTaskDetail', 'closeTaskDetailOnBackdrop',
    'closeViewSheet', 'closeViewSheetOnBackdrop', 'closeWhatNext', 'closeWhatNextOnBackdrop',
    'closeXxxOnBackdrop', 'clusterSimilarTasks', 'cmdkAskApplyTurn', 'cmdkAskCancelLoad',
    'cmdkAskMinimize', 'cmdkAskRejectTurn', 'cmdkAskRerunTurn', 'cmdkAskRetryLoad',
    'cmdkAskReviewTurn', 'cmdkAskStarterSubmit', 'cmdkAskStop', 'cmdkKeydown', 'cmdkRestoreAsk',
    'cmdkRun', 'cmdkSetApplyMode', 'cmdkToggleAsk', 'confirmBulkImport',
    'createTaskFromCalEvent', 'cycleStatus', 'deleteTaskFromModal', 'dismissSwipeTip',
    'exportAllCSV', 'exportClipboard', 'exportData', 'exportDataEncrypted', 'exportFile',
    'exportTasksCSV', 'exportTasksICS', 'exportTasksJSON', 'filterSettingsRows', 'fnName',
    'genAbort', 'genAbortLoad', 'genClearAskHistory', 'genClearCache', 'genDownloadClick',
    'headerAIClick', 'hideWorkerInstructions', 'importDataEncryptedFromInput',
    'importDataFromInput', 'importTasksFromInput', 'indentTask', 'installPWA',
    'intelApplyPending', 'intelAutoOrganize', 'intelFindDuplicatesUI', 'intelHarmonizeFields',
    'intelMergeDuplicatePair', 'intelReclassifyUncategorized', 'intelReembedAll',
    'intelRejectPending', 'intelRetryLoad', 'intelToggleAllPending', 'intervalChimePreview',
    'jumpToSettingsSection', 'miniTimerToggle', 'moveTaskDown', 'moveTaskUp',
    'onCardDensityToggle', 'onHideHabitsToggle', 'onShowCompletedToggle', 'onTaskInputKey',
    'openAskMode', 'openCmdK', 'openFilterBuilder', 'openListDropdown', 'openRecurDropdown',
    'openTagsSheet', 'openTaskDetailAndCloseWhatNext', 'openViewSheet', 'openWhatNext',
    'outdentTask', 'pickDuePill', 'pickPriorityPill', 'pickStatusPill', 'qaPickDue',
    'qaPickList', 'qaPickPriority', 'qtLabelEnterKey', 'quickAddFabClick',
    'refreshSystemInfoQuota', 'removeBlockedBy', 'removeChecklistItem', 'removeTaskNote',
    'renderCmdK', 'resetStats', 'retryFailedCalFeeds', 'runMdBreakdown',
    'selectGenModelFromSelect', 'setCalMode', 'setCardDensity', 'setFilterCategory',
    'setGenAskApplyMode', 'setGenTimeoutFromInput', 'setQuickReminder', 'setQuickSnooze',
    'setSmartView', 'setTaskView', 'setTimerSub', 'showQaHint', 'showQuickAddSyntaxHint',
    'showTab', 'showTaskActionMenu', 'showWorkerInstructions', 'smartAddEnhance',
    'smartAddParseWithLLM', 'smartAddRemove', 'snoozeTodayBanner', 'startTimer',
    'submitAddCalFeed', 'submitAppPrompt', 'swLap', 'swReset', 'swToggle', 'switchPhase',
    'switchTaskDetailTab', 'syncAllCalFeedsAndRerender', 'syncConnectFromInput',
    'syncConnectInputKey', 'syncCopyMyCode', 'syncDisconnect', 'syncEnable',
    'syncOnCodeInputFromInput', 'syncReconnectNow', 'syncRegenerateCode',
    'taskBlockerAddFromSelect', 'taskInputLiveUpdate', 'taskNoteAddFromButton',
    'toggleBoardExpand', 'toggleBreakdownAccordion', 'toggleChecklistItem', 'toggleCollapse',
    'toggleGenEnabled', 'toggleOpt', 'toggleQuickAddPanel', 'toggleReorderMode',
    'toggleSearchBar', 'toggleSidebar', 'toggleSidebarCollapse', 'toggleSimilarAccordion',
    'toggleTask', 'toggleTaskDone', 'toggleTaskDoneQuick', 'toggleTaskSearchSemantic',
    'toggleTheme', 'toggleTimerDockMin', 'toggleVoiceInput', 'updateConfig', 'updateTaskFilters'
  ]);
  // Runtime registration for code (and tests) that wires a handler it builds
  // itself. Deliberately not in HANDLERS: markup cannot reach it.
  window.registerDelegatedHandler = function(name){
    if(typeof name === 'string' && /^[A-Za-z_$][\w$]*$/.test(name)) HANDLERS.add(name);
  };
  function resolve(name){
    if(!name || typeof name !== 'string' || !HANDLERS.has(name)) return null;
    const fn = window[name];
    return typeof fn === 'function' ? fn : null;
  }

  function parseArgs(el){
    if(!el || !el.dataset) return [];
    const ds = el.dataset;
    if(ds.args){
      try {
        const a = JSON.parse(ds.args);
        return Array.isArray(a) ? a : [a];
      } catch(e){ return []; }
    }
    if(ds.arg !== undefined) return [ds.arg];
    return [];
  }

  // Click — the by-far most common handler. Event is passed as the LAST
  // argument so handlers that need it (modal-backdrop close, miniTimer
  // delegation, etc.) can read e.target / e.key without breaking handlers
  // that just ignore the extra arg.
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if(!el) return;
    if(el.dataset.stopProp === '1') e.stopPropagation();
    if(el.dataset.preventDefault === '1') e.preventDefault();
    const fn = resolve(el.dataset.action);
    if(!fn) return;
    try { fn.apply(el, [...parseArgs(el), e]); }
    catch(err){ console.error('[delegation] click handler failed:', el.dataset.action, err); }
  });

  // Generic factory for the form/text-input event family. Each event type
  // looks at `data-on<type>` for the handler name.
  function attachEvent(eventName, dataAttr){
    document.addEventListener(eventName, e => {
      // e.target may be a non-Element (text node, document) for some events.
      const target = e.target;
      if(!target || typeof target.closest !== 'function') return;
      const el = target.closest(`[data-${dataAttr}]`);
      if(!el) return;
      const fn = resolve(el.dataset[toCamel(dataAttr)]);
      if(!fn) return;
      try { fn.call(el, e); }
      catch(err){ console.error(`[delegation] ${eventName} handler failed:`, el.dataset[toCamel(dataAttr)], err); }
    }, NON_BUBBLING.has(eventName));
  }
  // toggle, focus and blur do not bubble — a document-level listener only sees
  // them in the capture phase, so bubble-phase delegation for these types
  // would silently never fire.
  const NON_BUBBLING = new Set(['toggle', 'focus', 'blur']);

  function toCamel(kebab){
    return kebab.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }

  attachEvent('change',  'onchange');
  attachEvent('input',   'oninput');
  attachEvent('keydown', 'onkeydown');
  attachEvent('keyup',   'onkeyup');
  attachEvent('blur',    'onblur');
  attachEvent('focus',   'onfocus');
  attachEvent('submit',  'onsubmit');
  attachEvent('toggle',  'ontoggle');

  // Keyboard activation for non-button elements that opt into button semantics
  // via role="button". The native button element handles Enter/Space already,
  // so this only matters for divs/spans tagged role="button" (e.g. the
  // mini-timer wrapper). Without this, keyboard-only users can focus the
  // element but can't trigger its data-action. Synthesises a click so the
  // existing click delegation above handles the dispatch.
  document.addEventListener('keydown', e => {
    if(e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target;
    if(!target || typeof target.closest !== 'function') return;
    const el = target.closest('[role="button"][data-action]');
    if(!el || el.tagName === 'BUTTON' || el.tagName === 'A') return;
    // Skip when the focus is inside a form control sitting inside the
    // role=button container — those have their own activation semantics.
    const editable = target.closest('input, textarea, select, button, [contenteditable="true"]');
    if(editable && editable !== el && el.contains(editable)) return;
    e.preventDefault();
    try { el.click(); }
    catch(err){ console.error('[delegation] keyboard activation failed:', err); }
  });

  // Expose for any code that wants to manually dispatch (rare).
  window.ODTAULAI_DELEGATION_READY = true;
})();
