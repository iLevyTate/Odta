/**
 * Regressions in js/tasks.js list interactions:
 *
 * 1. toggleTaskDoneQuick / cycleStatus snapshot the task BEFORE mutating it.
 *    The backup used to be taken after the mutation, so the Undo toast (and
 *    Cmd+Z) re-applied the post-click state and the task stayed done.
 * 2. Priority sort ranks Urgent first. `PRIORITY_ORDER[p]||9` turned urgent's
 *    rank 0 into 9, so urgent tasks sorted LAST in the priority / smart sorts.
 * 3. The Inbox smart view can't require "no list": every task carries one
 *    (defaultTaskProps + ensureDefaultList), so the view was always empty.
 * 4. The "This week" view has the same lower bound as its chip count.
 * 5. Move up/down and Indent operate on the siblings the user can see.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'tasks.js'), 'utf8');

function fnBlock(name) {
  const s = src.indexOf(`function ${name}(`);
  assert.ok(s >= 0, `${name} found`);
  const e = src.indexOf('\nfunction ', s + 1);
  return src.slice(s, e > s ? e : undefined);
}

test('toggleTaskDoneQuick snapshots before mutating and restores that snapshot on undo', () => {
  const body = fnBlock('toggleTaskDoneQuick');
  const snapIdx = body.indexOf('const _pre = JSON.parse(JSON.stringify(t))');
  const mutIdx = body.indexOf("t.status='open'");
  assert.ok(snapIdx >= 0, 'pre-mutation snapshot taken');
  assert.ok(mutIdx > snapIdx, 'snapshot precedes the first status mutation');
  assert.match(body, /_restoreTaskSnapshot\(u,_pre\)/, 'undo restores the pre-mutation snapshot');
  assert.ok(!/const backup\s*=/.test(body), 'no post-mutation backup remains');
});

test('cycleStatus snapshots before mutating and restores that snapshot on undo', () => {
  const body = fnBlock('cycleStatus');
  const snapIdx = body.indexOf('const _pre=JSON.parse(JSON.stringify(t))');
  const mutIdx = body.indexOf('t.status=next');
  assert.ok(snapIdx >= 0 && mutIdx > snapIdx, 'snapshot precedes the status mutation');
  assert.match(body, /_restoreTaskSnapshot\(u,_pre\)/);
});

test('_restoreTaskSnapshot rolls back but keeps folded timer seconds and re-stamps lastModified', () => {
  const sandbox = { Date, Object };
  vm.createContext(sandbox);
  vm.runInContext(fnBlock('_restoreTaskSnapshot') + '\nthis.f=_restoreTaskSnapshot;', sandbox);
  const u = { id: 1, status: 'done', completedAt: '2026-09-26T10:00:00', totalSec: 900, lastModified: 5 };
  const pre = { id: 1, status: 'open', completedAt: null, totalSec: 600, lastModified: 5 };
  const before = Date.now();
  sandbox.f(u, pre);
  assert.strictEqual(u.status, 'open');
  assert.strictEqual(u.completedAt, null);
  assert.strictEqual(u.totalSec, 900, 'seconds toggleTask folded in are kept');
  assert.ok(u.lastModified >= before, 'restored task gets a fresh stamp so sync does not revert it');
});

test('urgent sorts first: PRIORITY_ORDER lookups use ?? not ||', () => {
  assert.ok(!/PRIORITY_ORDER\[[^\]]+\]\s*\|\|\s*9/.test(src), 'no `PRIORITY_ORDER[..]||9` (rank 0 is falsy)');
  const sandbox = { todayISO: () => '2026-09-26', _paretoScoreMap: new Map(), taskSortBy: 'priority', window: {}, taskFilters: { search: '' } };
  vm.createContext(sandbox);
  const s = src.indexOf('const PRIORITY_ORDER=');
  const e = src.indexOf('\n', s);
  vm.runInContext(src.slice(s, e) + '\n' + fnBlock('sortTasks') + '\nthis.sortTasks=sortTasks;', sandbox);
  const out = sandbox.sortTasks([
    { id: 1, priority: 'low' }, { id: 2, priority: 'urgent' }, { id: 3, priority: 'none' }, { id: 4, priority: 'high' },
  ]).map((t) => t.priority);
  assert.deepEqual(out, ['urgent', 'high', 'low', 'none']);
});

test('Inbox no longer requires listId === null; week view excludes overdue', () => {
  const body = fnBlock('matchesFilters');
  const inbox = body.slice(body.indexOf("smartView==='inbox'"), body.indexOf("smartView==='waiting'"));
  assert.ok(!/t\.listId/.test(inbox), 'inbox criteria must not mention listId');
  const week = body.slice(body.indexOf("smartView==='week'"), body.indexOf("smartView==='overdue'"));
  assert.match(week, /t\.dueDate<today/, 'week view bounded below by today, matching svcWeek');
  assert.ok(!/svcInbox',visibleNow\.filter\(t=>!t\.listId/.test(src), 'inbox chip count matches the view');
});

test('move / indent skip siblings the user cannot see', () => {
  assert.match(fnBlock('_moveTask'), /_visibleSiblings\(sibs,id\)/);
  assert.match(fnBlock('indentTask'), /_visibleSiblings\(sibs,id\)/);
});

test('grouped rendering promotes matching subtasks whose ancestors are filtered out', () => {
  const body = fnBlock('renderGroupedTasks');
  assert.match(body, /_hasVisibleAncestor/);
  assert.match(body, /hasVisibleDescendant\(c\.id,visibleSet\)/, 'children follow the tree-mode rule');
});

test('removeTask defers the attachment purge past the undo window', () => {
  const body = fnBlock('removeTask');
  assert.match(body, /setTimeout\(_purgeAttachments, /);
  assert.match(body, /clearTimeout\(_attachPurgeTimer\)/, 'undo cancels the purge');
  assert.match(body, /lastModified: _restoredAt/, 'restored tasks are re-stamped so tombstones do not win');
});
