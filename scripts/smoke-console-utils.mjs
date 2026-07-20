/**
 * Console noise expected in automated browser runs when ONNX / embedding
 * init fails under headless or constrained Chromium (distinct from CSP / app bugs).
 */

export const SMOKE_KNOWN_CONSOLE_NOISE = [
  /onnxruntime.*VerifyEachNodeIsAssignedToAnEp/i,
  /Session already started/i,
  /Session mismatch/i,
  /Inputs given to model/i,
  /\[intel\].*(?:protobuf|Can't create a session|pipeline failed|load failed)/i,
  /ERROR_CODE:\s*7/i,
  /Failed to load model because protobuf/i,
  // NOTE: CSP style-src violations are deliberately NOT filtered. CSSOM writes
  // (el.style.x = …) never trigger them — only real style="…" attributes do,
  // and those are bugs (the style is silently blocked). The old entry here
  // also never matched Chromium's actual message text ("Refused to apply
  // inline style because it violates …"), so it only documented a wrong
  // assumption while masking nothing.
];

/** @param {string} text */
export function isKnownSmokeNoise(text) {
  return SMOKE_KNOWN_CONSOLE_NOISE.some((re) => re.test(text));
}

/** @param {string[]} messages */
export function filterSmokeConsoleErrors(messages) {
  return messages.filter((t) => !isKnownSmokeNoise(t));
}

/** Chromium flags for Puppeteer inside Docker / GitHub Actions. */
export function smokePuppeteerLaunchOptions(base = {}) {
  const opts = { headless: 'new', ...base };
  if (process.env.CI || process.env.GITHUB_ACTIONS) {
    const ciFlags = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
    opts.args = [...ciFlags, ...(opts.args || [])];
  }
  return opts;
}

/** Load smoke URL and wait out an optional SW `controllerchange` reload (fresh profile). */
export async function gotoSmokeStable(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  for (let i = 0; i < 6; i++) {
    await page.waitForSelector('[data-navtab]', { timeout: 25000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
    try {
      const n = await page.evaluate(() => document.querySelectorAll('[data-action]').length);
      if (n > 0) return;
    } catch (_) {
      /* Navigation replaced the document mid-evaluate — retry loop. */
    }
    await new Promise((r) => setTimeout(r, 900));
  }
  throw new Error('gotoSmokeStable: document never stabilized (no data-action census)');
}
