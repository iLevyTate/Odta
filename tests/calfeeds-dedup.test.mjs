/**
 * createTaskFromCalEventCore dedupes by (calFeedId, calEventUid) (js/calfeeds.js).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadCreateTaskFromCalEventCore() {
  const src = readFileSync(join(root, 'js', 'calfeeds.js'), 'utf8');
  const start = src.indexOf('function createTaskFromCalEventCore(feedId, eventUid, eventDate){');
  const end = src.indexOf('function createTaskFromCalEvent(feedId, eventUid, eventDate){', start);
  assert.ok(start >= 0 && end > start, 'slice createTaskFromCalEventCore');
  const fnBody = src.slice(start, end).replace(/\s*$/, '');
  const factory = new Function(
    '_calFeeds',
    'tasks',
    `
    var taskIdCtr = 0;
    function _loadCalFeeds(){ return _calFeeds; }
    function defaultTaskProps(){
      return { status:'open', priority:'none', tags:[], dueDate:null, archived:false, listId:1 };
    }
    function timeNowFull(){ return 'now'; }
    function _taskIndexRegister(){}
    ${fnBody}
    return createTaskFromCalEventCore;
  `,
  );
  return factory;
}

test('createTaskFromCalEventCore returns same task id on second call', () => {
  const feedId = 'feed-1';
  const eventUid = 'evt-uid-99';
  const _calFeeds = {
    feeds: [{
      id: feedId,
      label: 'Work',
      events: [{ uid: eventUid, title: 'Standup', description: '', location: '', dateISO: '2026-04-22' }],
    }],
  };
  const tasks = [];
  const createTaskFromCalEventCore = loadCreateTaskFromCalEventCore()(_calFeeds, tasks);
  const id1 = createTaskFromCalEventCore(feedId, eventUid);
  assert.equal(tasks.length, 1);
  const id2 = createTaskFromCalEventCore(feedId, eventUid);
  assert.equal(id1, id2);
  assert.equal(tasks.length, 1);
});
