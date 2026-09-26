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
  // _calFetchUrlOk depends on the loose-IPv4 and embedded-IPv4 helpers.
  const helpers = ['_calParseIpv4Loose', '_calIpv4IsPrivate', '_calParseIpv6', '_calIpv6EmbeddedIpv4']
    .map(sliceFn).join('\n') + '\n';
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
  // Trailing-dot (DNS root) and *.localhost forms of loopback:
  'https://localhost./x',
  'https://foo.localhost/x',
  'https://a.b.localhost./x',
  'https://lvh.me./x',
  'https://foo.nip.io./x',
  // IPv6 forms embedding a private IPv4 (URL rewrites the dotted quad to hex):
  'https://[::ffff:127.0.0.1]/x',  // IPv4-mapped → [::ffff:7f00:1]
  'https://[::ffff:7f00:1]/x',
  'https://[::ffff:0:7f00:1]/x',   // IPv4-translated (RFC 2765)
  'https://[::ffff:0:a00:1]/x',    // translated 10.0.0.1
  'https://[::ffff:a00:1]/x',      // mapped 10.0.0.1 (old prefix regex missed it)
  'https://[::ffff:c0a8:101]/x',   // mapped 192.168.1.1
  'https://[::ffff:a9fe:a9fe]/x',  // mapped 169.254.169.254 (metadata)
  'https://[64:ff9b::7f00:1]/x',   // NAT64 127.0.0.1
  'https://[64:ff9b::a9fe:a9fe]/x',// NAT64 metadata
  'https://[::7f00:1]/x',          // deprecated IPv4-compatible
  // CGNAT 100.64/10 (RFC 6598):
  'https://100.64.0.1/x',
  'https://100.127.255.254/x',
  'https://[::ffff:6440:1]/x',     // mapped 100.64.0.1
];

const ALLOWED = [
  'https://calendar.google.com/calendar/ical/example/basic.ics',
  'https://outlook.live.com/owa/calendar/x/calendar.ics',
  'https://example.com/feed.ics',
  'https://172.15.0.1/x',  // just outside 172.16/12
  'https://172.32.0.1/x',  // just outside 172.16/12
  'https://192.169.1.1/x', // just outside 192.168/16
  'https://169.253.1.1/x', // just outside 169.254/16
  'https://100.63.255.255/x', // just below 100.64/10
  'https://100.128.0.1/x',    // just above 100.64/10
  'https://example.com./feed.ics',  // trailing dot on a public name
  'https://notlocalhost.example/x', // "localhost" only as a label suffix match
  'https://[::ffff:808:808]/x',     // mapped 8.8.8.8 (public)
  'https://[64:ff9b::808:808]/x',   // NAT64 8.8.8.8 (public)
  'https://[2001:4860:4860::8888]/x',
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
