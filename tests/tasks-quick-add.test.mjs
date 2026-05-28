/**
 * parseQuickAdd in js/tasks.js — the natural-language quick-add parser.
 *
 * The user types tokens like "@urgent #work !star ~daily tomorrow buy milk"
 * and we extract structured props. This is a high-traffic regression magnet:
 * every quick-add bug starts here.
 *
 * parseQuickAdd uses todayISO() and `new Date()` internally. We inject a fixed
 * todayISO; for tomorrow/next-week/weekday we only verify shape (the calendar
 * math depends on real Date.now()).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadParser(fixedTodayISO) {
  const src = readFileSync(join(root, 'js', 'tasks.js'), 'utf8');
  const h = src.indexOf('function _qaPad2(n)');
  const s = src.indexOf('function parseQuickAdd(raw)');
  const e = src.indexOf('async function addTask()', s);
  assert.ok(h >= 0 && s >= 0 && e > s, 'slice parseQuickAdd helpers');
  const block = src.slice(h, e);
  return new Function('todayISO',
    `${block}\nreturn parseQuickAdd;`,
  )(() => fixedTodayISO);
}

test('parseQuickAdd: plain text returns name with no props', () => {
  const parse = loadParser('2026-04-27');
  const r = parse('buy milk');
  assert.equal(r.name, 'buy milk');
  assert.deepEqual(r.props, {});
});

test('parseQuickAdd: @priority extracted (urgent/high/normal/low, case-insensitive)', () => {
  const parse = loadParser('2026-04-27');
  assert.equal(parse('buy milk @urgent').props.priority, 'urgent');
  assert.equal(parse('buy milk @HIGH').props.priority, 'high');
  assert.equal(parse('buy milk @Normal').props.priority, 'normal');
  assert.equal(parse('buy milk @low').props.priority, 'low');
  assert.equal(parse('buy milk @urgent').name, 'buy milk');
});

test('parseQuickAdd: @priority requires leading whitespace (token at start of text is NOT extracted)', () => {
  // Regex is /\s@(urgent|...)/ — no leading space at position 0 means no match.
  // Locking this contract: leading-position tokens stay in the name.
  const parse = loadParser('2026-04-27');
  const r = parse('@urgent buy milk');
  assert.equal(r.props.priority, undefined);
  assert.equal(r.name, '@urgent buy milk');
});

test('parseQuickAdd: #tags accumulate (multiple), name strips them', () => {
  const parse = loadParser('2026-04-27');
  const r = parse('clean garage #home #weekend');
  assert.deepEqual(r.props.tags, ['home', 'weekend']);
  assert.equal(r.name, 'clean garage');
});

test('parseQuickAdd: !star and !pin both set starred=true (case-insensitive)', () => {
  const parse = loadParser('2026-04-27');
  assert.equal(parse('email boss !star').props.starred, true);
  assert.equal(parse('email boss !pin').props.starred, true);
  assert.equal(parse('email boss !PIN').props.starred, true);
  assert.equal(parse('email boss !star').name, 'email boss');
});

test('parseQuickAdd: ~recur extracted (daily/weekdays/weekly/monthly)', () => {
  const parse = loadParser('2026-04-27');
  assert.equal(parse('standup ~daily').props.recur, 'daily');
  assert.equal(parse('email triage ~weekdays').props.recur, 'weekdays');
  assert.equal(parse('review ~WEEKLY').props.recur, 'weekly');
  assert.equal(parse('rent ~Monthly').props.recur, 'monthly');
});

test('parseQuickAdd: "today" → injected fixedTodayISO', () => {
  const parse = loadParser('2026-04-27');
  assert.equal(parse('buy milk today').props.dueDate, '2026-04-27');
  assert.equal(parse('buy milk today').name, 'buy milk');
});

test('parseQuickAdd: "tomorrow" / "tmrw" → ISO-shaped date, both spellings produce the same value', () => {
  const parse = loadParser('2026-04-27');
  const r = parse('buy milk tomorrow');
  const r2 = parse('buy milk tmrw');
  assert.match(r.props.dueDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(r.props.dueDate, r2.props.dueDate);
  assert.equal(r.name, 'buy milk');
  assert.equal(r2.name, 'buy milk');
});

test('parseQuickAdd: "next week" → ISO-shaped date, name stripped', () => {
  const parse = loadParser('2026-04-27');
  const r = parse('plan trip next week');
  assert.match(r.props.dueDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(r.name, 'plan trip');
});

test('parseQuickAdd: weekday names — all short and long forms map to a date', () => {
  const parse = loadParser('2026-04-27');
  const days = [
    'sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat',           // 3-letter abbreviations
    'tues', 'thurs',                                            // common 4-letter abbreviations
    'sunday', 'monday', 'tuesday', 'wednesday',                 // full forms
    'thursday', 'friday', 'saturday',
  ];
  for (const day of days) {
    const r = parse(`haircut ${day}`);
    assert.match(r.props.dueDate, /^\d{4}-\d{2}-\d{2}$/, `dueDate for ${day}`);
    assert.equal(r.name, 'haircut', `name stripped for ${day}`);
  }
});

test('parseQuickAdd: combined tokens — every type at once', () => {
  const parse = loadParser('2026-04-27');
  const r = parse('finish report @high #work !star ~weekly today');
  assert.equal(r.props.priority, 'high');
  assert.deepEqual(r.props.tags, ['work']);
  assert.equal(r.props.starred, true);
  assert.equal(r.props.recur, 'weekly');
  assert.equal(r.props.dueDate, '2026-04-27');
  assert.equal(r.name, 'finish report');
});

test('parseQuickAdd: token-only input — empty name after stripping', () => {
  // Note the leading space: the priority/star/recur regexes require \s before
  // the marker, so a token at position 0 won't match (locked in by test above).
  // To get a fully-tokenized input that reduces to empty name, every token
  // needs a leading space.
  const parse = loadParser('2026-04-27');
  const r = parse(' @urgent #work today');
  assert.equal(r.props.priority, 'urgent');
  assert.deepEqual(r.props.tags, ['work']);
  assert.equal(r.props.dueDate, '2026-04-27');
  assert.equal(r.name, '');
});

test('parseQuickAdd: collapses multiple spaces left behind by token removal', () => {
  const parse = loadParser('2026-04-27');
  const r = parse('write   notes  @urgent  today');
  assert.equal(r.name, 'write notes');
});

test('parseQuickAdd: duplicate priorities — first occurrence wins, second stays in name', () => {
  // Contract: match() returns the first occurrence positionally, so the
  // first priority the user typed is treated as their commitment. The
  // second @-token survives in the title (the parser doesn't loop).
  // Rationale for first-wins (vs. last-wins): users tend to type their
  // intent first; a stray second priority is more often a typo than a
  // deliberate revision. If product changes its mind, swap the regex
  // for a global match + pick the last group, then update this test.
  const parse = loadParser('2026-04-27');
  const r = parse('task @urgent @low');
  assert.equal(r.props.priority, 'urgent');
  assert.equal(r.name, 'task @low');
  // Mirror case: order in input flips the winner (positional, not semantic)
  const r2 = parse('task @low @urgent');
  assert.equal(r2.props.priority, 'low');
  assert.equal(r2.name, 'task @urgent');
});

test('parseQuickAdd: multiple date phrases — cascade priority decides (today > tomorrow > next week > weekday)', () => {
  // Contract: the parser uses an if/else-if cascade for dates, so an
  // earlier branch wins regardless of input order. This is *semantic*
  // priority (today is "more specific"), not positional priority like
  // the priority/star tokens above. Both are intentional; this test
  // makes the difference visible so future refactors don't accidentally
  // unify them.
  const parse = loadParser('2026-04-27');
  const r1 = parse('buy milk today tomorrow');
  assert.equal(r1.props.dueDate, '2026-04-27');
  assert.equal(r1.name, 'buy milk tomorrow');
  // Even with "tomorrow" first in input, "today" still wins
  const r2 = parse('buy milk tomorrow today');
  assert.equal(r2.props.dueDate, '2026-04-27');
  assert.equal(r2.name, 'buy milk tomorrow');
  // Today beats weekday too
  const r3 = parse('haircut friday today');
  assert.equal(r3.props.dueDate, '2026-04-27');
  assert.match(r3.name, /friday/);
});

test('parseQuickAdd: clock phrases set remindAt and default dueDate to today', () => {
  const parse = loadParser('2026-05-28');
  const r = parse('call mom at 3pm');
  assert.equal(r.name, 'call mom');
  assert.equal(r.props.dueDate, '2026-05-28');
  assert.equal(r.props.remindAt, '2026-05-28T15:00');
});

test('parseQuickAdd: time combines with an existing due date instead of replacing it', () => {
  const parse = loadParser('2026-05-28');
  const r = parse('meeting tomorrow at 2pm');
  assert.equal(r.name, 'meeting');
  assert.equal(r.props.dueDate, '2026-05-29');
  assert.equal(r.props.remindAt, '2026-05-29T14:00');
});

test('parseQuickAdd: 24-hour and noon aliases parse offline', () => {
  const parse = loadParser('2026-05-28');
  assert.equal(parse('standup 09:30').props.remindAt, '2026-05-28T09:30');
  assert.equal(parse('lunch at noon tomorrow').props.remindAt, '2026-05-29T12:00');
  assert.equal(parse('wrap at midnight today').props.remindAt, '2026-05-28T00:00');
});
