# Manual QA matrix

Use this checklist when you need confidence beyond CI (layouts, gestures, offline, real devices). Automated coverage: `npm test`, `npm run smoke` (in CI), and locally `npm run smoke:deep` plus `npm run smoke:exhaustive` after `npm run serve:smoke` in another terminal.

**Environment:** HTTPS or localhost, **not** raw `file://` for embedding/PWA fidelity.

## Viewports & theme

Repeat at **360**, **640**, and **960** px width — or rely on exhaustive smoke screenshots `tests/screenshots/exhaustive-w*.png`.

- [ ] Light and dark themes; text remains readable.

## Tasks

- [ ] NL quick-add (`@p1`, `#tag`, dates), ✦ suggestions (with model loaded)
- [ ] Smart views and list/board/calendar; search operators + semantic toggle
- [ ] Task detail: status, dates, checklist, recurrence, close/save
- [ ] Bulk select, reorder / indent modes, swipe (touch device)

## Timer

- [ ] Pomodoro phases, pause/skip; quick timers; stopwatch laps
- [ ] Floating mini-timer when leaving Focus tab

## Tools (intel)

- [ ] Model download / error state; harmonize preview → apply → undo
- [ ] Destructive actions still require confirmation

## Data / Settings

- [ ] Export backup and import dry-run restore
- [ ] Encrypted backup round-trip (spot-check)
- [ ] Optional: P2P sync pairing; ICS feed add/remove

## Cross-cutting

- [ ] Cmd+K palette; keyboard focus trap in modals
- [ ] PWA install banner (HTTPS); offline reload after SW cache
