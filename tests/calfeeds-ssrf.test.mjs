/**
 * calfeeds.js — _calFetchUrlOk SSRF guard.
 * Regression for the audit finding: private IPs / loopback / link-local /
 * IPv6 ULA / link-local must be rejected so a malicious backup can't point
 * a "calendar feed" at internal services (e.g. router admin, AWS metadata).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'js', 'calfeeds.js'), 'utf8');

function sliceFn(name){
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' must exist');
  const sigEnd = src.indexOf('{', i);
  let depth = 0;
  let j = sigEnd;
  for(; j < src.length; j++){
    if(src[j] === '{') depth++;
    else if(src[j] === '}'){ depth--; if(depth === 0){ j++; break; } }
  }
  return src.slice(i, j);
}

function extractFn(){
  // _calFetchUrlOk depends on the two loose-IPv4 helpers, so include them.
  const helpers = sliceFn('_calParseIpv4Loose') + '\n' + sliceFn('_calIpv4IsPrivate') + '\n';
  const body = sliceFn('_calFetchUrlOk');
  // Stub for the production env that the helper reads.
  return new Function('window', 'location', helpers + 'return (' + body + ')');
}

const fakeWin = { location: { href: 'https://example.com/' } };
const fakeLoc = { protocol: 'https:' };
const calFetchUrlOk = extractFn()(fakeWin, fakeLoc);

const BLOCKED = [
  // Audit-flagged ranges:
  'http://127.0.0.1/x',
  'http://127.5.5.5/x',
  'https://localhost/x',
  'https://10.0.0.1/x',
  'https://172.16.0.1/x',
  'https://172.31.255.255/x',
  'https://192.168.1.1/x',
  'http://169.254.169.254/latest/meta-data/',   // AWS metadata
  'http://169.254.1.1/admin',
  'http://0.0.0.0/x',
  'https://[::1]/x',
  'https://[::]/x',
  'https://[fe80::1]/x',
  'https://[fc00::1]/x',
  'https://[fd00::1]/x',
  // Numeric / hex / octal / short IPv4 obfuscations of 127.0.0.1:
  'http://2130706433/x',          // decimal
  'http://0x7f000001/x',          // hex
  'http://017700000001/x',        // octal
  'http://127.1/x',               // short form
  'http://0x7f.0.0.1/x',          // mixed hex octet
  'http://3232235521/x',          // decimal 192.168.0.1
  // DNS-rebind helpers that map names to loopback/private without an IP label:
  'https://app.localtest.me/x',
  'https://foo.lvh.me/x',
  'https://service.nip.io/x',
];

const ALLOWED = [
  'https://calendar.google.com/calendar/ical/example/basic.ics',
  'https://outlook.live.com/owa/calendar/x/calendar.ics',
  'https://example.com/feed.ics',
  'https://172.15.0.1/x',  // just outside 172.16/12
  'https://172.32.0.1/x',  // just outside 172.16/12
  'https://192.169.1.1/x', // just outside 192.168/16
  'https://169.253.1.1/x', // just outside 169.254/16
];

test('calfeeds SSRF: private/loopback/link-local ranges are rejected', () => {
  for(const u of BLOCKED){
    assert.strictEqual(calFetchUrlOk(u), false, `should block ${u}`);
  }
});

test('calfeeds SSRF: public hosts pass through', () => {
  for(const u of ALLOWED){
    assert.strictEqual(calFetchUrlOk(u), true, `should allow ${u}`);
  }
});

test('calfeeds SSRF: non-http(s) schemes are rejected', () => {
  for(const u of ['ftp://example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,hi']){
    assert.strictEqual(calFetchUrlOk(u), false, `should block scheme: ${u}`);
  }
});
