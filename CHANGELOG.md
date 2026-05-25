# Changelog

## v54 — 2026-05-25

- **Drag-to-reorder works again, on desktop and touch.** The drag grip only rendered in "Manual" sort (default is Smart), so there was nothing to grab — now it always renders, and dragging from any sort reorders and locks the list to manual. On mobile the grip is a real 34px touch target that coexists with swipe (Sortable scopes drags to the handle; the row's swipe handler ignores touches that begin on it).
- **Reliable touch gestures**: task rows get `touch-action: pan-y` so the browser reserves horizontal swipes for move/delete instead of treating them as scroll/back-nav; Sortable uses its pointer-tracked fallback (`forceFallback`) because native HTML5 drag never fires from a touch.
- **Drag stability**: task-list re-renders are frozen for the duration of a drag and flushed once on drop. A background refresh (duplicate scores, sync, day rollover) firing mid-drag previously detached the dragged row and crashed Sortable's fallback, or reset the order before it was saved.
- Docs realigned with the delete+undo / swipe rework (README, ARCHITECTURE) and the CHANGELOG backfilled to v53.
- Service worker cache rotated to `odtaulai-v54`.

## v53 — 2026-05-25

- **Task delete + undo replaces archive.** The per-task archive ("recycle bin") is gone; tasks are deleted directly with an undo toast. The old `ARCHIVE_TASK` / `RESTORE_TASK` AI ops were removed and duplicate-merge now annotates the kept task and deletes the duplicate. A one-shot migration permanently drops any previously-archived tasks. Day-streak copy clarified.
- **Mobile swipe gestures reworked**: swipe **right** now opens a list picker to move the task to another list (was "mark done"); swipe **left** deletes (with undo). Membership-aware auto-organize and task clustering added.
- **Mobile task-list UX wave (P1–P4)**: filter chrome consolidated into a single bar with bottom sheets (P1); decluttered task rows plus a dedicated reorder/indent mode (P2); collapsible parent cards with tap-to-open subtasks on the board (P3); thumb-zone add sheet and a top bulk-action bar (P4).
- **List-view redesign**: reworked selection, category, and control highlights; list scroll position is preserved across task updates; added "date added" and "recently updated" sorts.
- **Fixes**: bulk-select toolbar no longer renders as a distorted oval on mobile; calendar month grid no longer overflows its container; calfeeds collapse duplicate calendar occurrences in queries; text selection suppressed on the filter bar and quick-add controls; on-load layout shift, FAB overlap, and an undismissable toast resolved.
- **Rebrand**: display name OdTauLai → **Odta** (internal storage keys and cache prefix unchanged); prominent live-app launch button in the README; CNAME added.
- Service worker cache rotated to `odtaulai-v53`.

## v49–v52 — 2026-05-22 → 2026-05-23

- **Offline-first**: every runtime dependency is now vendored and the embedding model weights are committed to the repo, so ambient AI works from the first launch with no network round-trip. A remote fallback still lets fresh installs fetch weights if the bundled copy is unavailable.
- **Bulk-import routing**: choose how each pasted task is routed — Auto-organize, Same-for-all, or Per-task — with self-audit gaps from the import flow closed.
- **Model-loader hardening**: vendored module URLs now resolve against the document base (fixes 404s), with improved error handling and logging around model load failures; secret-scanning ignores vendored runtime deps to avoid false positives.
- Service worker cache rotated through `odtaulai-v49` → `odtaulai-v52` to push these to returning users.

## v48 — 2026-05-21

- **Removed generative AI (Ask) entirely.** The on-device LLM (SmolLM2 / Qwen2.5 via Transformers.js), the Ask chat sheet, the `?` task-input prefix, the GenAI settings panel, the download ribbon, and all LLM-only surfaces (Daily brief, Weekly review, AI rephrase, AI suggest tags, "Break down with AI", parse-with-LLM smart-add button, AI rationale annotations on harmonize/auto-organize/dedupe/what-next) are gone. Embedding-based ambient intelligence stays — semantic search, kNN metadata prediction, life-area classification, values alignment, duplicate detection, list routing, due-date kNN suggestion — all unchanged.
- **Single mobile-friendly embedding model**: `Xenova/bge-small-en-v1.5` (384-dim, ~33 MB quantized) now runs on every device. Dropped the WebGPU/WASM dual-model split — bge-small works equally well on both backends, simplifying the load path and shrinking the WebGPU download from ~110 MB to ~33 MB.
- **Auto-load on first idle**: the embedding model now warms up automatically via `requestIdleCallback` after first paint. No more "Load model first" toggle for ambient features — they just work after the one-time download.
- **Storage migration**: bump to `bge-small-en-v1.5-unified-v3` triggers a one-shot re-embed of open tasks on first boot. `GEN_CFG` / `GEN_HISTORY` localStorage keys are no longer written.
- **Deleted**: `js/gen.js`, `js/ask.js`, `tests/gen-autoload.test.mjs`, `tests/gen-cfg.test.mjs`, `tests/gen-native-tools.test.mjs`, `tests/hybrid-ai.test.mjs`, `tests/ask-pipeline.test.mjs`, `tests/tasks-input-ask-prefix.test.mjs`.
- Service worker cache rotated to `odtaulai-v48`.

## v46 — 2026-04-30

- **Ask (`?` prefix)**: completed the third Ask-LLM entry point promised in README — typing `? archive everything done last week` (or any line beginning with `?`) into the main task input now opens the command palette in Ask mode with the rest of the line pre-filled and the caret at end-of-text. Previously only Cmd/Ctrl+K and the Ask toggle chip routed to Ask; the `?` prefix in the main input fell through to `addTask()` and created a literal task. Smart-add preview is cleared during the routing so it can't intercept the next Enter (`js/tasks.js` `onTaskInputKey`, `js/ui.js` `openCmdK` gains `opts.prefill`).
- **Regression test**: `tests/tasks-input-ask-prefix.test.mjs` (+7 tests) locks the routing contract — `?` precedence over smart-add preview, mid-string `?` stays literal, bare `?` opens Ask with empty prefill, and plain Enter still falls through to addTask. Suite is now 188 / 188.
- Service worker cache rotated to `odtaulai-v46`.

## v32 — 2026-04-21

- **Icons**: Vector-first brand assets — `icons/icon.svg` (master squircle), `icons/icon-maskable.svg` (full-bleed, ~80% safe zone for Android adaptive icons), and `icons/icon-small.svg` (thick strokes for 16–32 px). PNGs (`favicon-32`, `apple-touch-icon`, `icon-192`, `icon-512`, `icon-maskable-512`) are generated via `npm run build:icons` (`scripts/build-icons.mjs`, `@resvg/resvg-js`). Navy radial background matches theme `#0a1320`; removed stale unused `icons/logo-full-256.png`.
- **Header**: Inline SVG logo in `index.html` (no extra fetch); SVG favicon linked before the 32×32 PNG fallback; `.header-logo` no longer uses a bordered “sticker” frame.
- **Bugfix**: Re-opening the task-detail modal clears `mdBreakdownBody.dataset.loaded` so “Break down with AI” lazy-load runs again instead of staying empty (`js/ui.js`).
- Service worker cache rotated to `odtaulai-v32` (precache includes `icons/icon-small.svg` for offline SVG favicon).

## v31 — 2026-04-21

- **Hybrid AI (embedding + LLM)**: the always-on embedding model keeps owning the fast, deterministic surface (similarity, kNN metadata, live search, duplicate candidates, auto-organize proposals). The opt-in generative LLM is now invited in *only* where deeper reasoning pays off — every LLM call races a short timeout and silently falls back to embedding-only behaviour if the model isn't loaded or responds too slowly. No feature regresses when the LLM is off.
- **Ambient rationales**: `UPDATE_TASK`/move proposals in the Intel pending stack now carry an optional `_rationale` explanation from the LLM (e.g. *"marked high because description says 'before friday demo'"*) surfaced in the preview card. The validator (`js/tool-schema.js`) accepts `_rationale` or `rationale` on any op, sanitises control bytes, clamps to 240 chars, and never lets the field reach `executeIntelOp` — so a noisy explanation can never mutate task state.
- **Values alignment**: `aiAlign()` and `intelHarmonizeFields()` now ask the LLM for a one-sentence, task-specific `valuesNote` (via `genValuesNote`), replacing the generic *"Cosine similarity vs Schwartz value descriptions"* string when the LLM is available.
- **Duplicate adjudication**: `intelFindDuplicatesUI()` feeds the top embedding-ranked candidate pairs to the LLM (`genDedupeJudge`, capped at 6) for a *same / partial / different* verdict plus a short reason — helps break ties when cosine similarity alone is ambiguous.
- **Refine low-confidence harmonize fields**: when the embedding-based per-field confidence is below threshold, the LLM re-reads the task and prunes fields it can't justify (`genRefineTaskUpdate`). High-confidence fields are never touched; the LLM only narrows the proposal.
- **Break down with AI**: new accordion in the task-detail modal (visible only when the LLM is loaded). Generates 2–6 imperative next-action subtasks with per-subtask effort chips; user checks the ones they want and "Add as subtasks" creates real child tasks under the parent.
- **Parse freeform sentence**: new wand-icon button next to the smart-add sparkles. When the input is a messy natural-language sentence (≥ 8 chars), the LLM extracts `name`/`priority`/`dueDate`/`effort`/`tags` and populates the smart-add preview chips. Deterministic nlparse still owns the common shortcut cases.
- **What-next explainer**: the three top picks in the What-next overlay are still ranked by embedding + rules; a one-sentence LLM rationale (`genExplainRanking`) fades in under the top pick when available.
- **Auto-organize rationales**: proposed list moves include an LLM-generated *"why this list"* note (`genExplainMove`) on the first 6 moves.
- **New LLM helpers** (in `js/gen.js`, all `_rationale`-safe and with `null`-on-failure contracts): `genRefineTaskUpdate`, `genDedupeJudge`, `genSuggestTags`, `genValuesNote`, `genParseFreeform`, `genBreakdownTask`, `genExplainRanking`, `genExplainMove`. Each uses bounded `maxTokens`, low temperature, and shares the tolerant JSON extractor that strips code fences / trailing prose / handles truncation.
- **Icon**: added `wand` glyph for the LLM parse affordance.
- **Tests**: new `tests/hybrid-ai.test.mjs` (+9 tests) covering rationale passthrough, adversarial-rationale sanitisation, LLM JSON extractor edge cases (truncation, fenced code, embedded prose, first-line clamp). Full suite: 52/52 passing.
- Service worker cache rotated to `odtaulai-v31`.

## v30 — 2026-04-21

- **Breaking — task model**: Removed per-task **context** (work / home / phone / computer / errands). Export/import ignores any legacy `context` column on CSV/JSON.
- **Life areas**: Replaced the eight default **life categories** (health, finance, work, …) with seven **life areas** — Body, Mind & Spirit; Relationships; Community; Job, Learning & Finances; Interests; Personal Care; General — each with a color accent on chips, optional metadata (description + core values), and Settings UI to rename, reorder, hide, or add custom areas. Schwartz **values alignment** is unchanged.
- Service worker cache rotated to `odtaulai-v30`.

## v29 — 2026-04-21

- Hotfix (critical): the Tools panel and the Generative AI settings section went blank after the v28 release. Root cause: both `js/gen.js` and `js/ai.js` declared `let _genLastError` at the top level, and because classic `<script>` tags share one lexical scope, the second `let` threw `SyntaxError: Identifier '_genLastError' has already been declared`, which silently killed every function defined in `ai.js` (task-understanding panel, `renderGenSettings`, `toggleGenEnabled`, smart-add, promo chip sync, etc.). Renamed the `ai.js` per-model mirror to `_askLoadError`; the authoritative error string still lives in `gen.js` and is surfaced via `getGenLastError()`.
- Regression guard: new `tests/script-scope.test.mjs` concatenates every `<script src="js/*.js">` in `index.html` load order and parses them in a single lexical scope, so any future duplicate top-level `let`/`const`/`class` across classic scripts fails CI with a message naming the offending identifier.
- Service worker cache rotated to `odtaulai-v29` so existing v28 installs pick up the fix on next load instead of continuing to serve the broken bundle from cache.

## v28 — 2026-04-21

- Ask (generative): fix "stuck download" UX — download/cached/loaded state is now honest per-model. Progress bar aggregates bytes across files (no more snap-back when a new file starts), status text updates while downloading, and errors persist inline until the user retries or switches models.
- Ask: switching between model presets no longer erases the per-model "cached" flag; the dropdown now shows "✓ cached" next to models whose weights are already in the browser HTTP cache.
- Ask: auto-load the LLM on boot when it was previously enabled and cached (never downloads without consent).
- Ask: "Open Settings" fallback from the command palette now deep-links into the Integrations accordion and focuses the download button.
- Performance: 1-second active-timer tick no longer re-renders the entire task list — it patches only the live row + floating banner, fixing hover/scroll flicker and CPU burn on long lists.
- Performance: hoisted the per-row `listsWithTasks` computation out of `renderTaskItem` (was O(N²) on every render).
- Correctness: `gen.js` now rejects `genLoad` fast when a different model is already in flight instead of silently handing back the in-progress pipeline; `genGenerate` clears its `AbortController` in `finally` so a failed generation can't poison the next `genAbort` call.
- Correctness: IndexedDB "backup recovery" in `loadState` no longer clobbers live edits — it only restores when the in-memory state is still pristine, otherwise surfaces a toast.
- Security (low-likelihood XSS): escape `note.createdAt` and smart-add chip enum fields before injection.
- Mobile: body now uses `min-height: 100dvh` (with `100vh` fallback) so iOS Safari's address bar no longer hides the bottom of the app.

## v27 — 2026-04-21

- **Ask mode (opt-in generative LLM)**: new command-palette sub-mode (`Ctrl/⌘+K`, prefix `?`) turns plain-English requests into a previewable batch of the existing `executeIntelOp` operations. Default model is `HuggingFaceTB/SmolLM2-360M-Instruct` q4 (~230 MB), with a tiny 135M preset, a bigger Qwen2.5-0.5B preset, and `onnx-community/*` mirror fallbacks. Strictly opt-in: nothing downloads until the user toggles Settings → Integrations → Generative AI and clicks Download. Runs on-device via Transformers.js (WebGPU → WASM).
- **New files**: `js/gen.js` (LLM loader), `js/ask.js` (retrieval-augmented tool-calling orchestrator), `js/tool-schema.js` (pure-JS validator for 21 op types with enum coercion, id checks, 50-op cap, destructive-level aggregation).
- **Safety**: every LLM-proposed op flows through the existing `_pendingOps` preview + 10-deep undo stack; never auto-applies; destructive batches (`DELETE_TASK`, or ≥5 mass `ARCHIVE_TASK`/`CHANGE_LIST`) require an extra `confirm()` before apply.
- **Resilience (hotfix + audit pass)**: auto-fallback between `HuggingFaceTB/*` and `onnx-community/*` mirrors on 401/403/404 (the initial launch shipped non-existent `Xenova/SmolLM2-*` slugs); `InterruptableStoppingCriteria` for real mid-generation abort; cancellable download; friendly error translation; one-shot `cfgVersion` migration off the stale Xenova slugs for existing installs; abort-race cleanup when leaving Ask mode, closing the palette, or toggling the `?` prefix mid-turn.
- **UX**: header chip composes embedding + LLM state separately; promo chip near the task input appears when the LLM is ready; undo button tooltip shows batch source ("6 changes via ask"); ArrowUp input-history recall; Clear Ask history and Clear LLM cache buttons in Settings; low-RAM devices default to the 135M Tiny preset.
- **Tests**: +33 regression tests across validator, config migration, Ask pipeline, prompt-injection resistance, and alt-slug gating.
- **Docs**: README stance updated (cloud LLMs remain forbidden); `ARCHITECTURE.md` documents the RAG flow; `DEPLOY.md` notes the CSP allow-list for the HF CDN.
- Content-Security-Policy widened to allow `cdn.jsdelivr.net` + Hugging Face hosts for the one-time model fetch; service worker continues to bypass the LLM CDN so weights live in the browser HTTP cache rather than the SW cache.

## v26 — 2026-04-21

- Security: CSP meta tag, XSS hardening (attribute contexts, smart-add tags), inbound P2P accept/reject gate, sync timestamp clamping, calendar fetch URL/timeout/size limits, CSV formula injection mitigation, aligned inline service worker cache policy with main `sw.js`.
- Correctness: midnight rollover archives then resets daily counters safely; local `completedAt` timestamps for "done today"; `resumeTimer` restarts keepalive; monthly recurrence day clamp; RRULE `COUNT=0` returns no occurrences; calendar month navigation uses local `YYYY-MM`.
- Performance / UX: debounced auto-save; chunked duplicate-similarity scans; single-flight `intelLoad` / Schwartz embeddings; filters summary line; command palette footer hints; search clear + semantic pill; swipe tip + today-banner snooze; drag handle when sort is manual; export toasts; floating mini timer wording in README.
- DX: `js/version.js` release anchor, `LICENSE`, docs (`SECURITY`, `CONTRIBUTING`, `ARCHITECTURE`), CI smoke tests for version ↔ service worker sync.
