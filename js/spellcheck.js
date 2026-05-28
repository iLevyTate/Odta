/**
 * Lightweight offline spell hints for task titles.
 * Uses a compact English dictionary + task vocabulary + words from your existing tasks/tags.
 * Suggestions appear as tap-to-fix chips in the quick-add preview row.
 */
(function(){
  'use strict';

  const TASK_VOCAB = (
    'appointment appointments async backlog birthday bills bread breakfast budget butter calendar call '
    + 'car cat cheese checklist chicken chore chores clean cleanup coffee dinner dishes dog drive dust '
    + 'eggs email errand errands estimate feed fish fix flight focus followup fuel garbage gas groceries '
    + 'grocery habit habits haircut homework hotel inbox invoice invoices kids kitchen laundry lawn mail '
    + 'meeting meetings meditation milk mop organize overdue package pay pharmacy pickup plants pomodoro '
    + 'post prescription project projects rent reschedule reminder reminders review reviews rice router '
    + 'salad schedule school shopping sink snack soup sprint standup standups subtask subtasks sushi sync '
    + 'tea todo trash triage utilities vacuum vet walk water weed wifi wine workout workouts '
    + 'tomorrow today weekday weekdays monthly weekly daily'
  ).split(/\s+/);

  // Top-frequency English words (compact offline set — enough for everyday task titles).
  const COMMON = (
    'a about above accept account across act action add after again against age ago agree air all allow almost alone along already also although always am among amount an and another answer any anyone anything appear apply area around ask at away back bad be because become been before began begin being believe below best better between big both bring build business but buy by call came can cannot car case change child children city close come company could country course create day days did different do does done down during each early easy end enough even ever every everyone everything example face fact family far feel few find first follow for form found four from get give go good got great group had hand happen has have he head help her here high him his home house how however i if important in include increase information into is it its just keep kind know large last late later learn leave left less let life like line little long look made make man many may me mean men might million mind minute minutes more most move much must my name near need never new next night no not now number of off often old on once one only open or order other our out over own part people place plan play point possible present problem program public put question quite read real really reason right room run said same say school see seem seen send set several shall she should show side since small so some someone something sometimes soon still such take talk tell than that the their them then there these they thing think this those though three through time to today together too took turn two under until up us use used very want was way we week well went were what when where which while who why will with without work world would write year years you young your'
  ).split(/\s+/);

  const TOKEN_FIXES = {
    urgnet: 'urgent', urget: 'urgent', urgnt: 'urgent',
    tomorow: 'tomorrow', tommorrow: 'tomorrow',
    grocceries: 'groceries', grocieries: 'groceries', grocerys: 'groceries',
    appoitment: 'appointment', apointment: 'appointment', appointmnt: 'appointment',
    metting: 'meeting', meetng: 'meeting',
    dentst: 'dentist', dntist: 'dentist',
    excercise: 'exercise', excersise: 'exercise',
    recieve: 'receive', recieved: 'received',
    seperate: 'separate', definately: 'definitely',
  };

  let _dict = null;
  let _byLen = null;
  let _userWordsCache = null;
  let _userWordsCacheKey = '';

  function _isBadSuggestion(w, cand){
    if(cand[0] !== w[0]) return true;
    if(cand.includes(w) && cand.length > w.length + 1) return true;
    if(w.includes(cand) && w.length > cand.length + 1) return true;
    return false;
  }

  function _maxDistFor(word){
    if(word.length >= 7) return 2;
    if(word.length >= 5) return 1;
    return 0;
  }

  function _buildDict(){
    if(_dict) return _dict;
    _dict = new Set(COMMON);
    TASK_VOCAB.forEach(w => _dict.add(w));
    Object.values(TOKEN_FIXES).forEach(w => _dict.add(w));
    _byLen = new Map();
    for(const w of _dict){
      const len = w.length;
      if(!_byLen.has(len)) _byLen.set(len, []);
      _byLen.get(len).push(w);
    }
    return _dict;
  }

  function _collectUserWords(){
    const key = ((typeof tasks !== 'undefined' && tasks.length) || 0) + ':' + ((typeof lists !== 'undefined' && lists.length) || 0);
    if(_userWordsCache && _userWordsCacheKey === key) return _userWordsCache;
    const out = new Set();
    const add = s => {
      String(s || '').toLowerCase().split(/[^a-z0-9']+/).forEach(w => {
        if(w.length >= 3) out.add(w);
      });
    };
    if(typeof tasks !== 'undefined' && Array.isArray(tasks)){
      tasks.forEach(t => {
        add(t.name);
        (t.tags || []).forEach(tag => add(tag));
        if(t.category) add(t.category);
      });
    }
    if(typeof lists !== 'undefined' && Array.isArray(lists)) lists.forEach(l => add(l.name));
    if(typeof getCategoryDef === 'function' && typeof CLASSIFICATION_CATEGORIES !== 'undefined'){
      try{
        Object.values(CLASSIFICATION_CATEGORIES).forEach(c => add(c && c.label));
      }catch(_){}
    }
    _userWordsCache = out;
    _userWordsCacheKey = key;
    return out;
  }

  function _lev(a, b){
    if(a === b) return 0;
    const m = a.length, n = b.length;
    if(!m) return n;
    if(!n) return m;
    let prev = new Array(n + 1);
    let curr = new Array(n + 1);
    for(let j = 0; j <= n; j++) prev[j] = j;
    for(let i = 1; i <= m; i++){
      curr[0] = i;
      for(let j = 1; j <= n; j++){
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      }
      const tmp = prev; prev = curr; curr = tmp;
    }
    return prev[n];
  }

  function _suggestions(word){
    const w = word.toLowerCase();
    if(TOKEN_FIXES[w]) return [TOKEN_FIXES[w]];
    const maxDist = _maxDistFor(w);
    if(!maxDist) return [];
    _buildDict();
    const hits = [];
    for(let d = 1; d <= maxDist; d++){
      for(let len = Math.max(1, w.length - d); len <= w.length + d; len++){
        const bucket = _byLen.get(len);
        if(!bucket) continue;
        for(const cand of bucket){
          if(_isBadSuggestion(w, cand)) continue;
          const dist = _lev(w, cand);
          if(dist > 0 && dist <= maxDist) hits.push({ word: cand, dist });
        }
      }
      if(hits.length) break;
    }
    hits.sort((a, b) => a.dist - b.dist || a.word.localeCompare(b.word));
    const out = [];
    for(const h of hits){
      if(!out.includes(h.word)) out.push(h.word);
      if(out.length >= 2) break;
    }
    return out;
  }

  function _titleWords(raw){
    let title = String(raw || '');
    if(typeof parseQuickAdd === 'function'){
      try{ title = parseQuickAdd(raw).name || title; }catch(_){}
    }
    return title.split(/[^a-zA-Z']+/).filter(Boolean);
  }

  function checkTaskSpelling(raw){
    if(!raw || raw.trim().length < 4) return [];
    _buildDict();
    const userWords = _collectUserWords();
    const dict = _dict;
    const seen = new Set();
    const issues = [];
    for(const word of _titleWords(raw)){
      const key = word.toLowerCase();
      if(key.length < 3 || seen.has(key)) continue;
      seen.add(key);
      if(/^\d/.test(key) || /^[A-Z]{2,}$/.test(word)) continue;
      if(dict.has(key) || userWords.has(key)) continue;
      const suggestions = _suggestions(key);
      if(suggestions.length) issues.push({ word, suggestions });
    }
    return issues;
  }

  function _qpcSpellChip(bad, good){
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'qpc qpc--spell qpc--warning';
    btn.title = 'Replace with ' + good;
    btn.textContent = bad + ' \u2192 ' + good + '?';
    btn.dataset.action = 'applySpellSuggestion';
    btn.dataset.args = JSON.stringify([bad, good]);
    return btn;
  }

  function applySpellSuggestion(bad, good){
    const inp = typeof gid === 'function' ? gid('taskInput') : null;
    if(!inp || !bad || !good) return;
    const esc = String(bad).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^a-zA-Z])' + esc + '([^a-zA-Z]|$)', 'i');
    inp.value = inp.value.replace(re, (m, before, after) => before + good + after);
    if(typeof scheduleLiveParsePreview === 'function') scheduleLiveParsePreview();
    else if(typeof updateLiveParsePreview === 'function') updateLiveParsePreview();
    if(typeof maybeShowEnhanceBtn === 'function') maybeShowEnhanceBtn();
    try{ inp.focus({ preventScroll: true }); }catch(_){ inp.focus(); }
  }

  window.checkTaskSpelling = checkTaskSpelling;
  window.applySpellSuggestion = applySpellSuggestion;
  window._qpcSpellChip = _qpcSpellChip;
})();
