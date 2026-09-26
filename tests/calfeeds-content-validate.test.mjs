/**
 * Regression: pasted / opened .ics content must be validated for every caller
 * (js/calfeeds.js).
 *
 * The 2 MB size cap and BEGIN:VCALENDAR marker check lived only in
 * submitAddCalFeed (the paste form). app.js's "Open with Odta" file handler
 * calls addCalFeed({content}) directly, so any file of any size was stored in
 * localStorage and re-parsed on every sync. calFeedContentError is now the one
 * gate: addCalFeed throws with its message, and syncCalFeed refuses stored
 * content that fails it (older builds / restored backups).
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(root, 'js', 'calfeeds.js'), 'utf8');
const FEEDS_KEY = 'stupind_calfeeds';
const ICS = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:a\nDTSTART;VALUE=DATE:20260105\nEND:VEVENT\nEND:VCALENDAR\n';

function load(seed) {
  const store = new Map();
  if (seed) store.set(FEEDS_KEY, JSON.stringify(seed));
  const ctx = {
    console, URL,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
    },
    location: { protocol: 'https:', href: 'https://example.com/' },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, store };
}

test('calFeedContentError: accepts an .ics, rejects oversize / markerless / non-string', () => {
  const { ctx } = load();
  assert.equal(ctx.calFeedContentError(ICS), null);
  assert.match(ctx.calFeedContentError('BEGIN:VCALENDAR\n' + 'x'.repeat(2_000_000)), /too large/);
  assert.match(ctx.calFeedContentError('<html>login</html>'), /BEGIN:VCALENDAR/);
  assert.match(ctx.calFeedContentError(''), /BEGIN:VCALENDAR/);
  assert.match(ctx.calFeedContentError({}), /text/);
});

test('addCalFeed({content}), the "Open with Odta" path, enforces the same checks', () => {
  const { ctx, store } = load();
  assert.throws(() => ctx.addCalFeed({ label: 'Big', content: 'BEGIN:VCALENDAR\n' + 'x'.repeat(2_000_000) }), /too large/);
  assert.throws(() => ctx.addCalFeed({ label: 'Html', content: '<!DOCTYPE html><p>nope' }), /BEGIN:VCALENDAR/);
  assert.equal(ctx._loadCalFeeds().feeds.length, 0, 'rejected content adds no feed');
  assert.equal(store.has(FEEDS_KEY), false, 'and nothing is persisted');

  const ok = ctx.addCalFeed({ label: 'Ok', content: ICS });
  assert.equal(ok.content, ICS);
  // URL-mode feeds carry no content and are unaffected.
  const u = ctx.addCalFeed({ label: 'Url', url: 'https://calendar.example.com/x.ics' });
  assert.equal(u.content, null);
  assert.equal(ctx._loadCalFeeds().feeds.length, 2);
});

test('syncCalFeed refuses stored content that fails the gate and records the error', async () => {
  const bad = { id: 'old', label: 'Old', content: 'X'.repeat(2_000_001), events: [{ uid: 'keep', dateISO: '2026-01-01' }], visible: true };
  const { ctx } = load({ feeds: [bad] });
  await assert.rejects(ctx.syncCalFeed('old'), /too large/);
  const f = ctx._loadCalFeeds().feeds[0];
  assert.match(f.error, /too large/);
  assert.equal(f.events.length, 1, 'previous events are kept, not replaced by a giant parse');
});

test('valid pasted content still syncs', async () => {
  const { ctx } = load();
  const f = ctx.addCalFeed({ label: 'Ok', content: ICS });
  const r = await ctx.syncCalFeed(f.id);
  assert.equal(r.count, 1);
  assert.equal(ctx._loadCalFeeds().feeds[0].error, null);
});

test('submitAddCalFeed routes the paste through calFeedContentError', () => {
  const i = SRC.indexOf('async function submitAddCalFeed(');
  const body = SRC.slice(i, SRC.indexOf('\n}\n', i));
  assert.ok(/calFeedContentError\(content\)/.test(body), 'paste form uses the shared validator');
});
