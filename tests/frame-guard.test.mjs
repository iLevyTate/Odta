/**
 * Clickjacking guard.
 *
 * The CSP lives in a <meta> tag (index.html) because GitHub Pages sends no
 * response headers, and frame-ancestors is ignored in meta CSPs — so nothing
 * at the HTTP layer stops another site from framing odta.app and overlaying
 * invisible controls on the sync Accept banner, a delete confirmation or
 * Import → Replace. The substitute is in script:
 *
 *  - js/pwa.js, the first script that runs only in a window (js/version.js
 *    is shared with the service worker via importScripts, so it can't carry
 *    the guard), aborts the parse inside any frame and swaps the document
 *    for a notice with a target="_top" link, with a MutationObserver that
 *    removes anything the parser might still append.
 *  - js/app.js, where the app boots, throws before loadState() as a second
 *    guard in case the parser carried on.
 *
 * Static checks pin both in place; a functional check runs the real pwa.js
 * in a fake framed window and asserts what it does — and doesn't — touch.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pwa = readFileSync(join(root, 'js', 'pwa.js'), 'utf8');
const app = readFileSync(join(root, 'js', 'app.js'), 'utf8');
const version = readFileSync(join(root, 'js', 'version.js'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');

test('pwa.js: the frame check is the first statement of the file', () => {
  // Nothing but comments may sit between the IIFE's opening and the check.
  assert.match(pwa, /^\(function\(\)\{\s*\n(?:\s*\/\/[^\n]*\n)*\s*if \(window\.top !== window\.self\) \{/,
    'the guard must run before anything else in js/pwa.js');
  const guard = pwa.slice(0, pwa.indexOf('const isFileProtocol'));
  assert.match(guard, /window\.stop\(\)/, 'stops the parser');
  assert.match(guard, /a\.href = location\.href/, 'links to the app itself');
  assert.match(guard, /a\.target = '_top'/, 'opens top-level');
  assert.match(guard, /document\.documentElement\.replaceChildren\(head, body\)/, 'replaces the document');
  assert.match(guard, /new MutationObserver\(/, 'removes anything the parser still appends');
  assert.match(guard, /\n    return;\n  \}\n/, 'returns before the rest of pwa.js');
});

test('pwa.js is the first window-only script in index.html, loaded in <head> before the app modules', () => {
  const order = [...html.matchAll(/<script\s+src="(js\/[^"]+\.js)"/g)].map((m) => m[1]);
  const i = order.indexOf('js/pwa.js');
  assert.ok(i >= 0, 'js/pwa.js is loaded');
  // Only the SW-shared release stamp and the passive dispatcher/alarm helpers
  // may precede it; none of those read state or render.
  assert.deepStrictEqual(order.slice(0, i), ['js/version.js', 'js/event-delegation.js', 'js/alarm-store.js', 'js/alarms.js']);
  assert.ok(html.indexOf('<script src="js/pwa.js">') < html.indexOf('<body'), 'pwa.js is in <head>');
  for (const f of order.slice(0, i)) {
    const src = readFileSync(join(root, f), 'utf8');
    assert.doesNotMatch(src, /loadState\(|localStorage\.getItem\(\s*['"]stupind_state/, f + ' must not read app state before the guard');
  }
});

test('version.js stays free of the guard (it is shared with the service worker)', () => {
  assert.doesNotMatch(version, /window\.top|window\.self|document\./);
  const sw = readFileSync(join(root, 'sw.js'), 'utf8');
  assert.match(sw, /importScripts\('\.\/js\/version\.js'\)/);
});

test('app.js refuses to boot inside a frame before any state is read', () => {
  const m = app.match(/if \(window\.top !== window\.self\) \{\s*\n\s*throw new Error\([^)]*\);\s*\n\}/);
  assert.ok(m, 'boot guard present');
  assert.ok(m.index < app.indexOf('window.onerror'), 'before the error safety net');
  assert.ok(m.index < app.indexOf('loadState();'), 'before loadState()');
  assert.ok(m.index < app.indexOf('localStorage'), 'before any localStorage access');
});

test('index.html documents why frame-ancestors is absent from the meta CSP', () => {
  const comment = html.slice(html.indexOf('<!-- CSP:'), html.indexOf('http-equiv="Content-Security-Policy"'));
  assert.match(comment, /frame-ancestors/);
  assert.match(comment, /js\/pwa\.js/);
  assert.match(comment, /js\/app\.js/);
});

test('functional: framed, pwa.js stops the parser, replaces the document with a top-level link and touches nothing else', () => {
  const calls = [];
  const nodes = [];
  const makeEl = (tag) => {
    const el = { tag, children: [], attrs: {}, style: {}, textContent: '',
      appendChild(c) { this.children.push(c); return c; },
      setAttribute(k, v) { this.attrs[k] = v; },
      remove() { calls.push('remove:' + this.tag); } };
    nodes.push(el);
    return el;
  };
  const documentElement = { childNodes: [], replaceChildren(...kids) { calls.push('replaceChildren'); this.childNodes = kids; } };
  const document = {
    documentElement,
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => { calls.push('getElementById:' + id); return null; },
    addEventListener: () => calls.push('document.addEventListener'),
    body: null,
  };
  let observed = null;
  class MutationObserver { constructor(fn) { this.fn = fn; } observe(target, opts) { observed = { target, opts, fn: this.fn }; } }
  const top = {};
  const win = {
    top, document, location: { href: 'https://odta.app/?tab=tasks', protocol: 'https:' },
    stop: () => calls.push('stop'),
    addEventListener: () => calls.push('window.addEventListener'),
    navigator: { serviceWorker: { get controller() { calls.push('serviceWorker'); return null; } } },
    MutationObserver, Array, Error, console, setTimeout, clearTimeout, Blob: class {}, URL: { createObjectURL() {} },
  };
  win.self = win;
  win.window = win;
  vm.createContext(win);
  vm.runInContext(pwa, win, { filename: 'js/pwa.js' });
  assert.deepStrictEqual(calls, ['stop', 'replaceChildren'], 'only stop() and the document swap ran: ' + calls.join(','));
  const [head, body] = documentElement.childNodes;
  assert.equal(head.tag, 'head');
  assert.equal(body.tag, 'body');
  const a = body.children.find((c) => c.tag === 'a');
  assert.ok(a, 'the notice carries a link');
  assert.equal(a.href, 'https://odta.app/?tab=tasks');
  assert.equal(a.target, '_top');
  assert.equal(a.rel, 'noopener');
  assert.ok(body.children.some((c) => c.tag === 'p' && /inside another website/.test(c.textContent)));
  assert.ok(observed && observed.target === documentElement && observed.opts.childList === true, 'the observer watches the root');
  // A late-appended node (parser carrying on) is removed at the next callback.
  const stray = makeEl('body');
  documentElement.childNodes = [head, body, stray];
  observed.fn();
  assert.ok(calls.includes('remove:body'), 'stray nodes are detached');
  assert.ok(!calls.includes('remove:head') && calls.filter((c) => c === 'remove:body').length === 1, 'the notice itself is kept');
  // Not framed: the guard is a no-op and the rest of the file runs (it reaches the service-worker probe).
  const calls2 = [];
  const win2 = { ...win, top: null, stop: () => calls2.push('stop'),
    document: { ...document, addEventListener: () => calls2.push('document.addEventListener') },
    navigator: { serviceWorker: { get controller() { calls2.push('serviceWorker'); return null; }, addEventListener() {}, register: () => Promise.resolve({ addEventListener() {} }) } } };
  win2.self = win2; win2.window = win2; win2.top = win2;
  vm.createContext(win2);
  try { vm.runInContext(pwa, win2, { filename: 'js/pwa.js' }); } catch (_) { /* later DOM code may throw in this stub; the guard's branch is what matters */ }
  assert.ok(!calls2.includes('stop'), 'a top-level window is never stopped');
  assert.ok(calls2.includes('serviceWorker'), 'the rest of pwa.js ran');
});

test('functional: framed, app.js throws before touching anything', () => {
  const touched = [];
  const win = { top: {}, localStorage: new Proxy({}, { get() { touched.push('localStorage'); return () => null; } }), document: new Proxy({}, { get(_, k) { touched.push('document.' + String(k)); return () => null; } }), console };
  win.self = win; win.window = win;
  vm.createContext(win);
  assert.throws(() => vm.runInContext(app, win, { filename: 'js/app.js' }), /inside a frame/);
  assert.deepStrictEqual(touched, []);
});
