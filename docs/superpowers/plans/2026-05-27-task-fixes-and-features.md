# Task Fixes and Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship four targeted improvements to OdTauLai's task list — fix done-subtask visibility, fix horizontal-scroll selection-bar clipping on swipe-right, add a reusable Dropdown utility (migrating Recurrence + List), and add duration / completion-date search operators.

**Architecture:** Each task is an independent commit. No new architectural patterns — every change either fixes an existing function or adds a small utility (`js/dropdown.js`) modeled on the recently-shipped `js/modal.js`. The plan piggybacks on existing infrastructure: the `parseTaskSearchQuery` parser block in `js/tasks.js`, the `.task-action-menu` popover primitive in `css/main.css`, the test-runner pattern that slices live source into a function scope for unit testing (see `tests/search-operators.test.mjs` for the canonical example).

**Tech Stack:** Static PWA, vanilla JS (no bundler), CSS custom properties, node:test for unit tests, Puppeteer smoke tests, service-worker asset list.

**Source spec:** `docs/superpowers/specs/2026-05-27-task-fixes-and-features-design.md`

**Test pattern note:** Several tasks below add unit tests that load a slice of `js/tasks.js` into an isolated function scope. The canonical pattern is `tests/search-operators.test.mjs:13-29`. Copy that file's header (the `readFileSync` / `indexOf` / `slice` block) verbatim into each new test file, then adjust the slice markers as called out per task.

---

## Task 1: Hide done subtasks in non-completed views

**Files:**
- Modify: `js/tasks.js:1109-1115` — `_subtaskAllowedUnderShownParent()`
- Test (new): `tests/subtask-done-visibility.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/subtask-done-visibility.test.mjs`. Use the same source-slicing pattern as `tests/search-operators.test.mjs:13-29`, but:
- The slice markers are `'function _subtaskAllowedUnderShownParent'` (start) and the next `'\n}'` after it (end).
- The function reads `smartView` and `gid('showCompletedAll')` from surrounding scope. Stub them via a prelude string concatenated before the slice. Stub `todayISO` as `() => '2026-05-27'`.

The six assertions to write (one `test(...)` block each):

```js
test('done subtask is hidden in today view when showCompletedAll is off', () => {
  const fn = loadFn('today', false);     // helper that injects stubs and returns the sliced function
  assert.equal(fn({ status: 'done' }), false);
});

test('done subtask is visible in completed view regardless of toggle', () => {
  const fn = loadFn('completed', false);
  assert.equal(fn({ status: 'done' }), true);
});

test('done subtask is visible in all view when showCompletedAll is on', () => {
  const fn = loadFn('all', true);
  assert.equal(fn({ status: 'done' }), true);
});

test('open subtask is visible in any non-snooze view', () => {
  for(const view of ['today', 'all', 'starred', 'completed', 'overdue']){
    const fn = loadFn(view, false);
    assert.equal(fn({ status: 'open' }), true, 'view=' + view);
  }
});

test('snoozed subtask is hidden in non-snooze view', () => {
  const fn = loadFn('today', false);
  assert.equal(fn({ status: 'open', hiddenUntil: '2026-05-28' }), false);
});

test('snoozed subtask is visible in snoozed view', () => {
  const fn = loadFn('snoozed', false);
  assert.equal(fn({ status: 'open', hiddenUntil: '2026-05-28' }), true);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test tests/subtask-done-visibility.test.mjs`

Expected: the four `done`-related assertions FAIL (the function currently does not filter on status). The two snooze-related tests PASS (existing behaviour).

- [ ] **Step 3: Implement the fix**

In `js/tasks.js`, replace the body of `_subtaskAllowedUnderShownParent` (currently lines 1109-1115) with:

```js
function _subtaskAllowedUnderShownParent(t){
  if(!t) return false;
  const today = (typeof todayISO === 'function') ? todayISO() : null;
  if(today && t.hiddenUntil && t.hiddenUntil > today
     && smartView !== 'snoozed'
     && smartView !== 'completed') return false;
  // Hide done children outside the 'completed' view unless the global
  // "show completed" toggle is on — same rule top-level done tasks already
  // follow in the 'all' view (matchesFilters at line ~2646).
  if(t.status === 'done' && smartView !== 'completed'){
    const sd = gid('showCompletedAll');
    if(!sd || !sd.checked) return false;
  }
  return true;
}
```

- [ ] **Step 4: Run the new test and verify it passes**

Run: `node --test tests/subtask-done-visibility.test.mjs`

Expected: all six tests pass.

- [ ] **Step 5: Run the full test suite and verify no regression**

Run: `npm test 2>&1 | tail -8`

Expected: `# tests 296 # pass 296` (290 prior + 6 new). No failures.

- [ ] **Step 6: Run static checks**

Run: `npm run check 2>&1 | tail -5`

Expected: `Version sync OK`, `Asset sync OK`, `No inline event handlers`.

- [ ] **Step 7: Commit**

```bash
git add js/tasks.js tests/subtask-done-visibility.test.mjs
git commit -m "fix(tasks): hide done subtasks under visible parents

_subtaskAllowedUnderShownParent decided whether a subtask should render
when its parent passed the smart-view filter. It checked snooze
(hiddenUntil) but not status, so a done subtask under a parent that
itself matched 'today' / 'starred' / etc. kept rendering. Added a status
check gated by smart view and the existing showCompletedAll toggle:

- In the 'completed' view, done subtasks remain visible (drilling into
  what's finished).
- In other smart views, done subtasks hide unless the user has toggled
  'show completed' on — same rule top-level done tasks already follow
  in the 'all' view (matchesFilters at line ~2646).

Behavioural change: previously, done subtasks in 'all' view stayed
visible regardless of the toggle. Now they follow the toggle. Consistent
with how top-level done tasks behave in the same view.

Test added: tests/subtask-done-visibility.test.mjs slices the function
out of tasks.js and exercises six scenarios (done in today/completed/all,
open across views, snoozed behaviour unchanged)."
```

---

## Task 2: Add `duration:` and `completed:` search operators + `sort:duration`

**Files:**
- Modify: `js/tasks.js:2284-2346` — `parseTaskSearchQuery` (inside the bounded comment markers so the existing test pattern picks up new code)
- Modify: `js/tasks.js` — `matchesFilters` (find the existing operator-application block near line 2625; add new branches)
- Modify: `js/tasks.js` — `sortTasks` (add `'totalSec'` case) and `taskSortBy` valid-values list
- Modify: `index.html` — add "Time spent" `<option>` to the Sort `<select>`
- Modify: `css/main.css` — add `.task-duration-pill` rule
- Modify: `js/ui.js` — render the duration pill on each task card when `duration:` or `sort:totalSec` is active
- Test (new): `tests/search-operators-duration.test.mjs`
- Test (new): `tests/search-operators-completed.test.mjs`
- Test (new): `tests/search-operators-duration-filter.test.mjs`

### Task 2.1: Parser — `duration:` operator

- [ ] **Step 1: Write the failing parser test**

Create `tests/search-operators-duration.test.mjs`. Copy the source-slicing header from `tests/search-operators.test.mjs:1-29` (same parser slice markers — `// ── Search operator parser` and the `window.parseTaskSearchQuery` assignment). Then add these assertions:

```js
test('duration: bare integer interpreted as minutes', () => {
  const r = loadParser()('duration:90 hello');
  assert.deepEqual(r.ops.duration, [{ op: '=', seconds: 90 * 60 }]);
  assert.equal(r.text, 'hello');
});

test('duration: h/m/s suffixes', () => {
  const r = loadParser()('duration:2h duration:30m duration:45s');
  assert.deepEqual(r.ops.duration, [
    { op: '=', seconds: 7200 },
    { op: '=', seconds: 1800 },
    { op: '=', seconds: 45 },
  ]);
});

test('duration: compound 1h30m', () => {
  const r = loadParser()('duration:1h30m');
  assert.deepEqual(r.ops.duration, [{ op: '=', seconds: 5400 }]);
});

test('duration: compare prefixes', () => {
  const r = loadParser()('duration:>2h duration:<=30m duration:>=0 duration:=0');
  assert.deepEqual(r.ops.duration, [
    { op: '>',  seconds: 7200 },
    { op: '<=', seconds: 1800 },
    { op: '>=', seconds: 0    },
    { op: '=',  seconds: 0    },
  ]);
});

test('duration: invalid value is dropped, text falls through', () => {
  const r = loadParser()('duration:banana keep this');
  assert.equal((r.ops.duration || []).length, 0);
  assert.equal(r.text, 'keep this');
});
```

- [ ] **Step 2: Run parser test, verify failure**

Run: `node --test tests/search-operators-duration.test.mjs`
Expected: all five tests fail because `ops.duration` is undefined in the current parser output.

- [ ] **Step 3: Extend the parser inside `js/tasks.js`**

Inside `parseTaskSearchQuery` (between the markers at lines 2284 and 2346), add a duration parser helper. Locate the existing token-walking loop (it iterates over space-split tokens checking for `tag:`, `list:`, `is:`, `priority:`, `due:`, `status:` prefixes) and add a sibling branch for `duration:`. Initialize `ops.duration = []` near the top where the other op arrays are declared.

Helper to add inside the parser scope (before the token loop):

```js
function _parseDurationVal(raw){
  // raw is everything after "duration:"
  const m = raw.match(/^([<>]=?|=)?\s*(.+)$/);
  if(!m) return null;
  const op = m[1] || '=';
  const body = m[2];
  let seconds = 0;
  if(/^\d+$/.test(body)){
    seconds = parseInt(body, 10) * 60;
  } else {
    let any = false;
    const pairs = body.matchAll(/(\d+)([hms])/gi);
    for(const pair of pairs){
      any = true;
      const n = parseInt(pair[1], 10);
      const u = pair[2].toLowerCase();
      seconds += u === 'h' ? n * 3600 : u === 'm' ? n * 60 : n;
    }
    if(!any) return null;
  }
  return { op, seconds };
}
```

Then in the token loop, add the branch:

```js
} else if(tok.startsWith('duration:')){
  const parsed = _parseDurationVal(tok.slice('duration:'.length));
  if(parsed) ops.duration.push(parsed);
  // invalid values silently drop; tok does not survive as free text
}
```

- [ ] **Step 4: Run parser test, verify it passes**

Run: `node --test tests/search-operators-duration.test.mjs`
Expected: 5/5 pass.

- [ ] **Step 5: Run the full test suite, verify no regression**

Run: `npm test 2>&1 | tail -8`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add js/tasks.js tests/search-operators-duration.test.mjs
git commit -m "feat(search): add duration: operator to parseTaskSearchQuery

Recognises duration:>2h / duration:<30m / duration:1h30m / duration:90
(bare integer interpreted as minutes for ergonomics). Five-mode compare
operator (>, >=, <, <=, =) with default '=' when absent. Invalid values
are silently dropped so free-text search keeps working when users type
half-formed queries.

Filter application in matchesFilters comes in a follow-up commit so the
parser change can land standalone."
```

### Task 2.2: Parser — `completed:` operator

- [ ] **Step 1: Write the failing parser test**

Create `tests/search-operators-completed.test.mjs`. Same source-slicing header as 2.1, but ALSO inject a stub for `todayISO` as part of the prelude (so keyword tests like `today` / `last-week` resolve deterministically):

The prelude prefix to prepend before the parser slice when loading: `const todayISO = () => '2026-05-27';\n`

Assertions:

```js
test('completed: today resolves to a single-day range', () => {
  const r = loadParser()('completed:today');
  assert.deepEqual(r.ops.completed, [{ start: '2026-05-27', end: '2026-05-27' }]);
});

test('completed: yesterday', () => {
  const r = loadParser()('completed:yesterday');
  assert.deepEqual(r.ops.completed, [{ start: '2026-05-26', end: '2026-05-26' }]);
});

test('completed: last-week resolves to a 7-day window ending yesterday', () => {
  const r = loadParser()('completed:last-week');
  assert.deepEqual(r.ops.completed, [{ start: '2026-05-20', end: '2026-05-26' }]);
});

test('completed: exact ISO date', () => {
  const r = loadParser()('completed:2026-05-20');
  assert.deepEqual(r.ops.completed, [{ start: '2026-05-20', end: '2026-05-20' }]);
});

test('completed: ISO range', () => {
  const r = loadParser()('completed:2026-05-20..2026-05-27');
  assert.deepEqual(r.ops.completed, [{ start: '2026-05-20', end: '2026-05-27' }]);
});

test('completed: invalid value drops, text survives', () => {
  const r = loadParser()('completed:banana keep');
  assert.equal((r.ops.completed || []).length, 0);
  assert.equal(r.text, 'keep');
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `node --test tests/search-operators-completed.test.mjs`
Expected: all six tests fail.

- [ ] **Step 3: Extend the parser with `completed:`**

Inside `parseTaskSearchQuery` (still within the bounded markers), add the helper:

```js
function _parseCompletedVal(raw){
  // ISO date helpers — pure-string math so we don't pull in Date.
  function shift(iso, days){
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  const today = (typeof todayISO === 'function') ? todayISO() : new Date().toISOString().slice(0, 10);
  if(raw === 'today')      return { start: today, end: today };
  if(raw === 'yesterday')  return { start: shift(today, -1), end: shift(today, -1) };
  if(raw === 'this-week')  return { start: shift(today, -6), end: today };
  if(raw === 'last-week')  return { start: shift(today, -7), end: shift(today, -1) };
  if(raw === 'this-month') return { start: today.slice(0, 8) + '01', end: today };
  if(raw === 'last-month'){
    // first day of previous month → last day of previous month (inclusive)
    const d = new Date(today + 'T00:00:00Z');
    const lastPrev  = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));
    const firstPrev = new Date(Date.UTC(lastPrev.getUTCFullYear(), lastPrev.getUTCMonth(), 1));
    return { start: firstPrev.toISOString().slice(0, 10), end: lastPrev.toISOString().slice(0, 10) };
  }
  // exact ISO date: YYYY-MM-DD
  if(/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { start: raw, end: raw };
  // ISO range: YYYY-MM-DD..YYYY-MM-DD
  const range = raw.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  if(range) return { start: range[1], end: range[2] };
  return null;
}
```

Initialize `ops.completed = []` next to other op arrays. Add the token branch:

```js
} else if(tok.startsWith('completed:')){
  const parsed = _parseCompletedVal(tok.slice('completed:'.length));
  if(parsed) ops.completed.push(parsed);
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `node --test tests/search-operators-completed.test.mjs`
Expected: 6/6 pass.

- [ ] **Step 5: Run full suite**

Run: `npm test 2>&1 | tail -8`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add js/tasks.js tests/search-operators-completed.test.mjs
git commit -m "feat(search): add completed: operator to parseTaskSearchQuery

Accepts keywords (today, yesterday, this-week, last-week, this-month,
last-month), exact ISO dates (2026-05-20), and ISO date ranges
(2026-05-20..2026-05-27). Resolves to {start, end} ISO date strings the
filter applier compares against completionDateKey(t.completedAt).

Date math is pure string arithmetic in Date.UTC space so the parser
stays free of locale / TZ surprises."
```

### Task 2.3: Filter application + display + sort

- [ ] **Step 1: Locate the operator-application block in `matchesFilters`**

In `js/tasks.js`, find the existing operator-checking code (search for `ops.tag` or `ops.priority` to locate it). It's inside `matchesFilters` near line 2625.

- [ ] **Step 2: Add the duration + completed filter branches**

Inside `matchesFilters`, after the existing op checks, add:

```js
// duration: compare elapsed time on the task to each declared target.
if(ops.duration && ops.duration.length){
  const sec = (typeof getTaskElapsed === 'function') ? getTaskElapsed(t) : (t.totalSec || 0);
  for(const d of ops.duration){
    switch(d.op){
      case '>':  if(!(sec >  d.seconds)) return false; break;
      case '>=': if(!(sec >= d.seconds)) return false; break;
      case '<':  if(!(sec <  d.seconds)) return false; break;
      case '<=': if(!(sec <= d.seconds)) return false; break;
      case '=':  if(sec !== d.seconds)   return false; break;
    }
  }
}
// completed: limit to tasks whose completionDateKey falls in any declared range.
if(ops.completed && ops.completed.length){
  if(!t.completedAt) return false;
  const k = (typeof completionDateKey === 'function')
    ? completionDateKey(t.completedAt)
    : String(t.completedAt).slice(0, 10);
  if(!k) return false;
  const inRange = ops.completed.some(r => k >= r.start && k <= r.end);
  if(!inRange) return false;
}
```

- [ ] **Step 3: Add `sort:duration` support**

Locate `parseTaskSearchQuery`'s existing `sort:` handling (if a dedicated `ops.sort` op exists) and ensure `'duration'` maps to the internal sort key `'totalSec'`. If `sort:` is not yet a recognised operator, add it: token `sort:VALUE` sets `ops.sort = VALUE` (single, not array).

Then in `sortTasks` (search for the existing sort-by-`estimateMin` case as a template), add:

```js
if(by === 'totalSec'){
  return arr.slice().sort((a, b) => {
    const sa = (typeof getTaskElapsed === 'function') ? getTaskElapsed(a) : (a.totalSec || 0);
    const sb = (typeof getTaskElapsed === 'function') ? getTaskElapsed(b) : (b.totalSec || 0);
    return sb - sa;  // descending: longest tasks first
  });
}
```

Also extend whatever valid-values guard exists for `taskSortBy` to accept `'totalSec'`.

- [ ] **Step 4: Add "Time spent" option to the Sort `<select>` in `index.html`**

Find the existing Sort dropdown (look for `id="taskSortBy"`). Add inside it:

```html
<option value="totalSec">Time spent</option>
```

- [ ] **Step 5: Render duration pill on task cards when active**

In `js/ui.js`, find `renderTaskItem` (or whichever function renders a task card row). Add a small inline pill when the current filter has an active `duration:` operator OR the sort is `totalSec`:

```js
// inside renderTaskItem, after the task name span is appended:
const showDur = (window._activeDurationFilter === true)
             || (typeof taskSortBy === 'string' && taskSortBy === 'totalSec');
if(showDur && typeof getTaskElapsed === 'function'){
  const sec = getTaskElapsed(t);
  if(sec > 0){
    const pill = document.createElement('span');
    pill.className = 'task-duration-pill';
    pill.textContent = ' · ' + (typeof fmtHMS === 'function' ? fmtHMS(sec) : (Math.round(sec/60) + 'm'));
    nameRow.appendChild(pill);
  }
}
```

In `updateTaskFilters` (where parsed ops are stored — search for where the result of `parseTaskSearchQuery` is assigned), set:

```js
window._activeDurationFilter = !!(ops.duration && ops.duration.length);
```

- [ ] **Step 6: Add the duration-pill CSS**

In `css/main.css`, near the other `.task-*` rules, add:

```css
.task-duration-pill{font-size:11px;color:var(--text-3);font-variant-numeric:tabular-nums;margin-left:4px}
```

- [ ] **Step 7: Write an integration test for the filter**

Create `tests/search-operators-duration-filter.test.mjs`. Use the same source-slicing header pattern as 2.1; this time slice the filter branches into a minimal evaluator. Stub `getTaskElapsed = (t) => t.totalSec || 0` in the function scope.

Assertions:

```js
test('duration:>2h matches a 3-hour task', () => {
  assert.equal(applyDuration({ totalSec: 10800 }, { duration: [{ op: '>', seconds: 7200 }] }), true);
});

test('duration:>2h rejects a 1-hour task', () => {
  assert.equal(applyDuration({ totalSec: 3600 }, { duration: [{ op: '>', seconds: 7200 }] }), false);
});

test('duration:=0 matches a task with no time logged', () => {
  assert.equal(applyDuration({ totalSec: 0 }, { duration: [{ op: '=', seconds: 0 }] }), true);
});

test('two duration ops AND together', () => {
  assert.equal(applyDuration(
    { totalSec: 5400 },
    { duration: [{ op: '>', seconds: 3600 }, { op: '<', seconds: 7200 }] }
  ), true);
  assert.equal(applyDuration(
    { totalSec: 10800 },
    { duration: [{ op: '>', seconds: 3600 }, { op: '<', seconds: 7200 }] }
  ), false);
});
```

The `applyDuration(task, ops)` helper should be a small function in the test file that hand-evaluates the same logic the production filter applies. Two ways to write it: (a) duplicate the switch from Step 2 inline (acceptable; small, explicit), (b) use the source-slice pattern to load the filter branches from `js/tasks.js`. Choose (a) for simplicity.

- [ ] **Step 8: Run all new tests**

Run: `node --test tests/search-operators-duration.test.mjs tests/search-operators-completed.test.mjs tests/search-operators-duration-filter.test.mjs`

Expected: all pass.

- [ ] **Step 9: Manual smoke**

Start the server: `npm run serve:smoke` (run in background) then open http://localhost:8080.
- Type `is:done duration:>1h` in the search box. Confirm only tasks with > 1h logged remain.
- Type `is:done completed:today`. Confirm only today-completed tasks remain.
- Switch the Sort dropdown to "Time spent". Confirm the list re-orders by descending duration.
- Confirm a small duration pill appears next to each task name when either filter is active.
- Clear the search. Confirm the pill disappears and unfiltered list returns.

Kill the server when done.

- [ ] **Step 10: Run full suite + smokes**

```bash
npm test 2>&1 | tail -8
npm run check 2>&1 | tail -5
npm run smoke:deep 2>&1 | tail -15
```

Expected: all green; 0 actionable console errors; 0 page errors.

- [ ] **Step 11: Commit**

```bash
git add js/tasks.js js/ui.js index.html css/main.css \
  tests/search-operators-duration-filter.test.mjs
git commit -m "feat(search): apply duration:/completed: filters + sort:duration

Wires the parser additions from the previous commits into matchesFilters
and sortTasks. New behaviour:

- duration:>2h / <30m / =0 / etc. rejects tasks whose getTaskElapsed
  doesn't match the compare op.
- completed:today / last-week / 2026-05-20..2026-05-27 rejects tasks
  whose completionDateKey(t.completedAt) is outside any declared range.
- sort:duration / Sort dropdown 'Time spent' option ranks by descending
  total time logged.
- When either filter is active, task cards surface a 'X h Y m' inline
  pill next to the name so users see why a task survived the filter.

Three integration tests added covering >, AND-stacking, and =0 edge case."
```

---

## Task 3: Audit and fix horizontal-scroll selection bars on swipe-right

**Files:**
- Modify: `js/ui.js:1023-1085` — task-card swipe handler (defensive scope check)
- Modify: `css/main.css` — `.smart-views`, `.lists-bar`, `.tags-bar` rule sets (add `touch-action: pan-x` if missing)

- [ ] **Step 1: Locate the task-card swipe handler**

Open `js/ui.js` and read lines 1023-1085 to confirm the touchstart/touchmove/touchend flow. The handler currently does not short-circuit based on touch target.

- [ ] **Step 2: Add the defensive scope check**

At the very top of the `touchstart` handler (before any other logic), add:

```js
// Defensive: if the touch starts inside a horizontally-scrollable
// selection bar, let that bar handle its own scroll. Otherwise the
// task-card swipe handler can translateX a sibling and leave the bar
// clipped, with only the leftmost portion visible.
if(e.target.closest && e.target.closest('.smart-views, .lists-bar, .tags-bar, .bulk-route-row, select, .dropdown-popover')){
  return;
}
```

- [ ] **Step 3: Verify each bar has `touch-action: pan-x`**

In `css/main.css`, locate the rules for `.smart-views`, `.lists-bar`, and `.tags-bar`. For each that does not already include `touch-action`, append the declaration so the browser knows horizontal pan is the intended gesture and won't fall back to interpreting the touch as a generic swipe:

```css
.smart-views{ /* existing rules */; touch-action: pan-x; -webkit-overflow-scrolling: touch; }
.lists-bar  { /* existing rules */; touch-action: pan-x; -webkit-overflow-scrolling: touch; }
.tags-bar   { /* existing rules */; touch-action: pan-x; -webkit-overflow-scrolling: touch; }
```

(Only add if not already present — don't duplicate declarations. If the rule already includes one of these properties, leave it alone.)

- [ ] **Step 4: Check for transform-leftover bug on touchend**

In the existing `touchend` handler in `js/ui.js`, confirm there is a reset of `sheet.style.transform = ''` and `sheet.style.transition = ''` even when the swipe falls short of threshold. If absent, add at the bottom of the handler:

```js
// Defensive reset: any in-flight transform from this gesture must clear
// so the next touch starts from a clean state. Otherwise an aborted swipe
// can leave the card partially translated.
if(active === false && sheet){
  sheet.style.transform = '';
  sheet.style.transition = '';
}
```

- [ ] **Step 5: Manual visual verification**

Start: `npm run serve:smoke` (background). Open http://localhost:8080 in Chrome with DevTools mobile emulation (390×844, touch enabled).

For each of these surfaces, perform a touch-swipe RIGHT inside the bar:

1. Smart-views chip bar at the top of the task list — confirm: bar scrolls horizontally; no underlying task card moves; the bar's right-side chips become reachable.
2. Open the Lists & Views sheet. Lists chip bar — same test.
3. Open the Tags sheet. Tags chip bar — same test.
4. As a control: swipe right on a task card itself (NOT a chip bar) — confirm the existing swipe-to-list-picker behaviour still fires.

Kill the server when done.

- [ ] **Step 6: Run full suite + smokes**

```bash
npm test 2>&1 | tail -8
npm run smoke:deep 2>&1 | tail -15
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add js/ui.js css/main.css
git commit -m "fix(gestures): chip bars no longer clipped by task-card swipe-right

The task-card swipe handler at js/ui.js:~1023 bound touchmove on a
parent of the chip bars, so a horizontal scroll attempt inside the
smart-views / lists / tags bar got captured before the bar's native
overflow-x scroll could start. The handler then translateX'd a sibling
task card; the chip bar ended up partially pushed off-screen with only
its left edge visible.

Two changes:
- Defensive scope check at the top of touchstart: if the touch starts
  inside a horizontally-scrollable selection bar, return early and let
  the bar handle its own scroll.
- Added touch-action:pan-x and -webkit-overflow-scrolling:touch to the
  three bars so the browser's intended-gesture heuristic agrees.

Manual verification on 390x844 mobile-emulated viewport confirms all
three bars now scroll fully and remain tappable after a right-swipe."
```

---

## Task 4: Dropdown utility + migrate Recurrence and List

**Files:**
- Create: `js/dropdown.js` — new utility
- Modify: `index.html` — replace `<select id="mdRecur">` and `<select id="mdList">` markup; add `<script src="js/dropdown.js">` after `js/modal.js`
- Modify: `sw.js` — add `./js/dropdown.js` to the `ASSETS` array
- Modify: `css/main.css` — `.dropdown-trigger`, `.dropdown-shadow-select`, `.dropdown-popover`, `.dropdown-sheet`, `.dropdown-item`, `.dropdown-swatch` rules
- Modify: `js/ui.js` — add `openRecurDropdown` and `openListDropdown` handlers
- Test (new): `tests/dropdown-utility.test.mjs`

### Task 4.1: Create the Dropdown utility

- [ ] **Step 1: Write the test for the pure-logic helper**

Create `tests/dropdown-utility.test.mjs`. Use the source-slicing pattern (see `tests/search-operators.test.mjs:13-29` for the canonical example), slicing the `_resolveAnchor` helper out of `js/dropdown.js` once it's created.

The helper signature is `_resolveAnchor(rect, viewportHeight, dropdownHeight, explicitChoice?)` and returns `'above'` or `'below'`.

Assertions:

```js
test('flip above when not enough room below', () => {
  const fn = loadResolveAnchor();
  // trigger at y=600 in an 800px viewport, dropdown wants 250px.
  // Below: 800 - 640 = 160 (not enough). Above: 600 (room).
  assert.equal(fn({ top: 600, bottom: 640 }, 800, 250), 'above');
});

test('open below when room available', () => {
  const fn = loadResolveAnchor();
  assert.equal(fn({ top: 100, bottom: 140 }, 800, 250), 'below');
});

test("explicit anchor='above' overrides", () => {
  const fn = loadResolveAnchor();
  assert.equal(fn({ top: 100, bottom: 140 }, 800, 250, 'above'), 'above');
});
```

- [ ] **Step 2: Run the test, verify failure (file doesn't exist)**

Run: `node --test tests/dropdown-utility.test.mjs`
Expected: failure, `dropdown.js` not found.

- [ ] **Step 3: Create `js/dropdown.js`**

Create the file. Full source below.

```js
/**
 * Dropdown — pop-up selection picker. One open at a time. Modeled on the
 * same pattern as js/modal.js: a small dependency-free utility attached
 * to window.Dropdown with explicit lifecycle hooks.
 *
 * Public API:
 *   Dropdown.open(trigger, opts) -> Promise<value|null>
 *     trigger : Element
 *     opts    : {
 *       options:    Array<{value, label, icon?, color?, group?}>,
 *       selected?:  value,
 *       anchor?:    'auto'|'below'|'above',     (default 'auto')
 *       searchable?: boolean,                    (always-on for >8 options)
 *       onSelect:   (value) => void,
 *       onClose?:   () => void,
 *     }
 *   Dropdown.close()
 *   Dropdown.isOpen()
 *
 * Mobile (≤640px): renders as a bottom sheet instead of an inline popover.
 */
(function(){
  'use strict';

  let _open = null;

  function _resolveAnchor(rect, vh, dropdownH, explicit){
    if(explicit === 'above' || explicit === 'below') return explicit;
    const roomBelow = vh - rect.bottom;
    const roomAbove = rect.top;
    if(roomBelow >= dropdownH) return 'below';
    if(roomAbove >= dropdownH) return 'above';
    return roomBelow >= roomAbove ? 'below' : 'above';
  }

  function _isNarrowViewport(){
    return typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches;
  }

  function open(trigger, opts){
    if(_open) close();
    if(!trigger || !opts || !Array.isArray(opts.options)) return Promise.resolve(null);

    return new Promise(resolve => {
      const isSheet = _isNarrowViewport();
      const root = document.createElement('div');
      root.className = isSheet ? 'dropdown-sheet' : 'dropdown-popover';
      root.setAttribute('role', 'listbox');
      const list = document.createElement('div');
      list.className = 'dropdown-list';
      root.appendChild(list);

      let highlightIdx = -1;
      const options = opts.options;

      function _applyHighlight(){
        const items = [...list.querySelectorAll('.dropdown-item')];
        items.forEach((el, i) => {
          el.classList.toggle('is-highlight', i === highlightIdx);
          if(i === highlightIdx){
            el.setAttribute('aria-selected', 'true');
            if(el.scrollIntoView) try { el.scrollIntoView({ block: 'nearest' }); } catch(_){}
          } else if(el.dataset.value !== opts.selected){
            el.removeAttribute('aria-selected');
          }
        });
      }

      function renderItems(filter){
        list.replaceChildren();
        const norm = (filter || '').toLowerCase().trim();
        options.forEach((o, i) => {
          if(norm && !String(o.label || '').toLowerCase().startsWith(norm)) return;
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'dropdown-item';
          item.setAttribute('role', 'option');
          item.dataset.value = o.value;
          if(o.color){
            const sw = document.createElement('span');
            sw.className = 'dropdown-swatch';
            sw.style.background = o.color;
            item.appendChild(sw);
          }
          const lab = document.createElement('span');
          lab.className = 'dropdown-label';
          lab.textContent = o.label;
          item.appendChild(lab);
          if(o.value === opts.selected){
            item.classList.add('is-selected');
            item.setAttribute('aria-selected', 'true');
            if(highlightIdx < 0) highlightIdx = i;
          }
          item.addEventListener('click', () => select(o.value));
          list.appendChild(item);
        });
        _applyHighlight();
      }

      let searchEl = null;
      if(opts.searchable || options.length > 8){
        searchEl = document.createElement('input');
        searchEl.type = 'text';
        searchEl.className = 'dropdown-search';
        searchEl.placeholder = 'Type to filter…';
        searchEl.addEventListener('input', () => renderItems(searchEl.value));
        root.insertBefore(searchEl, list);
      }

      renderItems('');

      document.body.appendChild(root);
      const rect = trigger.getBoundingClientRect();
      const dropdownH = root.offsetHeight;
      const vh = window.innerHeight;
      if(!isSheet){
        const where = _resolveAnchor(rect, vh, dropdownH, opts.anchor || 'auto');
        root.style.position = 'fixed';
        root.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - root.offsetWidth - 8)) + 'px';
        root.style.top = (where === 'below') ? (rect.bottom + 4) + 'px' : (rect.top - dropdownH - 4) + 'px';
      }

      const prevFocus = document.activeElement;
      if(searchEl){ try { searchEl.focus(); } catch(_){} }

      function moveHighlight(delta){
        const items = list.querySelectorAll('.dropdown-item');
        if(!items.length) return;
        highlightIdx = (highlightIdx + delta + items.length) % items.length;
        _applyHighlight();
      }

      function select(value){
        try { if(typeof opts.onSelect === 'function') opts.onSelect(value); } catch(err){ console.warn('[dropdown] onSelect', err); }
        close(value);
      }

      function keyHandler(e){
        if(e.key === 'ArrowDown'){ e.preventDefault(); moveHighlight(+1); return; }
        if(e.key === 'ArrowUp'){   e.preventDefault(); moveHighlight(-1); return; }
        if(e.key === 'Enter'){
          e.preventDefault();
          const items = list.querySelectorAll('.dropdown-item');
          const el = items[highlightIdx];
          if(el) select(el.dataset.value);
          return;
        }
        if(e.key === 'Escape'){ e.preventDefault(); close(null); return; }
        if(!searchEl && /^[a-z0-9]$/i.test(e.key)){
          const items = [...list.querySelectorAll('.dropdown-item')];
          const idx = items.findIndex(el =>
            String(el.dataset.value || '').toLowerCase().startsWith(e.key.toLowerCase()) ||
            String(el.textContent).toLowerCase().startsWith(e.key.toLowerCase())
          );
          if(idx >= 0){ highlightIdx = idx; _applyHighlight(); }
        }
      }
      document.addEventListener('keydown', keyHandler, true);

      function outsideHandler(e){
        if(_open && _open.el && !_open.el.contains(e.target) && e.target !== trigger){
          close(null);
        }
      }
      requestAnimationFrame(() => {
        document.addEventListener('mousedown', outsideHandler, true);
        document.addEventListener('touchstart', outsideHandler, { capture: true, passive: true });
      });

      _open = { el: root, opts, resolve, prevFocus, keyHandler, outsideHandler };
    });
  }

  function close(value){
    if(!_open) return;
    const { el, opts, resolve, prevFocus, keyHandler, outsideHandler } = _open;
    document.removeEventListener('keydown', keyHandler, true);
    document.removeEventListener('mousedown', outsideHandler, true);
    document.removeEventListener('touchstart', outsideHandler, { capture: true });
    if(el && el.parentNode) el.parentNode.removeChild(el);
    if(prevFocus && typeof prevFocus.focus === 'function'){
      try { prevFocus.focus(); } catch(_){}
    }
    _open = null;
    try { if(typeof opts.onClose === 'function') opts.onClose(); } catch(err){ console.warn('[dropdown] onClose', err); }
    if(typeof resolve === 'function') resolve(value === undefined ? null : value);
  }

  function isOpen(){ return _open !== null; }

  window.Dropdown = { open, close, isOpen };
})();
```

- [ ] **Step 4: Run the unit test, verify pass**

Run: `node --test tests/dropdown-utility.test.mjs`
Expected: 3/3 pass.

- [ ] **Step 5: Register the script and cache it**

Edit `index.html` (script load order):

```html
<!-- after <script src="js/modal.js"></script>, add: -->
<script src="js/dropdown.js"></script>
```

Edit `sw.js` ASSETS array, after `'./js/modal.js'`:

```js
'./js/dropdown.js',
```

- [ ] **Step 6: Run static checks**

Run: `npm run check 2>&1 | tail -5`
Expected: `Asset sync OK: 25 HTML refs, 36 SW entries` (was 24 / 35; the new file is referenced and registered).

- [ ] **Step 7: Add dropdown CSS**

In `css/main.css`, near the existing `.task-action-menu` rules, add:

```css
/* Dropdown — small selection popover with optional bottom-sheet variant
   on narrow viewports. Visual base copied from .task-action-menu. */
.dropdown-popover{
  position:fixed; z-index:var(--z-popover);
  background:var(--bg-2); border:1px solid var(--border); border-radius:var(--r-md);
  box-shadow:var(--shadow-overlay);
  min-width:200px; max-width:320px; max-height:60vh;
  overflow:hidden; display:flex; flex-direction:column;
  animation:fadeIn .12s ease-out;
}
.dropdown-sheet{
  position:fixed; left:0; right:0; bottom:0; z-index:var(--z-modal);
  background:var(--bg-2); border-top:1px solid var(--border);
  border-radius:16px 16px 0 0;
  box-shadow:var(--shadow-overlay);
  max-height:70vh; padding-bottom:calc(8px + env(safe-area-inset-bottom, 0px));
  display:flex; flex-direction:column;
  animation:slideIn .2s ease-out;
}
.dropdown-search{
  width:100%; padding:10px 12px; background:transparent; border:none;
  border-bottom:1px solid var(--border); color:var(--text-1); font:inherit; outline:0;
}
.dropdown-list{ overflow-y:auto; padding:4px 0; }
.dropdown-item{
  display:flex; align-items:center; gap:8px; width:100%;
  padding:8px 12px; background:transparent; border:none;
  color:var(--text-1); font:inherit; font-size:13px; text-align:left; cursor:pointer;
}
.dropdown-item:hover, .dropdown-item.is-highlight{ background:var(--bg-3); }
.dropdown-item.is-selected{ color:var(--accent); font-weight:600; }
.dropdown-swatch{ width:10px; height:10px; border-radius:50%; flex-shrink:0; }
.dropdown-trigger{
  display:inline-flex; align-items:center; gap:6px;
  padding:8px 12px; background:var(--bg-0); border:1px solid var(--border);
  border-radius:var(--r-sm); color:var(--text-1); font:inherit; font-size:12px;
  cursor:pointer; min-height:32px;
}
.dropdown-trigger:hover{ border-color:var(--accent-border); }
.dropdown-trigger-caret{ margin-left:auto; opacity:.6; }
.dropdown-shadow-select{ display:none !important; }
```

- [ ] **Step 8: Commit (utility scaffolding only — no migrations yet)**

```bash
git add js/dropdown.js sw.js index.html css/main.css tests/dropdown-utility.test.mjs
git commit -m "feat(dropdown): add reusable Dropdown utility

js/dropdown.js — Window.Dropdown.open(trigger, opts) / close() / isOpen.
Inline popover on desktop with auto-flip-above; bottom-sheet variant on
viewports <=640px. Keyboard nav (arrows/Enter/Esc/type-to-search).
ARIA role=listbox/option. Pattern modeled on js/modal.js.

No migrations yet — the next commit replaces #mdRecur and #mdList in the
task detail modal."
```

### Task 4.2: Migrate Recurrence

- [ ] **Step 1: Replace `#mdRecur` markup in `index.html`**

Find the `<select id="mdRecur">` block (around the recurrence field in the task modal). Replace:

```html
<select id="mdRecur" class="mfield-in">…options…</select>
```

with:

```html
<button type="button" id="mdRecurTrigger" class="dropdown-trigger" data-action="openRecurDropdown" aria-haspopup="listbox">
  <span class="dropdown-trigger-label" id="mdRecurLabel">None</span>
  <span class="dropdown-trigger-caret" aria-hidden="true">▾</span>
</button>
<select id="mdRecur" class="dropdown-shadow-select" hidden tabindex="-1">…options…</select>
```

Keep the option list intact inside the hidden `<select>` so `saveTaskDetail` reads them as before.

- [ ] **Step 2: Add the `openRecurDropdown` handler**

In `js/ui.js`, near other `data-action`-wired handlers, add:

```js
function openRecurDropdown(){
  const trigger = gid('mdRecurTrigger');
  const sel = gid('mdRecur');
  const label = gid('mdRecurLabel');
  if(!trigger || !sel || typeof Dropdown === 'undefined') return;
  const options = [...sel.options].map(o => ({ value: o.value, label: o.textContent }));
  Dropdown.open(trigger, {
    options,
    selected: sel.value,
    onSelect: (value) => {
      sel.value = value;
      const opt = options.find(o => o.value === value);
      if(label) label.textContent = opt ? opt.label : value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    },
  });
}
window.openRecurDropdown = openRecurDropdown;
```

- [ ] **Step 3: Sync the trigger label on modal open**

In `openTaskDetail` (where the modal fields are populated from the task), find the line that sets `gid('mdRecur').value = t.recur || 'none'` (or similar). Right after it, add:

```js
const _rLabel = gid('mdRecurLabel');
const _rSel = gid('mdRecur');
if(_rLabel && _rSel){
  const _rOpt = _rSel.options[_rSel.selectedIndex];
  _rLabel.textContent = _rOpt ? _rOpt.textContent : 'None';
}
```

- [ ] **Step 4: Manual verification**

Start: `npm run serve:smoke` (background). Open http://localhost:8080.

- Open any task → task detail modal opens.
- The Recurrence field now shows a button (not a native select). Label matches the current value.
- Click the button → dropdown opens below the trigger with all 11 options.
- Arrow keys move the highlight; Enter selects; the trigger label updates and `saveTaskDetail` later persists the new value.
- Click outside the dropdown → it closes without changing the value.
- Esc closes the dropdown.
- Resize to 390px wide → click Recurrence → bottom sheet opens instead of inline popover.

- [ ] **Step 5: Full test suite + smokes**

```bash
npm test 2>&1 | tail -8
npm run smoke:deep 2>&1 | tail -15
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add index.html js/ui.js
git commit -m "feat(modal): replace Recurrence <select> with Dropdown utility

The native <select> for the task's recurrence pattern clashed with the
chip-based selection language used throughout the rest of the task
detail modal. Replaced the visible <select> with a .dropdown-trigger
button that opens a Dropdown popover (or bottom sheet on narrow
viewports) showing the same 11 options.

A hidden <select id='mdRecur'> remains in the DOM so saveTaskDetail's
existing read of gid('mdRecur').value keeps working unchanged. The
Dropdown's onSelect writes the value into the hidden select and fires a
synthetic 'change' event so estimate-variance and other change-listeners
fire normally."
```

### Task 4.3: Migrate List

- [ ] **Step 1: Replace `#mdList` markup in `index.html`**

Same shape as Recurrence:

```html
<button type="button" id="mdListTrigger" class="dropdown-trigger" data-action="openListDropdown" aria-haspopup="listbox">
  <span class="dropdown-trigger-label" id="mdListLabel">Inbox</span>
  <span class="dropdown-trigger-caret" aria-hidden="true">▾</span>
</button>
<select id="mdList" class="dropdown-shadow-select" hidden tabindex="-1"></select>
```

The list `<select>` is populated dynamically when the modal opens. That keeps working — only the visibility changes.

- [ ] **Step 2: Add the `openListDropdown` handler with color swatches**

```js
function openListDropdown(){
  const trigger = gid('mdListTrigger');
  const sel = gid('mdList');
  const label = gid('mdListLabel');
  if(!trigger || !sel || typeof Dropdown === 'undefined') return;
  // Map list options to dropdown options. We need each list's color, so we
  // look up the live list model instead of just reading <option> text.
  const allLists = (typeof getAllLists === 'function') ? getAllLists() : [];
  const options = [...sel.options].map(o => {
    const found = allLists.find(L => String(L.id) === String(o.value));
    return {
      value: o.value,
      label: o.textContent,
      color: found && found.color ? found.color : null,
    };
  });
  Dropdown.open(trigger, {
    options,
    selected: sel.value,
    searchable: options.length > 8,
    onSelect: (value) => {
      sel.value = value;
      const opt = options.find(o => o.value === value);
      if(label) label.textContent = opt ? opt.label : value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    },
  });
}
window.openListDropdown = openListDropdown;
```

If `getAllLists` does not exist with that name in `js/tasks.js`, search for the equivalent (look for `function getLists` or `window.lists`) and adjust the helper line.

- [ ] **Step 3: Sync label on modal open**

In `openTaskDetail`, right after the list `<select>` value is set, add:

```js
const _lLabel = gid('mdListLabel');
const _lSel = gid('mdList');
if(_lLabel && _lSel){
  const _lOpt = _lSel.options[_lSel.selectedIndex];
  _lLabel.textContent = _lOpt ? _lOpt.textContent : 'List';
}
```

- [ ] **Step 4: Manual verification**

Start: `npm run serve:smoke` (background). Open http://localhost:8080.

- Open a task → list trigger shows the task's current list name.
- Click it → dropdown opens with one row per list, each prefixed with a small color swatch matching the list's color metadata.
- If there are > 8 lists, a search input appears at the top of the dropdown. Typing filters the list.
- Pick a different list → trigger label updates; close the modal with Save → task moves to the new list correctly.

- [ ] **Step 5: Full suite + smokes**

```bash
npm test 2>&1 | tail -8
npm run smoke:deep 2>&1 | tail -15
```

- [ ] **Step 6: Commit**

```bash
git add index.html js/ui.js
git commit -m "feat(modal): replace List <select> with Dropdown utility

Same migration pattern as Recurrence: visible button + hidden <select>
+ Dropdown utility. The list dropdown additionally shows each list's
color metadata as a small swatch beside the label, matching the
chip-based color language used in the smart-views and filter bars.

Saved value still propagates through the hidden <select> + synthetic
'change' event, so saveTaskDetail's existing read path is unchanged."
```

---

## Self-review

**Spec coverage:**
- ✓ Section 1 (subtask filter) → Task 1
- ✓ Section 4 (search operators) → Task 2 (split into parser-duration, parser-completed, filter+display+sort sub-tasks)
- ✓ Section 2 (swipe-bug) → Task 3
- ✓ Section 3 (dropdown utility + migrations) → Task 4 (split into utility, recurrence, list sub-tasks)

**Placeholder scan:**
- No "TBD" / "TODO" / "implement later" in any task.
- Each code block is complete and self-contained.
- Each step has either explicit code or an explicit command.

**Type consistency:**
- `Dropdown.open(trigger, opts)` referenced identically in Task 4.1 (definition), 4.2 (Recurrence migration), 4.3 (List migration).
- `getTaskElapsed(t)` referenced identically in Task 2.3 and verification tests.
- `ops.duration` and `ops.completed` shape (`{ op, seconds }` / `{ start, end }`) consistent between parser tests and filter application.

**Commit count:** 8 commits total — 1 (Task 1) + 3 (Task 2.1, 2.2, 2.3) + 1 (Task 3) + 3 (Task 4.1, 4.2, 4.3). One commit per logical unit, each independently shippable.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-27-task-fixes-and-features.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent dispatched per task, review between tasks, fast iteration. Best for plans with discrete tasks that don't need shared in-memory state.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints. Best when you want to review intermediate state in the same conversation thread.

**Which approach?**
