# Design — Four Task UX Fixes and Features

**Date:** 2026-05-27
**Status:** Approved scope; awaiting implementation
**Author:** Drafted in collaboration with the OdTauLai user

## Context

Four issues in OdTauLai, a static PWA vanilla-JS task/Pomodoro app:

1. **Bug (P1):** Tasks marked "finished" still appear in the list — specifically, done **subtasks** remain visible under their parent.
2. **Bug (P1):** When the user swipes right on a list view, "only the very left part of the column with the lists is viewable so nothing can be selected." The selection bar is being partially clipped or pushed off-screen by an interfering touch gesture.
3. **Feature (P1):** Replace native `<select>` elements in the task detail modal (Recurrence and List) with a custom pop-up dropdown that matches the chip-based design language of the rest of the modal.
4. **Feature (P2):** Extend the existing task search bar to support operators for filtering and sorting by **time duration** and **completion date** of completed tasks.

These were chosen together because they share a theme: existing patterns and infrastructure are mostly correct, but coverage is incomplete or inconsistent. None of the four needs new architecture; all four need targeted plumbing on top of code that already exists.

## Decisions (defaulted on user's request)

| # | Decision | Default chosen | Why |
|---|---|---|---|
| 1 | Done-subtask visibility in `all` smart view | Hide unless `showCompletedAll` toggle is checked (same rule as top-level done tasks) | Consistency with existing user-facing toggle |
| 2 | Swipe-bug scope | Fix all three plausible bars (`.smart-views`, `.lists-bar`, `.tags-bar`) with one shared mechanism | Robust to ambiguity in user description |
| 3 | Recurrence dropdown on mobile | Bottom-sheet fallback (≤640px viewport) | 11 options too cramped for inline popover; matches smart-views sheet pattern |
| 4 | `duration:90` bare-number convention | Bare integer = minutes; `h/m/s` suffixes accepted; compound `1h30m` accepted | Friendlier ergonomics; matches how humans type estimates |

---

## Section 1 — Done subtasks no longer rendering under visible parents

### Root cause

`_subtaskAllowedUnderShownParent()` at `js/tasks.js:1109-1115` decides whether a subtask renders when its parent passed the smart-view filter. The function checks `hiddenUntil` (snooze) but **does not check `t.status === 'done'`**. Consequently, when a parent matches the active smart view (e.g. due today), its done children render alongside open ones.

### Fix

Add a `status === 'done'` check, gated by smart view and the `showCompletedAll` toggle:

```js
function _subtaskAllowedUnderShownParent(t){
  if(!t) return false;
  const today = (typeof todayISO === 'function') ? todayISO() : null;
  if(today && t.hiddenUntil && t.hiddenUntil > today
     && smartView !== 'snoozed'
     && smartView !== 'completed') return false;
  // Hide done children outside the 'completed' view unless the global
  // "show completed" toggle is on. The toggle is the same UI surface that
  // controls top-level done visibility in the 'all' view, so subtasks now
  // follow the same rule the user already understands.
  if(t.status === 'done' && smartView !== 'completed'){
    const sd = gid('showCompletedAll');
    if(!sd || !sd.checked) return false;
  }
  return true;
}
```

### Files

- `js/tasks.js:1109-1115` — `_subtaskAllowedUnderShownParent()` body

### Edge cases handled

- **Habits / recurring tasks:** `completeHabitCycle` (`js/tasks.js:1766`) flips `status` back to `'open'` and clears `completedAt`. The fix correctly ignores habits — they're not `done` after cycling.
- **Cascade-on-done:** When a parent is marked done, `_cascadeOnDone` (`js/tasks.js:1789`) marks open children done. The fix correctly hides those children. The parent typically also leaves the active view (e.g. due-today filter), so the whole subtree disappears coherently.
- **`completed` smart view:** Explicitly retains done subtask visibility so users can drill into completed parents and see what was finished.
- **`showCompletedAll` toggle:** Already controls top-level done tasks in the `all` view. Subtasks now respect the same toggle for consistency. **User-visible change:** done subtasks formerly visible in `all` will now hide unless the toggle is on. This is the intentional behaviour change.

### Verification

1. Create a task with two subtasks.
2. Mark one subtask done.
3. View the task list in `today` (parent is due today) → only the open subtask visible.
4. Switch to `completed` → both subtasks visible (one struck-through).
5. Switch to `all` with `showCompletedAll` off → done subtask hidden.
6. Toggle `showCompletedAll` on → done subtask returns.
7. Mark a habit done → cycles to next due date, status flips back to `open`, remains visible. No regression.

---

## Section 2 — Selection column no longer clipped by swipe-right

### Suspected mechanism

User report: "When swiping right only the very left part of the column with the lists is viewable so nothing can be selected." The codebase has three horizontally-scrollable selection surfaces that match the description:

1. `.smart-views` — chip bar at the top of the task list (All / Today / Starred / etc.).
2. `.lists-bar` — chip bar inside the Lists & Views sheet, one chip per task list.
3. `.tags-bar` — chip bar inside the Tags sheet, one chip per tag.

All three use `overflow-x:auto` with a horizontal-scroll mask gradient.

The task-card swipe handler at `js/ui.js:1023-1085` listens for `touchmove` events with a horizontal-delta threshold (`Math.abs(dx) > 12` && `Math.abs(dx) > Math.abs(dy) * 1.5`). When swipe-right exceeds 80px (`js/ui.js:1079`), it fires `showTaskListPickerSheet`. The handler applies a `translateX(dx)` to the task card during the gesture (`js/ui.js:1064`).

**Most likely failure mode:** the swipe handler is bound at a level where its `touchmove` listener captures events that started inside one of the chip bars. The bar's native horizontal scroll never begins because the parent listener intercepts. The user's finger drags right; instead of the chip bar scrolling, a sibling element (or the chip bar's wrapper) gets `translateX`'d off-screen, leaving "only the very left part" visible.

### Fix

**Step A — Defensive scope check in the swipe handler.** At the top of the `touchstart`/`touchmove` flow on task cards, short-circuit if the touch originates inside a horizontally-scrollable selection bar:

```js
// js/ui.js — beginning of the task-card touchstart handler
if(e.target.closest('.smart-views, .lists-bar, .tags-bar, .bulk-route-row, select')){
  return;
}
```

The `closest()` check lets each bar handle its own horizontal scroll without interference.

**Step B — CSS audit.** Verify each of the three bars has:

- `overflow-x: auto` on the bar element
- `-webkit-overflow-scrolling: touch` for momentum scroll on iOS
- `touch-action: pan-x` so the browser knows horizontal pan is the intended gesture
- No parent with `overflow: hidden` that would clip a wider scrolling child
- No leftover inline `transform: translateX(...)` from a previous gesture state (defensive reset on `touchend` if found)

**Step C — Visual confirmation.** Open each surface on a mobile-emulated viewport (Chrome DevTools 390×844), swipe right, confirm:

- The chip bar scrolls horizontally, revealing more chips on the right.
- No task card behind the bar gets `translateX`'d.
- The bar always remains fully tappable at any scroll position.

### Files

- `js/ui.js:1023-1085` — task-card swipe handler (add scope check at top)
- `css/main.css` — `.smart-views`, `.lists-bar`, `.tags-bar` rule sets (add `touch-action: pan-x` if missing)

### Risk

If the user's actual surface is not one of these three, the fix won't address it. Mitigation: the spec includes a manual verification matrix; if the bug persists on a fourth surface, the same `closest()` pattern can be extended.

---

## Section 3 — Reusable Dropdown utility; migrate Task Modal Recurrence + List

### What we're building

A small dropdown utility — `js/dropdown.js` — modelled on the same pattern as `js/modal.js` from the prior session. Used to replace two native `<select>` elements in the task detail modal:

- `#mdRecur` — recurrence pattern (11 fixed options)
- `#mdList` — destination list (dynamic, currently 2–N options)

The utility is also designed so the four filter-bar selects (Status / Priority / Sort / Group), the quick-add Recurrence select, and the bulk-import routing selects can be migrated later without changes to the utility itself.

### Public API

```js
// Window.Dropdown.open(trigger, opts) -> Promise<value|null>
//   trigger : Element                  (the button the dropdown anchors to)
//   opts    : {
//     options:    Array<{value, label, icon?, color?, group?}>,
//     selected?:  value,               // pre-highlight
//     anchor?:    'auto'|'below'|'above',
//     searchable?: boolean,            // adds type-to-search input row
//     onSelect:   (value) => void,
//     onClose?:   () => void,
//   }
// Returns Promise that resolves to the selected value (or null on dismiss).
//
// Window.Dropdown.close()  -> closes the currently-open dropdown if any.
```

### Reuses what already exists

- `.task-action-menu` / `.tam-item` CSS at `css/main.css:1873-1895` — visual pattern shipped, used by per-task action menu.
- `showTaskActionMenu` positioning logic at `js/ui.js:2115` — viewport-aware flip-above-when-needed and clamp-to-viewport.
- ESC handling pattern used by `js/modal.js` (capture-phase listener with `topmost()` check).

### Behaviour spec

- **Anchored to the trigger:** opens directly below the trigger button; auto-flips above when the trigger is too close to the viewport bottom.
- **Mobile fallback:** on viewports ≤ 640px, renders as a bottom sheet instead of an inline popover. Mirrors the existing smart-views sheet pattern. Threshold matches the existing `_cmdkTouchOrNarrowUI()` heuristic.
- **Keyboard navigation:**
  - `↑` / `↓` — move highlight
  - `Enter` — select highlighted option, close, resolve promise
  - `Esc` — close, resolve `null`
  - Letters `a`–`z` — type-to-search; the highlighted option jumps to the first label starting with the typed prefix
- **List picker enhancements:**
  - 10×10 swatch beside each option showing the list's color metadata (already in the list model)
  - Optional "New list…" affordance pinned at the bottom (for parity with the existing list-picker sheet)
- **ARIA:** `role="listbox"` on the container, `role="option"` on each item, `aria-selected="true"` on the highlighted option, `aria-activedescendant` on the listbox tracking the highlight.
- **Backdrop / outside click:** click anywhere outside the dropdown closes it and resolves `null`.

### Markup change in `index.html`

Replace each `<select>` with a paired structure that keeps a hidden `<select>` for unchanged save logic:

```html
<!-- before -->
<select id="mdRecur" class="mfield-in">…</select>

<!-- after -->
<button type="button"
        id="mdRecurTrigger"
        class="dropdown-trigger"
        data-action="openRecurDropdown"
        aria-haspopup="listbox">
  <span class="dropdown-trigger-label" id="mdRecurLabel">None</span>
  <span class="dropdown-trigger-caret" aria-hidden="true">▾</span>
</button>
<select id="mdRecur" class="dropdown-shadow-select" hidden tabindex="-1">…</select>
```

The hidden `<select>` keeps the existing `saveTaskDetail` logic (which reads `gid('mdRecur').value`) working unchanged — the dropdown's `onSelect` callback writes the value into the hidden select, then dispatches a `change` event on it so any existing change-listeners fire normally.

### Files

- `js/dropdown.js` — new file (~250 lines)
- `js/modal.js` — no changes (Dropdown is independent)
- `index.html` — replace `#mdRecur` and `#mdList` markup; add `<script src="js/dropdown.js">` after `js/modal.js`
- `sw.js` — add `./js/dropdown.js` to `ASSETS` array
- `css/main.css` — add `.dropdown-trigger`, `.dropdown-shadow-select` rules; `.dropdown-popover` rules (can reuse `.task-action-menu` styling via a shared class)
- `js/ui.js` — wire the `data-action="openRecurDropdown"` and `openListDropdown` handlers via the existing `event-delegation.js` pattern

### Verification

1. Open a task in the detail modal.
2. Click the Recurrence button → dropdown opens below the trigger, showing all 11 options.
3. Use ↑/↓ to highlight; Enter to select. Hidden `<select>` value updates; `saveTaskDetail` persists correctly.
4. On a mobile viewport (390×844), click Recurrence → bottom sheet renders instead of popover.
5. Click List → dropdown shows all lists with color swatches.
6. Type "w" while List dropdown is open → highlight jumps to first list starting with "W".
7. Esc closes the dropdown without changing the value.
8. Tab order: Trigger → next field skips the hidden `<select>` (because `tabindex="-1"`).

### Risk

- **Form submission:** the original `<select>` was wired into the form's `change` event for live previews of estimate-variance / similar-tasks. The hidden `<select>` + manual change-event dispatch pattern handles this, but every consumer must be re-verified.
- **A11y:** custom listbox semantics can drift from native `<select>` accessibility. The spec uses `role="listbox"` + `role="option"` + `aria-activedescendant`, which is the standard W3C ARIA-Authoring-Practices pattern. Screen-reader smoke test (VoiceOver or NVDA) recommended before merge.

---

## Section 4 — Search operators for duration and completion date

### What we're adding

Three new operator families recognized by `parseTaskSearchQuery` (`js/tasks.js:2298`) and applied in `matchesFilters` (`js/tasks.js:2625`):

| Operator | Examples | Filter logic |
|---|---|---|
| `duration:` | `duration:>2h`, `duration:<30m`, `duration:>=1h30m`, `duration:=0`, `duration:90` | Compares `getTaskElapsed(t)` in seconds to the parsed duration |
| `completed:` | `completed:today`, `completed:yesterday`, `completed:this-week`, `completed:last-week`, `completed:this-month`, `completed:last-month`, `completed:2026-05-20`, `completed:2026-05-20..2026-05-27` | Compares `completionDateKey(t.completedAt)` to the parsed date or range |
| `sort:duration` | `is:done sort:duration` | Adds a new sort mode ranking by `getTaskElapsed(t)` descending |

### Parser additions

Duration parser — accepts:
- bare integer: `"90"` → 90 minutes (5400 seconds)
- h/m/s suffix: `"2h"`, `"30m"`, `"45s"`
- compound: `"1h30m"`, `"2h15m30s"`
- compare prefix: `>`, `>=`, `<`, `<=`, `=` (default `=` if absent)

Pseudocode:
```
function _parseDurationOp(raw):
  match raw against /^([<>]=?|=)?\s*(.+)$/
    op   = capture-1 or '='
    body = capture-2
  if body matches /^\d+$/:
    seconds = body * 60
  else:
    seconds = 0
    for each (digits, unit) pair in body matching /(\d+)([hms])/gi:
      seconds += digits * (3600 if unit='h' else 60 if unit='m' else 1)
    if no pairs matched: return null
  return { op, seconds }
```

Completion-date parser — accepts:
- keyword: `today` | `yesterday` | `this-week` | `last-week` | `this-month` | `last-month`
- exact ISO date: `2026-05-20`
- ISO date range: `2026-05-20..2026-05-27` (inclusive)

Returns `{ start, end }` ISO date strings.

### Filter logic in `matchesFilters`

Pseudocode (inside the existing filter chain):
```
if operators.duration:
  sec    = getTaskElapsed(t)            # falls back to t.totalSec || 0
  target = operators.duration.seconds
  switch operators.duration.op:
    case '>':  reject if not (sec >  target)
    case '>=': reject if not (sec >= target)
    case '<':  reject if not (sec <  target)
    case '<=': reject if not (sec <= target)
    case '=':  reject if sec !== target

if operators.completed:
  if t.completedAt is null: reject
  k = completionDateKey(t.completedAt)
  if k < operators.completed.start or k > operators.completed.end: reject
```

### Sort

Extend the `taskSortBy` enum (currently `name | priority | impact | effort | created | dueDate | estimateMin | completed`) with `totalSec`. The existing `sortTasks` function adds a case that returns `getTaskElapsed(b) - getTaskElapsed(a)` (descending). The `sort:duration` operator in the query maps to `taskSortBy = 'totalSec'` for the duration of that query.

### Display

When a `duration:` filter is active, surface the per-task elapsed time on each card (currently shown only inside the detail modal). A small inline pill next to the task name: `· 2h 14m`. Uses existing `fmtHMS(getTaskElapsed(t))`.

Behind a feature condition: `if(operators.duration || taskSortBy === 'totalSec') showDurationOnCard = true;`

### Filter-pill UI

The existing visible-filter-pills row (per `js/tasks.js` agent report — commit `5558694`) auto-renders one pill per active operator. The new operators inherit this: `[duration:>2h] [completed:last-week]` pills appear in the row, clickable to remove (mutating the search input).

### Files

- `js/tasks.js`:
  - `parseTaskSearchQuery` (~line 2298) — add duration + completed parsing
  - `matchesFilters` (~line 2625) — add duration + completed checks
  - `sortTasks` — add `'totalSec'` case
  - taskSortBy enum / Sort dropdown options — add "Time spent" label
- `index.html` — add "Time spent" `<option>` to the Sort `<select>` (or to the future Dropdown after Section 3 ships)
- `css/main.css` — small `.task-duration-pill` rule for the on-card duration display

### Verification

1. Type `is:done duration:>2h` → list narrows to done tasks with > 2 hours logged.
2. Type `is:done completed:last-week` → list narrows to done tasks completed in the prior 7-day window.
3. Type `is:done duration:>2h completed:last-week sort:duration` → combined filter with descending duration sort.
4. Filter pills appear for each operator; clicking a pill removes the operator from the query.
5. Task cards show inline duration pill when a `duration:` filter is active.
6. Sort dropdown gains "Time spent" entry; works independently of the operator.
7. Bare-number ergonomics: `duration:90` matches tasks with exactly 90 minutes (5400s). `duration:>=90` matches ≥ 90 minutes.
8. Invalid operator (`duration:banana`) — silently ignored; query falls back to literal text search.

### Risk

- **Bare-number convention:** `duration:90` means 90 minutes. If users expect seconds, they'll be surprised. Mitigation: filter-pill displays the parsed value with units (`duration:>90m`), making the convention explicit.
- **Edge case — `=0`:** `duration:=0` matches tasks with no time logged. Useful for "find done tasks I never timed" but might surface non-obvious results. Acceptable; no special handling.

---

## Cross-cutting concerns

### Delivery strategy

Four independent commits, in this order (smallest blast radius first):

1. **Section 1** (subtask filter fix) — ~10 LoC change in one function. Highest impact, lowest risk. Ship first.
2. **Section 4** (search operators) — additive parser + filter changes. Touches one file, doesn't change existing semantics. Ship second.
3. **Section 2** (swipe-bug audit + fix) — defensive `closest()` check + CSS audit. Ship third.
4. **Section 3** (Dropdown utility + Recurrence/List migration) — new file, new pattern. Largest change. Ship last.

Each commit stands on its own; user can stop after any of them. Consistent with the "one PR per stage" delivery pattern from the prior session.

### Testing

- Existing `npm test` suite (290 tests) must continue to pass after each commit.
- `npm run check` and `npm run smoke:deep` clean after each commit.
- Manual verification matrices included per section (above).

### Accessibility

- Section 3's dropdown follows W3C ARIA Authoring Practices for listbox.
- Section 4's filter pills inherit existing pill keyboard accessibility (Tab + Enter to remove).
- Sections 1 and 2 don't introduce new interactive surfaces.

### Out of scope

- **Generalizing the Dropdown utility to all native selects** in the app (filter bar, quick-add, bulk import, settings). The utility is designed for this but only Recurrence and List migrate in this spec.
- **A separate Reports tab** for time analytics. Section 4 lives in the existing search bar; cross-day aggregate analytics ("total time spent matching X") deferred.
- **prefers-reduced-motion** for the dropdown animation. The existing reduced-motion rule covers the modal-overlay family; if the dropdown uses the same `.task-action-menu` styling base, it inherits already.

---

## Implementation plan

To be generated by the writing-plans skill from this design document. The plan will produce one commit per section, each with explicit file edits, verification commands, and a checklist.
