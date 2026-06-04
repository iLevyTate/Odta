// ════════════════════════════════════════════════════════════════════════════
// CALENDAR FEEDS — import external .ics (iCalendar) feeds like Google Calendar
// ════════════════════════════════════════════════════════════════════════════
// Fully client-side. Parses .ics locally, caches events in localStorage.
// Three fetch modes: paste raw content, direct URL (rarely works due to CORS),
// or via a user-configured CORS proxy. No centralised infrastructure — each
// user decides their own privacy/convenience tradeoff.

const CALFEEDS_KEY    = (window.ODTAULAI_CONFIG && window.ODTAULAI_CONFIG.STORAGE_KEYS && window.ODTAULAI_CONFIG.STORAGE_KEYS.CAL_FEEDS) || 'stupind_calfeeds';       // {feeds:[{id,label,color,url,proxy,content,events,lastSync}]}
const CALFEEDS_PROXY  = (window.ODTAULAI_CONFIG && window.ODTAULAI_CONFIG.STORAGE_KEYS && window.ODTAULAI_CONFIG.STORAGE_KEYS.CAL_FEEDS_PROXY) || 'stupind_calfeeds_proxy'; // default proxy URL (optional, user-entered)
// PRIVACY NOTE: Calendar events are stored in localStorage for offline access.
// Same-origin isolation prevents cross-site access. The proxy URL is also stored
// here — users accept this tradeoff when configuring URL-mode feeds.

let _calFeeds = null;

function _loadCalFeeds(){
  if(_calFeeds) return _calFeeds;
  try {
    const raw = localStorage.getItem(CALFEEDS_KEY);
    _calFeeds = raw ? JSON.parse(raw) : { feeds: [] };
    if(!_calFeeds.feeds) _calFeeds.feeds = [];
  } catch(e) {
    _calFeeds = { feeds: [] };
  }
  return _calFeeds;
}

function _saveCalFeeds(){
  try { localStorage.setItem(CALFEEDS_KEY, JSON.stringify(_calFeeds)); } catch(e) {}
}

// Cross-tab freshness: another tab can add / remove / re-sync a feed and rewrite
// CALFEEDS_KEY. This tab's in-memory cache is only populated once, so without
// invalidation it would serve stale feeds (and overwrite the other tab's work on
// the next save). The `storage` event fires only in OTHER tabs, so dropping the
// cache here is safe — the next _loadCalFeeds() re-reads the authoritative value.
// (All mutations persist via _saveCalFeeds, so there is no unsaved in-memory state.)
if(typeof window !== 'undefined' && typeof window.addEventListener === 'function'){
  window.addEventListener('storage', e => {
    if(e && e.key === CALFEEDS_KEY) _calFeeds = null;
  });
}

// ── Parser: minimal but correct iCalendar subset ───────────────────────────
// Handles VEVENT entries with DTSTART, DTEND, SUMMARY, DESCRIPTION, LOCATION,
// UID, RRULE. Properly unfolds long lines (RFC 5545: lines continue on the
// next line if they start with a space or tab).
function parseICS(text){
  if(typeof text !== 'string') return [];
  // Normalise line endings and unfold continuation lines
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const unfolded = [];
  for(const line of lines){
    if(line.startsWith(' ') || line.startsWith('\t')){
      if(unfolded.length) unfolded[unfolded.length-1] += line.slice(1);
    } else {
      unfolded.push(line);
    }
  }

  const events = [];
  let current = null;
  for(const raw of unfolded){
    if(raw === 'BEGIN:VEVENT'){ current = {}; continue; }
    if(raw === 'END:VEVENT'){
      if(current && current.DTSTART){ events.push(current); }
      current = null; continue;
    }
    if(!current) continue;

    // Split "KEY;PARAM=VAL:VALUE" → key (ignore params for our subset), value
    const colonIdx = raw.indexOf(':');
    if(colonIdx < 0) continue;
    let keyPart = raw.slice(0, colonIdx);
    const value = raw.slice(colonIdx + 1);
    // Key may have params (e.g. DTSTART;TZID=America/New_York) — strip them but keep TZID for date parse
    const semi = keyPart.indexOf(';');
    let tzid = null;
    let valueType = null;
    if(semi >= 0){
      const params = keyPart.slice(semi+1).split(';');
      keyPart = keyPart.slice(0, semi);
      for(const p of params){
        if(p.startsWith('TZID=')) tzid = p.slice(5);
        if(p.startsWith('VALUE=')) valueType = p.slice(6);
      }
    }
    if(keyPart === 'EXDATE'){
      // Keep each EXDATE value WITH its own TZID/VALUE params. A timed or UTC
      // EXDATE must be resolved to the same local date as the occurrence it
      // cancels; dropping the zone (the old behaviour) made the literal date
      // digits mismatch the local occurrence date and the exclusion silently
      // missed. The concatenated string is retained only as a legacy fallback.
      current._exdateSpecs = current._exdateSpecs || [];
      for(const part of String(value).split(',')){
        const v = part.trim();
        if(v) current._exdateSpecs.push({ v, tzid, valueType });
      }
      current.EXDATE = current.EXDATE ? String(current.EXDATE) + ',' + value : value;
    } else {
      current[keyPart] = value;
    }
    if(keyPart === 'DTSTART' || keyPart === 'DTEND'){
      current[keyPart + '_TZID'] = tzid;
      current[keyPart + '_VALUE'] = valueType;
    }
  }

  // Transform raw VEVENTS to our normalized shape
  return events.map(normaliseEvent).filter(Boolean);
}

// Convert iCal date format to ISO YYYY-MM-DD and HH:MM (local) where possible
function normaliseEvent(ev){
  if(!ev.DTSTART) return null;
  const start = parseICSDate(ev.DTSTART, ev.DTSTART_VALUE === 'DATE', ev.DTSTART_TZID);
  if(!start) return null;
  const end = ev.DTEND ? parseICSDate(ev.DTEND, ev.DTEND_VALUE === 'DATE', ev.DTEND_TZID) : null;
  // Prefer zone-aware specs (resolve each EXDATE to a LOCAL date so it matches
  // the occurrence dates); fall back to the literal-date parser for safety.
  const exdateSet = Array.isArray(ev._exdateSpecs) && ev._exdateSpecs.length
    ? _exdateSetFromSpecs(ev._exdateSpecs)
    : (ev.EXDATE ? parseExdateList(ev.EXDATE) : new Set());
  return {
    uid:         (ev.UID || '').slice(0, 200),
    title:       unescapeICS(ev.SUMMARY || '(no title)'),
    description: unescapeICS(ev.DESCRIPTION || ''),
    location:    unescapeICS(ev.LOCATION || ''),
    dateISO:     start.iso,       // YYYY-MM-DD (in user's local zone)
    time:        start.time,      // HH:MM (in user's local zone) or null for all-day
    endDateISO:  end ? end.iso : null,
    endTime:     end ? end.time : null,
    allDay:      ev.DTSTART_VALUE === 'DATE',
    rrule:       ev.RRULE || null,
    exdateList:  Array.from(exdateSet), // array so JSON in localStorage round-trips
  };
}

// Parse iCal date/datetime formats:
//   20260420           → date-only (all-day)
//   20260420T143000Z   → UTC datetime
//   20260420T143000    → floating/local datetime (or TZID-specified if tzid provided)
function parseICSDate(raw, isDateOnly, tzid){
  if(!raw) return null;
  // Strip non-alnum except T
  const clean = raw.replace(/[^\dTZ]/g, '');
  if(clean.length < 8) return null;
  const Y = clean.slice(0, 4);
  const M = clean.slice(4, 6);
  const D = clean.slice(6, 8);
  const iso = `${Y}-${M}-${D}`;
  if(isDateOnly || clean.length === 8){
    return { iso, time: null };
  }
  if(clean[8] !== 'T' || clean.length < 15) return { iso, time: null };
  const hh = clean.slice(9, 11);
  const mm = clean.slice(11, 13);
  const isUTC = clean.endsWith('Z');

  // Convert to user's local timezone if input is UTC or TZID-specified
  if(isUTC){
    const d = new Date(Date.UTC(+Y, +M-1, +D, +hh, +mm));
    return toLocalIsoTime(d);
  }
  if(tzid){
    // Works for IANA zone names (America/New_York, Europe/London, etc.)
    try {
      const wallUTC = Date.UTC(+Y, +M-1, +D, +hh, +mm);
      // Pass 1: the offset assuming the wall time is UTC.
      const off1 = getTzOffsetMinutes(tzid, +Y, +M, +D, +hh, +mm);
      // Pass 2: re-evaluate the offset at the CANDIDATE instant. Near a DST
      // transition the offset at the wall-as-UTC guess differs from the offset
      // at the real instant by an hour, which shifts the result to the wrong
      // side of the boundary. Correcting once converges everywhere except the
      // (nonexistent) spring-forward gap.
      const off2 = _tzOffsetAtInstantMin(tzid, wallUTC - off1 * 60000);
      const d = new Date(wallUTC - off2 * 60000);
      return toLocalIsoTime(d);
    } catch(e) {
      // TZID unrecognised — record once per (feed, tzid) so the renderer can
      // flag events that silently fell back to floating-local time (#21 in
      // UX audit). Without this, events show at the wrong hour with no clue.
      try {
        const w = (window._calfeedsTzWarnings = window._calfeedsTzWarnings || new Map());
        if(!w.has(tzid)){
          w.set(tzid, true);
          console.warn('[calfeeds] Unknown TZID, falling back to floating time:', tzid);
        }
      } catch(_){}
    }
  }
  // Floating time (no Z, no TZID) — treat as if already local
  return { iso, time: `${hh}:${mm}` };
}

// Helper: given a Date object, format as {iso: 'YYYY-MM-DD', time: 'HH:MM'} in local zone
function toLocalIsoTime(d){
  const localY = d.getFullYear();
  const localM = String(d.getMonth()+1).padStart(2,'0');
  const localD = String(d.getDate()).padStart(2,'0');
  const localH = String(d.getHours()).padStart(2,'0');
  const localMin = String(d.getMinutes()).padStart(2,'0');
  return { iso: `${localY}-${localM}-${localD}`, time: `${localH}:${localMin}` };
}

// Helper: figure out what UTC offset an IANA timezone has at a given wall-clock moment.
// Returns minutes east of UTC. Uses Intl.DateTimeFormat trick — works in all modern browsers.
function getTzOffsetMinutes(tzid, Y, M, D, hh, mm){
  // Build a Date pretending the wall time is UTC, then format it in the target zone
  // and see how much it shifts.
  const asUTC = new Date(Date.UTC(Y, M-1, D, hh, mm));
  // Format target zone's wall clock for this instant
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tzid, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hour12:false,
  });
  const parts = {};
  fmt.formatToParts(asUTC).forEach(p => { parts[p.type] = p.value; });
  const targetY  = +parts.year;
  const targetM  = +parts.month;
  const targetD  = +parts.day;
  const targetH  = +parts.hour === 24 ? 0 : +parts.hour;
  const targetMi = +parts.minute;
  const targetUTC = Date.UTC(targetY, targetM-1, targetD, targetH, targetMi);
  return (targetUTC - asUTC.getTime()) / 60000;
}

// Minutes east of UTC that `tzid` is offset at a specific ABSOLUTE instant
// (unlike getTzOffsetMinutes, which takes a wall-clock time treated as UTC).
// Used for the second pass of the DST-aware conversion in parseICSDate.
function _tzOffsetAtInstantMin(tzid, instantMs){
  const dt = new Date(instantMs);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tzid, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false,
  });
  const parts = {};
  fmt.formatToParts(dt).forEach(p => { parts[p.type] = p.value; });
  const h = +parts.hour === 24 ? 0 : +parts.hour;
  const asIfUTC = Date.UTC(+parts.year, +parts.month-1, +parts.day, h, +parts.minute, +parts.second || 0);
  return Math.round((asIfUTC - instantMs) / 60000);
}

// Unescape iCal text (RFC 5545 section 3.3.11)
// IMPORTANT: order matters — \\ must be processed first, otherwise "\\n"
// (literal backslash followed by n) would be misread as newline.
/** EXDATE can be 20240420,20240421Z or 2024-04-20 — normalize to YYYY-MM-DD in local parse */
function parseExdateList(raw){
  if(!raw) return new Set();
  const out = new Set();
  for(const part of String(raw).split(',')){
    const p = part.replace(/^TZID=[^:]*:/i, '').trim();
    if(!p) continue;
    const d = p.replace(/[^\d]/g, '');
    if(d.length >= 8) out.add(d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8));
  }
  return out;
}

/** Resolve EXDATE specs (each carrying its own TZID/VALUE) to a Set of LOCAL
 *  YYYY-MM-DD dates, using the same conversion as occurrence dates so timezone'd
 *  exclusions line up with the instances they cancel. */
function _exdateSetFromSpecs(specs){
  const out = new Set();
  for(const s of specs){
    if(!s || !s.v) continue;
    const digits = String(s.v).replace(/[^\dTZ]/g, '');
    const isDateOnly = s.valueType === 'DATE' || digits.length === 8;
    const parsed = parseICSDate(s.v, isDateOnly, s.tzid);
    if(parsed && parsed.iso) out.add(parsed.iso);
  }
  return out;
}

function unescapeICS(s){
  if(!s) return '';
  // Use a placeholder to avoid double-processing
  const PH = '\u0000UESC_BS\u0000';
  return String(s)
    .replace(/\\\\/g, PH)      // Escaped backslash → placeholder
    .replace(/\\n/g, '\n')     // Literal newline
    .replace(/\\N/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(new RegExp(PH, 'g'), '\\'); // Placeholder → actual backslash
}

// ── Expand RRULE (minimal — handles DAILY/WEEKLY/MONTHLY/YEARLY) ──
// Supports: FREQ, INTERVAL, COUNT, UNTIL, BYDAY (weekly only, most common)
// Skipped: BYMONTHDAY, BYMONTH, BYSETPOS (less common; EXDATE is handled)
// Expands only within ±windowDays around today so caches stay small.
function expandEventToDateRange(event, windowDays = 180){
  const today = new Date();
  const past = new Date(today); past.setDate(past.getDate() - windowDays);
  const future = new Date(today); future.setDate(today.getDate() + windowDays);

  if(!event.rrule){
    return [event];
  }

  const params = {};
  event.rrule.split(';').forEach(p => {
    const [k, v] = p.split('=');
    if(k && v) params[k] = v;
  });
  const freq = params.FREQ;
  if(!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)){
    return [event];
  }

  const interval = parseInt(params.INTERVAL || '1', 10);
  const until = params.UNTIL ? parseICSDate(params.UNTIL, false) : null;
  const countSpecified = params.COUNT !== undefined && String(params.COUNT).length > 0;
  const countParsed = countSpecified ? parseInt(params.COUNT, 10) : null;
  if(countSpecified && (!Number.isFinite(countParsed) || countParsed <= 0)){
    return [];
  }
  const count = countParsed;
  const countActive = countSpecified && Number.isFinite(count) && count > 0;
  // BYDAY — e.g. "MO,WE,FR" — for weekly events that fire on multiple days per week
  const BY_DAY_MAP = { SU:0, MO:1, TU:2, WE:3, TH:4, FR:5, SA:6 };
  const byDays = params.BYDAY
    ? params.BYDAY.split(',').map(d => BY_DAY_MAP[d.replace(/^[+-]?\d+/,'')]).filter(v => v != null).sort((a, b) => a - b)
    : null;

  const baseDate = new Date(event.dateISO + 'T12:00:00');
  const results = [];
  let current = new Date(baseDate);
  let iterations = 0;
  const maxIter = 2000;

  // Each emitted occurrence is a CONCRETE instance: it must carry its own
  // start/end dates and must NOT keep the rrule (otherwise _alldayRangeCovers
  // bails and a recurring multi-day all-day event only shows on its start day,
  // and timed occurrences inherit the first instance's stale end date). Shift
  // endDateISO by the original start→end span so every occurrence spans the same
  // number of days.
  let _spanDays = 0;
  if(event.endDateISO){
    const s0 = new Date(event.dateISO + 'T00:00:00').getTime();
    const e0 = new Date(event.endDateISO + 'T00:00:00').getTime();
    if(Number.isFinite(s0) && Number.isFinite(e0) && e0 > s0) _spanDays = Math.round((e0 - s0) / 86400000);
  }
  const _occ = iso => {
    const o = { ...event, dateISO: iso, rrule: null };
    if(event.endDateISO){
      const d = new Date(iso + 'T00:00:00');
      d.setDate(d.getDate() + _spanDays);
      o.endDateISO = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    }
    return o;
  };

  while(iterations < maxIter && current <= future){
    // For WEEKLY with BYDAY: expand each week cycle to all specified weekdays
    if(freq === 'WEEKLY' && byDays && byDays.length){
      // Find start of this week's cycle (Sunday)
      const weekStart = new Date(current);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      for(const dayOfWeek of byDays){
        const occ = new Date(weekStart);
        occ.setDate(weekStart.getDate() + dayOfWeek);
        if(occ < past || occ > future) continue;
        if(occ < baseDate) continue; // don't emit before the original DTSTART
        const iso = occ.getFullYear() + '-' +
                    String(occ.getMonth()+1).padStart(2,'0') + '-' +
                    String(occ.getDate()).padStart(2,'0');
        if(until && iso > until.iso) continue;
        if(event.exdateList && event.exdateList.includes && event.exdateList.includes(iso)) continue;
        results.push(_occ(iso));
        if(countActive && results.length >= count) break;
      }
      if(countActive && results.length >= count) break;
      current.setDate(current.getDate() + 7 * interval);
    } else {
      // Standard path — one occurrence per interval
      if(current >= past){
        const iso = current.getFullYear() + '-' +
                    String(current.getMonth()+1).padStart(2,'0') + '-' +
                    String(current.getDate()).padStart(2,'0');
        if(until && iso > until.iso) break;
        if(event.exdateList && event.exdateList.includes && event.exdateList.includes(iso)) { /* skip */ }
        else { results.push(_occ(iso)); }
        if(countActive && results.length >= count) break;
      }
      if(freq === 'DAILY')        current.setDate(current.getDate() + interval);
      else if(freq === 'WEEKLY')  current.setDate(current.getDate() + 7 * interval);
      else if(freq === 'MONTHLY') current.setMonth(current.getMonth() + interval);
      else if(freq === 'YEARLY')  current.setFullYear(current.getFullYear() + interval);
    }
    iterations++;
  }
  // De-duplicate in case BYDAY + original DTSTART produced the same date
  const seen = new Set();
  return results.filter(r => {
    if(seen.has(r.dateISO)) return false;
    seen.add(r.dateISO);
    return true;
  });
}

const CAL_FETCH_MAX_BYTES = 2_000_000;
const CAL_FETCH_TIMEOUT_MS = 25000;

// Parse the "loose" IPv4 forms that inet_aton / browsers accept but a naive
// string check misses: a single decimal (2130706433), hex (0x7f000001), octal
// (017700000001), or dotted with fewer than four octal/hex/decimal parts
// (127.1). Returns the 32-bit address, or null when `host` is not such a form.
function _calParseIpv4Loose(host){
  if(typeof host !== 'string' || !/^[0-9a-fx.]+$/i.test(host)) return null;
  const parts = host.split('.');
  if(parts.length === 0 || parts.length > 4) return null;
  const nums = [];
  for(const p of parts){
    if(p === '') return null;
    let n;
    if(/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p, 16);
    else if(/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if(/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return null;
    if(!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  // inet_aton semantics: the final part fills the remaining low-order bytes.
  let ip;
  switch(nums.length){
    case 1: ip = nums[0]; break;
    case 2: if(nums[0] > 0xff || nums[1] > 0xffffff) return null; ip = (nums[0] * 0x1000000) + nums[1]; break;
    case 3: if(nums[0] > 0xff || nums[1] > 0xff || nums[2] > 0xffff) return null; ip = (nums[0] * 0x1000000) + (nums[1] * 0x10000) + nums[2]; break;
    default: if(nums.some(x => x > 0xff)) return null; ip = (nums[0] * 0x1000000) + (nums[1] * 0x10000) + (nums[2] * 0x100) + nums[3];
  }
  if(ip < 0 || ip > 0xffffffff) return null;
  return ip >>> 0;
}

// True for loopback / private / link-local / unspecified IPv4 (matches the
// literal-string ranges blocked below, but applied to a parsed address so the
// numeric/hex/octal/short obfuscations are caught too).
function _calIpv4IsPrivate(ip){
  const a = (ip >>> 24) & 0xff, b = (ip >>> 16) & 0xff;
  if(a === 127 || a === 10 || a === 0) return true;            // loopback, 10/8, 0/8
  if(a === 192 && b === 168) return true;                      // 192.168/16
  if(a === 169 && b === 254) return true;                      // link-local + cloud metadata
  if(a === 172 && b >= 16 && b <= 31) return true;             // 172.16/12
  return false;
}

function _calFetchUrlOk(urlStr){
  let u;
  try{ u = new URL(urlStr, window.location.href); }
  catch(e){ return false; }
  if(u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if(location.protocol === 'https:' && u.protocol === 'http:') return false;
  // Defense-in-depth: block loopback / private / link-local / unique-local.
  // Covers 127/8 (loopback), 10/8, 172.16/12, 192.168/16 (RFC1918),
  // 169.254/16 (link-local — includes AWS metadata 169.254.169.254),
  // 0.0.0.0, IPv6 ::1, fe80::/10 (link-local), fc00::/7 (unique-local).
  let h = u.hostname.toLowerCase();
  // Strip IPv6 brackets if present
  if(h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if(h === 'localhost' || h === '0.0.0.0' || h === '::' || h === '::1') return false;
  // Numeric/hex/octal/short IPv4 obfuscations (e.g. http://2130706433/,
  // http://0x7f000001/, http://127.1/) — parse to a real address and block if
  // it lands in a private range. Without this the string checks below miss them.
  const _ip = _calParseIpv4Loose(h);
  if(_ip != null && _calIpv4IsPrivate(_ip)) return false;
  // Well-known DNS-rebind helpers that resolve arbitrary names to loopback /
  // private addresses without exposing an IP literal in the hostname.
  if(/(^|\.)(nip\.io|xip\.io|sslip\.io|localtest\.me|lvh\.me|vcap\.me|localho\.st)$/i.test(h)) return false;
  if(h.startsWith('127.') ||
     h.startsWith('10.') ||
     h.startsWith('192.168.') ||
     h.startsWith('169.254.') ||
     /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  // IPv6 link-local fe80::/10 and unique-local fc00::/7. Also IPv4-mapped
  // forms ::ffff:127.0.0.1 / ::ffff:7f00:1.
  if(/^fe[89ab][0-9a-f]?:/.test(h)) return false;
  if(/^f[cd][0-9a-f]{2}:/.test(h)) return false;
  if(/^::ffff:(7f|0a|c0a8|a9fe|ac1[0-9a-f])/.test(h)) return false;
  if(/^::ffff:127\./.test(h) || /^::ffff:10\./.test(h) ||
     /^::ffff:192\.168\./.test(h) || /^::ffff:169\.254\./.test(h) ||
     /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  return true;
}

// ── Fetch: try direct, fall back to proxy if configured ────────────────────
// In-flight controllers keyed by feed.id so removeCalFeed can abort a sync
// that's still pending. Otherwise the fetch outlives the feed object and
// writes results into a stale closure (or silently completes for nothing).
const _calFeedControllers = new Map();

async function fetchICSContent(feed){
  if(feed.content){ return feed.content; }      // paste mode — already have it
  if(!feed.url) throw new Error('No URL or pasted content for feed');

  let fetchUrl = feed.url;
  const proxy = feed.proxy || localStorage.getItem(CALFEEDS_PROXY) || '';
  if(proxy){
    // Append url param — supports corsproxy.io style and Worker style
    fetchUrl = proxy.endsWith('=') || proxy.endsWith('?')
      ? proxy + encodeURIComponent(feed.url)
      : proxy + (proxy.includes('?') ? '&' : '?') + 'url=' + encodeURIComponent(feed.url);
  }

  if(!_calFetchUrlOk(fetchUrl)) throw new Error('Calendar URL must be http(s)');

  const ac = new AbortController();
  if(feed && feed.id) _calFeedControllers.set(feed.id, ac);
  const to = setTimeout(() => ac.abort(), CAL_FETCH_TIMEOUT_MS);
  let res;
  try{
    res = await fetch(fetchUrl, { cache: 'no-cache', signal: ac.signal });
  }finally{
    clearTimeout(to);
    if(feed && feed.id && _calFeedControllers.get(feed.id) === ac) _calFeedControllers.delete(feed.id);
  }
  if(!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if(text.length > CAL_FETCH_MAX_BYTES) throw new Error('Calendar response too large');
  // Detect proxies that returned 200 OK with a non-ICS body (e.g. an auth /
  // login HTML page). Without this, parseICS happily produces 0 events and
  // the user sees "Last synced · 0 events" with no error, looking like an
  // empty calendar instead of a misconfigured proxy.
  const sample = text.slice(0, 2048).toUpperCase();
  if(!sample.includes('BEGIN:VCALENDAR')){
    if(/^\s*</.test(text) || sample.includes('<HTML') || sample.includes('<!DOCTYPE')){
      throw new Error('Proxy returned HTML, not an iCalendar feed — check the proxy or feed URL');
    }
    throw new Error('Response is not an iCalendar feed (missing BEGIN:VCALENDAR)');
  }
  return text;
}

// ── Sync a single feed: fetch + parse + store ──────────────────────────────
async function syncCalFeed(feedId){
  _loadCalFeeds();
  const feed = _calFeeds.feeds.find(f => f.id === feedId);
  if(!feed) throw new Error('Feed not found');

  try {
    const content = await fetchICSContent(feed);
    const events = parseICS(content);
    // Expand recurring events within window
    const expanded = [];
    events.forEach(e => {
      expandEventToDateRange(e, 180).forEach(occ => expanded.push(occ));
    });
    feed.events = expanded;
    feed.lastSync = Date.now();
    feed.error = null;
    _saveCalFeeds();
    return { count: expanded.length };
  } catch(err) {
    // If the feed was removed mid-sync (AbortError from removeCalFeed) the
    // feed object is now an orphan; skip writing error state to it.
    const stillPresent = _calFeeds.feeds.some(f => f.id === feedId);
    if(stillPresent){
      feed.error = String(err.message || err).slice(0, 120);
      feed.lastSync = Date.now();
      _saveCalFeeds();
    }
    throw err;
  }
}

// Sync all feeds in parallel, don't let one failure block others
async function syncAllCalFeeds(){
  _loadCalFeeds();
  const results = await Promise.allSettled(
    _calFeeds.feeds.map(f => syncCalFeed(f.id))
  );
  return results;
}

// ── CRUD: add/remove/update feeds ──────────────────────────────────────────
function addCalFeed({label, url, proxy, content, color}){
  _loadCalFeeds();
  const id = 'cf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const feed = {
    id, label: label || 'Calendar',
    color: color || '#1a8cff',
    url: url || null,
    proxy: proxy || null,
    content: content || null,
    events: [],
    lastSync: null,
    visible: true,
    error: null,
  };
  _calFeeds.feeds.push(feed);
  _saveCalFeeds();
  return feed;
}

function removeCalFeed(feedId){
  _loadCalFeeds();
  // Abort any in-flight fetch for this feed so it can't write back to a
  // deleted entry or hold a connection open after removal.
  const ac = _calFeedControllers.get(feedId);
  if(ac){
    try { ac.abort(); } catch(_) {}
    _calFeedControllers.delete(feedId);
  }
  _calFeeds.feeds = _calFeeds.feeds.filter(f => f.id !== feedId);
  _saveCalFeeds();
}

function toggleCalFeedVisibility(feedId){
  _loadCalFeeds();
  const f = _calFeeds.feeds.find(x => x.id === feedId);
  if(f){ f.visible = !f.visible; _saveCalFeeds(); }
}

// ── Query: get events for a specific date (used by calendar view) ──────────
function _alldayRangeCovers(ev, isoDate){
  if(!ev || !ev.allDay || !ev.endDateISO || ev.rrule) return false;
  try{
    const t = new Date(isoDate + 'T12:00:00').getTime();
    const s = new Date(ev.dateISO + 'T00:00:00').getTime();
    const e = new Date(ev.endDateISO + 'T00:00:00').getTime();
    // iCalendar: DTEND;VALUE=DATE is exclusive
    return t >= s && t < e;
  }catch(e){ return false; }
}

// Return all feeds whose last sync attempt errored. Used by the calendar
// view to surface "events may be stale" inline instead of leaving the user
// with cached data and a silent failure in the settings panel.
function getFailedCalFeeds(){
  _loadCalFeeds();
  return (_calFeeds.feeds || []).filter(f => f && f.error);
}
// Retry every failed feed in parallel. Triggered from the calendar's inline
// "Retry sync" button. Refreshes the calendar render via renderTaskList()
// so the alert vanishes once a feed recovers.
async function retryFailedCalFeeds(){
  _loadCalFeeds();
  const failed = (_calFeeds.feeds || []).filter(f => f && f.error);
  if(!failed.length) return;
  await Promise.all(failed.map(f => syncCalFeed(f.id).catch(()=>{})));
  if(typeof renderTaskList === 'function') renderTaskList();
  if(typeof renderCalFeedsPanel === 'function') renderCalFeedsPanel();
}
if(typeof window !== 'undefined'){
  window.getFailedCalFeeds = getFailedCalFeeds;
  window.retryFailedCalFeeds = retryFailedCalFeeds;
}

// Collapse identical occurrences that entered the merged set from more than one
// source: the same calendar subscribed as two feeds, an event living on two of
// your calendars, or a Google recurring master colliding with a RECURRENCE-ID
// override in the same slot. Two rows sharing UID + date + time are never
// intentional, so keep the first and drop the rest. Distinct UIDs (or distinct
// times) are preserved, so genuinely different events both still show. Falls
// back to title when a feed omits UID.
function _dedupCalEvents(list){
  if(!Array.isArray(list) || list.length < 2) return list;
  const seen = new Set();
  const out = [];
  for(const ev of list){
    const date = ev.dateISO || '';
    const time = ev.time || '';
    const key = ev.uid
      ? 'u:' + ev.uid + '|' + date + '|' + time
      : 'n:' + String(ev.title || '').trim().toLowerCase() + '|' + date + '|' + time;
    if(seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }
  return out;
}

function getCalFeedEventsForDate(isoDate){
  _loadCalFeeds();
  const out = [];
  _calFeeds.feeds.forEach(feed => {
    if(!feed.visible) return;
    (feed.events || []).forEach(ev => {
      if(ev.exdateList && ev.exdateList.includes && ev.exdateList.includes(isoDate)) return;
      if(ev.dateISO === isoDate || _alldayRangeCovers(ev, isoDate)){
        out.push({ ...ev, feedId: feed.id, feedLabel: feed.label, feedColor: feed.color });
      }
    });
  });
  return _dedupCalEvents(out);
}

// Get all visible feed events (for list view / search)
function getAllCalFeedEvents(){
  _loadCalFeeds();
  const out = [];
  _calFeeds.feeds.forEach(feed => {
    if(!feed.visible) return;
    (feed.events || []).forEach(ev => {
      out.push({ ...ev, feedId: feed.id, feedLabel: feed.label, feedColor: feed.color });
    });
  });
  return _dedupCalEvents(out);
}

function _calEventStartMs(ev){
  try{
    if(!ev || !ev.dateISO) return 0;
    if(ev.allDay) return new Date(ev.dateISO + 'T12:00:00').getTime();
    const tm = (ev.time && String(ev.time).length >= 4) ? String(ev.time).slice(0, 5) : '09:00';
    return new Date(ev.dateISO + 'T' + tm + ':00').getTime();
  }catch(e){ return 0; }
}

function _calEventEndMs(ev){
  const s = _calEventStartMs(ev);
  if(!s) return 0;
  if(ev && ev.endDateISO && ev.endTime){
    try{
      const t = String(ev.endTime).slice(0, 5);
      return new Date(ev.endDateISO + 'T' + t + ':00').getTime();
    }catch(e){}
  }
  if(ev && ev.endTime && ev.dateISO){
    try{
      return new Date(ev.dateISO + 'T' + String(ev.endTime).slice(0, 5) + ':00').getTime();
    }catch(e){}
  }
  return s + 30 * 60 * 1000;
}

/**
 * Upcoming events across visible feeds, sorted by start, within a rolling window of days.
 * @param {number} [windowDays=7]
 * @param {number} [max=200]
 * @param {{ strictFuture?: boolean }} [opts] - If omitted, strictFuture defaults to true (timed events that already started today are excluded). Pass `{ strictFuture: false }` for full-day / historical context.
 * @returns {Array<object & {_startMs:number,_endMs:number}>}
 */
function getUpcomingEvents(windowDays, max, opts){
  const o = opts || {};
  const strictFuture = o.strictFuture !== false;
  const wd = windowDays == null ? 7 : +windowDays;
  const lim = max == null ? 200 : +max;
  const todayK = (typeof todayKey === 'function') ? todayKey() : new Date().toISOString().slice(0, 10);
  const t0 = new Date(todayK + 'T00:00:00');
  const t1 = new Date(t0);
  t1.setDate(t1.getDate() + Math.max(1, wd));
  const t1ms = t1.getTime();
  const all = getAllCalFeedEvents();
  const out = [];
  const now = Date.now();
  for(const ev of all){
    if(!ev.dateISO) continue;
    const d = new Date(ev.dateISO + 'T00:00:00');
    if(d.getTime() < t0.getTime() - 86400000 || d.getTime() > t1ms) continue;
    const _startMs = _calEventStartMs(ev);
    const _endMs = _calEventEndMs(ev);
    out.push({ ...ev, _startMs, _endMs });
  }
  out.sort((a, b) => a._startMs - b._startMs);
  let sliced = out.slice(0, lim);
  if(strictFuture){
    sliced = sliced.filter(ev => {
      if(!ev || ev.allDay) return true;
      const s = ev._startMs;
      return typeof s === 'number' && Number.isFinite(s) && s >= now;
    });
  }
  return sliced;
}

/**
 * One-line hint when a focus block would overlap a calendar event (What-next).
 * @param {{ timeMin?: number }} [opts]
 * @returns {string}
 */
function getWhatNextCalConflictHint(opts){
  const o = opts || {};
  if(typeof getUpcomingEvents !== 'function') return '';
  const workMin = o.timeMin > 0 ? o.timeMin : 25;
  const workMs = workMin * 60 * 1000;
  const now = Date.now();
  const evs = getUpcomingEvents(2, 48);
  for(const ev of evs){
    if(!ev || ev.allDay) continue;
    const s = ev._startMs, e2 = ev._endMs;
    if(!s) continue;
    if(s < now + workMs && e2 > now){
      const t = (ev.time || '').toString() || '—';
      return `${ev.title || 'Event'} (${t}) overlaps a ${workMin}m focus block — start after, or a shorter time budget.`;
    }
  }
  return '';
}

/**
 * Create a local task from a synced VEVENT — no save/render/modal (for batch apply).
 * @param {string} feedId
 * @param {string} eventUid
 * @returns {number|undefined} new task id
 */
function createTaskFromCalEventCore(feedId, eventUid, eventDate){
  _loadCalFeeds();
  const feed = _calFeeds.feeds.find(f => f.id === feedId);
  if(!feed) return;
  const events = feed.events || [];
  const wantDate = eventDate ? String(eventDate) : null;
  // A recurring event expands into many rows sharing ONE uid, so a uid-only
  // match always returned the FIRST (often long-past) occurrence and the task
  // got the wrong due date. Prefer an exact uid+date match for the clicked
  // occurrence; fall back to uid-only for non-recurring events or callers that
  // don't pass a date.
  const ev = (wantDate && events.find(e => (e.uid || '') === (eventUid || '') && (e.dateISO || '') === wantDate))
    || events.find(e => (e.uid || '') === (eventUid || ''));
  if(!ev) return;
  if(typeof taskIdCtr === 'undefined' || !Array.isArray(tasks) || typeof defaultTaskProps !== 'function') return;
  const fid = String(feedId), uid = String(eventUid || ''), occDate = String(ev.dateISO || '');
  for(const x of tasks){
    const ex = x && x._ext;
    // Dedup per OCCURRENCE so each instance of a recurring event can become its
    // own task. A legacy task without calEventDate matches any date (preserves
    // the old single-task-per-event dedup rather than spawning a duplicate).
    if(ex && String(ex.calFeedId) === fid && String(ex.calEventUid) === uid
        && (ex.calEventDate == null || String(ex.calEventDate) === occDate)) return x.id;
  }
  const descParts = [];
  if(ev.description) descParts.push(String(ev.description));
  if(ev.location) descParts.push('Location: ' + String(ev.location));
  const t = Object.assign({
    id: ++taskIdCtr,
    name: (ev.title || 'Calendar event').slice(0, 500),
    totalSec: 0,
    sessions: 0,
    created: (typeof timeNowFull === 'function' ? timeNowFull() : ''),
    parentId: null,
    collapsed: false,
  }, defaultTaskProps(), {
    dueDate: ev.dateISO || null,
    startDate: null,
    description: descParts.join('\n\n').slice(0, 8000),
    tags: ['calendar', 'feed'],
  });
  if(Array.isArray(t.tags) && feed.label){
    t.tags[1] = String(feed.label).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 32) || 'feed';
  }
  t._ext = Object.assign({}, t._ext || {}, { calFeedId: fid, calEventUid: uid, calEventDate: occDate });
  tasks.push(t);
  if(typeof _taskIndexRegister === 'function') _taskIndexRegister(t);
  return t.id;
}

/**
 * Create a local task from a synced VEVENT (calendar panel) — includes save, list render, and detail open.
 * @param {string} feedId
 * @param {string} eventUid
 */
function createTaskFromCalEvent(feedId, eventUid, eventDate){
  const id = createTaskFromCalEventCore(feedId, eventUid, eventDate);
  if(id == null) return;
  if(typeof saveState === 'function') saveState('user');
  if(typeof renderTaskList === 'function') renderTaskList();
  if(typeof openTaskDetail === 'function') openTaskDetail(id);
  return id;
}

// ── UI: render the Settings panel section for managing feeds ───────────────
function renderCalFeedsPanel(){
  const panel = document.getElementById('calFeedsPanel');
  if(!panel) return;
  _loadCalFeeds();
  const proxyDefault = localStorage.getItem(CALFEEDS_PROXY) || '';

  const feedRows = _calFeeds.feeds.length
    ? _calFeeds.feeds.map(f => {
        const evCount = (f.events || []).length;
        const lastSync = f.lastSync
          ? new Date(f.lastSync).toLocaleString(undefined, {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})
          : 'Never';
        const status = f.error
          ? `<span class="calfeed-status calfeed-status--error">✕ ${esc(f.error)}</span>`
          : f.visible
            ? `<span class="calfeed-status calfeed-status--ok">✓ ${evCount} events · ${lastSync}</span>`
            : `<span class="calfeed-status calfeed-status--warn">◎ synced (${evCount} events) · <strong>hidden</strong> — tap 👁 to show on calendar</span>`;
        return `
          <div class="calfeed-row" data-id="${escAttr(f.id)}">
            <span class="calfeed-dot"></span>
            <div class="calfeed-info">
              <div class="calfeed-label">${esc(f.label)}</div>
              ${status}
            </div>
            <button type="button" class="calfeed-btn calfeed-toggle" aria-label="${f.visible?'Hide calendar':'Show calendar'}" title="${f.visible?'Hide':'Show'}">${f.visible?'👁':'◎'}</button>
            <button type="button" class="calfeed-btn calfeed-refresh" aria-label="Refresh calendar now" title="Refresh now">↻</button>
            <button type="button" class="calfeed-btn calfeed-rm" aria-label="Remove calendar" title="Remove">×</button>
          </div>`;
      }).join('')
    : '<div class="calfeed-empty">No calendars added yet</div>';

  panel.innerHTML = `
    <div class="calfeeds-list">${feedRows}</div>

    <details class="calfeed-add-wrap">
      <summary class="calfeed-add-toggle">+ Add Calendar Feed</summary>
      <div class="calfeed-add-body">
        <label class="calfeed-lbl">Label</label>
        <input type="text" id="cfLabel" class="calfeed-in" placeholder="e.g. Work, Personal">

        <label class="calfeed-lbl">Color</label>
        <input type="color" id="cfColor" class="calfeed-color" value="#1a8cff">

        <div class="calfeed-mode-tabs">
          <button class="calfeed-mode active" data-mode="paste" data-action="calFeedModeFromButton">Paste .ics</button>
          <button class="calfeed-mode" data-mode="url" data-action="calFeedModeFromButton">URL + Proxy</button>
        </div>

        <div id="cfPasteMode" class="calfeed-mode-panel">
          <label class="calfeed-lbl">Paste the entire .ics file contents</label>
          <textarea id="cfPasteContent" class="calfeed-ta" rows="6" placeholder="BEGIN:VCALENDAR..."></textarea>
          <p class="calfeed-hint">Most private option. Download the .ics file from Google Calendar (Settings → your calendar → Export calendar), unzip, open in text editor, paste contents.</p>
        </div>

        <div id="cfUrlMode" class="calfeed-mode-panel" hidden>
          <label class="calfeed-lbl">Secret iCal URL</label>
          <input type="url" id="cfUrl" class="calfeed-in" placeholder="https://calendar.google.com/calendar/ical/.../private-.../basic.ics">
          <p class="calfeed-hint">Google Calendar: ⚙ <strong>Settings</strong> → click your calendar in the left list → <strong>Integrate calendar</strong> → copy <strong>Secret address in iCal format</strong>. Treat it like a password — anyone with it can read your calendar.</p>

          <label class="calfeed-lbl">CORS proxy URL (required for direct fetch)</label>
          <input type="url" id="cfProxy" class="calfeed-in" value="${esc(proxyDefault)}" placeholder="https://your-name.workers.dev/?url=">
          <p class="calfeed-hint">
            Browsers block direct fetches from Google. Options:<br>
            • <strong>Most private:</strong> <a href="#" data-action="showWorkerInstructions" data-prevent-default="1">Deploy a free Cloudflare Worker (15 min)</a><br>
            • <strong>Convenient:</strong> Use a public proxy like <code>https://corsproxy.io/?url=</code> — the operator CAN see your URL<br>
            • <strong>Paste mode</strong> (left tab) has no proxy at all
          </p>
        </div>

        <button class="btn-primary calfeed-submit" data-action="submitAddCalFeed">Add Calendar</button>
      </div>
    </details>

    <div class="calfeed-sync-row">
      <button class="btn-ghost btn-sm" data-action="syncAllCalFeedsAndRerender" ${_calFeeds.feeds.length?'':'disabled'}>↻ Refresh all</button>
      <span class="calfeed-hint">Auto-refresh runs on app open. Events cache locally for offline use.</span>
    </div>

    <div id="workerInstructions" class="calfeed-worker-panel" hidden>
      <button class="btn-ghost btn-sm calfeed-worker-close" data-action="hideWorkerInstructions" aria-label="Close instructions" title="Close">×</button>
      <h4 class="mt-0">Deploy a personal CORS proxy (free, 15 min)</h4>
      <ol class="calfeed-worker-list">
        <li>Sign up at <a href="https://dash.cloudflare.com" target="_blank" rel="noopener noreferrer">dash.cloudflare.com</a> (free)</li>
        <li>Go to <strong>Workers & Pages</strong> → <strong>Create</strong> → <strong>Create Worker</strong></li>
        <li>Name it (e.g. "ical-proxy"), click <strong>Deploy</strong></li>
        <li>Click <strong>Edit code</strong>, replace the default with this:</li>
      </ol>
      <pre class="calfeed-code">export default {
  async fetch(req) {
    const url = new URL(req.url).searchParams.get('url');
    if (!url) return new Response('Missing ?url param', {status: 400});
    if (!url.startsWith('https://calendar.google.com/')) {
      return new Response('Only calendar.google.com allowed', {status: 403});
    }
    const r = await fetch(url);
    return new Response(await r.text(), {
      status: r.status,
      headers: {
        'content-type': 'text/calendar',
        'access-control-allow-origin': '*',
        'cache-control': 'no-cache',
      },
    });
  },
};</pre>
      <ol start="5" class="calfeed-worker-list">
        <li>Click <strong>Save and deploy</strong></li>
        <li>Copy your Worker URL (looks like <code>ical-proxy.your-name.workers.dev</code>)</li>
        <li>In Odta, paste it in the "CORS proxy URL" field above, appending <code>?url=</code></li>
      </ol>
      <p class="calfeed-worker-note"><strong>Privacy note:</strong> This Worker only forwards requests to <code>calendar.google.com</code>. You're the only one using it. Cloudflare's free tier gives 100k requests/day, more than enough for personal use.</p>
      <p class="calfeed-worker-note"><strong>Troubleshooting — feed shows <code>✕ HTTP 404</code>:</strong> your secret address was reset. Google invalidates the old <code>private-…</code> token whenever you regenerate it, so the saved URL goes dead. Grab a fresh <strong>Secret address in iCal format</strong> (Settings → Integrate calendar) and re-add the feed. The proxy URL stays the same.</p>
    </div>
  `;
  // Wire per-row buttons via delegated listeners. The row's data-id carries
  // the trusted feed id without needing to embed it in an inline JS handler
  // (which would pull untrusted strings into a JS-string parser context).
  panel.querySelectorAll('.calfeed-row').forEach(row => {
    const id = row.dataset.id;
    if(!id) return;
    const tog = row.querySelector('.calfeed-toggle');
    if(tog) tog.addEventListener('click', () => {
      toggleCalFeedVisibility(id);
      renderCalFeedsPanel();
      if(typeof renderTaskList === 'function') renderTaskList();
    });
    const ref = row.querySelector('.calfeed-refresh');
    if(ref) ref.addEventListener('click', () => refreshCalFeed(id));
    const rm = row.querySelector('.calfeed-rm');
    if(rm) rm.addEventListener('click', () => confirmRemoveCalFeed(id));
    // Apply per-feed dot color via DOM API (allowed by CSP) since the
    // value is dynamic and can't sit in an inline style attribute.
    const dot = row.querySelector('.calfeed-dot');
    const f = _calFeeds.feeds.find(x => x.id === id);
    if(dot && f) dot.style.background = (typeof sanitizeListColor === 'function') ? sanitizeListColor(f.color) : '#888';
  });
}

function calFeedMode(btn, mode){
  document.querySelectorAll('.calfeed-mode').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('cfPasteMode').hidden = !(mode === 'paste');
  document.getElementById('cfUrlMode').hidden = !(mode === 'url');
}

function showWorkerInstructions(){
  const el = document.getElementById('workerInstructions');
  if(el) el.hidden = false;
}

// Toast wrapper — falls back to alert only when running headless (tests).
// The rest of the app uses showExportToast / showActionToast; calendar flows
// were the lone holdout on blocking native alert() (#16/#17 in UX audit).
function _cfToast(msg){
  if(typeof showExportToast === 'function'){ showExportToast(msg); return; }
  try { alert(msg); } catch(_){ /* no-op */ }
}
function _cfActionToast(msg, label, fn){
  if(typeof showActionToast === 'function'){ showActionToast(msg, label, fn, 6000); return; }
  _cfToast(msg);
}

// Form submission handler
async function submitAddCalFeed(){
  const label = document.getElementById('cfLabel').value.trim() || 'Calendar';
  const color = document.getElementById('cfColor').value || '#1a8cff';
  const pasteActive = document.querySelector('.calfeed-mode.active')?.dataset.mode === 'paste';

  let feed;
  if(pasteActive){
    const content = document.getElementById('cfPasteContent').value.trim();
    if(content.length > CAL_FETCH_MAX_BYTES){
      _cfToast('Calendar paste is too large (max ' + (CAL_FETCH_MAX_BYTES / 1_000_000) + ' MB).');
      return;
    }
    if(!content.includes('BEGIN:VCALENDAR')){
      _cfToast('That doesn\'t look like an .ics file. It should start with BEGIN:VCALENDAR.');
      return;
    }
    feed = addCalFeed({ label, color, content });
  } else {
    const url = document.getElementById('cfUrl').value.trim();
    const proxy = document.getElementById('cfProxy').value.trim();
    if(!url){ _cfToast('URL is required'); return; }
    if(!proxy){
      const cmsg = 'No proxy set — direct fetch will likely fail due to browser CORS restrictions. Continue anyway?';
      if(typeof showAppConfirm === 'function'){
        if(!(await showAppConfirm(cmsg))) return;
      }else if(!confirm(cmsg)) return;
    } else {
      // Remember proxy as default for next time
      try { localStorage.setItem(CALFEEDS_PROXY, proxy); } catch(e) {}
    }
    feed = addCalFeed({ label, color, url, proxy });
  }

  // Initial sync
  try {
    const result = await syncCalFeed(feed.id);
    renderCalFeedsPanel();
    if(typeof renderTaskList === 'function') renderTaskList();
    _cfToast(`✓ Loaded ${result.count} events from ${label}`);
  } catch(err) {
    renderCalFeedsPanel();
    _cfActionToast(`Feed "${label}" added but first sync failed: ${err.message}`, 'Retry', () => {
      refreshCalFeed(feed.id);
    });
  }
}

async function refreshCalFeed(feedId){
  try {
    const r = await syncCalFeed(feedId);
    renderCalFeedsPanel();
    if(typeof renderTaskList === 'function') renderTaskList();
  } catch(err) {
    renderCalFeedsPanel();
    _cfActionToast('Calendar sync failed: ' + err.message, 'Retry', () => {
      refreshCalFeed(feedId);
    });
  }
}

async function syncAllCalFeedsAndRerender(){
  await syncAllCalFeeds();
  renderCalFeedsPanel();
  if(typeof renderTaskList === 'function') renderTaskList();
}

async function confirmRemoveCalFeed(feedId){
  _loadCalFeeds();
  const f = _calFeeds.feeds.find(x => x.id === feedId);
  if(!f) return;
  const q = `Remove "${f.label}"? This only removes it from Odta — your actual calendar is unaffected.`;
  const ok = typeof showAppConfirm === 'function' ? await showAppConfirm(q) : confirm(q);
  if(!ok) return;
  removeCalFeed(feedId);
  renderCalFeedsPanel();
  if(typeof renderTaskList === 'function') renderTaskList();
}

// Auto-sync all feeds on app start (non-blocking, errors silent), and again
// every CAL_REFRESH_MS while the tab is open. Long-running PWA sessions used
// to show stale events all day because the only fetch path was boot-time.
const CAL_REFRESH_MS = 30 * 60 * 1000; // 30 min — balances freshness vs CORS-proxy load
let _calRefreshTimer = null;
function _hasFetchableFeeds(){
  _loadCalFeeds();
  return !!(_calFeeds && _calFeeds.feeds && _calFeeds.feeds.some(f => f && f.url));
}
async function _refreshCalFeedsTick(){
  if(!_hasFetchableFeeds()) return;
  // Skip when the tab is hidden — Page Visibility API gates the work so we
  // don't hammer CORS proxies for tabs the user isn't even looking at; a
  // visibilitychange listener below catches up the moment they return.
  if(typeof document !== 'undefined' && document.hidden) return;
  try{
    await syncAllCalFeeds();
    renderCalFeedsPanel();
    if(typeof renderTaskList === 'function') renderTaskList();
  }catch(e){ console.warn('[calfeeds] periodic refresh', e); }
}
function _ensureCalRefreshTimer(){
  if(_calRefreshTimer != null) return;
  if(!_hasFetchableFeeds()) return;
  _calRefreshTimer = setInterval(_refreshCalFeedsTick, CAL_REFRESH_MS);
}
function autoSyncCalFeedsOnBoot(){
  _loadCalFeeds();
  if(!_calFeeds.feeds.length){ _ensureCalRefreshTimer(); return; }
  const fetchable = _calFeeds.feeds.filter(f => f.url);
  if(!fetchable.length){ _ensureCalRefreshTimer(); return; }
  setTimeout(async () => {
    await syncAllCalFeeds();
    renderCalFeedsPanel();
    if(typeof renderTaskList === 'function') renderTaskList();
    _ensureCalRefreshTimer();
  }, 2000); // let the app finish rendering first
  if(typeof document !== 'undefined' && !document._calRefreshVisListener){
    document._calRefreshVisListener = true;
    document.addEventListener('visibilitychange', () => {
      // Catch up once on return from hidden so the user doesn't have to wait
      // up to CAL_REFRESH_MS after unlocking their phone or refocusing.
      if(!document.hidden) _refreshCalFeedsTick();
    });
  }
}
