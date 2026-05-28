<!--
  ╔══════════════════════════════════════════════════════════════════════════╗
  ║   Odta — On-Device Task App Using Local Ambient Intelligence             ║
  ║   A Pomodoro + ClickUp-style task manager that understands meaning,      ║
  ║   on your device, offline. No accounts. No telemetry. Embeddings by default;  ║
  ║   optional on-device Ask (generative) — never cloud.                          ║
  ╚══════════════════════════════════════════════════════════════════════════╝
-->

<div align="center">

<img src="icons/icon-512.png" alt="Odta" width="140" height="140" />

<br />

### **Odta**

**On-Device Task App Using Local Ambient Intelligence**

<br />

<a href="https://odta.app"><img src="https://img.shields.io/badge/%E2%96%B6%20Launch%20Odta-odta.app-7048e8?style=for-the-badge&logo=pwa&logoColor=white" alt="Launch Odta at odta.app" height="48" /></a>

**[Open the live app → odta.app](https://odta.app)** &nbsp;·&nbsp; free &amp; open source · runs in your browser · installable as an app · works offline · no account

<br />

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge)](LICENSE)
[![No Build Step](https://img.shields.io/badge/build-none-blueviolet?style=for-the-badge)](#architecture)
[![Local First](https://img.shields.io/badge/local-first-success?style=for-the-badge)](#privacy-explicitly)
[![PWA](https://img.shields.io/badge/PWA-installable-2c2c2c?style=for-the-badge&logo=pwa&logoColor=white)](#pwa--offline)
[![Offline](https://img.shields.io/badge/works-offline-blue?style=for-the-badge)](#pwa--offline)

[![Vanilla JS](https://img.shields.io/badge/vanilla-JS-f7df1e?style=flat-square&logo=javascript&logoColor=black)](#architecture)
[![No Tracking](https://img.shields.io/badge/tracking-zero-critical?style=flat-square)](#privacy-explicitly)
[![On-Device AI](https://img.shields.io/badge/AI-on--device-7048e8?style=flat-square&logo=huggingface&logoColor=white)](#the-ambient-intelligence-the-headline-feature)
[![WebGPU](https://img.shields.io/badge/WebGPU-WASM%20fallback-005cc5?style=flat-square)](#browser-support)
[![~33MB Model](https://img.shields.io/badge/model-~33%20MB-orange?style=flat-square)](#the-ambient-intelligence-the-headline-feature)

<br />

[**Live app ↗**](https://odta.app) · [**Highlights**](#highlights) · [**Get started**](#getting-started) · [**Privacy**](#privacy-explicitly) · [**Architecture**](#architecture) · [**Cheat sheets**](#keyboard-cheat-sheet) · [**FAQ**](#faq)

</div>

---

## What it stands for

> **Odta** stands for **On Device Task App** — pronounced **"OH-duh"**.

---

## Why Odta

| | Everyone else | **Odta** |
|---|---|---|
| **Data** | Cloud sync, accounts, trackers | Nothing leaves the device. No account. No analytics. |
| **"AI"** | Cloud LLM, your text leaves the device | On-device embeddings. Text stays local. |
| **Footprint** | Heavy SPA, 10 MB of JS, build pipeline | Vanilla JS, no bundler, no framework, no build |
| **Scope** | Timer **or** tasks **or** calendar | Timer + tasks + calendar feeds + P2P sync + AI, one file server |
| **Trust** | Destructive AI "fix it for me" buttons | AI **proposes** updates — you preview, apply, undo |

> [!IMPORTANT]
> **Local-first isn't a marketing word here.** The app shell, all JS libraries (Transformers.js, chrono-node, PeerJS) and the ONNX runtime are **vendored under `js/vendor/`** — open the app offline on the very first launch and tasks, timer, search, and storage all work without a network round-trip. The embedding model weights belong at `assets/models/` and are vendor-ready: commit them via `npm run fetch-models` for fully-offline AI from minute zero, or let transformers.js fetch them from Hugging Face on first AI feature use (~33 MB, cached by the browser + service worker after). The only other outbound calls the app makes are the optional calendar feeds and P2P sync **you** turn on.

---

## Table of contents

<details>
<summary><b>Click to expand</b></summary>

- [Highlights](#highlights)
  - [The ambient intelligence](#the-ambient-intelligence-the-headline-feature)
  - [Impact scoring (Pareto 80/20)](#impact-scoring-pareto-8020)
  - [Deep-work timer](#deep-work-timer)
  - [ClickUp-style tasks](#clickup-style-tasks)
  - [Input superpowers](#input-superpowers)
  - [Views & navigation](#views--navigation)
  - [Calendar feeds](#calendar-feeds-read-only-ical--ics)
  - [Optional P2P sync](#optional-p2p-sync-off-by-default)
  - [Data portability](#data-portability)
  - [PWA & offline](#pwa--offline)
  - [Bells, whistles, QoL](#bells-whistles-and-quality-of-life)
- [Getting started](#getting-started)
- [Privacy, explicitly](#privacy-explicitly)
- [Architecture](#architecture)
- [Keyboard cheat sheet](#keyboard-cheat-sheet)
- [Quick-add cheat sheet](#quick-add-cheat-sheet)
- [Browser support](#browser-support)
- [FAQ](#faq)
- [Not in scope](#not-in-scope-deliberately)
- [Contributing](#contributing)
- [License](#license)

</details>

---

## Highlights

### The ambient intelligence (the headline feature)

A compact sentence-embedding model — **`Xenova/bge-small-en-v1.5`**, 384 dimensions, about 33 MB — loads into your browser via **Transformers.js**. Every task title + description is encoded into a vector. Cosine similarity in that vector space lets the app reason about **meaning and context**, not just keywords.

Runs on **WebGPU** when available, **WASM** everywhere else (including iPhone). The model is served from `assets/models/` on the same origin and precached by the service worker — fully offline from a fresh install. **Generative Ask is opt-in** (Settings → Integrations → Generative AI): download a local SmolLM2/Qwen causal model (~135–230 MB) for conversational task planning via **Cmd/Ctrl+K → Ask** or a `?` prefix in the task input. Embeddings stay on by default; no cloud LLM, no API keys, no token streaming to a server.

What you get from embeddings (always-on when loaded):


- **Semantic search** — toggle `◎ Semantic` next to the search box. `"bills"` finds `"pay the electricity"`.
- **Smart-add suggestions** — type a new task and the app predicts life area, priority, effort, energy, tags, and target list from your existing tasks via kNN.
- **Harmonize all fields** — one click proposes updates for every task: values (Schwartz), life area, priority, effort, energy, tags (merged, never wiped). Preview diffs. Apply what you want. Undo the last 10 batches.
- **Auto-organize into lists** — route tasks to the list whose name + description matches best. Preview before apply.
- **Duplicate detection** — near-duplicate pairs by cosine ≥ 0.9, with one-click merge (annotates the task you keep, deletes the duplicate — all via the previewable pending-ops stack).
- **Similar tasks** — top neighbors surface in the task detail drawer.
- **Suggest due date** — kNN over your task history infers a sensible due date for a new task.
- **Align values only** — narrow button for Schwartz-only alignment if you don't want other fields touched.

**Generative Ask** (opt-in download) adds:

- **Edit mode** in Cmd/Ctrl+K (`?` prefix in task input) — natural language → proposed task ops
- **Review first** (default) or **Apply automatically** (Settings default + per-session toggle in chat)
- Destructive batches (delete, bulk list moves) confirm once; undo always available

- **Conversational task chat** — `"group overdue items by list and mark urgent anything due this week"` → previewable ops; auto-apply optional.
- **Parse wand** on smart-add — freeform sentences the deterministic parser misses.
- **Break down with AI** — subtask suggestions in the task detail drawer.
- **LLM rationales** on harmonize moves, auto-organize previews, what-next top pick (when the model is loaded).

### Impact scoring (Pareto 80/20)

A derived impact score ranks every active task from signals you already have — priority, due urgency, **how many other tasks this one unblocks**, values alignment, starred, **multiplied by an effort inverse** (`xs → 1.35x`, `xl → 0.7x`). Classic 80/20: high output, low input, rises.

- Smart view chip **`⚡ Impact`** — live count of the top ~20% (capped at 20).
- Sort option **`Sort: Impact (Pareto 80/20)`**.
- Inline **`⚡ impact`** badge on items in the top set, tooltip shows the numeric score.
- No new fields on tasks. No persisted state. Recomputed each render from live data.

### Deep-work timer

- **Pomodoro** with Focus / Short Break / Long Break and auto-cycle, configurable per-phase durations, long-break cadence.
- **Quick Timers** — spawn multiple named countdowns (tea, pasta, stretch) with presets from 1 min → 1 hr.
- **Stopwatch** with laps.
- **Repeating chimes** (e.g. posture check every 15 min).
- **Background-safe audio** — timers still chime when the tab is minimized: audio events are pre-scheduled on the Web Audio clock (immune to `setInterval` throttling), a silent 20 Hz oscillator keeps the tab alive, **Media Session API** puts controls in the OS, **Wake Lock** on mobile.
- **Floating mini timer** overlay that stays visible when you switch away from the Timer tab.

### ClickUp-style tasks

- **Nested subtasks**, arbitrary depth, collapsible.
- **Statuses**: Open / In Progress / Review / Blocked / Done — cycle with a click.
- **Priorities**: Urgent / High / Normal / Low / None with coloured left-stripe.
- **Due dates** with smart chips (overdue / today / soon / future), **start dates**, **reminders**, **recurring** (daily / weekdays / weekly / monthly).
- **Tags**, **starred pins**, **per-task time tracking** with rollup from subtasks.
- **Blockers** (`blockedBy`) — real dependency graph, used by the impact score.
- **Effort** (xs/s/m/l/xl), **energy level**.
- **Life areas** — seven default groups (customizable labels, icons, and accent colors in Settings → Classifications): *Body, Mind & Spirit* (purple), *Relationships* (red), *Community* (amber), *Job, Learning & Finances* (green), *Interests* (blue), *Personal Care* (pink), *General* (gray). Each can carry optional descriptive "core values" metadata (distinct from Schwartz alignment below).
- **Values alignment** (Schwartz human values) per task.
- **Checklists**, **notes**, **URL**, **completion notes** per task.
- **Multiple lists** with colours and descriptions (descriptions drive AI list routing).

### Input superpowers

- **Natural-language quick add** (via `chrono-node`):
  `Buy milk tomorrow @urgent #shopping !star ~daily`
- **Bulk paste import** — paste multi-line text into the task input, a preview modal opens with one task per line; edit before committing. Skips lines >200 chars. Routing modes: **Auto-organize** (AI picks list + category per task), **Same for all** (one list + category for the whole batch), or **Per task** (preview each row with editable list + category dropdowns, pre-filled by AI suggestions you can override).
- **Smart-add enhancement** — hit the `✦` button next to the input to prefill life area, priority, tags, and list from embeddings before you submit.
- **Drag-and-drop reorder**, subtask drop, list drop.
- **Mobile swipe gestures** — swipe right to move a task to another list, swipe left to delete (with undo), with haptic feedback.

### Views & navigation

- **List / Board (kanban) / Calendar** — all three, switchable, keyboard-accessible.
- **Smart views**: All, **Inbox** (untriaged), Today, Week, Overdue, Unscheduled, Starred, **Impact (Pareto)**, **Waiting** (blocked on someone else), **Stuck** (untouched 14+ days), **Snoozed** (hidden until a date), **Habits** (recurring / `~daily` etc.), Done.
- **Hide recurring from main lists** — optional (on by default): daily/weekly habits stay out of All/Today/Week/etc. and show in **Habits**; open **Filters** → **Display** → uncheck **Hide recurring from main** to mix them into main views.
- **Group by** priority, status, due date, or list.
- **Command palette** (`Cmd / Ctrl + K`) — fuzzy over tasks, actions, views, lists, AI commands, theme, sort, sync, everything. Toggle **Ask** or prefix with `?` for on-device generative planning (requires Generative AI download).
- **Dark and light themes** with a one-key toggle.
- **Responsive** down to 320 px; touch-first on mobile; full keyboard on desktop.

### Calendar feeds (read-only iCal / ICS)

- Subscribe to any public `.ics` URL — Google Calendar, Outlook, Fastmail, Proton, personal CalDAV exports.
- Parsed entirely in the browser (full VEVENT / VTIMEZONE / RRULE / EXDATE expansion, 180-day window).
- Events appear alongside your tasks in the Calendar view.
- Per-feed colour and visibility toggle.
- **Google secret URL:** Settings → click your calendar → **Integrate calendar** → copy **Secret address in iCal format**. Treat it like a password.
- **Troubleshooting:** a feed showing `✕ HTTP 404` means the secret address was reset (Google invalidates the old token) — grab a fresh URL and re-add the feed; the proxy stays the same.

### Optional P2P sync (off by default)

- **WebRTC via PeerJS** — paste a short code on your second device, they're linked.
- **Zero server-side state** — the PeerJS signalling server brokers the handshake; your task payload goes direct device-to-device.
- **Beta** — you can turn it off, wipe, and forget it ever existed.

### Data portability

- **Export**: full JSON (everything), CSV (spreadsheet), Markdown (human-readable).
- **Import**: JSON round-trips perfectly; CSV and plain-text task lists import cleanly.
- **Clear all** with confirmation — real delete, nothing hiding on a server.

### PWA & offline

- Installs as a standalone app on Chrome/Edge/Safari/Firefox (desktop), iOS Safari (Add to Home Screen), Android Chrome.
- **Works offline** after first visit — service worker precaches the shell.
- **Manifest shortcuts**: jump straight to "Focus Timer" or "New Task" from the OS app icon.
- **Launch handler** — deep links focus the existing window instead of spawning duplicates.

### Bells, whistles, and quality-of-life

- **Undo stack** for AI batches (last 10).
- **Save indicator** — only on user-initiated saves, never nags.
- **Today banner** — only shown when something is overdue or due today.
- **Storage telemetry** in Settings: IndexedDB quota, persistent-storage state, online/offline.
- **Optional persistent storage** prompt so "Clear browsing data" doesn't nuke your tasks.
- **Haptic feedback** on destructive mobile gestures.
- **Accessibility**: `aria-live` AI status, disabled-state semantic search until the model loads, full keyboard navigation.

---

## Getting started

### The 1-second path

**[Open odta.app](https://odta.app)** in any modern browser — nothing to install, no account, no build. Want it on your home screen or dock? [Install it as an app](#install-as-an-app) and it runs fully offline.

### Run it yourself

```bash
git clone https://github.com/iLevyTate/Odta.git
cd Odta
python3 -m http.server 8080
# open http://localhost:8080
```

Or just **double-click `index.html`** — it works from `file://` too. You lose service-worker offline and PWA install, but everything else runs.

### One-click deploys

| Host | Command | Notes |
|---|---|---|
| **Netlify Drop** | drag the repo to https://app.netlify.com/drop | 30 seconds, free, HTTPS |
| **GitHub Pages** | push, enable Pages on `main /` | free, permanent URL |
| **Vercel** | `npx vercel` | free, instant |
| **Cloudflare Pages** | connect GitHub, no build command, output `/` | free, great custom domains |

Full walkthroughs with Nginx configs, troubleshooting, custom icons, and manifest `id` guidance live in **[DEPLOY.md](DEPLOY.md)**.

### Install as an app

<details>
<summary><b>Per-platform install instructions</b></summary>

| Platform | How |
|---|---|
| Chrome / Edge desktop | Click the install icon in the address bar |
| Safari macOS | File → Add to Dock |
| iOS Safari | Share → Add to Home Screen |
| Android Chrome | ⋮ → Install app |
| Firefox desktop | Address bar install icon (desktop only) |

</details>

---

## Privacy, explicitly

> [!NOTE]
> **Odta does not** collect any data, send your tasks anywhere, use analytics / tracking / cookies, require an account / email / phone, or sync across devices unless you explicitly opt into the beta P2P feature.

**Odta does:**

- store app state in `localStorage`,
- store the embedding cache in `IndexedDB`,
- load Transformers.js, chrono-node, and PeerJS **from the same origin** — they're vendored at `js/vendor/`, never fetched from a CDN,
- load the embedding model from `assets/models/` if you've committed it (`npm run fetch-models`); otherwise fetch it once from Hugging Face on the first AI feature use, then serve subsequent loads from the browser cache + service worker,
- fetch calendar feeds you subscribe to (those servers see you),
- open a WebRTC connection to a device you explicitly pair with (PeerJS signalling server sees the handshake, not the payload).

To audit outbound traffic yourself, search the source for `fetch(`, dynamic `import(`, `XMLHttpRequest`, and `new WebSocket(`. PeerJS uses WebSockets internally for signalling when sync is enabled.

---

## Architecture

No framework, no bundler, no transpiler. Just **HTML, CSS, and vanilla JS modules** loaded in order from `index.html`.

<details>
<summary><b>Source tree</b></summary>

```
Odta/
├── index.html                single source of truth for the UI
├── manifest.json             PWA manifest
├── sw.js                     service worker (shell precache)
├── css/main.css              themed design system with CSS variables
├── js/
│   ├── config.js             CDN URLs, model id, storage keys (window.ODTAULAI_CONFIG)
│   ├── version.js            release id (keep in sync with sw.js cache name)
│   ├── utils.js              helpers, date, DOM
│   ├── storage.js            localStorage + IndexedDB persistence
│   ├── nlparse.js            natural-language quick-add (chrono-node)
│   ├── tasks.js              task model, filtering, sorting, impact scoring
│   ├── timer.js              pomodoro, quick timers, stopwatch, chimes
│   ├── audio.js              Web Audio scheduling + wake-lock
│   ├── ui.js                 renderers, command palette, task item
│   ├── ai.js                 UI glue: preview, undo, settings, smart-add
│   ├── intel.js              embedding pipeline loader + status
│   ├── intel-features.js     harmonize, auto-organize, duplicates, kNN predict
│   ├── embed-store.js        IndexedDB vector cache
│   ├── tool-schema.js        op vocabulary + validator (proposed-op pipeline)
│   ├── calfeeds.js           iCal / ICS parser + renderer
│   ├── sync.js               WebRTC P2P (PeerJS)
│   ├── pwa.js                service-worker registration + update flow
│   ├── app.js                boot, version, routing
│   └── vendor/peerjs.min.js  offline fallback for P2P signalling client
├── icons/                    PWA icons (192, 512, maskable, apple-touch, etc.)
├── DEPLOY.md
└── README.md
```

</details>

**JS dependencies** are vendored under `js/vendor/` — zero CDN calls for the app shell. **Model weights** belong at `assets/models/`; commit them via `npm run fetch-models` for a fully-vendored build, or let transformers.js fetch them once from Hugging Face on first AI feature use (cached afterwards).

| Library | Purpose | Vendored at |
|---|---|---|
| [`@huggingface/transformers`](https://huggingface.co/docs/transformers.js) v3.3.1 | on-device embeddings | `js/vendor/transformers/` (incl. ORT WASM) |
| [`Xenova/bge-small-en-v1.5`](https://huggingface.co/Xenova/bge-small-en-v1.5) | 384-dim sentence embedding model (~33 MB) | `assets/models/Xenova/bge-small-en-v1.5/` *(run `npm run fetch-models` once to populate)* |
| [`chrono-node`](https://github.com/wanasit/chrono) v2.7.7 | natural-language dates | `js/vendor/chrono-node.min.mjs` |
| [`peerjs`](https://peerjs.com/) v1.5.4 | WebRTC signalling client | `js/vendor/peerjs.min.js` |

Everything else is hand-written.

---

## Keyboard cheat sheet

| Action | Shortcut |
|---|---|
| Command palette | <kbd>Cmd/Ctrl</kbd> + <kbd>K</kbd> |
| Go to Tasks / Focus / Tools / Data / Settings | <kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd> / <kbd>4</kbd> / <kbd>5</kbd> *(from palette)* |
| Toggle theme | palette → "Toggle theme" |
| Toggle semantic search | palette → "Toggle semantic search" |
| Impact view | palette → "Impact view" |
| Sort by Impact | palette → "Sort by Impact" |
| Start / stop focus timer | palette → "Start focus timer" |
| Add new list | palette → "Add new list" |
| Find duplicates | palette → "Find duplicate tasks" |
| Harmonize all fields | palette → "Harmonize all fields" |

All palette actions fuzzy-match — you rarely need to remember the exact label.

## Quick-add cheat sheet

```text
Buy milk tomorrow @urgent #shopping !star ~daily
│        │        │       │         │     └─ recurrence: daily | weekdays | weekly | monthly
│        │        │       │         └─ star flag
│        │        │       └─ tag
│        │        └─ priority: urgent | high | normal | low
│        └─ date: natural language (chrono-node — "next Monday at 3pm", "in 2 hours", …)
└─ task name
```

Paste multiple lines at once for **bulk import** — you'll get a preview modal.

---

## Browser support

| Browser | Local use | PWA install | Background audio | Offline | WebGPU AI |
|---|:---:|:---:|:---:|:---:|:---:|
| Chrome / Edge desktop | ✓ | ✓ | ✓ *(while open)* | ✓ | ✓ |
| Chrome Android | ✓ | ✓ | ✓ *(while open)* | ✓ | partial |
| Safari macOS | ✓ | ✓ | ✓ | ✓ | ✓ *(17+)* |
| Safari iOS | ✓ | Add to Home | limited | ✓ | WASM fallback |
| Firefox | ✓ | desktop only | ✓ | ✓ | WASM fallback |

The AI falls back from **WebGPU → WASM** automatically; no action required from you.

---

## FAQ

<details>
<summary><b>Is my task text ever sent to a server?</b></summary>

No. The embedding model runs locally via Transformers.js. The only outbound calls are the one-time model download from Hugging Face / jsDelivr and whatever integrations you explicitly enable (calendar feeds, P2P sync).

</details>

<details>
<summary><b>Why a small embedding model instead of a chat LLM?</b></summary>

Chat LLMs are too big for a phone, need a cloud, and hallucinate. A 33 MB embedding model answers "what does this task mean?" deterministically, on-device, in milliseconds.

</details>

<details>
<summary><b>How do I get the AI features to work?</b></summary>

Open the **Tools** tab. The embedding model is served from `assets/models/` (same-origin, no network) and loads on first use. If you cloned a build without the model weights, run `npm run fetch-models` once to populate them. A status chip in the header shows load progress; click it to retry if something fails.

</details>

<details>
<summary><b>Will clearing site data delete my tasks?</b></summary>

Yes — grant **persistent storage** in Settings to prevent this. Or export JSON periodically; it round-trips perfectly.

</details>

<details>
<summary><b>Can I sync across devices without the cloud?</b></summary>

Yes — the beta P2P sync uses WebRTC. Your data goes peer-to-peer; only the handshake touches a signalling server.

</details>

<details>
<summary><b>How do I run this on a corporate network that blocks CDNs?</b></summary>

All JS dependencies are vendored under `js/vendor/`, so the app shell and every feature except the AI pipeline work with zero outbound calls. The embedding model weights are the one piece that may need to come from Hugging Face on first load — to avoid that, run `npm run fetch-models` on a machine that *can* reach `huggingface.co`, commit the resulting files under `assets/models/Xenova/bge-small-en-v1.5/`, and the AI features become fully offline too. Every URL the app touches is centralized in [`js/config.js`](js/config.js) (`window.ODTAULAI_CONFIG`); point `MODEL_BASE_PATH` at your own mirror if you'd rather host the weights yourself.

</details>

<details>
<summary><b>How do I get the embedding model into <code>assets/models/</code> on a fresh clone?</b></summary>

Run `npm run fetch-models` once. The script in [`scripts/fetch-models.mjs`](scripts/fetch-models.mjs) downloads the ~33 MB of weights from Hugging Face into `assets/models/Xenova/bge-small-en-v1.5/`. Commit the result and anyone who clones the repo afterwards gets a fully offline build with no model download.

</details>

<details>
<summary><b>Can I remove the AI entirely?</b></summary>

Yes. Delete `js/ai.js`, `js/intel.js`, `js/intel-features.js`, `js/embed-store.js`, `js/tool-schema.js` and remove their `<script>` tags. Tasks, timer, sync, and calendar keep working.

</details>

<details>
<summary><b>Why vanilla JS?</b></summary>

Frameworks rot. `git clone`, open in any browser, and in 10 years this will still work. No npm install, no lockfile drift, no "recompile the universe to change a button."

</details>

---

## Not in scope (deliberately)

- **Cloud generative LLM** — no OpenAI/Anthropic/Gemini calls, no subscription "Brain", no server-side chat. On-device generative Ask is optional and stays 100% local.
- Cloud accounts, user profiles, team features.
- Analytics. Telemetry. A/B tests. "Engagement."
- Push notifications to your phone while the app is fully closed (browsers don't allow this without a cloud backend — by design).

If you need any of the above, this isn't the right app. That's the point.

---

## Contributing

> [!NOTE]
> **Git hygiene confession:** much of this repo's history is straight-to-`main` commits. PRs are very welcome — be the responsible one.

Pull requests welcome. Keep it:

- **vanilla** (no framework, no build step),
- **local-first** (no new outbound calls without an opt-in),
- **small** (every feature earns its kilobytes),
- **accessible** (keyboard and screen reader).

Before committing, run `node --check` on the same file list as [`.github/workflows/ci.yml`](.github/workflows/ci.yml) (or copy the one-liner from that workflow), then **`npm test`**. **`npm ci`** installs Puppeteer once; **`npm run serve:smoke`** in another terminal and **`npm run smoke`** catches nav/wiring regressions locally (same flow as CI). See [docs/MANUAL_QA_MATRIX.md](docs/MANUAL_QA_MATRIX.md) for widths, themes, `file://` vs HTTPS, embedding load UI, and PWA install checks.

See also: **[CONTRIBUTING.md](CONTRIBUTING.md)** · **[ARCHITECTURE.md](ARCHITECTURE.md)** · **[SECURITY.md](SECURITY.md)** · **[DEPLOY.md](DEPLOY.md)**.

---

## License

**MIT.** Do what you want. Attribution appreciated but not required. See [LICENSE](LICENSE).

---

## Credits

Built with:

- [Transformers.js](https://huggingface.co/docs/transformers.js) — on-device inference.
- [`Xenova/bge-small-en-v1.5`](https://huggingface.co/Xenova/bge-small-en-v1.5) — the embedding model.
- [chrono-node](https://github.com/wanasit/chrono) — natural-language date parsing.
- [PeerJS](https://peerjs.com/) — WebRTC signalling client.

Inspired by ClickUp, Things, Todoist, OmniFocus, and the long-standing tradition of Pomodoro apps that don't need an account.

Everything else — vanilla HTML, CSS, JS, and a lot of care.
