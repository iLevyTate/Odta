/**
 * Values that arrive from a backup file, the tasks JSON import, another tab
 * or a sync peer, and the sinks they used to reach unrepaired.
 *
 *  - cfg.cycle drives a DOM loop in renderPips(); {cycle:1e9} froze the tab
 *    on every boot because load saves before it renders.
 *  - taskIdCtr:1e21 made ++taskIdCtr a no-op (1e21+1 === 1e21); after a
 *    reload parseInt("1e+21") read back as 1 and new ids collided.
 *  - List names went into innerHTML (ai.js list-move summary) as stored.
 *  - A restored archive's totalPomos / date went into innerHTML and a
 *    quoted CSV cell as stored.
 *  - _icsEscape turned \n into \\n but left a bare \r as a line break.
 *  - esc() round-tripped through textContent → innerHTML, which never
 *    escapes quotes, so every attr="${esc(x)}" could be broken out of.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const storage = readFileSync(join(root, 'js', 'storage.js'), 'utf8');
const utils = readFileSync(join(root, 'js', 'utils.js'), 'utf8');

function slice(src, from, to) {
  const i = src.indexOf(from);
  const j = src.indexOf(to, i + from.length);
  assert.ok(i >= 0 && j > i, `slice ${from}`);
  return src.slice(i, j);
}

const coerce = storage.match(/\/\/ ── Type coercions[\s\S]*?const _enum[^\n]*\n/)[0];
const ingress = slice(storage, '// ── Ingress repair: id counters, lists ──', '// ── end ingress repair ──');
const cfgBlock = slice(storage, '/** [min, max, default]', 'if(typeof window!==\'undefined\') window.normalizeCfg=normalizeCfg;');
const ics = slice(storage, 'function _icsEscape(', 'function _icsFoldLine(');

const H = new Function(`
  ${coerce}
  ${ingress}
  ${cfgBlock}
  ${ics}
  return { _reseedIdCtr, _idOk, _repairList, _repairArchives, normalizeCfg, CFG_INT_BOUNDS, _icsEscape };
`)();

test('normalizeCfg holds durations and cycle to the Settings stepper ranges', () => {
  const c = H.normalizeCfg({ work: 1e9, short: -4, long: '15', cycle: 1e9 });
  assert.deepStrictEqual([c.work, c.short, c.long, c.cycle], [120, 1, 15, 10]);
  const d = H.normalizeCfg({ work: 'x', cycle: NaN });
  assert.deepStrictEqual([d.work, d.short, d.long, d.cycle], [25, 5, 15, 4], 'garbage falls back to defaults');
  assert.equal(H.normalizeCfg({ cycle: 1 }).cycle, 1, 'Ultradian / Deep work presets use cycle 1');
});

test('id counters: unsafe or huge values are dropped and reseeded from the ids in use', () => {
  assert.equal(H._reseedIdCtr(1e21, [{ id: 3 }, { id: 7 }]), 7);
  assert.equal(H._reseedIdCtr('1e+21', []), 0);
  assert.equal(H._reseedIdCtr(4, [{ id: 9 }]), 9, 'counter must sit above every id in use');
  assert.equal(H._reseedIdCtr(12, [{ id: 9 }]), 12);
  assert.equal(H._reseedIdCtr(0, [{ id: 1e20 }, { id: 2 }]), 2, 'an id past the cap does not drag the counter up');
});

test('lists are repaired to {int id, string name, hex colour, string description}', () => {
  assert.deepStrictEqual(
    H._repairList({ id: '5', name: '  Work ', color: 'red;background:url(x)', description: 7, extra: 1 }),
    { id: 5, name: 'Work', color: '#1a8cff', description: '', lastModified: 0 },
  );
  assert.equal(H._repairList({ id: 'x', name: 'A' }), null);
  assert.equal(H._repairList({ id: 2, name: '' }), null);
  assert.equal(H._repairList({ id: 2, name: 'A', color: '#ABC' }).color, '#ABC');
});

test('archives: numbers become numbers, the date must be YYYY-MM-DD', () => {
  const [day, ...rest] = H._repairArchives([
    { date: '2026-01-01', totalPomos: '<form action=https://evil>', totalFocusSec: '90', tasks: [{ name: 'a', sessions: '<b>' }] },
    { date: 'x",=HYPERLINK("https://evil")', totalPomos: 3 },
    'junk',
  ]);
  assert.equal(rest.length, 0, 'bad dates and non-objects are dropped');
  assert.equal(day.totalPomos, 0);
  assert.equal(day.totalFocusSec, 90);
  assert.equal(day.tasks[0].sessions, 0);
  assert.equal(H._repairArchives('not an array').length, 0);
});

test('ICS export escapes CR as well as LF', () => {
  const out = H._icsEscape('x\rEND:VEVENT\r\nBEGIN:VEVENT\nSUMMARY:injected');
  assert.doesNotMatch(out, /[\r\n]/, 'no raw line break may survive');
  assert.equal(out, 'x\\nEND:VEVENT\\nBEGIN:VEVENT\\nSUMMARY:injected');
});

test('esc() escapes both quote characters for attribute contexts', () => {
  const esc = new Function(utils.match(/function esc\(s\)\{[\s\S]*?\n\}/)[0] + '; return esc;')();
  assert.equal(esc(`x" data-action="syncConnect" y='z'`), 'x&quot; data-action=&quot;syncConnect&quot; y=&#39;z&#39;');
  assert.equal(esc('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
  assert.equal(esc(null), '');
  assert.equal(esc(0), '0');
});

test('note ids are numeric after repair, and the note row escapes its data-args', () => {
  assert.match(storage, /id:\s*\(Number\.isFinite\(Number\(n\.id\)\)[^?]*\) \? Number\(n\.id\)/);
  const tasks = readFileSync(join(root, 'js', 'tasks.js'), 'utf8');
  assert.match(tasks, /data-action="removeTaskNote" data-args=["']\$\{escAttr\(JSON\.stringify\(\[taskId,n\.id\]\)\)\}["']/);
});
