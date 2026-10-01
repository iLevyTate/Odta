/**
 * Lockstep film recorder: one scripted walkthrough played on a desktop page
 * and a phone page at the same time, frame by frame, then composed on a
 * 1920x1080 canvas with the desktop in a browser window and the phone in
 * front of the window's right edge.
 *
 * Nothing is sampled in real time. Each page runs on Playwright's fake clock,
 * paused, and is moved forward one frame at a time: timers and
 * requestAnimationFrame callbacks fire when their time comes, and every CSS
 * animation and transition is paused and seeked to the frame's time before
 * the screenshot. A slow machine renders slower, never choppier, and the two
 * screens cannot drift apart because neither has a clock of its own.
 *
 * A cut supplies what is app-specific: the directory to serve, the moment the
 * film pretends it is, how to seed and settle each page, the beats, the
 * frame's colours and the end card. See promo.mjs beside this file.
 *
 * Requires Chromium (via playwright) and ffmpeg with H.264.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';

/*
 * Geometry, on a 1920x1080 canvas. Both screens are scaled by 0.9, so a CSS
 * pixel is the same size on each and the phone reads as the same page at a
 * narrower width rather than a zoomed one. The phone's bezel covers the
 * desktop page from x=1429 to its right edge at 1440, so a cut whose desktop
 * layout reaches past 1428 loses that strip behind the phone.
 */
export const WIDE = { w: 1920, h: 1080 };
export const DESKTOP = { width: 1440, height: 900 };
export const HANDSET = { width: 393, height: 852 };
const WIN = { x: 128, y: 114, w: 1296, bar: 42, r: 14 };
const VIEWPORT = { x: WIN.x, y: WIN.y + WIN.bar, w: 1296, h: 810 };
const PHONE = { x: 1426, y: 157, w: 354, h: 767, bezel: 12, r: 34 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/** Serves the app's directory, plus pages held in memory for the stills. */
function serve(root, pages) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (pages.has(path)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(pages.get(path));
      return;
    }
    let target = resolve(root, path.replace(/^\/+/, ''));
    if (target !== root && !target.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      let s = await stat(target);
      if (s.isDirectory()) {
        target = join(target, 'index.html');
        s = await stat(target);
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream' });
      createReadStream(target).pipe(res);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((res) => {
    server.listen(0, '127.0.0.1', () => res({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

function run(cmd, args) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', (e) =>
      rej(new Error(e.code === 'ENOENT' ? `${cmd} is not installed or not on PATH.` : e.message)),
    );
    child.on('close', (code) =>
      code === 0 ? res() : rej(new Error(`${cmd} exited with ${code}\n${err.trim().split('\n').slice(-6).join('\n')}`)),
    );
  });
}

export const ease = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const clamp = (t) => Math.min(1, Math.max(0, t));

/**
 * Installed in every page before its own scripts. It owns two things: the
 * seek that holds CSS animations to the film's time, and the pointer and tap
 * marks, which live in a closed shadow root so the app's styles cannot reach
 * them and its code cannot find them.
 */
function inPage() {
  // Taken before the fake clock is installed (the recorder adds this script
  // first), so a frame can wait in real time for the browser.
  const realTimeout = window.setTimeout.bind(window);
  const seen = new WeakMap();
  let marks = null;

  // A View Transition's animations are created a real frame after it starts
  // and run for a few hundred ms, which a slow screenshot can outlast. They
  // are paused the moment they exist, and the next frame times them from 0.
  const transitions = new Set();
  const native = Document.prototype.startViewTransition;
  if (native) {
    Document.prototype.startViewTransition = function startViewTransition(...args) {
      const t = native.apply(this, args);
      transitions.add(t);
      t.ready.then(() => {
        for (const a of document.getAnimations()) {
          if (String(a.effect?.pseudoElement ?? '').startsWith('::view-transition')) a.pause();
        }
      }).catch(() => {});
      t.finished.catch(() => {}).finally(() => transitions.delete(t));
      return t;
    };
  }
  const ensure = () => {
    if (marks || !document.documentElement) return marks;
    const host = document.createElement('promo-marks');
    host.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;border:0;' +
      'background:transparent;overflow:visible;z-index:2147483647;pointer-events:none;display:block';
    // A popover, so it can sit in the top layer above a modal <dialog>.
    host.popover = 'manual';
    const root = host.attachShadow({ mode: 'closed' });
    // A constructed sheet rather than a <style>: a page whose CSP forbids
    // inline styles blocks the element but not the CSSOM.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      .pointer { position: fixed; left: 0; top: 0; width: 20px; height: 28px; transform-origin: 1px 1px;
        filter: drop-shadow(0 2px 3px rgba(0,0,0,.45)); display: none; }
      .ring { position: fixed; border-radius: 50%; transform: translate(-50%, -50%); display: none; }
      .tap { position: fixed; border-radius: 50%; transform: translate(-50%, -50%); display: none;
        background: radial-gradient(circle, rgba(255,255,255,.55), rgba(255,255,255,.18) 55%, transparent 72%);
        box-shadow: 0 0 0 1.5px rgba(0,0,0,.12); }
    `);
    root.adoptedStyleSheets = [sheet];
    root.innerHTML = `
    <svg class="pointer" viewBox="0 0 20 28"><path d="M1 1v21.5l5.3-5.1 3.6 8.6 3.9-1.6-3.6-8.5H17.6Z"
      fill="#fff" stroke="#0b0d12" stroke-width="1.5" stroke-linejoin="round"/></svg>
    <div class="ring"></div><div class="tap"></div>`;
    document.documentElement.appendChild(host);
    marks = {
      host,
      pointer: root.querySelector('.pointer'),
      ring: root.querySelector('.ring'),
      tap: root.querySelector('.tap'),
    };
    return marks;
  };

  window.__promo = {
    /** Holds every animation to `now` ms of film time, then draws the marks. */
    async frame(now, m) {
      // A cross-fade this frame's action began is waiting on the browser to
      // snapshot the old screen. Wait for it, so the frame shows its first
      // instant rather than wherever real time had got to.
      const pending = [...transitions].map((t) => t.ready.catch(() => {}));
      if (pending.length) await Promise.race([Promise.all(pending), new Promise((r) => realTimeout(r, 3000))]);
      for (const a of document.getAnimations()) {
        let s = seen.get(a);
        // An animation is timed from the first frame that sees it; one the
        // app restarts after it finished starts its clock again.
        if (!s || (s.done && a.playState !== 'finished')) {
          s = { start: now, done: false };
          seen.set(a, s);
        }
        if (s.done) continue;
        const end = a.effect ? a.effect.getComputedTiming().endTime : Infinity;
        const local = (now - s.start) * (a.playbackRate || 1);
        if (Number.isFinite(end) && local >= end) {
          s.done = true;
          a.finish();
        } else {
          a.pause();
          a.currentTime = local;
        }
      }
      const el = ensure();
      if (!el) return;
      // Kept last in the top layer: anything shown there since the last frame
      // (a modal dialog, another popover) would otherwise draw over the marks.
      const above = [...document.querySelectorAll(':modal, :popover-open')].some((n) => n !== el.host);
      if (above || !el.host.matches(':popover-open')) {
        if (el.host.matches(':popover-open')) el.host.hidePopover();
        el.host.showPopover();
      }
      if (m.pointer) {
        el.pointer.style.display = 'block';
        el.pointer.style.transform = `translate(${m.pointer.x - 1}px, ${m.pointer.y - 1}px) scale(${m.pointer.down ? 0.88 : 1})`;
      } else {
        el.pointer.style.display = 'none';
      }
      for (const [node, mark] of [[el.ring, m.ring], [el.tap, m.tap]]) {
        if (!mark) {
          node.style.display = 'none';
          continue;
        }
        node.style.display = 'block';
        node.style.left = `${mark.x}px`;
        node.style.top = `${mark.y}px`;
        node.style.width = node.style.height = `${mark.size}px`;
        node.style.opacity = String(mark.opacity);
        if (node === el.ring) node.style.border = `2px solid ${mark.color}`;
      }
    },
  };
}

/**
 * What a beat's handler is given each frame. `k` counts frames within the
 * beat and `n` is its length; the helpers spread an action across the beat or
 * fire it on its first frame, so a handler reads as a sentence.
 */
function makeContext(screen, k, n, fps) {
  const { page, kind } = screen;
  const desktop = kind === 'desktop';
  const p = n > 1 ? k / (n - 1) : 1;

  const center = async (target) => {
    const box = typeof target === 'string'
      ? await page.locator(target).first().boundingBox({ timeout: 5000 })
      : target;
    if (!box) throw new Error(`${kind}: nothing to aim at for ${target}`);
    const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const view = page.viewportSize();
    // A tap off screen lands nowhere and the walkthrough carries on wrong.
    if (c.x < 0 || c.y < 0 || c.x > view.width || c.y > view.height) {
      throw new Error(`${kind}: ${target} is off screen at ${Math.round(c.x)},${Math.round(c.y)}; bring it into view first`);
    }
    return c;
  };

  return {
    page,
    kind,
    desktop,
    phone: !desktop,
    k,
    n,
    p,
    fps,
    /** Runs `fn` on one frame of the beat, the first unless told otherwise. */
    async once(fn, at = 0) {
      if (k === at) await fn();
    },
    /**
     * Desktop: glides the pointer onto the target over the first `share` of
     * the beat. The real mouse moves with it, so hover states follow.
     */
    async aim(target, { share = 0.7, dx = 0, dy = 0 } = {}) {
      if (!desktop) return;
      if (k === 0) {
        const to = await center(target);
        screen.aim = { from: { ...screen.pointer }, to: { x: to.x + dx, y: to.y + dy } };
      }
      const { from, to } = screen.aim;
      const t = ease(clamp(p / share));
      screen.pointer = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      await page.mouse.move(screen.pointer.x, screen.pointer.y);
    },
    /**
     * Clicks the target on frame `at`: the desktop presses where its pointer
     * is (aim first), the phone taps the target's centre.
     */
    async click(target, { at = 0 } = {}) {
      if (k !== at) return;
      if (desktop) {
        if (target) {
          const c = await center(target);
          screen.pointer = c;
          await page.mouse.move(c.x, c.y);
        }
        screen.press = screen.frame;
        await page.mouse.down();
        await page.mouse.up();
      } else {
        const c = await center(target);
        screen.tap = { ...c, frame: screen.frame };
        await page.touchscreen.tap(c.x, c.y);
      }
    },
    /** Types `text` evenly across the first `share` of the beat. */
    async type(text, { share = 0.85 } = {}) {
      if (k === 0) screen.typed = 0;
      const want = Math.min(text.length, Math.round(text.length * clamp((k + 1) / Math.max(1, n * share))));
      if (want > screen.typed) {
        await page.keyboard.type(text.slice(screen.typed, want));
        screen.typed = want;
      }
    },
    /** Presses a key on frame `at`. */
    async press(key, { at = 0 } = {}) {
      if (k === at) await page.keyboard.press(key);
    },
    /**
     * Scrolls a container (or the page) to `top` px over the first `share` of
     * the beat, eased, and set directly each frame so CSS smooth scrolling
     * never runs on the wall clock.
     */
    async scroll(selector, top, { share = 0.8 } = {}) {
      if (k === 0) {
        screen.scrollFrom = await page.evaluate((sel) => {
          const el = sel ? document.querySelector(sel) : document.scrollingElement;
          return el ? el.scrollTop : 0;
        }, selector);
      }
      const y = screen.scrollFrom + (top - screen.scrollFrom) * ease(clamp(p / share));
      await page.evaluate(({ sel, y }) => {
        const el = sel ? document.querySelector(sel) : document.scrollingElement;
        if (el) el.scrollTo({ top: y, behavior: 'instant' });
      }, { sel: selector, y });
    },
    /**
     * Eases the page so the target ends up centred (or `block: 'start'`, its
     * top `offset` px from the viewport's top) over the first `share` of the
     * beat. The distance is measured on the beat's first frame.
     */
    async bring(target, { block = 'center', offset = 0, share = 0.85 } = {}) {
      if (k === 0) {
        screen.scrollFrom = await page.evaluate(() => window.scrollY);
        screen.scrollTo = await page.locator(target).first().evaluate((el, { block, offset }) => {
          const r = el.getBoundingClientRect();
          const y = block === 'start' ? r.top - offset : r.top - (innerHeight - r.height) / 2;
          const max = document.scrollingElement.scrollHeight - innerHeight;
          return Math.max(0, Math.min(max, window.scrollY + y));
        }, { block, offset });
      }
      const y = screen.scrollFrom + (screen.scrollTo - screen.scrollFrom) * ease(clamp(p / share));
      await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), y);
    },
    /** Desktop: puts the pointer, and the real mouse, at a page point. */
    async pointAt({ x, y }, { down = false } = {}) {
      if (!desktop) return;
      screen.pointer = { x, y };
      if (down) screen.press = screen.frame;
      await page.mouse.move(x, y);
    },
    /** Phone: draws a tap at a page point without sending one, for a drag the page is told about directly. */
    markTap({ x, y }) {
      if (!desktop) screen.tap = { x, y, frame: screen.frame };
    },
    /** Scrolls the target into view, centred, on frame `at`. */
    async reveal(target, { at = 0 } = {}) {
      if (k !== at) return;
      await page.locator(target).first().evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    },
  };
}

/** The pointer, press ring and tap ripple for this frame, in page pixels. */
function marksFor(screen, fps) {
  const out = {};
  if (screen.kind === 'desktop' && screen.showPointer) {
    const since = screen.press == null ? Infinity : screen.frame - screen.press;
    out.pointer = { ...screen.pointer, down: since < Math.round(0.12 * fps) };
    const life = Math.round(0.45 * fps);
    if (since < life) {
      const t = ease(since / life);
      out.ring = { ...screen.pointer, size: 14 + 52 * t, opacity: 0.75 * (1 - t), color: screen.accent };
    }
  }
  if (screen.kind === 'phone' && screen.tap) {
    const life = Math.round(0.5 * fps);
    const since = screen.frame - screen.tap.frame;
    if (since < life) {
      const t = ease(since / life);
      out.tap = { x: screen.tap.x, y: screen.tap.y, size: 40 + 110 * t, opacity: 0.9 * (1 - t) };
    }
  }
  return out;
}

/* ═══════════════════════════════════════════════════════ the wide frame ══ */

function roundRect({ x, y, w, h }, r, top = true) {
  const t = top ? r : 0;
  return (
    `M${x + t} ${y}h${w - t - r}` +
    (top ? `a${r} ${r} 0 0 1 ${r} ${r}` : `h${r}`) +
    `v${h - t - r}a${r} ${r} 0 0 1 -${r} ${r}h-${w - 2 * r}a${r} ${r} 0 0 1 -${r} -${r}` +
    `v-${h - t - r}` +
    (top ? `a${r} ${r} 0 0 1 ${r} -${r}` : `h${t}`) +
    'z'
  );
}

/** A CSS mask image, opaque across the canvas except for the hole given. */
function holes(path) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDE.w}" height="${WIDE.h}">` +
    `<path fill="#fff" fill-rule="evenodd" d="M0 0H${WIDE.w}V${WIDE.h}H0Z${path}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** A still: the cut's ground and fonts under whatever the layer draws. */
function sheet(look, css, body) {
  return `<!doctype html><meta charset="utf-8"><style>
    ${look.fonts ?? ''}
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: ${WIDE.w}px; height: ${WIDE.h}px; background: transparent; }
    body { font-family: ${look.sans}; -webkit-font-smoothing: antialiased; }
    .mono { font-family: ${look.mono}; }
    .ground { position: absolute; inset: 0; overflow: hidden; background: ${look.ground}; }
    ${css}
  </style>${body}`;
}

/**
 * Back layer: the ground and a browser window, with a hole where the desktop
 * recording shows through. Generic chrome, not any real browser's: three dots
 * and an address pill.
 */
function backHtml(look, address) {
  const slash = address.indexOf('/');
  const host = slash < 0 ? address : address.slice(0, slash);
  const rest = slash < 0 ? '' : address.slice(slash);
  const c = look.chrome;
  return sheet(look, `
    .cut { position: absolute; inset: 0; -webkit-mask-image: ${holes(roundRect(VIEWPORT, WIN.r, false))}; }
    .window {
      position: absolute; left: ${WIN.x}px; top: ${WIN.y}px;
      width: ${WIN.w}px; height: ${WIN.bar + VIEWPORT.h}px; border-radius: ${WIN.r}px;
      background: ${c.page};
      box-shadow: 0 0 0 1px ${c.edge}, 0 40px 110px -30px rgba(0,0,0,.75), ${c.glow};
    }
    .bar {
      position: absolute; left: 0; right: 0; top: 0; height: ${WIN.bar}px;
      border-radius: ${WIN.r}px ${WIN.r}px 0 0;
      background: ${c.bar}; border-bottom: 1px solid ${c.rule};
    }
    .dots { position: absolute; left: 18px; top: 15px; display: flex; gap: 8px; }
    .dots i { width: 12px; height: 12px; border-radius: 50%; background: ${c.dots}; }
    .address {
      position: absolute; left: 50%; top: 8px; transform: translateX(-50%);
      min-width: 520px; height: 26px; padding: 0 22px; border-radius: 13px;
      background: ${c.pill}; border: 1px solid ${c.pillEdge};
      font-size: 13px; line-height: 24px; text-align: center; letter-spacing: .01em;
      color: ${c.path}; white-space: nowrap;
    }
    .address span { color: ${c.host}; }`, `
    <div class="cut">
      <div class="ground">${look.groundExtra ?? ''}</div>
      <div class="window">
        <div class="bar">
          <div class="dots"><i></i><i></i><i></i></div>
          <div class="address mono"><span>${host}</span>${rest}</div>
        </div>
      </div>
    </div>`);
}

/**
 * Front layer: the phone alone on a transparent sheet, with a hole for its
 * screen. The shadow belongs to this layer, so it falls across the browser
 * window as well as the ground.
 */
function phoneHtml(look) {
  const b = {
    x: PHONE.x - PHONE.bezel,
    y: PHONE.y - PHONE.bezel,
    w: PHONE.w + PHONE.bezel * 2,
    h: PHONE.h + PHONE.bezel * 2,
  };
  return sheet(look, `
    .cut { position: absolute; inset: 0; -webkit-mask-image: ${holes(roundRect(PHONE, PHONE.r))}; }
    .body {
      position: absolute; left: ${b.x}px; top: ${b.y}px; width: ${b.w}px; height: ${b.h}px;
      border-radius: ${PHONE.r + PHONE.bezel}px;
      background: linear-gradient(148deg, #5d6470 0%, #262b33 16%, #0e1116 46%, #0b0e13 72%, #474e59 100%);
      box-shadow: 0 0 0 1px rgba(255,255,255,.10), -18px 30px 70px -10px rgba(0,0,0,.7), ${look.chrome.phoneGlow};
    }
    .rim {
      position: absolute;
      left: ${PHONE.x - 1.5}px; top: ${PHONE.y - 1.5}px;
      width: ${PHONE.w + 3}px; height: ${PHONE.h + 3}px;
      border-radius: ${PHONE.r + 1.5}px;
      box-shadow: inset 0 0 0 1px rgba(0,0,0,.85), inset 0 0 0 2px rgba(255,255,255,.14);
    }`, `
    <div class="cut"><div class="body"></div></div>
    <div class="rim"></div>`);
}

async function drawStills(browser, origin, pages, dir, cut) {
  await mkdir(dir, { recursive: true });
  const page = await browser.newPage({ viewport: { width: WIDE.w, height: WIDE.h }, deviceScaleFactor: 1 });
  const draw = async (name, html, transparent) => {
    const path = `/__promo/${name}.html`;
    pages.set(path, html);
    await page.goto(origin + path, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const file = join(dir, `${name}.png`);
    await page.screenshot({ path: file, omitBackground: transparent });
    return file;
  };
  const backs = [];
  for (const [i, a] of cut.addresses.entries()) backs.push({ at: a.at, file: await draw(`back-${i}`, backHtml(cut.look, a.text), true) });
  const phone = await draw('phone', phoneHtml(cut.look), true);
  const card = cut.card ? await draw('card', sheet(cut.look, cut.card.css, cut.card.html), false) : null;
  await page.close();
  return { backs, phone, card };
}

const H264 = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
  '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1',
  '-movflags', '+faststart', '-an'];

/** One ffmpeg pass: both screens scaled into their holes, the stills over them. */
async function compose(ffmpeg, { desk, phone, stills, out, fps, frames, outro, dip, start }) {
  await mkdir(dirname(resolve(out)), { recursive: true });
  const seconds = frames / fps;
  const still = (file, length) => ['-loop', '1', '-framerate', String(fps), '-t', String(length), '-i', file];
  const inputs = [
    '-framerate', String(fps), '-i', join(desk, 'f%06d.png'),
    '-framerate', String(fps), '-i', join(phone, 'f%06d.png'),
  ];
  const filter = [
    `[0:v]scale=${VIEWPORT.w}:${VIEWPORT.h}:flags=lanczos,setsar=1,` +
      `pad=${WIDE.w}:${WIDE.h}:${VIEWPORT.x}:${VIEWPORT.y}:color=black[l0]`,
  ];
  // Each address owns the stretch until the next one, in output seconds.
  stills.backs.forEach((b, i) => {
    inputs.push(...still(b.file, seconds));
    const from = (b.at - start).toFixed(4);
    const to = i + 1 < stills.backs.length ? (stills.backs[i + 1].at - start).toFixed(4) : '1e9';
    filter.push(`[${i + 2}:v]format=rgba[b${i}]`);
    filter.push(`[l${i}][b${i}]overlay=0:0:format=auto:enable='between(t,${from},${to})'[l${i + 1}]`);
  });
  const nb = stills.backs.length;
  inputs.push(...still(stills.phone, seconds));
  filter.push(`[1:v]scale=${PHONE.w}:${PHONE.h}:flags=lanczos,setsar=1[screen]`);
  filter.push(`[l${nb}][screen]overlay=${PHONE.x}:${PHONE.y}[held]`);
  filter.push(`[${nb + 2}:v]format=rgba[body]`);
  const card = stills.card && outro > 0;
  filter.push(`[held][body]overlay=0:0:format=auto,format=yuv420p,setsar=1` +
    (card ? `,fade=t=out:st=${(seconds - dip).toFixed(3)}:d=${dip}[main]` : '[v]'));
  if (card) {
    inputs.push(...still(stills.card, outro));
    filter.push(`[${nb + 3}:v]format=yuv420p,setsar=1,fade=t=in:st=0:d=${dip}[card]`);
    filter.push('[main][card]concat=n=2:v=1:a=0[v]');
  }
  await run(ffmpeg, ['-y', ...inputs, '-filter_complex', filter.join(';'), '-map', '[v]', ...H264, out]);
  return seconds + (card ? outro : 0);
}

/* ═══════════════════════════════════════════════════════════════ record ══ */

function parseArgs(argv, cut) {
  const o = { out: cut.out, fps: 30, ffmpeg: 'ffmpeg', from: 0, to: Infinity, card: true, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--out': o.out = argv[++i]; break;
      case '--fps': o.fps = Number(argv[++i]); break;
      case '--from': o.from = Number(argv[++i]); break;
      case '--to': o.to = Number(argv[++i]); break;
      case '--no-end-card': o.card = false; break;
      case '--ffmpeg': o.ffmpeg = argv[++i]; break;
      case '--quiet': o.quiet = true; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`Unknown option: ${argv[i]}`);
    }
  }
  return o;
}

const HELP = (cut) => `
Film ${cut.name}'s desktop page and phone page side by side at 1920x1080

Usage
  node ${cut.script} [options]

Options
  --out <file>      .mp4                          (default ${cut.out})
  --fps <n>         frames per second                         (default 30)
  --from <s>        start the output this many seconds in      (default 0)
  --to <s>          end the output here                   (default the end)
                    Frames outside the window are still played, only not
                    shot, so a preview of the middle shows the same state.
  --no-end-card     end on the walkthrough
  --ffmpeg <path>   ffmpeg binary                          (default ffmpeg)
  --quiet           only print the output path
`;

/** Plays a cut on both screens and writes the composed film. */
export async function record(cut, argv) {
  let opts;
  try {
    opts = parseArgs(argv, cut);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (opts.help) {
    console.log(HELP(cut));
    return;
  }
  const log = (m) => {
    if (!opts.quiet) process.stderr.write(`${m}\n`);
  };

  let chromium;
  try {
    ({ chromium } = await import(process.env.PROMO_PLAYWRIGHT || 'playwright'));
  } catch {
    console.error('playwright is not installed. Run: npm i --no-save playwright, or set PROMO_PLAYWRIGHT to its index.mjs');
    process.exit(1);
  }

  const pages = new Map();
  const { server, origin } = await serve(resolve(cut.root), pages);
  const frameDir = await mkdtemp(join(tmpdir(), `${cut.name}-promo-`));
  const browser = await chromium.launch({ args: ['--hide-scrollbars', '--force-color-profile=srgb'] });
  const fps = opts.fps;
  const now = Date.parse(cut.now);

  try {
    const screens = [];
    for (const [kind, viewport] of [['desktop', DESKTOP], ['phone', HANDSET]]) {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 1,
        isMobile: kind === 'phone',
        hasTouch: kind === 'phone',
        serviceWorkers: 'block',
        reducedMotion: 'no-preference',
        colorScheme: cut.colorScheme ?? 'light',
        locale: cut.locale ?? 'en-US',
        timezoneId: cut.timezone ?? 'America/New_York',
      });
      // The film is offline: anything off this origin fails fast rather than
      // landing on whichever frame the network happens to answer by.
      await context.route((url) => !url.href.startsWith(origin), (route) => route.abort());
      await context.addInitScript(inPage);
      await context.clock.install({ time: now });
      if (cut.seed) await context.addInitScript(cut.seed, { kind, now });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const dir = join(frameDir, kind);
      await mkdir(dir, { recursive: true });
      screens.push({
        kind,
        page,
        context,
        dir,
        errors,
        frame: 0,
        accent: cut.look.accent,
        pointer: { x: viewport.width * 0.62, y: viewport.height * 0.72 },
        showPointer: true,
      });
    }

    log(`Loading ${cut.name} on a ${DESKTOP.width}x${DESKTOP.height} desktop and a ${HANDSET.width}x${HANDSET.height} phone…`);
    await Promise.all(screens.map(async (s) => {
      await s.page.goto(origin + (cut.path ?? '/'), { waitUntil: 'load' });
      await s.page.evaluate(() => document.fonts.ready);
      if (cut.settle) await cut.settle(s.page, s.kind);
    }));
    // From here the clock only moves when a frame asks it to. The jump past
    // the boot clears whatever the app timed to dismiss itself.
    await Promise.all(screens.map((s) => s.page.clock.pauseAt(now + (cut.bootMs ?? 20000))));
    await Promise.all(screens.map(async (s) => {
      await s.page.clock.runFor(1000);
      if (cut.ready) await cut.ready(s.page, s.kind);
      await s.page.clock.runFor(1000);
    }));

    const total = cut.beats.reduce((sum, b) => sum + Math.max(1, Math.round(b.seconds * fps)), 0);
    const first = Math.round(opts.from * fps);
    const last = Math.min(total, Math.round(opts.to * fps));
    log(`  ${total} frames (${(total / fps).toFixed(1)}s at ${fps}fps), shooting ${first} to ${last - 1}`);

    let f = 0;
    let shot = 0;
    try {
      await play();
    } catch (e) {
      // Both screens as they were when the beat failed, which usually says why.
      for (const s of screens) {
        const file = join(tmpdir(), `${cut.name.toLowerCase()}-promo-failed-${s.kind}.png`);
        await s.page.screenshot({ path: file }).catch(() => {});
        log(`  ${s.kind} at the failure: ${file}`);
      }
      throw new Error(`frame ${f}: ${e.message.split('\n')[0]}`);
    }
    async function play() {
    for (const beat of cut.beats) {
      const n = Math.max(1, Math.round(beat.seconds * fps));
      for (let k = 0; k < n; k += 1) {
        const tick = Math.round(((f + 1) * 1000) / fps) - Math.round((f * 1000) / fps);
        const filmMs = Math.round(((f + 1) * 1000) / fps);
        const shoot = f >= first && f < last;
        const name = `f${String(shot).padStart(6, '0')}.png`;
        await Promise.all(screens.map(async (s) => {
          s.frame = f;
          const handler = beat[s.kind] ?? beat.both;
          if (handler) await handler(makeContext(s, k, n, fps));
          await s.page.clock.runFor(tick);
          await s.page.evaluate(({ t, m }) => window.__promo.frame(t, m), { t: filmMs, m: marksFor(s, fps) });
          if (shoot) await s.page.screenshot({ path: join(s.dir, name) });
        }));
        if (shoot) shot += 1;
        f += 1;
        if (!opts.quiet && f % 30 === 0) process.stderr.write(`\r  ${f}/${total} frames`);
      }
    }
    }
    if (!opts.quiet) process.stderr.write('\n');
    for (const s of screens) {
      if (s.errors.length) throw new Error(`The ${s.kind} page failed: ${s.errors[0]}`);
    }

    log('Drawing the frame…');
    const stills = await drawStills(browser, origin, pages, join(frameDir, 'stills'), {
      ...cut,
      card: opts.card && last === total ? cut.card : null,
    });
    log('Compositing…');
    const out = resolve(opts.out);
    const seconds = await compose(opts.ffmpeg, {
      desk: screens[0].dir,
      phone: screens[1].dir,
      stills,
      out,
      fps,
      frames: shot,
      outro: cut.outro ?? 5,
      dip: cut.dip ?? 0.8,
      start: first / fps,
    });
    const size = (await stat(out)).size;
    if (opts.quiet) console.log(out);
    else log(`Wrote ${out} (${(size / 1024 / 1024).toFixed(1)} MB, ${seconds.toFixed(1)}s)`);
  } finally {
    await browser.close();
    server.close();
    await rm(frameDir, { recursive: true, force: true });
  }
}
