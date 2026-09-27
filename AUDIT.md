# Odta — Post-Feature-Wave Audit

**Original scope**: codebase state on branch `audit-findings`, head `40617a1` (cache `odtaulai-v43`, build 2026-04-27), after the wave of UX/UI/coverage PRs (#21–#25).

**Method**: read-only static analysis of `js/`, `sw.js`, `js/pwa.js`, `index.html`, and the `tests/` inventory. No code was modified by this audit. Each finding lists severity, evidence with file:line citations, and a suggested fix that's small enough to land in a focused follow-up branch.

---

## v80 wave (2026-09-27)

Ran in parallel with the v79 bug sweep (#133) and merged after it; rows that v79 also fixed say so.

Request: fix open problems, security first, plus odd UI/UX glitches. There were no open issues and one open PR (a Dependabot bump), so findings came from three read-only audits of the render paths, the data-ingress boundaries and the SW / CSP / LLM pipeline, plus a headless-Chromium walk of every tab at 390×844 and 1440×900 with seeded hostile task text. Each finding below was reproduced or read to its sink before it was fixed. Baseline 789/789.

| # | Finding | Severity | Status |
|---|---|---|---|
| AB-1 | P2P sync had no authentication: a device was its PeerJS id alone, claimable on the broker while offline, and the initiator answered any non-hello message with `_packState()`. A squatter got the vault on the next auto-reconnect and could push +5 min tombstones (`js/sync.js`) | High | ✅ Fixed. Accept mints a 256-bit pairing key; later connections prove it both ways (HMAC-SHA256 over the other side's nonce); nothing but hello/auth/pair before proof; reconnects never take a new key. `tests/sync-handshake.test.mjs` |
| AB-1b | Pairing devices that both had tasks lost one task of every same-id pair: per-device counters + id-keyed LWW (measured over PeerJS: both first tasks were id 1, both devices kept only one) (`js/sync.js`) | High (data loss) | ✅ Fixed on the initial exchange: same id + different `created` → older keeps the id, newer moves to max(counters, ids)+rank on both sides; references follow. Same-minute collisions and list/goal/log counters remain |
| AB-1c | Residual of AB-1 (found in review after v80): the first pairing and every manual re-pair still trusted whoever answered the dialled PeerJS id. The pairing code was the id alone (first-come on the public broker), the acceptor minted the key on Accept and sent it to the dialer, any stranger got an Accept banner and a failed proof a "Re-pair request" banner whose Accept minted a new key; `unavailable-id` rotated the id and broke every pairing (`js/sync.js`) | Medium | ✅ Fixed in v81. Pairing code = id + 12-char secret; pair key = PBKDF2-SHA256(secret, id, 100k) derived on both ends, the dialer stores it before dialling and the acceptor verifies the dialer's proof before signing anything; Accept confirms a proven device; strangers / bad proofs / v2 / plaintext get `{type:'refuse', reason}` and no banner; AES-256-GCM transport (HKDF of the pair key, AAD = nonces + role) after readiness; inbound failure back-off; 45 s timeouts; busy id retried, never rotated. `tests/sync-handshake.test.mjs` (18 cases) |
| AB-2 | Delegated dispatcher called any `window[data-action]` with element-supplied JSON args, so any HTML injection could call `syncConnect('<attacker>')` (`js/event-delegation.js`) | High | ✅ Fixed. Closure-local allowlist of the 201 emitted names; `tests/event-delegation-allowlist.test.mjs` |
| AB-3 | `esc()` never escaped quotes (textContent → innerHTML), so every `attr="${esc(x)}"` could be broken out of: life-area label input, ICS title attribute (`js/utils.js`) | Medium | ✅ Fixed (also fixed independently in v79; v79's version kept) |
| AB-4 | Raw sinks: note ids into `data-args` (`tasks.js`), list names into the list-move summary (`ai.js`), restored archive fields into the history panel and CSV (`app.js`); lists had no repair step anywhere | Medium | ✅ Fixed. Numeric note ids + escaped args, `_repairList` on load/import/cross-tab/sync, `_repairArchives` on restore and read |
| AB-4b | Ask auto-apply: calendar-made tasks entered the prompt untainted (Context line, `GET_TASK_DETAIL`, replayed prior turn); mass non-destructive batches applied without a prompt; the model could write the list-move card's `_preview` (`js/ask.js`, `js/tool-schema.js`, `js/ai.js`) | Medium | ✅ Fixed. `_ext`-keyed taint on all three paths; ≥5 writes or a quiet rewrite → confirm; bare `{name,args}` ops, card names from live ids. `tests/ask-calendar-task-taint`, `ask-batch-confirm`, `ask-preview-spoof` |
| AB-5 | `cfg.cycle:1e9` from a peer or backup froze the tab on every boot (`renderPips` loop; load saves before render) (`js/storage.js`) | Medium | ✅ Fixed. Stepper ranges enforced in `normalizeCfg` |
| AB-6 | ICS expansion unbounded: `INTERVAL=0`, 100k-token BYDAY (5.8 s, 1.4 GB), 10k daily rules → 3.6M occurrences (`js/calfeeds.js`) | Medium | ✅ Fixed. 5000 events / 20000 occurrences, BYDAY dedupe, Set EXDATE; capped feeds show a warning, not the stale-sync alert |
| AB-7 | Feed fetch timeout and 2 MB cap ended at the headers; the body read had neither and couldn't be cancelled (`js/calfeeds.js`) | Medium | ✅ Fixed. v79 extended the timeout over the body; the byte cap is now enforced while streaming |
| AB-8 | CSP had no `media-src`: every blob: media load was refused, so the v78 keepalive WAV and voice-note playback never played (`index.html`) | Medium | ✅ Fixed (also fixed in v79); `form-action 'none'` added; `tests/csp-sw-hardening.test.mjs` |
| AB-9 | Ctrl+K dropped typed keys: `.cmdk-panel` transitioned `all`, inherited `visibility` included, so the input was unfocusable on the first frame (`css/main.css`) | Medium (UX) | ✅ Fixed. Named transition properties + `Modal` focus retry; `tests/cmdk-open-focus.test.mjs` |
| AB-10 | Id counters accepted unsafe values (`taskIdCtr:1e21` → id collisions after reload) (`sync.js`, `storage.js`) | Low | ✅ Fixed. `_reseedIdCtr` |
| AB-11 | ICS export left a bare `\r` unescaped, allowing event injection (`js/storage.js`) | Low | ✅ Fixed |
| AB-12 | Private-address block missed `localhost.`, `*.localhost`, IPv4-mapped / NAT64 IPv6, 100.64/10 (`js/calfeeds.js`) | Low | ✅ Fixed |
| AB-13 | "Open with Odta" `.ics` skipped the size / `BEGIN:VCALENDAR` checks, failed silently and never synced (`js/app.js`) | Low | ✅ Fixed |
| AB-14 | SW cached navigations per full URL (share text persisted after the URL scrub), and v79's cache-first shell wrote any in-scope navigation (e.g. the update banner's CHANGELOG.md tab) into the shell key; `notificationclick` opened any URL; unused `SHOW_NOTIFICATION` handler (`sw.js`) | Low | ✅ Fixed. Only shell paths read/write the shell key |
| AB-15 | Gen worker `import()`ed any URL its load message named; workers get no meta CSP (`js/gen-worker.js`) | Low | ✅ Fixed. Same-origin only |
| AB-16 | `DEPLOY.md` recommended jsDelivr/unpkg in `script-src` and said headers override the meta CSP | Low | ✅ Fixed |
| AB-17 | Sticky top bar was transparent under its own border; stats row read through the header on phones (`css/main.css`) | Low (UI) | ✅ Fixed |
| AB-18 | Sub-24 px touch targets: Pomodoro pips 10×10, filter × 14×14, dock grip/min 18×14 / 20×16, detail checkbox 22×22, "Got it", "View Habits" | Low (UI) | ✅ Fixed. Coarse-pointer sizes / invisible hit areas |
| AB-19 | Calendar cells showed a cryptic "1·0" counter; "Description" flush under Type chips; reminder quick-picks wrapping in a half-width grid cell | Low (UI) | ✅ Fixed |
| AB-20 | 11 dev-dependency advisories (10 high); puppeteer 25 needs Node ≥ 22.12 but CI ran Node 20 | Low (dev only) | ✅ Fixed. puppeteer 25.12 (also in v79), CI Node 22, `npm audit` 0 |
| AB-21 | Clickjacking: the CSP is a `<meta>` tag (GitHub Pages sends no headers), so `frame-ancestors` can't be delivered and any site could frame odta.app and overlay the sync Accept banner, delete confirmations or import → replace (`index.html`) | Low | ✅ Fixed in v81. `js/pwa.js` (first window-only script) aborts the parse inside any frame and swaps in a `target="_top"` link; `js/app.js` refuses to boot framed. `tests/frame-guard.test.mjs` |
| AB-22 | CI workflow had no top-level `permissions:` block (`.github/workflows/ci.yml`) | Low | ✅ Fixed in v81. `permissions: contents: read` |

**Not fixed (deliberate)**: PeerJS reassembles chunked messages before the app sees them, and its `_handleChunk` has no size limit, so a connected peer can still push memory until the tab dies. That needs a patch to the vendored library. A first pairing was trust-on-first-use (typing a code while that device was offline let whoever held its id accept); v81 closes it with a secret in the pairing code, see AB-1c.

---

## v77 wave (2026-09-10)

User report: the chat (Cmd/Ctrl+K → Edit) "still comes back with an error" on a phone, plus a request to ship a basic model that just works and to check the chat / add-task surfaces at phone width. Reproduced end to end in headless Chromium at 390×844 (iPhone UA, WASM backend, Hugging Face fetches redirected to a local mirror of `HuggingFaceTB/SmolLM2-135M-Instruct`): model loaded in 10–16 s; first token after 36 s; the reply looped on the task context for five minutes; the 360 s hard cap fired → "Timed out — try a shorter request or a smaller model"; the abort went unanswered for 9 s → worker torn down → the next question showed "Download local AI" again. Baseline 702/702 green; 716/716 after.

| # | Finding | Severity | Status |
|---|---|---|---|
| AA-1 | Default preset was `SmolLM2-360M` (`sizeMb:230`, real WASM file 388 MB) for every device without `navigator.deviceMemory` — i.e. every iPhone; the 135M "tiny" label said 100 MB (real: 182 MB WASM / 118 MB WebGPU); Qwen 0.5B/1.5B said 320/600 MB (real: 786 MB / 1.8 GB) (`js/gen.js`) | High | ✅ Fixed — 135M is the default everywhere; `sizeMb`/`sizeMbGpu` are the Hub file sizes; `genPresetSizeLabel` shows the range; cfg v3 migration (never-downloaded 360M → 135M, weights already cached stay) |
| AA-2 | Preset + alt-slug `onnx-community/SmolLM2-360M-Instruct` answers HTTP 401 (gated); the public repack is `-ONNX` (`js/gen.js`) | Medium | ✅ Fixed — preset and fallback point at `-ONNX`; stored ids renamed by the v3 migration |
| AA-3 | A question typed before the model was loaded parked behind a "Download local AI" button; on completion `syncGenChip` replaced the whole conversation DOM with a static "ready" line, so the question was lost and had to be retyped (`js/ui.js`, `js/ai.js`) | High | ✅ Fixed — `_cmdkAskAutoLoadThenRun`: the chat runs the Settings download path, mirrors progress into the bubble (`cmdkAskOnGenProgress`), then runs the parked turn; cancel / retry / run-now actions; `tests/ask-auto-load.test.mjs` |
| AA-4 | Ops turns decoded greedily with no repetition control and `max_new_tokens: 512`; a 135M model echoing the context at ~1.5 tok/s spent the entire time budget on one loop (`js/ask.js`, `js/gen-pipeline.js`) | High | ✅ Fixed — `repetition_penalty` 1.1 plumbed through worker + engine; 320-token ops cap; `_askLooksDegenerate` streaming guard cuts the turn and skips the corrective retry |
| AA-4b | The 135M model cannot follow the ops prompt at all on the WASM path: "add a task to buy milk tomorrow" ran 383 s through ops turn, corrective turn, write retry and prose pass and ended "No changes to apply"; "what is overdue?" ended "Couldn't parse a valid plan" (`js/ask.js`) | High | ✅ Fixed — `askQuickIntent`: creation via the quick-add parser → validated `CREATE_TASK`; overdue / today / tomorrow / week / count / starred lookups from the data; both work with no model loaded (`quickOnly`). Pure questions go prose-first with `"overdue":true` in the context and an "Answer:" cue; `tests/ask-quick-intents.test.mjs` |
| AA-5 | 30 s mobile idle budget with 2× for prefill was under the measured first-token latency on WASM; the 9 s abort watchdog declared a worker "wedged" during a slow token and tore it down; the 90 s load-stall watchdog fired during silent WASM session creation after the last file (`js/gen.js`, `js/ask.js`, `js/gen-pipeline.js`) | High | ✅ Fixed — 60 s default (stored 30/60 defaults lifted by the migration), 3× prefill, 20 s abort watchdog, 5-minute init window after the last `done` |
| AA-6 | Add-task sheet on a 390 px phone: `.task-input-wrap` (flex item, `min-width:auto`) kept its min-content width (~320 px incl. mic/? buttons) and pushed "+ Add" past the viewport (`css/main.css`) | Medium | ✅ Fixed — `min-width:0` on the wrap, `flex-shrink:0` on the button; measured right edge 375/390 |
| AA-7 | Palette header on phones stacked input + Review/Auto + Minimize + Edit on one row (input ~200 px, placeholder clipped mid-word); bottom-anchored `#exportToast` landed on the sheet's input / behind the palette (`css/main.css`, `js/ui.js`) | Low | ✅ Fixed — two-row grid header on ≤640 px, short touch placeholders, toast moves to the top edge above the palette layer while a sheet is open; filter-bar orphan cell, swipe-tip "Got it" wrap, detail quick-pick spacing |

**Not changed (deliberate)**: the model weights are not vendored under `assets/models/` like the embedding model — every usable file is over GitHub's 100 MB per-file limit (135M q4f16 is 118 MB), so the chat downloads from the Hub on first use and the browser cache keeps it. Static hosting still sends no COOP/COEP, so ORT WASM stays single-threaded on phones; a service-worker-injected isolation header is the next lever for speed and was left out of this wave as a separate risk.

---

## Phone surface pass (2026-09-16)

Follow-up to the v77 wave, driving the built app in headless Chromium at 390×844 (touch, `isMobile`) and reading each first-run surface as a visitor sees it rather than as the desktop layout implies. Every finding below was measured in the running app, not read off the source. Baseline 737/737 green; 759/759 after.

| # | Finding | Severity | Status |
|---|---|---|---|
| AB-1 | "+ Add your first task" (the first-run empty state's primary CTA) focused `#taskInput`; on a phone that input lives in the quick-add sheet and is `display:none` until the sheet opens — measured `0×0`, `offsetParent:null`, so the tap moved focus nowhere and nothing opened (`js/tasks.js`) | High | ✅ Fixed — the button calls `quickAddFabClick()`, which already branches sheet-vs-inline on `(max-width:640px)` |
| AB-2 | Same card's copy described desktop-only UI: "Type a task above" (no visible input above on a phone) and "Press Ctrl+K" / "Or press Ctrl+K to open the command palette" (no keyboard) (`js/tasks.js`) | Medium | ✅ Fixed — touch copy points at the + button and the header search icon; the keyboard line is desktop-only |
| AB-3 | Task row at 390 px: grip 34 + checkbox + date chip 76 + two action buttons are all `flex-shrink:0`, leaving `.task-name` **67 px** — "Ship the v78 release notes" wrapped to four lines next to a half-empty row (`css/main.css`) | High | ✅ Fixed — `.task-main` wraps and `.task-signals` takes `flex:1 0 100%` on ≤640 px; name measures 170 px. `.task-name` uses `flex:1 1 0` so the pin star stays on the title's line |
| AB-4 | The last `@media (max-width:640px)` block set `.task-row-primary .task-checkbox` to 20 px, overriding the 24 px earlier in the same file whose own comment cites WCAG 2.5.5 — on the row's primary action (`css/main.css:2699`) | Medium | ✅ Fixed — 24 px with `min-height` |
| AB-5 | A browser without WebGPU/WASM support saw the raw engine error in three places: `showExportToast('Embedding model failed to load: ' + err.slice(0,120))`, the header chip's `title` (`slice(0,72) + ' — tap to retry'`, cutting "You may need ."), and the Tools banner (`slice(0,64)`, ending "Failed to get G") (`js/app.js:974`, `js/ai.js`) | High | ✅ Fixed — `friendlyModelError()` in `js/utils.js` maps failure class → one actionable sentence; raw text kept in `console.error` + `window._intelLoadErrorDetail` (chip `title`); `statusText` now escaped before `innerHTML` |
| AB-6 | Quick add dropped words from task names: "Morning run daily" → **run**, "Night shift prep friday" → **shift prep** (chrono's match at index 0 was a bare day-part word); "Take meds every night" → **Take meds every**, "Review PR by 5pm today" → **Review PR by** (the preposition pointing at the consumed phrase survived) (`js/nlparse.js`, `js/tasks.js`) | High | ✅ Fixed — leading day-part words stay in the title (the time is still applied); an orphaned connector is consumed with the date. Phrasal-verb particles excluded, so "Check in tomorrow" → "Check in" |
| AB-6b | `intelLoad` set `tryWebGPU = !!navigator.gpu`; where the API exists but `requestAdapter()` resolves null (headless Chromium here, plus Chrome/Edge on VMs, remote desktops, blocklisted drivers, acceleration off) the WebGPU attempt wedged the shared ORT instance, so the `device:'wasm'` fallback on the next line failed too with the WebGPU message — embeddings permanently unavailable, Retry included (`js/intel.js:77`) | High | ✅ Fixed — `_probeIntelWebGPU()` (adapter + device, mirroring `_probeWebGPU` in js/gen-pipeline.js) decides the device. Measured after: model ready on WASM in ~1.6 s, chip ✓, `semanticSearch('money')` ranks "Review Q3 budget" 1st (0.62 similarity for "buy milk" vs "pick up groceries") |
| AB-6c | `#taskSearchSemanticPill` was shown whenever the semantic checkbox was checked — directly beside that checkbox's own "Semantic" label, duplicating it and leaving the query input ~200 px on a phone (`js/tasks.js`) | Low | ✅ Fixed — the pill renders only when the labelled control has no layout box |
| AB-7 | `.header-date` rendered "Wednesday, September 16, 2026" into a 390 px top bar, wrapping to a second line and growing the header (`js/utils.js`) | Low | ✅ Fixed — `weekday:'short'` form under 480 px |
| AB-8 | The undo toast appended "Also: Ctrl+Z" on every device, keyboard or not (and Ctrl+Z on Macs); the extra line is also what pushed the top-anchored pill over the whole header (`js/utils.js`) | Low | ✅ Fixed — hint skipped on `(pointer: coarse)`, ⌘Z on Apple platforms |
| AB-9 | `#fbSearch` used a colour emoji 🔍 among four monochrome glyphs, against the "no emoji in the UI" rule stated at the top of `js/icons.js` (`index.html:302`) | Low | ✅ Fixed — `data-icon="search"` from the shared set |
| AB-10 | `.modal-stat` is a flex row, so the literal `" · "` text nodes between its spans were flex items in their own right and wrapped alone to the end of a line; the "Path:" span repeated the task title on root tasks (`js/ui.js`) | Low | ✅ Fixed — separators via `span + span::before`, Path only when a parent path exists, `#` id badge no longer carries its own separator |

**Not changed (deliberate)**: the action toast stays top-centre on phones (documented decision in `css/main.css`, pinned by `tests/toast-position.test.mjs`) — only the keyboard hint inside it was removed. The drag grip keeps its 34 px touch target on phones: it is the only manual reorder affordance there, so the row's width was found elsewhere.

---

## v76 wave (2026-09-06)

Targeted root-cause pass on two user reports: generative Ask failing with "Couldn't parse a valid plan" (screenshot: `Clean up overdue tasks` → parse error with the model reported ready), and timer chimes / notifications going silent once the app is backgrounded. Baseline 652/652 green; 684/684 after.

| # | Finding | Severity | Status |
|---|---|---|---|
| Z-1 | `parseOpsJson` threw on every non-canonical reply shape small models emit — truncated arrays (max_new_tokens), bare op objects, wrappers, Python literals, trailing commas, `<tool_call>` blocks, `arguments`/flattened args (`js/tool-schema.js`) | High | ✅ Fixed — structural salvage + `normalizeProposedOp`; `tests/tool-schema-tolerant-parse.test.mjs` |
| Z-2 | On parse failure `cognitaskRun` re-sent the identical message list up to 4× (`continue` with no feedback), then reported PARSE_FAILED; non-question commands never reached the write retry (`js/ask.js`) | High | ✅ Fixed — one corrective turn quoting the failure, then write-retry / prose fallbacks; `tests/ask-parse-recovery.test.mjs` |
| Z-3 | Prompt examples used `<tomorrow>` style placeholders that small models copy literally; validator dropped the field silently (`js/ask.js`, `js/tool-schema.js`) | Medium | ✅ Fixed — concrete ISO dates in examples + user prompt; `_naturalDateISO` backstop in the coercer |
| Z-4 | `QUERY_TASKS` had only a name-substring `filter`, so "overdue" queries had no tool path (`js/tool-schema.js`, `js/ask.js` `runReadOp`) | Medium | ✅ Fixed — `overdue`/`dueBefore`/`dueAfter`/`status`/`priority`/`tag`/`listId`/`includeDone`/`includeArchived` |
| Z-5 | Ops turns sampled at T=0.1–0.2; `timeoutSec` was a wall clock over the entire multi-turn run (30 s mobile default ≈ one WASM prefill of the ~1.5k-token prompt) (`js/ask.js`) | Medium | ✅ Fixed — greedy decode for structured turns; idle watchdog (`_askIdleAbort`) with prefill allowance and hard cap |
| Z-6 | `_extractProseAnswer` surfaced broken JSON fragments as a chat "answer" (`js/ask.js`) | Low | ✅ Fixed — JSON-looking lines filtered before the prose fallback |
| Z-7 | Keepalive oscillator gain 0.0001 (≈ −80 dBFS) was below Chrome's −72.25 dBFS audibility threshold (`kSilenceThresholdDBFS`, amplitude 1/4096) — the tab was classified silent, so the media session, background-throttling exemption and screen-lock audio survival the design relied on never engaged (`js/audio.js`) | High | ✅ Fixed — `KEEPALIVE_GAIN = 0.004` (≈ −51 dBFS) at 20 Hz; `tests/audio-background-wake.test.mjs` pins the threshold |
| Z-8 | `onPhaseComplete` / quick-timer / stopwatch chime paths short-circuited on `audioScheduled` even when the AudioContext clock had stalled while hidden; `_reconcileTimerAfterWake` only ticked the Pomodoro (quick timers + stopwatch not reconciled) and never discarded/rescheduled stale nodes (`js/timer.js`, `js/audio.js`) | High | ✅ Fixed — wall-vs-audio clock snapshot on hide, measured before `resume()` on show; reconcile cancels stale nodes → catch-up ticks (chime + notification now) → reschedule; guards consult `_audioLost()` |

### v76 second pass (same branch)

| # | Finding | Severity | Status |
|---|---|---|---|
| Z-9 | Reminder notifications carried no `url`, so a tap with the app closed opened `./` and dropped the task id; no boot handler for a task param (`sw.js`, `js/tasks.js`, `js/app.js`) | High | ✅ Fixed — `data.url` + `applyTaskFromUrl` |
| Z-10 | `reminderFired` set regardless of delivery; with notifications toggled off but permission granted nothing was shown and the reminder was consumed; no staleness cutoff → "Missed:" storm on first load / restore / sync (`js/tasks.js`) | High | ✅ Fixed — chime fallback, 24 h stale cutoff for implicit reminders, burst summary |
| Z-11 | Quick-add bare clock in the past fired "Missed:" ~30 s after creation (`js/tasks.js` `_applyQuickAddTime`) | High | ✅ Fixed — rolls to tomorrow when the target day is today and the time has passed |
| Z-12 | `cfg.dueNotify` opt-out had no UI; `cfg.notif === undefined` read as ON by the toggle and OFF by `notify()`; synced cfg never updated toggles; `renderNotifStatus` never ran on a fresh install (`index.html`, `js/storage.js`, `js/sync.js`, `js/audio.js`, `js/app.js`) | Medium | ✅ Fixed — `togDueNotify`, `normalizeCfg`, `syncCfgToggles`, boot + settings-open render |
| Z-13 | Restored running quick timer: no keepalive, no scheduled audio, stale `_audioScheduled:true` persisted → silent completion; expired-while-closed quick timers fired nothing (`js/app.js`, `js/storage.js`) | High | ✅ Fixed — boot reconcile, `_needsCompletion`, `_qtSerializable` |
| Z-14 | Stopwatch / quick-timer interval chimes silent after the scheduling horizon (played nodes suppressed the fallback) (`js/audio.js`, `js/timer.js`) | High | ✅ Fixed — scheduler returns the covered horizon; ticks re-arm past it |
| Z-15 | Keepalive (tone, wake lock, worker) never released on natural completion / skip / reset; wake-lock request vs stop race; single-shot audio primer; media-session `play` started a Pomodoro (`js/timer.js`, `js/audio.js`) | Medium | ✅ Fixed |
| Z-16 | Reload mid-focus lost the linked task's session credit; hide-save debounced past the freeze window, no `pagehide` save (`js/app.js`, `js/storage.js`) | Medium | ✅ Fixed |
| Z-17 | WASM model load uncancellable and untimed → Settings stuck on "Loading…"; cancel reported as `LOAD_ABORTED` crash; progress bar jump/freeze; `_resetModule` re-import was a no-op (`js/gen-pipeline.js`, `js/gen.js`, `js/ai.js`) | High | ✅ Fixed — `_watchLoad` (abort + idle watchdog), local abort settle, friendly cancel, byte-monotonic aggregator, cache-busted re-import + env re-apply |
| Z-18 | `openCmdK` → global `genAbort()` killed unrelated in-flight LLM work; `SET_RECUR` with an unrecognised value wiped the recurrence; `RESCHEDULE` re-fired delivered reminders; destructive confirm lost its chrome; rejected rows `[object Object]`; unbounded total time across passes; no in-thread abort watchdog; unguarded calendar block; `CREATE_FROM_EVENT` unsatisfiable; per-token full re-render (`js/ui.js`, `js/ai.js`, `js/ask.js`, `js/gen.js`) | Medium | ✅ Fixed |

**Not fixed (deliberate)**: stopwatch state is not persisted across reloads (feature-sized change, not a regression); a second tab adopting a running Pomodoro via cross-tab sync renders a frozen countdown until it is touched (only when that tab is pristine).

**Not fixable client-side (documented residual)**: a browser tab that the OS fully freezes or kills (iOS Safari after a few minutes in the background without playing media, aggressive Android battery savers) cannot run JavaScript, so a chime can only be *caught up* on the next wake; only an installed PWA with the keepalive engaged, or a server-driven push, can beat that.

---

## v75 follow-up wave (2026-07-20)

A third review pass (three parallel deep-reads: data layer, UI/PWA layer, AI/intel layer) targeting what the v74 wave missed. Baseline at review time: 597/597 tests green, all CI checks green. Every confirmed finding below was fixed in the same branch; 644/644 tests green after, browser smoke green (exit 0, zero actionable console errors — it crashed or failed on the pre-fix baseline).

| # | Finding | Severity | Status |
|---|---|---|---|
| X-1 | `saveState` change comparator omitted `checklists`/`completionNote`/`hiddenUntil`/`valuesNote` — edits touching only those fields never bumped `lastModified`, so LWW merge (P2P sync, cross-tab) silently discarded them (`js/storage.js` `fieldsToCompare`; the comment above `_snapshotTask` anticipated exactly this class) | High | ✅ Fixed — fields added; `tests/storage-lww-comparator.test.mjs` |
| X-2 | Monthly recurrence: `setMonth` ran while day-of-month was 29–31, overflowing past short months (Jan 31 → "Feb 31" → Mar 3 → clamp to Mar 31; February skipped) (`js/tasks.js` `advanceRecurringDate`) | High | ✅ Fixed — `setDate(1)` before `setMonth`, then clamp; functional tests in `tests/recurrence-monthly-clamp.test.mjs` |
| X-3 | `SCHEMA_VERSION` was still 8 while a `step(9)` migration existed, so the default-Lists backfill (added in the v74 wave) re-ran on every load and resurrected deleted default Lists (`js/storage.js`) | Medium | ✅ Fixed — bumped to 9; gate test asserts `SCHEMA_VERSION` ≥ max step target |
| X-4 | `completeHabitCycle` never reset `reminderFired`, making recurring reminders one-shot (`js/tasks.js`) | Medium | ✅ Fixed — re-armed on cycle; `tests/habit-cycle-reminder.test.mjs` |
| X-5 | `controllerchange` reload had no prior-controller guard — `clients.claim()` on first install reloaded every new visitor's freshly painted page (`js/pwa.js`) | Medium | ✅ Fixed — reload only when a controller existed before; `tests/pwa-first-install-reload.test.mjs` |
| X-6 | Ask few-shot examples taught args the validator silently drops: `listName` (no such arg — list ops never worked via Ask) and `remindAt` on `CREATE_TASK` ("remind me to X" created the task, dropped the reminder) (`js/ask.js`, `js/tool-schema.js`, `js/ai.js`) | Medium | ✅ Fixed — examples use `listId`/`CHANGE_LIST`; `CREATE_TASK` accepts+applies `remindAt`; consistency test pins all example args to the schema (`tests/ask-examples-schema.test.mjs`) |
| X-7 | The v74 known residual: `_askCalendarBlock()` injected feed-authored text into every Ask turn's base prompt without tainting it, bypassing the W-2 auto-apply gate when the model never called `GET_CALENDAR_EVENTS` (`js/ask.js`) | Medium | ✅ Fixed — `externalReads` seeded true whenever the calendar block is non-empty; test added to `ask-external-taint` |
| X-8 | Cmd/Ctrl+N meta guard only bailed for `<input>`, hijacking the browser shortcut from textarea/select/contenteditable (`js/ui.js`) | Low | ✅ Fixed — guard uses `inField` |
| X-9 | Shortcuts cheat-sheet (and palette kbd labels) advertised 1–5 tab switching with no handler (`js/ui.js`) | Low | ✅ Fixed — digit handler added, same field/modifier guards as the other global shortcuts |
| X-10 | `computeDuplicateScores` scored against archived/deleted tasks' embeddings, inflating the duplicate badge (`js/intel-features.js`) | Low | ✅ Fixed — resolves ids via `findTask`, skips archived (parity with `findDuplicates`) |
| X-11 | `window.showTab` monkey-patch (panel-entered animation flag) bypassed by all internal bare `showTab()` calls — hoisted declaration vs wrapper (`js/ui.js`) | Low | ✅ Fixed — logic folded into `showTab` itself |
| X-12 | Dead `Math.min(500, …)` on `GET_CALENDAR_EVENTS` limit — coercer already clamps to 100 (`js/ask.js`) | Low | ✅ Fixed — misleading ceiling removed; 100 documented as the cap |
| X-13 | Classification-manager color dots emitted `style="background:…"` in innerHTML — blocked by the strict CSP (`style-src 'self'`), so dots rendered colorless and every settings render logged violations (`js/intel-features.js:546`) | Medium | ✅ Fixed — color applied via CSSOM after insert (`data-dot-color`); `tests/no-inline-style-markup.test.mjs` sweeps all of `js/` + `index.html` |
| X-14 | Smoke tooling: the CSP entry in `SMOKE_KNOWN_CONSOLE_NOISE` never matched Chromium's actual message text (and its premise was wrong — CSSOM writes don't trigger style-src violations), and the per-tab visibility probe read `el.style.display` while `showTab` toggles the `hidden` attribute, so it always printed `true` (`scripts/smoke-console-utils.mjs`, `scripts/smoke-check.mjs`) | Low | ✅ Fixed — dead filter entry removed (CSP violations now actionable, which is what caught X-13); probe checks `hidden` + `offsetParent`. Baseline smoke also crashed reproducibly from X-5's first-install reload mid-run; green after the guard |

### v75 second pass (same branch, 2026-07-20)

A further adversarial pass: regression review of the first v75 commit plus fresh lenses on the undo/executor layer and import/export.

| # | Finding | Severity | Status |
|---|---|---|---|
| Y-1 | `DELETE_TASK` cascade removed the whole subtree but snapshotted only the root — clicking Undo restored the parent and permanently lost every descendant (`js/ai.js` executor + `aiUndo`) | High | ✅ Fixed — snapshot carries the removed subtree; `aiUndo` restores it; `tests/ai-undo-integrity.test.mjs` |
| Y-2 | **Regression in the first v75 commit (X-4):** `completeHabitCycle` re-armed `reminderFired` without advancing an explicit `remindAt`, so a habit with a set reminder time re-fired "Missed:" ~30s after logging a cycle, and the stale past `remindAt` blocked the due-date reminder branch for all future cycles (`js/tasks.js`) | Medium | ✅ Fixed — `remindAt`'s date part rolls forward by the recurrence, keeping the time-of-day; functional test added |
| Y-3 | `MARK_DONE` on a recurring task took a shallow snapshot while `completeHabitCycle` mutates `completions[]` and checklist items in place — Undo silently failed to remove the logged completion or restore checked items (`js/ai.js`) | Medium | ✅ Fixed — deep (JSON) snapshot, matching `TOGGLE_CHECK`'s existing pattern |
| Y-4 | `DUPLICATE_TASK` shallow copy shared `valuesAlignment`/`completions`/`checklists`/`_ext` with the source (mutating one corrupted the other) and copied attachment ids whose blob records are keyed by the source task — removing an attachment from either task deleted the other's blob (`js/ai.js`) | Medium | ✅ Fixed — deep clone with history fields reset (`completions`, `sessionEntries`, `habitLastRecordedTotalSec`) and `attachments: []`; named-checklist done state reset |
| Y-5 | CSV export's formula-injection guard (leading `'` on cells starting `= + - @`) was never stripped on import — export→import round-trips accreted a literal apostrophe onto names like `@home water plants` (`js/storage.js`) | Low-Med | ✅ Fixed — import strips exactly the guard pattern; round-trip identity test in `tests/csv-roundtrip-guard.test.mjs` |
| Y-6 | Escape over a pill Dropdown inside a Modal-stack modal tore down the whole modal: both modules install capture-phase keydown listeners on `document`, and `stopPropagation()` can't suppress a same-node listener (`js/modal.js` + `js/dropdown.js`) | Medium | ✅ Fixed — Modal's ESC handler yields while `Dropdown.isOpen()`; `tests/modal-dropdown-esc.test.mjs` |
| Y-7 | `notify()` permanently silent on `file://`: the SW branch triggers on `'serviceWorker' in navigator` (true even where pwa.js deliberately never registers), so `.ready` never resolves and the early `return` strands the documented main-thread fallback — no timer/reminder notifications in portable mode (`js/audio.js` + `js/pwa.js`) | Medium | ✅ Fixed — SW branch gates on `navigator.serviceWorker.controller` |
| Y-8 | `?openfile=1` (manifest file-handler routing param) never stripped from the URL after an "Open with Odta" launch, unlike the share-target params (`js/app.js`, `manifest.json`) | Low | ✅ Fixed — scrubbed via `history.replaceState` at boot |

**Verified clean in the small-module/contract sweep:** every `data-action`/`data-on*` in `index.html` and JS-generated markup resolves to a defined global with well-formed `data-args`; no duplicate ids; all `aria-*`/`label[for]` targets exist; version strings consistent; all `typeof`-guarded cross-module calls resolve; boot IIFE ordering sound.

**Adversarially re-verified as sound in this pass:** the other 13 changes of the first v75 commit (comparator additions cause no sync churn — `_snapshotTask` deep-clones and `_repairTask` normalizes shapes; `SCHEMA_VERSION` 9 gate and v8↔v9 sync interop; monthly clamp incl. Dec→Jan rollover; `_hadController` guard vs the app.js update-banner path; `escAttr`→CSSOM dot-color round-trip; `externalReads` seeding only taints turns with real feed events). Also probed sound: `ui.js` escaping at every innerHTML sink incl. the markdown renderer; undo-toast/Ctrl+Z ring consistency; gen-worker dispose-during-load; task-index rebuild coverage; storage encryption (fresh salt+IV per export); sync `_packState` field fidelity and tombstone merge; ICS folding/escaping.

**Verified as sound in this pass (no action):** SW precache list vs disk, cache-version consistency, fetch handler + navigation fallback; gen worker message protocol and abort watchdog; sync LWW/tombstone/handshake; calfeeds RRULE/TZID/SSRF handling; embed-store transaction lifetimes; no unescaped user data in `innerHTML` sinks; all `data-action`/`data-on*` handlers resolve.

**Remaining known residuals (unchanged from v74):**
- New initiator → old (≤v73) acceptor late-Accept case (peer-side PeerJS bug; resolves as peers upgrade).
- `connect-src` remains broad by design (user-configured CORS proxies).

---

## v74 audit wave (2026-07-04)

A second full audit at v73 (three parallel passes: core app layer, AI/sync/network layer, infrastructure/CI), followed in the same branch by fixes for every confirmed finding. All prior (v48-era) findings below were re-verified as still resolved. Baseline at audit time: 573/573 tests green, all CI checks green.

| # | Finding | Severity | Status |
|---|---|---|---|
| W-1 | Sync: outbound connector sent the full task DB on channel open, before the remote user clicked Accept (`js/sync.js` `_wireConn`) — a mistyped pairing code disclosed the vault to a stranger | High | ✅ Fixed — hello/accept handshake; `syncBroadcast`/`_scheduleSyncAck` gated on `conn._syncReady`; ≤v73 interop preserved (their eager `state`/`patch` counts as acceptance); `tests/sync-handshake.test.mjs` |
| W-2 | Ask auto-apply: prompt injection via subscribed ICS feed content could drive silent task mutations — only DELETE/bulk-move were gated (`js/ai.js:1325`, `js/ui.js` auto branch) | Medium | ✅ Fixed — turns whose read rounds ran `GET_CALENDAR_EVENTS` are tainted (`externalContent`) and always land in review; tests in `ask-pipeline` + `ask-external-taint` |
| W-3 | RRULE: `COUNT` counted only windowed emissions (exhausted rules re-materialized phantom occurrences) and iteration started at DTSTART with maxIter=2000 (active rules >~5.5y old silently vanished) (`js/calfeeds.js` `expandEventToDateRange`) | Medium | ✅ Fixed — true occurrence-position counter + DAILY/WEEKLY arithmetic fast-forward; `tests/calfeeds-rrule-window.test.mjs` |
| W-4 | Gen worker: a worker wedged in native ONNX ignored the abort message, leaving `genGenerate` unsettled forever (Ask hang, Stop no-op) (`js/gen.js`) | Medium | ✅ Fixed — 9s abort watchdog rejects with `GEN_ABORTED` and recycles the worker via the shared teardown; fake-timer tests in `gen-worker-protocol` |
| W-5 | Timer: `resetAll()` didn't cancel pending auto-advance/auto-start, so a cycle reset self-started ~300ms later (`js/timer.js`) | Medium | ✅ Fixed — same cancellation as `resetPhase`; `tests/timer-reset-pending.test.mjs` |
| W-6 | Cross-tab: `startTimer`/`resumeTimer` didn't mark the tab dirty, so another tab's autosave wholesale-applied over a running timer (`js/timer.js`, `js/storage.js` `_onStorageFromOtherTab`) | Medium | ✅ Fixed — both now `saveState('user')` like `pauseTimer` |
| W-7 | CSP: dead `cdn.jsdelivr.net` / `unpkg.com` script-src allowances + dead preconnects (everything is vendored) (`index.html`) | Low-Med | ✅ Fixed — removed |
| W-8 | Sync merge assigned remote `cfg` verbatim, bypassing the H-1 classification-config allow-list applied on import (`js/sync.js`) | Low | ✅ Fixed — `ensureClassificationConfig` after assignment |
| W-9 | Checker gaps: `check-assets.mjs` attribute-order-fragile regexes + no on-disk existence check; `check-inline-handlers.mjs` regex evaded by quoted handler bodies | Low | ✅ Fixed — hardened all three (model weights exempt from existence check by design) |
| W-10 | Event delegation: `focus`/`blur` registered bubble-phase — delegated handlers could never fire (latent) (`js/event-delegation.js`) | Low | ✅ Fixed — capture phase, like `toggle`; test added |
| W-11 | Inline fallback SW was cache-first with no revalidation (`js/pwa.js`) | Low | ✅ Fixed — stale-while-revalidate, matching `sw.js` |
| W-12 | Dropdown: prefix-only search filter; outside-listener leak on same-frame open→close (`js/dropdown.js`) | Low | ✅ Fixed — substring match; rAF cancelled in `close()` |
| W-13 | A11y: quick-timer controls and interval remove button lacked `aria-label`; pips were mouse-only (`js/timer.js`) | Low | ✅ Fixed — labels + keyboard operability |
| W-14 | Stale Open Graph/Twitter URLs (GitHub Pages origin instead of `odta.app`) (`index.html`) | Low | ✅ Fixed |
| W-15 | Dead code: legacy `settingsOpen`/`toggleSettings()` no-ops (`js/timer.js`) | Low | ✅ Fixed — removed (zero references) |

**Audit findings rejected as false positives** (verified against source before fixing): `STORAGE_KEYS.GEN_CFG`/`GEN_HISTORY` are *not* dead (actively read by `js/gen.js`; the v48 purge in `app.js` is a one-shot legacy migration), and `updateLiveParsePreview` *does* exist (`js/tasks.js:523`) so `app.js`'s fallback branch is live.

**Known residuals (deliberately not fixed in this wave):**
- ~~`_askCalendarBlock()` injects the next-7-days event digest into every Ask turn's base prompt, even with zero read rounds — a smaller prompt-injection surface than W-2 (no tool-result framing) but not covered by the taint gate. Candidate follow-up: taint when the block is non-empty, or strip it from op-producing turns.~~ ✅ Fixed in the v75 wave (X-7) — the turn is tainted whenever the block is non-empty.
- New initiator → old (≤v73) acceptor who clicks Accept *after* the channel opened: the old side's `open` handler never fires (pre-existing PeerJS late-listener bug on their end), so state flows only after the old side's next local save. No worse than old↔old today; resolves as peers upgrade.
- `connect-src` remains broad (`http: https:`) by design — user-configured CORS proxies for calendar feeds need it (documented in the CSP comment).

---

## Status as of v48 (2026-05-21)

Most findings have been resolved by subsequent feature waves. Each section below is annotated with a ✅ Fixed / 🟡 Open / 🔵 Obsolete banner. The original analysis text is preserved so readers can see what the issue was, why it mattered, and how it was addressed.

| Finding | Severity | Status | Resolved in |
|---|---|---|---|
| H-1 | High | ✅ Fixed | Allow-list + addEventListener migration |
| H-2 | High | ✅ Fixed | CSP hardened; inline handlers eliminated |
| M-1 | Medium | ✅ Fixed | `check-version-sync.mjs` extended to `pwa.js` |
| M-2 | Medium | ✅ Fixed | `pwa.js` inline stub trimmed to 5 essential fields; drift surface eliminated |
| M-3 | Medium | ✅ Fixed | `setHeaderDate()` wrapper added |
| M-4 | Medium | ✅ Fixed | Same migration as H-1 |
| M-5 | Medium | ✅ Fixed | Day-rollover decision logic extracted to `planDayRollover`; covered by `tests/day-rollover.test.mjs` |
| L-1 | Low | ✅ Fixed | Dual install-timeouts removed; single 1.5s re-sync after `DOMContentLoaded`; `beforeinstallprompt` / `refreshPWAInstallUI` still cover races |
| L-2 | Low | 🔵 Obsolete | The `escAttr`-in-inline antipattern can no longer exist (H-2 removed all inline handlers) |
| L-3 | Low | ✅ Fixed | Dynamic icon controls: calendar feed row buttons and `cal-agenda-mk` "+Task" use `aria-label`; spot-check any new glyph-only buttons |

---

## Severity legend

- **High** — exploitable security issue or live functional bug.
- **Medium** — drift, footgun, or maintainability hazard that's likely to bite within one or two more feature waves.
- **Low** — hygiene, dead code, style.

---

## High-severity findings

### H-1 — XSS via malicious backup-import (category id injection)

> ✅ **Fixed.** `ensureClassificationConfig` now strips every imported category id through a `[A-Za-z0-9_-]` allow-list (`js/intel-features.js:161`), so an imported config can no longer smuggle quotes or HTML. The original `innerHTML +=` sink at `intel-features.js:510` was also migrated to `createElement` + `addEventListener` (now at `intel-features.js:521,529`), removing the inline-handler interpolation path entirely. Combined fix means the attack is closed at both ends — both Option 1 and Option 3 from the original recommendation landed.

**Vector**: `importData` (`js/storage.js:821-845`) accepts user-supplied JSON, parses it, and applies the embedded `cfg` directly via `_applyState`. `_applyState` assigns `cfg = s.cfg` (`js/storage.js:425`). On the next render, every category id flows into an inline onclick:

```
js/intel-features.js:510
tb.innerHTML += `<button class="sv-chip ..." onclick="setFilterCategory('${c.id}')">${c.label}</button>`;
```

`ensureClassificationConfig` (`js/intel-features.js:155-175`) only trims and length-caps the id (`String(row.id || '').trim().slice(0, 64)`) — it does **not** strip quotes or HTML. `slugClassId` (the safe slugifier at `js/intel-features.js:247`) is only applied when the user creates a category through the UI (`classificationAdd`, line 390), not when a config arrives via import.

The CSP allows `'unsafe-inline'` for scripts (`index.html:34`), so a payload like `cfg.categories[0].id = "x'); alert(document.cookie); //"` executes immediately on render.

**Realistic attack scenario**: a user opens a "shared backup" `.json` file via Settings → Import or via the Web Share Target / File Handler entry points (`js/app.js:288-373`).

**Fix options** (pick one, ~5–15 lines):
1. Run `slugClassId` inside `ensureClassificationConfig` for every imported id.
2. Replace `'${c.id}'` with `${JSON.stringify(String(c.id))}` at `intel-features.js:510` (safest pattern, already used at `js/ui.js:93`).
3. Convert that whole loop to `addEventListener` and drop the inline handler.

Option 1 is the smallest blast radius; option 3 is the better long-term move (see H-2).

### H-2 — Inline event handlers force `script-src 'unsafe-inline'` in CSP

> ✅ **Fixed.** Every inline `on<event>="..."` in `index.html` was migrated to `data-action` + the central dispatcher in `js/event-delegation.js`. `'unsafe-inline'` is no longer in `script-src` (see `index.html:45` — the production CSP). `scripts/check-inline-handlers.mjs` is wired into CI (`.github/workflows/ci.yml`) and fails the build if any `on<event>=` reappears in `index.html` — so the protection can't quietly regress.

**Evidence**: `index.html:34` declares `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com`. The `'unsafe-inline'` is required because the codebase uses `onclick="..."` inline handlers in dozens of places (`index.html` nav tabs at lines 96, 112, 116, 120; many dynamically-rendered buttons in `js/tasks.js`, `js/ai.js`, `js/calfeeds.js`, `js/ui.js`, `js/intel-features.js`).

Once `'unsafe-inline'` is in `script-src`, CSP provides essentially zero defense against any future XSS bug — including H-1 above. CSP nonce/hash mode would also work but doesn't compose well with hand-rolled string-templated DOM construction.

**Fix**: migrate inline handlers to delegated `addEventListener` over time, then remove `'unsafe-inline'`. This is a multi-PR effort, not a one-shot fix. A reasonable first slice: convert `index.html`'s static nav handlers (`onclick="showTab('tasks')"` etc.) since those are hand-written and few in number.

---

## Medium-severity findings

### M-1 — Cache version is three-way coupled; CI guard misses one copy

> ✅ **Fixed.** `scripts/check-version-sync.mjs` now reads `js/pwa.js` (line 16) and verifies the inline-SW fallback string against `version.js`, in addition to the `sw.js` check. CI runs this as the "Version sync" step; the v48 cache rotation flushed all three to `odtaulai-v48` and the test enforces it.

**Evidence**: the canonical cache identifier (`odtaulai-v43`) is duplicated across three files:

- `js/version.js` — canonical (`window.ODTAULAI_RELEASE.swCache`)
- `sw.js:2` — `const CACHE_NAME = 'odtaulai-v43'`
- `js/pwa.js:52` — hardcoded fallback when `window.ODTAULAI_RELEASE` is absent: `: 'odtaulai-v43'`

`scripts/check-version-sync.mjs` regexes (1) and (2) only:
```
js/version.js:18  /swCache\s*:\s*['"]([^'"]+)['"]/
sw.js:26          /const\s+CACHE_NAME\s*=\s*['"]([^'"]+)['"]/
```

The `pwa.js` fallback can silently drift. Risk: if `version.js` fails to load (asset 404, partial cache), the inline SW gets registered with whatever the stale `pwa.js` literal says.

**Fix** (~3 lines): extend `check-version-sync.mjs` to also match the `pwa.js` literal, or load `version.js` and reference `swCache` instead of hardcoding the fallback.

---

### M-2 — `js/pwa.js` carries an inline manifest that duplicates `manifest.json`

> ✅ **Fixed.** The inline manifest was trimmed to a minimal stub covering only the 5 fields file:// install actually needs (`name`, `short_name`, `display`, `background_color`, `theme_color`, plus `icons` using the embedded SVG data: URI). `description`, `display_override`, `categories`, and `orientation` no longer live in the stub — manifest.json is the only source. `tests/pwa-manifest-sync.test.mjs` was updated: pins the remaining 5 duplicated fields and includes a regression guard that fails if the dropped fields are ever re-added to the inline stub.
>
> Note: the AUDIT originally proposed `fetch('./manifest.json')` + reinline. That was reconsidered — `fetch` reliably fails on `file://` (same-origin-from-file restrictions), so on that path we'd end up using a stub anyway. Just shipping the stub directly is simpler and skips the round-trip on the only code path that ever runs this block.

**Evidence**: `js/pwa.js:18-35` constructed a full PWA manifest inline (name, short_name, theme_color, icons, etc.) for the `file://` fallback path. Every field had to be kept in sync with `manifest.json`. Today both say `theme_color: '#0a1320'`, but there was no test or guard that they agree.

---

### M-3 — `js/utils.js:59` performs a top-level DOM mutation at module load

> ✅ **Fixed.** `js/utils.js:61` now wraps the call: `function setHeaderDate(){const el=gid('headerDate');if(el) el.textContent=dateStr();}`. `js/app.js:387` invokes it during init alongside the other `render*` calls. Tests that load `utils.js` standalone no longer crash on the missing `#headerDate`.

```
js/utils.js:59
gid('headerDate').textContent = dateStr();
```

This runs at script-evaluation time. It works today only because `<script src="js/utils.js">` is loaded after `<div id="headerDate">` exists in the document. Consequences:

- Any test that loads `utils.js` without `index.html` crashes with `TypeError: Cannot read properties of null (setting 'textContent')`. (`tests/utils-fmt.test.mjs` and `tests/utils-security.test.mjs` likely paper around this — they appear to test only individual pure functions.)
- Any future async-load reorder silently breaks the header date.

**Fix** (~3 lines): wrap in `function setHeaderDate(){ const el = gid('headerDate'); if(el) el.textContent = dateStr(); }` and call from `app.js` init alongside the other `render*` calls.

---

### M-4 — `intel-features.js:508-511` rebuilds a chip row inside a forEach loop

> ✅ **Fixed.** Resolved as a side effect of the H-1 migration. The chip row is now built via `createElement` once and listeners attached via `addEventListener` (no `innerHTML +=` inside the loop), eliminating both the O(n²) rewrite and the XSS interpolation site.

```
js/intel-features.js:508-511
tb.innerHTML = `<button ...>All Tags</button>`;
getActiveCategories().forEach(c => {
  tb.innerHTML += `<button ... onclick="setFilterCategory('${c.id}')">${c.label}</button>`;
});
```

Two problems: (a) O(n²) DOM rewrite as the browser re-parses the string each iteration; (b) any event listeners attached to existing children get stripped on every iteration. With ~7 default categories the perf impact is invisible, but it's a footgun once user-defined categories grow. (Also see H-1: this is the exact site of the XSS.)

**Fix** (~6 lines): build an HTML string once, then assign to the chip row exactly once — or use `createElement` per chip.

---

### M-5 — `js/app.js` is a 600-LOC kitchen sink with no direct test

> ✅ **Fixed (day-rollover slice).** The highest-risk piece — day-rollover decision logic — was extracted into a pure function `planDayRollover` at `js/app.js:642`, fenced by `// region planDayRollover-test-extract` markers so it can load standalone via `new Function()`. `tests/day-rollover.test.mjs` pins every branch (10 cases): same-day, first-boot, missing clock, new-day no-modal, new-day modal-open first-tick / within-window / past-cap / past-cap-already-nagged, modal-closes-after-defer, and the boundary `>=` condition that determines when the nag fires. `_handleDayRollover` (the side-effect wrapper) now reads as: gather inputs → call `planDayRollover` → switch on `action` → dispatch.
>
> Share-target / file-handler IIFEs are still untested; their effect (parsing a single URL param into a task) is small and lower-risk than day-rollover. Worth a follow-up if it bites us.

`js/app.js` contains: global error handler, persistent storage request, storage-pressure check, online/offline indicator, SW update banner + reload flow, archive load/render/clear/export-CSV, daily report generation in two formats, app init, share-target handling, file-handler ingestion, day rollover, system-info renderer, intel-load orchestration. No `tests/app*.test.mjs` exists.

This is the single largest untested coordinator in the project. A regression here (e.g., day rollover not firing after wake-from-sleep) would be invisible to CI.

**Fix**: at minimum, extract day-rollover logic (`_handleDayRollover`, lines 422-465) and the share-target/file-handler IIFEs into a testable module. See the Coverage Matrix below for the full ranking.

---

## Low-severity findings

### L-1 — `pwa.js` polls install state with two layered timeouts

> ✅ **Fixed / simplified.** The former dual `800ms + 2500ms` timeouts are now a single **1.5s** delayed `_syncInstallButtonForPlatform()` after DOM ready (`js/pwa.js:321–324`). `beforeinstallprompt` listeners still toggle the install button immediately; the delay covers deferred platform detection only.

_(Historical: the audit originally cited duplicate `setTimeout` calls compensating for `beforeinstallprompt` racing platform detection.)_

---

### L-2 — `escAttr()` is used inside inline JS handlers, but does not protect that context

> 🔵 **Obsolete.** The H-2 migration removed every inline JS handler in the codebase, so the antipattern this finding describes can no longer exist. `escAttr` is still used for HTML *attribute* values (its actual safe context) where it's correct.

`js/calfeeds.js:640-642`:
```
onclick="toggleCalFeedVisibility('${escAttr(f.id)}')"
```

`escAttr` HTML-escapes `'` to `&#39;` — which is correct for the *attribute* parser, but the HTML parser then decodes `&#39;` back to `'` *before* the JS engine sees the handler text. Inside the JS-string context that's a quote-break.

Today this is **not exploitable** because feed IDs are generated internally (`'cf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)` at `calfeeds.js:391`) and contain only `[a-z0-9_]`. But if a future code path accepts feed IDs from imported JSON or URL params, the same H-1-class injection becomes possible.

**Preventive fix**: replace `'${escAttr(x)}'` with `${JSON.stringify(String(x))}` for all inline-handler arg interpolation. The same anti-pattern appears at `js/intel-features.js:510` (already covered by H-1) and `js/ai.js:1321` (`aiToggleValue('${key}')` — `key` is from a hardcoded `VALUE_KEYS` array, currently safe).

---

### L-3 — Inline icon-only buttons rely on `title` for screen readers

> ✅ **Fixed** for audited surfaces **where still relevant after H-2**: calendar-feed row controls (`js/calfeeds.js`), day-agenda `+Task`, and related patterns now pair `aria-label` with glyphs. **Residual risk:** future dynamic glyph-only `<button>`s must repeat the same pairing — smoke does not lint a11y.

Several dynamically-rendered icon-only buttons used to rely on `title` alone. `title` is not reliably announced.

The static `index.html` markup is generally good — 67 ARIA attributes, skip-link, polite live region, `role="tablist"` with `aria-selected`. The gap remains **policy** on new dynamic buttons.

---

## Test coverage matrix

Modules ranked by **untested user-facing surface area** (lines × user-impact):

| Module | LOC | Direct test? | Risk | Notes |
|---|---|---|---|---|
| `js/ui.js` | 2601 | **No** | High | Largest module. No `tests/ui*.test.mjs`. Some behaviors covered indirectly via `tasks-tree.test.mjs`, but command palette / detail-modal / board / what-next have nothing. |
| `js/app.js` | 598 | **No** | High | See M-5. Day rollover, share-target, file-handlers, archive export are all live and untested. |
| `js/audio.js` | 353 | **No** | Medium | Timer transition cues; silently breaking is plausible. |
| `js/pwa.js` | 176 | **No** | Medium | Install prompt + SW registration + file:// fallback. Hard to unit-test, but at least the inline manifest construction could be. |
| `js/nlparse.js` | 55 | **No** | Medium | Small, but parses user free-text — bugs are user-visible. |
| `js/ui-flip.js` | 153 | **No** | Low | Animation utility. |
| `js/icons.js` | 154 | **No** | Low | Icon registry, mostly data. |
| `js/ai.js` | 2533 | Partial (3) | — | `ai-classify-apply`, `ai-split`, `hybrid-ai`. ~1500 LOC of intel-features integration paths still untested. |
| `js/intel-features.js` | 1360 | Partial (1) | — | `category-config` covers config normalization. Classification render and life-area math are not directly tested. |

**Tests covering modules well**: `js/tasks.js` (4 tests), `js/timer.js` (2), `js/calfeeds.js` (2), `js/storage.js` (2), `js/utils.js` (2), `js/sync.js`, `js/embed-store.js`, `js/intel.js`, `js/tool-schema.js`, `js/version.js`.

---

## Out-of-scope / observations

- **Stash present** — `stash@{0}: WIP on fix/ui-audit-reactive-buttons-and-ribbon — fix: reactive tool buttons, ribbon safety nets, model version sync`. Belongs to a different branch but is unfinished work. Either pop on its origin branch or `git stash drop`.
- **`peerjs.min.js` is vendored** — sync feature uses PeerJS for WebRTC. The CSP allows `wss://*.peerjs.com` connections. Out of scope for this audit; worth a separate review for the sync trust model.
- **Accessibility** — Static `index.html` is solid; pair `aria-label` with glyph-only buttons in JS render paths. CI smoke exercises nav/DOM handlers, not VoiceOver parity.

---

## Recommended triage order

**Original list (April 2026):** H-1 → M-1 → M-3 → M-5 → H-2 → M-4 → M-2 → L-*

**Status as of v48 (May 2026):** H-1, H-2, M-1, M-2, M-3, M-4, M-5 (day-rollover slice), L-2 are all closed (see annotations above). Open items, ordered by remaining risk:

1. **Regression triage** — file issues for any new icon-only controls without `aria-label` (see L-3 audit history).
2. **M-5 follow-up** — share-target / file-handler IIFEs in `js/app.js` still untested end-to-end.
3. Smoke / CI — `npm run smoke` runs in GitHub Actions; run `smoke:deep` / `smoke:exhaustive` locally for deeper coverage.
