/**
 * Ambient features: kNN metadata, semantic search, duplicates, values alignment, what-next.
 * Loads before ai.js — exports Schwartz constants for values UI + embeddings.
 */

const LIFE_CATS = ['bodyMindSpirit','relationships','community','jobLearningFinances','interests','personalCare','general'];
// Category / Schwartz icons are UI_ICONS keys, resolved to SVG at render time via window.icon()
const CAT_ICON  = {bodyMindSpirit:'leaf',relationships:'heart',community:'users',jobLearningFinances:'briefcase',interests:'sparkles',personalCare:'home',general:'pin'};
const SCHWARTZ = {
  'self-direction':{ icon:'compass', def:'Independent thought, creativity, freedom to choose your own goals.' },
  'stimulation':   { icon:'zap',     def:'Excitement, novelty, challenge, variety over routine.' },
  'hedonism':      { icon:'sparkles',def:'Pleasure, enjoyment, comfort, sensory gratification.' },
  'achievement':   { icon:'trophy',  def:'Personal success, demonstrated competence, goal achievement.' },
  'power':         { icon:'crown',   def:'Social status, authority, control over resources and people.' },
  'security':      { icon:'shield',  def:'Safety, stability, harmony — reducing risk and uncertainty.' },
  'conformity':    { icon:'users',   def:'Meeting obligations, honoring commitments, maintaining harmony.' },
  'tradition':     { icon:'columns', def:'Respect for cultural customs, family traditions.' },
  'benevolence':   { icon:'heart',   def:'Welfare of close others — family, friends, community.' },
  'universalism':  { icon:'globe',   def:'Welfare of all people and nature — justice, sustainability.' },
};
const VALUE_KEYS = Object.keys(SCHWARTZ);

window.LIFE_CATS = LIFE_CATS;
window.CAT_ICON = CAT_ICON;
window.SCHWARTZ = SCHWARTZ;
window.VALUE_KEYS = VALUE_KEYS;

/**
 * @typedef {{ key: string, def: string }} CoreValueDef
 * Life areas — `general` is manual-only; never auto-assigned by kNN/centroid.
 */
const DEFAULT_CATEGORY_DEFS = [
  { id: 'bodyMindSpirit', label: 'Body, Mind & Spirit', icon: 'leaf', color: 'var(--cat-bodyMindSpirit)',
    focus: 'Physical health, mental wellness, and spirituality',
    description: 'Physical health, mental wellness, spirituality',
    coreValues: [
      { key: 'health', def: 'Physical and mental well-being' },
      { key: 'strength', def: 'Physical and mental resilience' },
      { key: 'spirituality', def: 'Connection to something greater' },
      { key: 'peace', def: 'Inner calm and tranquility' },
    ],
    examples: ['Exercise routines', 'Meditation', 'Therapy', 'Yoga', 'Doctor appointments', 'Spiritual practices'],
  },
  { id: 'relationships', label: 'Relationships', icon: 'heart', color: 'var(--cat-relationships)',
    focus: 'Family, friends, romantic partnerships',
    description: 'Family, friends, romantic partnerships',
    coreValues: [
      { key: 'family', def: 'Nurturing family relationships and bonds' },
      { key: 'connection', def: 'Deep relationships with others' },
      { key: 'loyalty', def: 'Faithfulness to people and commitments' },
      { key: 'trust', def: 'Reliability and dependability' },
    ],
    examples: ['Date nights', 'Family calls', 'Friend meetups', 'Relationship check-ins', 'Gift planning'],
  },
  { id: 'community', label: 'Community', icon: 'users', color: 'var(--cat-community)',
    focus: 'Social groups, volunteering, civic engagement',
    description: 'Social groups, volunteering, civic engagement',
    coreValues: [
      { key: 'service', def: 'Helping others and giving back' },
      { key: 'justice', def: 'Fairness and equality for all' },
      { key: 'compassion', def: 'Caring for others and showing empathy' },
    ],
    examples: ['Volunteer work', 'Donations', 'Neighborhood events', 'Advocacy', 'Mentoring'],
  },
  { id: 'jobLearningFinances', label: 'Job, Learning & Finances', icon: 'briefcase', color: 'var(--cat-jobLearningFinances)',
    focus: 'Career, education, financial stability',
    description: 'Career, education, financial stability',
    coreValues: [
      { key: 'achievement', def: 'Accomplishing meaningful goals' },
      { key: 'growth', def: 'Continuous learning and self-improvement' },
      { key: 'knowledge', def: 'Understanding and wisdom' },
      { key: 'leadership', def: 'Guiding and inspiring others' },
      { key: 'security', def: 'Financial and emotional stability' },
    ],
    examples: ['Work projects', 'Courses', 'Certifications', 'Budgeting', 'Investments', 'Skill development'],
  },
  { id: 'interests', label: 'Interests', icon: 'sparkles', color: 'var(--cat-interests)',
    focus: 'Hobbies, creative pursuits, leisure activities',
    description: 'Hobbies, creative pursuits, leisure activities',
    coreValues: [
      { key: 'creativity', def: 'Expressing yourself through creative work' },
      { key: 'adventure', def: 'New experiences and exploration' },
      { key: 'joy', def: 'Happiness and contentment' },
      { key: 'humor', def: 'Finding joy and laughter in life' },
    ],
    examples: ['Art projects', 'Music', 'Travel planning', 'Sports', 'Gaming', 'Reading'],
  },
  { id: 'personalCare', label: 'Personal Care', icon: 'home', color: 'var(--cat-personalCare)',
    focus: 'Self-maintenance, routines, life management',
    description: 'Self-maintenance, routines, life management',
    coreValues: [
      { key: 'balance', def: 'Harmony between different life areas' },
      { key: 'simplicity', def: 'Living with less complexity' },
      { key: 'patience', def: 'Acceptance and perseverance' },
      { key: 'responsibility', def: 'Accountability for your actions' },
    ],
    examples: ['Sleep hygiene', 'Skincare', 'Meal prep', 'Home organization', 'Errands', 'Self-reflection'],
  },
  { id: 'general', label: 'General', icon: 'pin', color: 'var(--cat-general)',
    focus: 'Uncategorized or cross-domain tasks',
    description: 'Uncategorized or cross-domain tasks; use for work that does not fit a single life area or spans many domains',
    coreValues: [],
    examples: [],
  },
];

/** Preset accent colors (CSS variables) for the classification manager & chips */
const CLASSIFICATION_COLOR_PRESETS = [
  { value: 'var(--cat-bodyMindSpirit)', label: 'Purple — Body, Mind & Spirit' },
  { value: 'var(--cat-relationships)', label: 'Red — Relationships' },
  { value: 'var(--cat-community)', label: 'Amber — Community' },
  { value: 'var(--cat-jobLearningFinances)', label: 'Green — Job, Learning & Finances' },
  { value: 'var(--cat-interests)', label: 'Blue — Interests' },
  { value: 'var(--cat-personalCare)', label: 'Pink — Personal Care' },
  { value: 'var(--cat-general)', label: 'Gray — General' },
];

function _normalizeRowCoreValues(coreRaw, base){
  if(Array.isArray(coreRaw) && coreRaw.length){
    const first = coreRaw[0];
    if(first && typeof first === 'object' && first.key != null){
      return coreRaw.map(x => ({
        key: String(x && x.key != null ? x.key : '').trim(),
        def: String(x && x.def != null ? x.def : '').trim(),
      })).filter(x => x.key).slice(0, 32);
    }
    return coreRaw.map(v => String(v).trim()).filter(Boolean).map(k => {
      const b = (base && Array.isArray(base.coreValues)) ? base.coreValues.find(c => c && c.key === k) : null;
      return { key: k, def: b && b.def ? b.def : '' };
    }).slice(0, 32);
  }
  if(base && Array.isArray(base.coreValues) && base.coreValues.length)
    return base.coreValues.map(x => (x && x.key
      ? { key: x.key, def: x.def != null ? String(x.def) : '' }
      : { key: String(x), def: '' }
    ));
  return [];
}

function _normalizeRowExamples(exRaw, base){
  if(Array.isArray(exRaw) && exRaw.length)
    return exRaw.map(x => String(x).trim()).filter(Boolean).slice(0, 32);
  if(base && Array.isArray(base.examples)) return base.examples.slice();
  return [];
}

function ensureClassificationConfig(c){
  if(!c || typeof c !== 'object') return;
  if(!Array.isArray(c.categories) || !c.categories.length){
    c.categories = DEFAULT_CATEGORY_DEFS.map(x => {
      const { hidden, ...rest } = { ...x, hidden: false };
      return { ...rest, coreValues: (x.coreValues || []).map(cv => ({ ...cv })), examples: (x.examples || []).slice(), hidden: false };
    });
  } else {
    c.categories = c.categories.map(row => {
      // Strip everything except [A-Za-z0-9_-] so an imported config cannot
      // smuggle quotes or HTML into ids that get interpolated into UI strings.
      // The default category ids (bodyMindSpirit, jobLearningFinances, …) are
      // camelCase, so we cannot lowercase or run them through `slugClassId`
      // without breaking existing data — the character allow-list is enough.
      const id = String(row.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || null;
      const base = id ? DEFAULT_CATEGORY_DEFS.find(d => d.id === id) : null;
      const coreValues = _normalizeRowCoreValues(row.coreValues, base);
      const examples = _normalizeRowExamples(row.examples, base);
      let color = String(row.color || '').trim().slice(0, 80);
      if(!color) color = base ? base.color : 'var(--cat-general)';
      const desc = String(row.description != null ? row.description : (base ? base.description : '')).trim().slice(0, 500);
      const focus = String(row.focus != null ? row.focus : (base && base.focus != null ? base.focus : (base ? base.description : ''))).trim().slice(0, 500);
      return {
        id,
        label: String(row.label || row.id || '').trim().slice(0, 80) || '',
        icon: String(row.icon || 'pin').trim() || 'pin',
        color,
        description: desc,
        focus,
        coreValues,
        examples,
        hidden: !!row.hidden,
      };
    }).filter(r => r.id);
    if(!c.categories.length){
      c.categories = DEFAULT_CATEGORY_DEFS.map(x => {
        return {
          ...x,
          coreValues: (x.coreValues || []).map(cv => ({ ...cv })),
          examples: (x.examples || []).slice(),
          hidden: false,
        };
      });
    }
  }
  if('contexts' in c) delete c.contexts;

  const validCat = new Set((c.categories || []).map(r => r.id).filter(Boolean));
  if(typeof tasks !== 'undefined' && Array.isArray(tasks) && validCat.size){
    for(const t of tasks){
      if(t && t.category && !validCat.has(t.category)) t.category = null;
    }
  }
}

function hasClassificationCategory(cat){
  if(!cat) return false;
  if(LIFE_CATS.includes(cat)) return true;
  if(typeof cfg === 'undefined' || !cfg) return false;
  ensureClassificationConfig(cfg);
  return (cfg.categories || []).some(c => c.id === cat);
}

function getCategoryDef(id){
  if(!id) return null;
  if(typeof cfg !== 'undefined' && cfg) ensureClassificationConfig(cfg);
  const row = (typeof cfg !== 'undefined' && cfg && Array.isArray(cfg.categories))
    ? cfg.categories.find(x => x.id === id) : null;
  if(row){
    const cv = _normalizeRowCoreValues(row.coreValues, DEFAULT_CATEGORY_DEFS.find(d => d.id === id));
    const ex = _normalizeRowExamples(row.examples, DEFAULT_CATEGORY_DEFS.find(d => d.id === id));
    return {
      id: row.id,
      label: row.label || row.id,
      icon: row.icon || 'pin',
      color: row.color || 'var(--cat-general)',
      description: row.description || '',
      focus: row.focus != null ? String(row.focus) : (row.description || ''),
      coreValues: cv,
      examples: ex,
    };
  }
  const base = DEFAULT_CATEGORY_DEFS.find(x => x.id === id);
  if(base){
    return {
      id: base.id,
      label: base.label,
      icon: base.icon,
      color: base.color,
      description: base.description,
      focus: base.focus || base.description || '',
      coreValues: base.coreValues ? base.coreValues.map(c => ({ ...c })) : [],
      examples: base.examples ? base.examples.slice() : [],
    };
  }
  const ic = CAT_ICON[id];
  return { id, label: id, icon: ic || 'pin', color: 'var(--cat-general)', description: '', focus: '', coreValues: [], examples: [] };
}

function getActiveCategories(){
  if(typeof cfg === 'undefined' || !cfg) return DEFAULT_CATEGORY_DEFS.map(d => ({ ...d, hidden: false }));
  ensureClassificationConfig(cfg);
  return (cfg.categories || []).filter(c => !c.hidden);
}

function slugClassId(label){
  const s = String(label).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return s || ('c' + Date.now().toString(36));
}

function classificationMove(idx, dir){
  if(typeof cfg === 'undefined' || !cfg) return;
  ensureClassificationConfig(cfg);
  const arr = cfg.categories;
  const j = idx + dir;
  if(j < 0 || j >= arr.length) return;
  const tmp = arr[idx];
  arr[idx] = arr[j];
  arr[j] = tmp;
  renderClassificationSettings();
  refreshClassificationUi();
  invalidateCategoryCentroids();
  if(typeof saveState === 'function') saveState('user');
}

function classificationToggleHidden(idx){
  if(typeof cfg === 'undefined' || !cfg) return;
  ensureClassificationConfig(cfg);
  const arr = cfg.categories;
  if(!arr[idx]) return;
  arr[idx].hidden = !arr[idx].hidden;
  renderClassificationSettings();
  refreshClassificationUi();
  invalidateCategoryCentroids();
  if(typeof renderTaskList === 'function') renderTaskList();
  if(typeof saveState === 'function') saveState('user');
}

function classificationSetLabel(idx, label){
  if(typeof cfg === 'undefined' || !cfg) return;
  ensureClassificationConfig(cfg);
  const arr = cfg.categories;
  if(!arr[idx]) return;
  arr[idx].label = String(label || '').trim().slice(0, 80) || arr[idx].id;
  invalidateCategoryCentroids();
  refreshClassificationUi();
  if(typeof renderTaskList === 'function') renderTaskList();
  if(typeof saveState === 'function') saveState('user');
}

function classificationSetIcon(idx, iconName){
  if(typeof cfg === 'undefined' || !cfg) return;
  ensureClassificationConfig(cfg);
  const arr = cfg.categories;
  if(!arr[idx]) return;
  arr[idx].icon = String(iconName || 'pin').trim() || 'pin';
  renderClassificationSettings();
  invalidateCategoryCentroids();
  if(typeof saveState === 'function') saveState('user');
}

function classificationSetColor(idx, colorVal){
  if(typeof cfg === 'undefined' || !cfg) return;
  ensureClassificationConfig(cfg);
  const arr = cfg.categories;
  if(!arr[idx]) return;
  arr[idx].color = String(colorVal || '').trim().slice(0, 80) || 'var(--cat-general)';
  renderClassificationSettings();
  invalidateCategoryCentroids();
  if(typeof saveState === 'function') saveState('user');
}

/**
 * Edit-in-place setters for the "Life area details" disclosure. They persist
 * user-authored copy so legacy/custom category ids get meaningful focus,
 * core values and examples instead of falling back to the empty defaults of
 * `getCategoryDef`. Centroids are invalidated so embedding-based predictions
 * rebuild on next use.
 */
function classificationSetFocus(idx, focus){
  if(typeof cfg === 'undefined' || !cfg) return;
  ensureClassificationConfig(cfg);
  const row = cfg.categories[idx];
  if(!row) return;
  row.focus = String(focus || '').trim().slice(0, 500);
  invalidateCategoryCentroids();
  if(typeof saveState === 'function') saveState('user');
}

function classificationSetExamples(idx, examplesText){
  if(typeof cfg === 'undefined' || !cfg) return;
  ensureClassificationConfig(cfg);
  const row = cfg.categories[idx];
  if(!row) return;
  row.examples = String(examplesText || '')
    .split(/\r?\n|,/)
    .map(x => x.trim())
    .filter(Boolean)
    .slice(0, 32);
  invalidateCategoryCentroids();
  if(typeof saveState === 'function') saveState('user');
}

function classificationSetCoreValues(idx, valuesText){
  if(typeof cfg === 'undefined' || !cfg) return;
  ensureClassificationConfig(cfg);
  const row = cfg.categories[idx];
  if(!row) return;
  // Each non-empty line: "key: definition" (definition optional).
  row.coreValues = String(valuesText || '')
    .split(/\r?\n/)
    .map(line => {
      const s = line.trim();
      if(!s) return null;
      const m = s.match(/^([^:]+?)\s*:\s*(.*)$/);
      if(m) return { key: m[1].trim().slice(0, 80), def: m[2].trim().slice(0, 240) };
      return { key: s.slice(0, 80), def: '' };
    })
    .filter(x => x && x.key)
    .slice(0, 32);
  invalidateCategoryCentroids();
  if(typeof saveState === 'function') saveState('user');
}

function classificationResetDetails(idx){
  if(typeof cfg === 'undefined' || !cfg) return;
  ensureClassificationConfig(cfg);
  const row = cfg.categories[idx];
  if(!row) return;
  const base = DEFAULT_CATEGORY_DEFS.find(d => d.id === row.id);
  if(!base) return;
  row.focus = base.focus || base.description || '';
  row.coreValues = (base.coreValues || []).map(cv => ({ ...cv }));
  row.examples = (base.examples || []).slice();
  invalidateCategoryCentroids();
  renderClassificationSettings();
  if(typeof saveState === 'function') saveState('user');
}

async function classificationAdd(kind){
  if(typeof cfg === 'undefined' || !cfg) return;
  const promptLabel = kind === 'cat' ? 'New category name:' : 'New context name:';
  const raw = typeof showAppPrompt === 'function'
    ? await showAppPrompt(promptLabel, '')
    : (kind === 'cat' ? prompt('New category name:') : prompt('New context name:'));
  if(raw === null || !String(raw).trim()) return;
  ensureClassificationConfig(cfg);
  const label = String(raw).trim().slice(0, 80);
  let id = slugClassId(label);
  const arr = cfg.categories;
  while(arr.some(x => x.id === id)){
    id = id + '-' + Math.random().toString(36).slice(2, 5);
  }
  arr.push({
    id, label, icon: 'pin', color: 'var(--cat-general)', description: '', focus: '', coreValues: [], examples: [], hidden: false,
  });
  renderClassificationSettings();
  refreshClassificationUi();
  invalidateCategoryCentroids();
  if(typeof saveState === 'function') saveState('user');
}

function renderClassificationSettings(){
  const root = document.getElementById('classificationManager');
  if(!root || typeof cfg === 'undefined' || !cfg) return;
  ensureClassificationConfig(cfg);
  const iconKeys = (window.UI_ICONS && typeof window.UI_ICONS === 'object')
    ? Object.keys(window.UI_ICONS).sort() : ['pin'];
  const presetVals = new Set(CLASSIFICATION_COLOR_PRESETS.map(p => p.value));

  let h = '<div class="class-mgr-block"><div class="class-mgr-hdr">Life areas</div>';
  cfg.categories.forEach((obj, idx) => {
    const def = (typeof getCategoryDef === 'function' ? getCategoryDef(obj.id) : null) || obj;
    // Prefer the row's own values when present (so renames/legacy ids survive)
    // and only fall back to the resolved def — which may be a default — for
    // initial seed values in the editor.
    const focusVal = String(obj.focus != null && obj.focus !== '' ? obj.focus : (def && def.focus ? def.focus : ''));
    const cv = (Array.isArray(obj.coreValues) && obj.coreValues.length)
      ? obj.coreValues
      : (def && Array.isArray(def.coreValues) ? def.coreValues : []);
    const cvText = cv.map(c => {
      if(c && typeof c === 'object' && c.key) return c.key + (c.def ? ': ' + c.def : '');
      return String(c || '');
    }).filter(Boolean).join('\n');
    const ex = (Array.isArray(obj.examples) && obj.examples.length)
      ? obj.examples
      : (def && Array.isArray(def.examples) ? def.examples : []);
    const exText = ex.map(x => String(x)).filter(Boolean).join('\n');
    const hasBaseDefault = !!DEFAULT_CATEGORY_DEFS.find(d => d.id === obj.id);
    const isEmpty = !focusVal && !cvText && !exText;

    const opt = iconKeys.map(k => '<option value="' + esc(k) + '"' + (k === obj.icon ? ' selected' : '') + '>' + esc(k) + '</option>').join('');
    let colOpts = '';
    if(obj.color && !presetVals.has(obj.color)){
      colOpts += '<option value="' + esc(obj.color) + '" selected>' + esc(obj.color) + '</option>';
    }
    colOpts += CLASSIFICATION_COLOR_PRESETS.map(p =>
      '<option value="' + esc(p.value) + '"' + (p.value === obj.color ? ' selected' : '') + '>' + esc(p.label) + '</option>',
    ).join('');

    const detailsBody = ''
      + '<label class="class-mgr-field">'
      +   '<span class="class-mgr-field-lbl">Focus</span>'
      +   '<textarea class="class-mgr-in class-mgr-ta" rows="2" '
      +     'placeholder="What this life area is about (one or two sentences)" '
      +     'data-onchange="classificationSetFocusFromTextarea" data-idx="' + idx + '">' + esc(focusVal) + '</textarea>'
      + '</label>'
      + '<label class="class-mgr-field">'
      +   '<span class="class-mgr-field-lbl">Core values <em class="class-mgr-hint">one per line — <code>key: definition</code></em></span>'
      +   '<textarea class="class-mgr-in class-mgr-ta" rows="3" '
      +     'placeholder="Health: take care of body and mind&#10;Growth: keep learning" '
      +     'data-onchange="classificationSetCoreValuesFromTextarea" data-idx="' + idx + '">' + esc(cvText) + '</textarea>'
      + '</label>'
      + '<label class="class-mgr-field">'
      +   '<span class="class-mgr-field-lbl">Example tasks <em class="class-mgr-hint">one per line or comma-separated</em></span>'
      +   '<textarea class="class-mgr-in class-mgr-ta" rows="3" '
      +     'placeholder="Walk for 30 min&#10;Meditate 10 min" '
      +     'data-onchange="classificationSetExamplesFromTextarea" data-idx="' + idx + '">' + esc(exText) + '</textarea>'
      + '</label>'
      + (hasBaseDefault
        ? '<div class="class-mgr-details-actions"><button type="button" class="btn-ghost btn-sm" '
          + 'data-action="classificationResetDetails" data-arg="' + idx + '">Reset to defaults</button></div>'
        : '');

    const summaryLabel = isEmpty ? 'Life area details — set up' : 'Life area details';

    h += '<div class="class-mgr-cat' + (obj.hidden ? ' class-mgr-cat--hidden' : '') + '">'
      + '<div class="class-mgr-row">'
      + '<input type="text" class="class-mgr-in" value="' + esc(obj.label) + '" '
      + 'data-onchange="classificationSetLabelFromInput" data-idx="' + idx + '" aria-label="Label"/>'
      + '<select class="class-mgr-sel" data-onchange="classificationSetIconFromSelect" data-idx="' + idx + '" aria-label="Icon">' + opt + '</select>'
      + '<select class="class-mgr-sel class-mgr-sel-color" data-onchange="classificationSetColorFromSelect" data-idx="' + idx + '" aria-label="Color">' + colOpts + '</select>'
      + '<button type="button" class="class-mgr-btn" data-action="classificationToggleHidden" data-arg="' + idx + '">' + (obj.hidden ? 'Show' : 'Hide') + '</button>'
      + '<button type="button" class="class-mgr-btn" data-action="classificationMove" data-args="[' + idx + ',-1]" aria-label="Move up" title="Move up">↑</button>'
      + '<button type="button" class="class-mgr-btn" data-action="classificationMove" data-args="[' + idx + ',1]" aria-label="Move down" title="Move down">↓</button>'
      + '<code class="class-mgr-id" title="Stable id stored on tasks">' + esc(obj.id) + '</code>'
      + '</div>'
      + '<details class="class-mgr-details"' + (isEmpty ? ' data-empty="1"' : '') + '><summary>' + esc(summaryLabel) + '</summary>'
      + detailsBody
      + '</details></div>';
  });
  h += '<div class="class-mgr-reclass">'
    + '<button type="button" class="btn-ghost btn-sm" data-action="intelReclassifyUncategorized">Re-classify uncategorized tasks</button>'
    + '<span class="class-mgr-hint">Uses embeddings to suggest a life area — review in the preview below.</span></div>'
    + '<button type="button" class="btn-ghost btn-sm class-mgr-add" data-action="classificationAdd">+ Add life area</button></div>';

  root.innerHTML = h;
}

function refreshClassificationUi(){
  if(typeof cfg !== 'undefined') ensureClassificationConfig(cfg);
  const sel = document.getElementById('filterCategory');
  const tb = document.getElementById('tagsBar');
  if(sel){
    const cur = sel.value;
    sel.innerHTML = '<option value="all">Any category</option>';
    getActiveCategories().forEach(c => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.label;
      sel.appendChild(o);
    });
    if([...sel.options].some(o => o.value === cur)) sel.value = cur;
  }
  if(tb){
    const cur = sel ? sel.value : 'all';
    // Build chips with DOM APIs so untrusted category ids/labels can never
    // reach the HTML parser. addEventListener also lets CSP eventually drop
    // 'unsafe-inline' for this row.
    tb.replaceChildren();
    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = 'sv-chip' + (cur === 'all' ? ' active' : '');
    allBtn.textContent = 'All Tags';
    allBtn.addEventListener('click', () => setFilterCategory('all'));
    tb.appendChild(allBtn);
    getActiveCategories().forEach(c => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sv-chip' + (cur === c.id ? ' active' : '');
      btn.textContent = String(c.label || '');
      const id = String(c.id);
      btn.addEventListener('click', () => setFilterCategory(id));
      tb.appendChild(btn);
    });
  }
  if(document.getElementById('classificationManager')){
    renderClassificationSettings();
  }
}

const LIFE_CATS_LOCAL = LIFE_CATS;
const PRIO_ORDER = { urgent: 0, high: 1, normal: 2, low: 3, none: 4 };

function _taskText(t){
  return `${t.name || ''}\n${(t.description || '').slice(0, 2000)}`;
}

function _heuristicMetadata(name){
  const out = {};
  const lower = name.toLowerCase();
  // Alternation has lower precedence than the \b anchors. Without the
  // group, `\burgent|asap|critical\b` parses as `\burgent` OR `asap` OR
  // `critical\b` — so "urgently" / "urgentish" matched (leading-only),
  // "asap" matched anywhere as a substring (no boundaries), and
  // "moonsoon" matched the trailing-anchored `soon\b`. Group the
  // alternation so both boundaries apply to every term.
  if(/\b(urgent|asap|critical)\b/.test(lower)) out.priority = 'urgent';
  else if(/\b(important|soon)\b/.test(lower)) out.priority = 'high';
  if(/\b(dentist|doctor|health|gym|workout|meditation|yoga|therapy|spiritual)\b/.test(lower)) out.category = 'bodyMindSpirit';
  else if(/\b(family|friend|date night|partner|spouse|romantic)\b/.test(lower)) out.category = 'relationships';
  else if(/\b(volunteer|donation|community|mentor|advocacy|neighborhood)\b/.test(lower)) out.category = 'community';
  else if(/\b(pay|invoice|tax|bank|finance|budget|invest|course|certif|deadline|meeting|project|career)\b/.test(lower)) out.category = 'jobLearningFinances';
  else if(/\b(art|music|travel|hobby|gaming|read|sports|fun)\b/.test(lower)) out.category = 'interests';
  else if(/\b(sleep|skincare|meal prep|organize|errand|reflection|routine)\b/.test(lower)) out.category = 'personalCare';
  return out;
}

let _schwartzEmbeddingsPromise = null;

/**
 * Ensure Schwartz value description embeddings cached in IDB.
 */
async function ensureSchwartzEmbeddings(){
  if(typeof embedStore === 'undefined' || !isIntelReady()) return null;
  const existing = await embedStore.getSchwartzEmbeddings();
  if(existing) return existing;
  if(_schwartzEmbeddingsPromise) return _schwartzEmbeddingsPromise;

  _schwartzEmbeddingsPromise = (async () => {
    const keys = VALUE_KEYS;
    const S = SCHWARTZ;
    const vecs = {};
    for(const k of keys){
      const def = (S[k] && S[k].def) ? S[k].def : k;
      const text = `${k}: ${def}`;
      vecs[k] = await embedText(text);
    }
    await embedStore.setSchwartzEmbeddings(vecs);
    return vecs;
  })();

  try{
    return await _schwartzEmbeddingsPromise;
  }finally{
    _schwartzEmbeddingsPromise = null;
  }
}

/** kNN neighborhood + vote quality (tuneable) */
const KNN_MIN_SIM = 0.55;
const KNN_CAT_MIN_CONF = 0.55;
const KNN_CAT_MIN_MARGIN = 0.15;
/** Life-area prototype vs task vector */
const CAT_CENTROID_MIN_SIM = 0.28;
const CAT_CENTROID_MIN_MARGIN = 0.04;
const KNN_PRIO_EFF_EN_MIN_CONF = 0.5;
const KNN_TAG_TOP_FRAC = 0.6;

function _categoryEmbedTextFromDef(def){
  if(!def || !def.id || def.id === 'general') return '';
  const lines = [];
  lines.push(String(def.label || def.id));
  if(def.focus) lines.push(String(def.focus));
  else if(def.description) lines.push(String(def.description));
  const cv = def.coreValues;
  if(Array.isArray(cv) && cv.length){
    lines.push('Values: ' + cv.map(c => (c && c.key ? `${c.key}: ${c.def || ''}` : String(c))).join('; '));
  }
  if(Array.isArray(def.examples) && def.examples.length){
    lines.push('Examples: ' + def.examples.join(', '));
  }
  return lines.join('\n').trim().slice(0, 8000);
}

let _categoryCentroidsPromise = null;

/**
 * Embeds each life-area (except General) for centroid classification. Invalidated on embed model change (meta) or invalidateCategoryCentroids().
 * @returns {Promise<Record<string, Float32Array>>}
 */
async function ensureCategoryCentroids(){
  if(typeof embedStore === 'undefined' || !isIntelReady() || typeof embedText !== 'function') return null;
  if(_categoryCentroidsPromise) return _categoryCentroidsPromise;

  _categoryCentroidsPromise = (async () => {
    const key = typeof embedStore.getCatCentroidsKey === 'function' ? embedStore.getCatCentroidsKey() : 'cat_centroids_v1';
    const schemaVer = (typeof window !== 'undefined' && window.INTEL_EMBED_MODEL_VER) || 'v1';
    const dim = (typeof getEmbedDim === 'function') ? getEmbedDim() : 768;
    const prev = await embedStore.getMeta(key);
    if(prev && prev.schemaVer === schemaVer && prev.dim === dim && prev.vecs && typeof prev.vecs === 'object'){
      const out = {};
      for(const [id, buf] of Object.entries(prev.vecs)){
        if(buf && buf.length === dim) out[id] = buf instanceof Float32Array ? buf : new Float32Array(buf);
      }
      if(Object.keys(out).length){
        if(typeof cfg !== 'undefined' && cfg) ensureClassificationConfig(cfg);
        const need = (typeof cfg !== 'undefined' && cfg && Array.isArray(cfg.categories))
          ? cfg.categories.map(c => c.id).filter(id => id && id !== 'general')
          : LIFE_CATS.filter(x => x !== 'general');
        const complete = !need.length || need.every(id => out[id] && (out[id].length === dim));
        if(complete) return out;
      }
    }

    if(typeof cfg !== 'undefined' && cfg) ensureClassificationConfig(cfg);
    const ids = (typeof cfg !== 'undefined' && cfg && Array.isArray(cfg.categories) && cfg.categories.length)
      ? cfg.categories.map(c => c.id).filter(Boolean)
      : LIFE_CATS.filter(x => x !== 'general');
    const vecs = {};
    for(const id of ids){
      if(id === 'general') continue;
      const def = getCategoryDef(id);
      const text = _categoryEmbedTextFromDef(def);
      if(!text) continue;
      vecs[id] = await embedText(text);
    }
    await embedStore.setMeta(key, { schemaVer, dim, vecs });
    return vecs;
  })();

  try{
    return await _categoryCentroidsPromise;
  }finally{
    _categoryCentroidsPromise = null;
  }
}

function invalidateCategoryCentroids(){
  _categoryCentroidsPromise = null;
  if(typeof embedStore === 'undefined' || !embedStore.deleteMeta) return;
  const key = typeof embedStore.getCatCentroidsKey === 'function' ? embedStore.getCatCentroidsKey() : 'cat_centroids_v1';
  embedStore.deleteMeta(key).catch(() => {});
}

function _sanitizeMergedCategory(merged){
  if(!merged || !merged.category) return;
  if(merged.category === 'general' || typeof hasClassificationCategory !== 'function' || !hasClassificationCategory(merged.category)){
    delete merged.category;
  }
}

function _weightedFieldVote(topNeighbors, field){
  const w = new Map();
  let total = 0;
  for(const { t, sim } of topNeighbors){
    const v = t[field];
    if(v == null || v === '') continue;
    w.set(v, (w.get(v) || 0) + sim);
    total += sim;
  }
  if(!w.size || total <= 0) return { value: null, confidence: 0, margin: 0, totalWeight: 0 };
  const sorted = [...w.entries()].sort((a, b) => b[1] - a[1]);
  const [v0, w0] = sorted[0];
  const w1 = sorted[1] ? sorted[1][1] : 0;
  const confidence = w0 / total;
  const margin = w0 > 0 ? (w0 - w1) / w0 : 0;
  return { value: v0, confidence, margin, totalWeight: w0 };
}

/**
 * kNN metadata from a precomputed query vector (no embedText call).
 * @param {Float32Array} queryVec
 * @param {{ store: Map<number,{vec:Float32Array,textHash:string}>, excludeId?: number|null, heuristic?: object, k?: number }} opts
 */
function predictMetadataFromVec(queryVec, opts){
  const o = opts || {};
  const store = o.store;
  const excludeId = o.excludeId == null ? null : o.excludeId;
  const kk = o.k || 5;
  const heuristic = (o.heuristic && typeof o.heuristic === 'object') ? { ...o.heuristic } : {};
  const merged = { ...heuristic };
  const _confidence = {};
  const hadHeuristicCat = !!(heuristic && heuristic.category);

  if(!queryVec){
    merged._confidence = _confidence;
    _sanitizeMergedCategory(merged);
    return merged;
  }

  const centroidMap = o.categoryCentroidVecs;
  let catFromCentroid = null;
  if(!hadHeuristicCat && centroidMap && typeof centroidMap === 'object'){
    const scoredC = [];
    for(const [cid, vec] of Object.entries(centroidMap)){
      if(cid === 'general' || !vec) continue;
      const v = vec instanceof Float32Array ? vec : new Float32Array(vec);
      if(v.length !== queryVec.length) continue;
      const sim = cosine(queryVec, v);
      scoredC.push({ id: cid, sim });
    }
    scoredC.sort((a, b) => b.sim - a.sim);
    if(scoredC.length){
      const best = scoredC[0];
      const second = scoredC[1];
      const haveRunnerUp = scoredC.length >= 2 && second;
      const margin = haveRunnerUp && best.sim > 0 ? (best.sim - second.sim) / best.sim : null;
      _confidence.categoryCentroid = { best: best.id, sim: best.sim, margin, second: second && second.id };
      if(
        best.sim >= CAT_CENTROID_MIN_SIM && best.id !== 'general' &&
        (margin != null ? margin >= CAT_CENTROID_MIN_MARGIN : false)
      ){
        catFromCentroid = best.id;
      }
    }
  }

  if(!store){
    if(!hadHeuristicCat && catFromCentroid) merged.category = catFromCentroid;
    merged._confidence = _confidence;
    _sanitizeMergedCategory(merged);
    return merged;
  }

  const scored = [];
  for(const [id, rec] of store){
    if(id === excludeId) continue;
    if(!rec || !rec.vec || rec.vec.length !== queryVec.length) continue;
    const t = typeof findTask === 'function' ? findTask(id) : null;
    if(!t || t.archived) continue;
    scored.push({ t, sim: cosine(queryVec, rec.vec) });
  }
  scored.sort((a, b) => b.sim - a.sim);
  const top = scored.slice(0, kk).filter(x => x.sim > KNN_MIN_SIM);
  if(!top.length){
    if(!hadHeuristicCat && catFromCentroid) merged.category = catFromCentroid;
    merged._confidence = _confidence;
    _sanitizeMergedCategory(merged);
    return merged;
  }

  const pickDiscrete = (field, minConf, minMargin, validator) => {
    const { value, confidence, margin } = _weightedFieldVote(top, field);
    _confidence[field] = { value, confidence, margin };
    if(value == null) return null;
    if(confidence < minConf || margin < minMargin) return null;
    if(typeof validator === 'function' && !validator(value)) return null;
    return value;
  };

  if(!hadHeuristicCat){
    if(catFromCentroid){
      merged.category = catFromCentroid;
    } else {
      const cat = pickDiscrete('category', KNN_CAT_MIN_CONF, KNN_CAT_MIN_MARGIN, v => v !== 'general' && hasClassificationCategory(v));
      if(cat) merged.category = cat;
    }
  }

  const prVote = _weightedFieldVote(top, 'priority');
  _confidence.priority = { value: prVote.value, confidence: prVote.confidence, margin: prVote.margin };
  if(prVote.value && ['urgent','high','normal','low'].includes(prVote.value) && prVote.confidence >= KNN_PRIO_EFF_EN_MIN_CONF){
    merged.priority = prVote.value;
  }

  const effVote = _weightedFieldVote(top, 'effort');
  _confidence.effort = { value: effVote.value, confidence: effVote.confidence, margin: effVote.margin };
  if(effVote.value && ['xs','s','m','l','xl'].includes(effVote.value) && effVote.confidence >= KNN_PRIO_EFF_EN_MIN_CONF){
    merged.effort = effVote.value;
  }

  const enVote = _weightedFieldVote(top, 'energyLevel');
  _confidence.energyLevel = { value: enVote.value, confidence: enVote.confidence, margin: enVote.margin };
  if(enVote.value && ['high','low'].includes(enVote.value) && enVote.confidence >= KNN_PRIO_EFF_EN_MIN_CONF){
    merged.energyLevel = enVote.value;
  }

  const tagCounts = new Map();
  for(const { t, sim } of top){
    (t.tags || []).forEach(tag => {
      if(!tag || typeof tag !== 'string') return;
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + sim);
    });
  }
  const tagSorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
  let tags = [];
  if(tagSorted.length){
    const topW = tagSorted[0][1];
    const floor = topW * KNN_TAG_TOP_FRAC;
    tags = tagSorted.filter(([, w]) => w >= floor).slice(0, 5).map(x => x[0]);
    _confidence.tags = { topWeight: topW, picked: tags.slice() };
  }
  if(tags.length) merged.tags = tags;

  merged._confidence = _confidence;
  _sanitizeMergedCategory(merged);
  return merged;
}

/**
 * kNN vote from embedding store (embeds query text once).
 */
async function predictMetadata(taskName, k){
  const kk = k || 5;
  const q = await embedText(taskName);
  const store = await embedStore.all();
  let centroids = null;
  try{ centroids = await ensureCategoryCentroids(); }catch(e){}
  return predictMetadataFromVec(q, {
    store,
    excludeId: null,
    heuristic: _heuristicMetadata(taskName),
    k: kk,
    categoryCentroidVecs: centroids || undefined,
  });
}

/**
 * G-8: Suggest a dueDate by looking at the median offset (in days from
 * creation) of similar past tasks with due dates. Returns YYYY-MM-DD or null.
 *
 * Heuristic: take top-K most-similar tasks that had a dueDate; compute their
 * (dueDate − created) in days; use the median, clamped to [0, 90]. We project
 * forward from *today*, not from the source's creation date.
 */
async function predictDueDate(taskName, k){
  if(typeof embedText !== 'function' || typeof embedStore === 'undefined' || !embedStore || typeof cosine !== 'function') return null;
  const q = await embedText(taskName);
  if(!q) return null;
  const store = await embedStore.all();
  const scored = [];
  for(const [id, rec] of store){
    if(!rec || !rec.vec || rec.vec.length !== q.length) continue;
    const t = typeof findTask === 'function' ? findTask(id) : null;
    if(!t || t.archived || !t.dueDate || !t.created) continue;
    scored.push({ t, sim: cosine(q, rec.vec) });
  }
  scored.sort((a, b) => b.sim - a.sim);
  const top = scored.slice(0, k || 8).filter(x => x.sim > 0.5);
  if(top.length < 3) return null; // need a quorum to avoid noise
  // Compute relative offsets in days
  const offsets = [];
  for(const { t } of top){
    try{
      const dDue = new Date(t.dueDate + 'T00:00:00').getTime();
      const dCreated = new Date(String(t.created).slice(0, 10) + 'T00:00:00').getTime();
      if(!Number.isFinite(dDue) || !Number.isFinite(dCreated)) continue;
      const diff = Math.round((dDue - dCreated) / 86400000);
      if(diff >= 0 && diff <= 365) offsets.push(diff);
    }catch(_){}
  }
  if(offsets.length < 3) return null;
  offsets.sort((a, b) => a - b);
  const median = offsets[Math.floor(offsets.length / 2)];
  const clamped = Math.max(0, Math.min(90, median));
  const today = new Date();
  today.setDate(today.getDate() + clamped);
  return today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
}
if(typeof window !== 'undefined') window.predictDueDate = predictDueDate;

/**
 * Predict the best-fitting list for a freeform task name via embeddings.
 * Mirrors the matcher inside autoOrganizeIntoLists() but for a single
 * unsaved task (so it works in the bulk-import flow before tasks land in
 * the store). Returns the list id or null when:
 *   - fewer than 2 lists exist
 *   - the cosine score is below the routing minimum
 *   - the margin to the runner-up is too small (avoids low-confidence picks)
 */
async function predictListId(taskName, opts){
  const o = opts || {};
  const minScore = o.minScore == null ? 0.45 : o.minScore;
  const minMargin = o.minMargin == null ? 0.04 : o.minMargin;
  if(typeof lists === 'undefined' || !Array.isArray(lists) || lists.length < 2) return null;
  if(typeof embedText !== 'function' || typeof cosine !== 'function') return null;
  const listVecs = await _getListVectors();
  if(!listVecs || listVecs.size < 2) return null;
  let q;
  try{ q = await embedText(taskName); }catch(e){ return null; }
  if(!q) return null;
  let best = null, second = null;
  for(const [lid, lv] of listVecs){
    if(!lv || lv.length !== q.length) continue;
    const sim = cosine(q, lv);
    if(!best || sim > best.sim){ second = best; best = { lid, sim }; }
    else if(!second || sim > second.sim){ second = { lid, sim }; }
  }
  if(!best || best.sim < minScore) return null;
  if(second && (best.sim - second.sim) < minMargin) return null;
  return best.lid;
}
if(typeof window !== 'undefined') window.predictListId = predictListId;

async function semanticSearch(query, limit){
  const lim = limit || 20;
  const q = await embedText(query);
  const store = await embedStore.all();
  const scored = [];
  for(const [id, rec] of store){
    if(!rec || !rec.vec || rec.vec.length !== q.length) continue;
    const t = typeof findTask === 'function' ? findTask(id) : null;
    if(!t || t.archived || t.status === 'done') continue;
    scored.push({ id, t, score: cosine(q, rec.vec) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, lim);
}

const _DUP_PAIR_YIELD = 350;

async function findDuplicates(threshold){
  const th = threshold == null ? 0.9 : threshold;
  const store = await embedStore.all();
  const ids = [...store.keys()];
  const pairs = [];
  let pairsChecked = 0;
  for(let i = 0; i < ids.length; i++){
    for(let j = i + 1; j < ids.length; j++){
      const a = ids[i], b = ids[j];
      const va = store.get(a).vec;
      const vb = store.get(b).vec;
      const sim = cosine(va, vb);
      if(sim >= th){
        const ta = findTask(a), tb = findTask(b);
        if(!ta || !tb || ta.archived || tb.archived) continue;
        pairs.push({ idA: a, idB: b, sim, taskA: ta, taskB: tb });
      }
      if(++pairsChecked % _DUP_PAIR_YIELD === 0) await new Promise(r => setTimeout(r, 0));
    }
  }
  pairs.sort((a, b) => b.sim - a.sim);
  return pairs;
}

/** Per-task max similarity to any other (for badge) */
async function computeDuplicateScores(){
  const store = await embedStore.all();
  const ids = [...store.keys()];
  const maxSim = new Map();
  let pairsChecked = 0;
  for(let i = 0; i < ids.length; i++){
    for(let j = i + 1; j < ids.length; j++){
      const a = ids[i], b = ids[j];
      const va = store.get(a).vec;
      const vb = store.get(b).vec;
      const sim = cosine(va, vb);
      if(sim >= 0.85){
        maxSim.set(a, Math.max(maxSim.get(a) || 0, sim));
        maxSim.set(b, Math.max(maxSim.get(b) || 0, sim));
      }
      if(++pairsChecked % _DUP_PAIR_YIELD === 0) await new Promise(r => setTimeout(r, 0));
    }
  }
  return maxSim;
}

function alignValuesFromVec(vec, schwartzVecs){
  if(!vec || !schwartzVecs) return [];
  const ranked = Object.entries(schwartzVecs)
    .map(([name, v]) => ({ name, sim: cosine(vec, v) }))
    .sort((a, b) => b.sim - a.sim)
    .filter(x => Number.isFinite(x.sim) && x.sim > 0.35)
    .slice(0, 3);
  return ranked.map(x => x.name);
}

async function alignValuesForTask(taskId){
  const t = typeof findTask === 'function' ? findTask(taskId) : null;
  if(!t) return [];
  const schwartzVecs = await ensureSchwartzEmbeddings();
  if(!schwartzVecs) return [];

  let vec;
  const got = await embedStore.get(t.id);
  if(got && got.vec) vec = got.vec;
  else vec = await embedText(_taskText(t));

  return alignValuesFromVec(vec, schwartzVecs);
}

function isTaskBlocked(t){
  if(!t || t.status === 'done' || t.archived) return true;
  if((t.status || '') === 'blocked') return true;
  const bb = t.blockedBy || [];
  for(const bid of bb){
    const b = typeof findTask === 'function' ? findTask(bid) : null;
    if(b && b.status !== 'done') return true;
  }
  return false;
}

function priorityWeight(t){
  const p = t.priority || 'none';
  return ({ urgent: 40, high: 28, normal: 14, low: 6, none: 0 })[p] || 0;
}

function deadlineUrgency(t, nowMs){
  if(!t.dueDate) return 0;
  const today = typeof todayISO === 'function' ? todayISO() : new Date().toISOString().slice(0, 10);
  if(t.dueDate < today) return 30;
  if(t.dueDate === today) return 22;
  const d = new Date(t.dueDate + 'T00:00:00');
  const diff = (d - new Date(today + 'T00:00:00')) / (86400000);
  if(diff <= 1) return 16;
  if(diff <= 7) return 8;
  return 3;
}

function effortFit(t, timeMin){
  if(timeMin == null || timeMin <= 0) return 0;
  const map = { xs: 15, s: 60, m: 240, l: 480, xl: 960 };
  const est = map[t.effort || ''] || 60;
  if(est <= timeMin) return 6;
  if(est <= timeMin * 2) return 3;
  return 0;
}

function energyFit(t, energy){
  if(!energy) return 0;
  if(energy === 'high' && t.energyLevel === 'high') return 4;
  if(energy === 'low' && (t.energyLevel === 'low' || !t.energyLevel)) return 4;
  if(!t.energyLevel) return 2;
  return 0;
}

function rankWhatNext(tasks, opts){
  const o = opts || {};
  const now = Date.now();
  const list = (tasks || []).filter(t => t && t.status !== 'done' && !t.archived && !isTaskBlocked(t));
  return list.map(t => ({
    t,
    score:
      priorityWeight(t)
      + deadlineUrgency(t, now)
      + (t.starred ? 12 : 0)
      + effortFit(t, o.timeMin)
      + energyFit(t, o.energy),
  })).sort((a, b) => b.score - a.score);
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTO-ORGANIZE INTO LISTS
// Embeds each list (name + description) once per content-hash, caches in meta
// store, then proposes CHANGE_LIST moves for tasks whose best list differs
// from their current list with enough confidence. Lists without descriptions
// still work — they just carry weaker signal (name-only embedding).
// ══════════════════════════════════════════════════════════════════════════════
const META_LIST_VECS_KEY = 'list_vecs_v1';

function _listText(l){
  const name = l.name || '';
  const desc = (l.description || '').slice(0, 2000);
  return desc ? `${name}\n${desc}` : name;
}

function _l2normalize(v){
  let s = 0;
  for(let i = 0; i < v.length; i++) s += v[i] * v[i];
  if(s > 0){
    const inv = 1 / Math.sqrt(s);
    for(let i = 0; i < v.length; i++) v[i] *= inv;
  }
  return v;
}

// Weight on the manual-sort centroid vs. the list's name/description vector
// when both are available. 0 = text-only (legacy), 1 = membership-only.
const LIST_MEMBER_BLEND = 0.5;

/** @returns {Promise<Map<number, Float32Array>>} */
async function _getListVectors(){
  if(typeof lists === 'undefined' || !Array.isArray(lists) || !lists.length) return new Map();
  const meta = await embedStore.getMeta(META_LIST_VECS_KEY);
  const cache = (meta && meta.vecs && typeof meta.vecs === 'object') ? meta.vecs : {};
  const result = new Map();
  let dirty = false;

  // Pull every task embedding once so each list's routing vector can be biased
  // toward the centroid of the tasks the user has actually filed under it. This
  // is how auto-organize "learns from manual sorting" instead of relying purely
  // on the list's name/description.
  let store = null;
  try{ store = await embedStore.all(); }catch(e){ store = null; }
  const membersByList = new Map();
  if(store){
    for(const [id, rec] of store){
      if(!rec || !rec.vec) continue;
      const t = (typeof findTask === 'function') ? findTask(id) : null;
      if(!t || t.archived || t.status === 'done' || t.listId == null) continue;
      let arr = membersByList.get(t.listId);
      if(!arr){ arr = []; membersByList.set(t.listId, arr); }
      arr.push({ id, vec: rec.vec, textHash: rec.textHash || '' });
    }
  }

  for(const l of lists){
    const members = membersByList.get(l.id) || [];
    // Fold the member set (ids + their text hashes) into the cache key so the
    // blended vector recomputes whenever this list's contents change.
    const memberSig = members.map(m => m.id + ':' + m.textHash).sort().join('|');
    const h = hashTaskText(l.name, l.description) + '~' + hashTaskText('members', memberSig);
    const cur = cache[l.id];
    if(cur && cur.hash === h && cur.vec){
      result.set(l.id, new Float32Array(cur.vec));
      continue;
    }
    const textVec = await embedText(_listText(l));
    let combined = textVec instanceof Float32Array ? textVec : new Float32Array(textVec);
    const dim = combined.length;
    if(members.length && dim){
      const centroid = new Float32Array(dim);
      let counted = 0;
      for(const m of members){
        const v = m.vec;
        if(!v || v.length !== dim) continue;
        for(let i = 0; i < dim; i++) centroid[i] += v[i];
        counted++;
      }
      if(counted){
        // Normalize the centroid, blend with the list-text vector, then
        // re-normalize so cosine() (a dot product over unit vectors) stays valid.
        _l2normalize(centroid);
        const blended = new Float32Array(dim);
        for(let i = 0; i < dim; i++) blended[i] = LIST_MEMBER_BLEND * centroid[i] + (1 - LIST_MEMBER_BLEND) * combined[i];
        _l2normalize(blended);
        combined = blended;
      }
    }
    const buf = combined.buffer
      ? combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength)
      : combined;
    cache[l.id] = { hash: h, vec: buf };
    result.set(l.id, new Float32Array(buf));
    dirty = true;
  }

  // Prune stale cache entries for deleted lists
  const liveIds = new Set(lists.map(l => l.id));
  for(const k of Object.keys(cache)){
    if(!liveIds.has(Number(k))){
      delete cache[k];
      dirty = true;
    }
  }

  if(dirty) await embedStore.setMeta(META_LIST_VECS_KEY, { vecs: cache });
  return result;
}

async function invalidateListVectorCache(){
  try{ await embedStore.setMeta(META_LIST_VECS_KEY, { vecs: {} }); }catch(e){}
}

/**
 * Propose list moves for active (non-archived, non-done) tasks whose best-fitting
 * list differs from their current one.
 * @param {{minScore?:number, minMargin?:number, includeEmptyListId?:boolean}} opts
 *   minScore   — min absolute cosine to the winning list (default 0.45)
 *   minMargin  — min gap between best and 2nd-best list (default 0.04)
 * @returns {Promise<Array<{id:number,name:string,fromListId:number|null,toListId:number,sim:number,margin:number}>>}
 */
async function autoOrganizeIntoLists(opts){
  const o = opts || {};
  const minScore = o.minScore == null ? 0.45 : o.minScore;
  const minMargin = o.minMargin == null ? 0.04 : o.minMargin;
  if(typeof lists === 'undefined' || !Array.isArray(lists) || lists.length < 2) return [];

  const listVecs = await _getListVectors();
  if(listVecs.size < 2) return [];

  if(typeof tasks !== 'undefined' && Array.isArray(tasks) && typeof embedStore !== 'undefined' && embedStore.ensure){
    for(const t of tasks){
      if(!t || t.archived || t.status === 'done') continue;
      try{ await embedStore.ensure(t); }catch(e){ /* skip */ }
      // WASM embeddings block the main thread — yield so the AI panel can
      // repaint between items instead of freezing for the whole batch.
      await new Promise(r => setTimeout(r, 0));
    }
  }

  const store = await embedStore.all();
  const proposals = [];

  for(const [id, rec] of store){
    const t = typeof findTask === 'function' ? findTask(id) : null;
    if(!t || t.archived || t.status === 'done') continue;

    let best = null, second = null;
    for(const [lid, lv] of listVecs){
      if(!lv || lv.length !== rec.vec.length) continue;
      const sim = cosine(rec.vec, lv);
      if(!best || sim > best.sim){ second = best; best = { lid, sim }; }
      else if(!second || sim > second.sim){ second = { lid, sim }; }
    }
    if(!best || best.sim < minScore) continue;
    if(second && (best.sim - second.sim) < minMargin) continue;
    if(t.listId === best.lid) continue;

    proposals.push({
      id: t.id,
      name: t.name,
      fromListId: t.listId || null,
      toListId: best.lid,
      sim: best.sim,
      margin: second ? best.sim - second.sim : best.sim,
    });
  }

  proposals.sort((a, b) => b.sim - a.sim);
  return proposals;
}

function _stableSortedJson(arr){
  return JSON.stringify([...(arr || [])].map(String).sort());
}

/**
 * Build UPDATE_TASK ops from embeddings: Schwartz-style values + kNN metadata
 * (category, priority, effort, energy, tags) where they differ from current.
 * Uses dominant value keys when set (from settings) to filter alignment; otherwise top 3.
 * @param {{dominant?:string[], maxTasks?:number}} opts
 * @returns {Promise<Array<{name:'UPDATE_TASK', args:object}>>}
 */
async function proposeHarmonizeUpdates(opts){
  const o = opts || {};
  const dominant = Array.isArray(o.dominant) ? o.dominant : [];
  const maxTasks = o.maxTasks == null ? 200 : o.maxTasks;
  if(typeof tasks === 'undefined' || !Array.isArray(tasks)) return [];

  const schwartzVecs = await ensureSchwartzEmbeddings();

  const active = tasks.filter(t => t && !t.archived && t.status !== 'done').slice(0, maxTasks);
  const ops = [];

  if(typeof embedStore !== 'undefined' && embedStore.ensure){
    for(const t of active){
      try{ await embedStore.ensure(t); }catch(e){ /* skip */ }
      // Yield between WASM embeds so Harmonize doesn't freeze the AI panel.
      await new Promise(r => setTimeout(r, 0));
    }
  }
  const store = await embedStore.all();
  let centroids = null;
  try{ centroids = await ensureCategoryCentroids(); }catch(e){}

  for(const t of active){
    const rec = store.get(t.id);
    if(!rec || !rec.vec) continue;

    const meta = predictMetadataFromVec(rec.vec, {
      store,
      excludeId: t.id,
      heuristic: _heuristicMetadata((t.name || '').trim()),
      k: 7,
      categoryCentroidVecs: centroids || undefined,
    });
    const fieldConfidence = meta._confidence || null;
    if(meta._confidence) delete meta._confidence;

    const valsRaw = schwartzVecs ? alignValuesFromVec(rec.vec, schwartzVecs) : [];
    const useVals = dominant.length
      ? valsRaw.filter(v => dominant.includes(v))
      : valsRaw.slice(0, 3);
    const vals = useVals.length ? useVals : valsRaw.slice(0, 3);

    const args = { id: t.id };
    let changes = 0;

    if(vals.length){
      if(_stableSortedJson(t.valuesAlignment) !== _stableSortedJson(vals)){
        args.valuesAlignment = vals;
        args.valuesNote = 'Harmonized from on-device embeddings (values + task similarity)';
        changes++;
      }
    }

    if(meta.category && hasClassificationCategory(meta.category) && meta.category !== (t.category || null)){
      args.category = meta.category;
      changes++;
    }
    if(meta.priority && ['urgent','high','normal','low'].includes(meta.priority) && meta.priority !== (t.priority || 'none')){
      args.priority = meta.priority;
      changes++;
    }
    if(meta.effort && ['xs','s','m','l','xl'].includes(meta.effort) && meta.effort !== (t.effort || null)){
      args.effort = meta.effort;
      changes++;
    }
    if(meta.energyLevel && ['high','low'].includes(meta.energyLevel) && meta.energyLevel !== (t.energyLevel || null)){
      args.energyLevel = meta.energyLevel;
      changes++;
    }
    if(Array.isArray(meta.tags) && meta.tags.length){
      const cur = [...(t.tags || [])];
      const merged = [...cur];
      const seen = new Set(cur.map(String));
      let added = false;
      for(const tag of meta.tags){
        if(merged.length >= 12) break;
        if(tag && !seen.has(tag)){
          merged.push(tag);
          seen.add(tag);
          added = true;
        }
      }
      if(added){
        args.tags = merged;
        changes++;
      }
    }

    if(changes){
      const op = { name: 'UPDATE_TASK', args };
      if(fieldConfidence) op._fieldConfidence = fieldConfidence;
      ops.push(op);
    }
  }

  return ops;
}

/**
 * Suggest life areas for tasks that have no `category` (preview as UPDATE_TASK batch).
 * @returns {Promise<Array<{name:'UPDATE_TASK',args:object}>>}
 */
async function proposeReclassifyUncategorized(){
  const ops = [];
  if(typeof tasks === 'undefined' || !Array.isArray(tasks)) return ops;
  const targets = tasks.filter(t => t && !t.archived && !t.category);
  if(!targets.length) return ops;
  if(typeof embedStore !== 'undefined' && embedStore.ensure){
    for(const t of targets){
      try{ await embedStore.ensure(t); }catch(e){}
      // Yield between WASM embeds so Reclassify doesn't freeze the AI panel.
      await new Promise(r => setTimeout(r, 0));
    }
  }
  const store = await embedStore.all();
  let centroids = null;
  try{ centroids = await ensureCategoryCentroids(); }catch(e){}
  for(const t of targets){
    const rec = store.get(t.id);
    if(!rec || !rec.vec) continue;
    const meta = predictMetadataFromVec(rec.vec, {
      store,
      excludeId: t.id,
      heuristic: _heuristicMetadata((t.name || '').trim()),
      k: 7,
      categoryCentroidVecs: centroids || undefined,
    });
    if(meta._confidence) delete meta._confidence;
    if(meta.category && hasClassificationCategory(meta.category) && meta.category !== 'general'){
      ops.push({ name: 'UPDATE_TASK', args: { id: t.id, category: meta.category } });
    }
  }
  return ops;
}

async function similarTasksFor(taskId, k){
  const kk = k || 5;
  const t = findTask(taskId);
  if(!t) return [];
  let vec;
  const got = await embedStore.get(taskId);
  if(got && got.vec) vec = got.vec;
  else vec = await embedText(_taskText(t));

  const store = await embedStore.all();
  const scored = [];
  for(const [id, rec] of store){
    if(id === taskId) continue;
    const ot = findTask(id);
    if(!ot || ot.archived) continue;
    scored.push({ id, t: ot, sim: cosine(vec, rec.vec) });
  }
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, kk);
}

window.ensureSchwartzEmbeddings = ensureSchwartzEmbeddings;
window.predictMetadataFromVec = predictMetadataFromVec;
window.alignValuesFromVec = alignValuesFromVec;
window.predictMetadata = predictMetadata;
window.semanticSearch = semanticSearch;
window.findDuplicates = findDuplicates;
window.computeDuplicateScores = computeDuplicateScores;
window.alignValuesForTask = alignValuesForTask;
window.rankWhatNext = rankWhatNext;
window.similarTasksFor = similarTasksFor;
window.isTaskBlocked = isTaskBlocked;
window.autoOrganizeIntoLists = autoOrganizeIntoLists;
window.invalidateListVectorCache = invalidateListVectorCache;
window.proposeHarmonizeUpdates = proposeHarmonizeUpdates;
window.proposeReclassifyUncategorized = proposeReclassifyUncategorized;
window.ensureCategoryCentroids = ensureCategoryCentroids;
window.invalidateCategoryCentroids = invalidateCategoryCentroids;
window.ensureClassificationConfig = ensureClassificationConfig;
window.getCategoryDef = getCategoryDef;
window.getActiveCategories = getActiveCategories;
window.hasClassificationCategory = hasClassificationCategory;
window.renderClassificationSettings = renderClassificationSettings;
window.refreshClassificationUi = refreshClassificationUi;
window.classificationMove = classificationMove;
window.classificationToggleHidden = classificationToggleHidden;
window.classificationSetLabel = classificationSetLabel;
window.classificationSetIcon = classificationSetIcon;
window.classificationSetColor = classificationSetColor;
window.classificationSetFocus = classificationSetFocus;
window.classificationSetExamples = classificationSetExamples;
window.classificationSetCoreValues = classificationSetCoreValues;
window.classificationResetDetails = classificationResetDetails;
window.classificationAdd = classificationAdd;
