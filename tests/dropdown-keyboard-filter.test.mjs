/**
 * Regression: Dropdown kept the keyboard highlight as an index into the SOURCE
 * options array, while _applyHighlight / moveHighlight / Enter all operate on
 * the VISIBLE (filtered) DOM items. Once the search box filtered the list
 * (recurrence picker has 11 options, > the 8-item searchable threshold), arrow
 * keys and Enter highlighted/selected the wrong row — or nothing at all. The
 * highlight must be a visible-DOM index, recomputed on every render.
 *
 * Exercised against a minimal DOM stub so the real open()/renderItems()/
 * keyHandler() run end-to-end.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'dropdown.js'), 'utf8');

function makeClassList(el) {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle: (c, force) => {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      return on;
    },
    _set: set,
  };
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toLowerCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attrs = {};
    this.style = {};
    this.listeners = {};
    this._text = '';
    this.value = '';
    this.classList = makeClassList(this);
    this.offsetHeight = 10;
    this.offsetWidth = 10;
  }
  set className(v) {
    this.classList._set.clear();
    String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList._set.add(c));
  }
  get className() { return [...this.classList._set].join(' '); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k]; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  insertBefore(c, ref) {
    const i = this.children.indexOf(ref);
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    c.parentNode = this; return c;
  }
  replaceChildren() { this.children = []; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) {
    const a = this.listeners[type]; if (!a) return;
    const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
  }
  fire(type, ev) { (this.listeners[type] || []).slice().forEach((fn) => fn(ev || {})); }
  getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0 }; }
  scrollIntoView() {}
  focus() {}
  contains() { return false; }
  _walk(out) { for (const c of this.children) { out.push(c); c._walk(out); } }
  querySelectorAll(sel) {
    const cls = sel.replace(/^\./, '');
    const out = []; this._walk(out);
    return out.filter((e) => e.classList.contains(cls));
  }
}

function openDropdown(opts) {
  const doc = new El('#document');
  doc.body = new El('body');
  doc.createElement = (t) => new El(t);
  doc.activeElement = null;
  const win = { innerHeight: 800, innerWidth: 1200 };
  const matchMedia = () => ({ matches: false });
  const raf = () => {}; // skip the deferred outside-click listeners
  const factory = new Function(
    'window', 'document', 'matchMedia', 'requestAnimationFrame',
    src + '\n; return window.Dropdown;',
  );
  win.document = doc;
  const Dropdown = factory(win, doc, matchMedia, raf);

  const trigger = new El('button');
  const selected = [];
  Dropdown.open(trigger, { ...opts, onSelect: (v) => selected.push(v) });

  const root = doc.body.children[doc.body.children.length - 1];
  const searchEl = root.children.find((c) => c.tagName === 'input') || null;
  const listEl = root.children.find((c) => c.classList.contains('dropdown-list'));

  return {
    type: (s) => { if (searchEl) { searchEl.value = s; searchEl.fire('input'); } },
    press: (key) => doc.fire('keydown', { key, preventDefault() {} }),
    visibleValues: () => listEl.querySelectorAll('dropdown-item').map((e) => e.dataset.value),
    highlightedValue: () => {
      const hit = listEl.querySelectorAll('dropdown-item').find((e) => e.classList.contains('is-highlight'));
      return hit ? hit.dataset.value : null;
    },
    selected,
  };
}

const RECUR = [
  'never', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly',
  'quarterly', 'yearly', 'weekends', 'workdays', 'custom',
].map((v) => ({ value: v, label: v }));

test('Enter selects the highlighted (selected) row with no filter', () => {
  const dd = openDropdown({ options: RECUR, selected: 'monthly' });
  assert.equal(dd.highlightedValue(), 'monthly', 'selected row is highlighted on open');
  dd.press('Enter');
  assert.deepEqual(dd.selected, ['monthly']);
});

test('after filtering, ArrowDown + Enter selects the FIRST VISIBLE row (not a stale source index)', () => {
  const dd = openDropdown({ options: RECUR, selected: 'custom' /* last, source idx 10 */ });
  // Filter to items starting with "w": weekdays, weekly, weekends, workdays.
  dd.type('w');
  const visible = dd.visibleValues();
  assert.deepEqual(visible, ['weekdays', 'weekly', 'weekends', 'workdays']);
  // 'custom' is filtered out, so highlight reset; ArrowDown -> first visible.
  dd.press('ArrowDown');
  assert.equal(dd.highlightedValue(), 'weekdays', 'highlight must land on the first visible row');
  dd.press('Enter');
  assert.deepEqual(dd.selected, ['weekdays'], 'Enter selects the highlighted visible row, not a stale index');
});

test('ArrowUp from no highlight wraps to the last visible row', () => {
  const dd = openDropdown({ options: RECUR, selected: 'never' });
  dd.type('w'); // 4 items, selected 'never' filtered out -> highlight -1
  dd.press('ArrowUp');
  assert.equal(dd.highlightedValue(), 'workdays', 'ArrowUp from empty highlight selects the last visible row');
});
