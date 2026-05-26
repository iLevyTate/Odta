# UI consistency checklist

This complements [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md): shared tokens live in `:root` in [`css/main.css`](../css/main.css). New UI should reuse these primitives instead of one-off pills.

## Primitives

| Class | Role |
|--------|------|
| `.ui-chip` | Pill base — padding 12–13px feel, rounded full, bordered `var(--border)` |
| `.ui-chip--dot` | Leading coloured dot via `--ui-chip-dot` or `--sv-cat` |
| `.list-chip`, `.smart-views .sv-chip` | Interactive list / smart-view variants (aligned with `.ui-chip`) |
| `.sv-chip--cat` | Life-area filter chips (`--sv-cat` + colour-mix active) |
| `.mfield-chip-btn--cat` | Task modal category row (uses `--md-cat` for tint) |

## Surface map

| Area | Tokens / primitives |
|------|---------------------|
| Compact filter bar (Tasks) | `.fb-*`, `.ft-count`; mobile 2×2 grid ≤480px |
| Sheets (lists / life areas / view) | `.sheet-section-lbl`, `.sheet .smart-views`; non-category `.sv-chip` matches list-chip calm active |
| View sheet → Display row | `.task-toolbar-display-head` / `.task-toolbar-display-checks` stacked on narrow |
| Active filters bar | `.af-main-row`, `.af-footer-row` + `.qpc--*` hues |
| Settings nav | `.set-nav-btn.active` matches calm chip (`--bg-3`, `--border-strong`) |
| Life areas (Settings editor) | `.class-mgr-chip-preview-bar` + `.ui-chip--preview` |
| Tools → pending ops | `.pending-move-*`, mobile `max-height: min(50vh,420px)` |
| Focus tab form labels | `.fl` typography aligned with section labels |

## Manual spot-check

- 320px / 375px / 640px: filter bar triggers, badges, sheets wrap without clipping.
- Life-area sheet chips and list chips visually rhyme.
- Task modal category active state keeps category hue, not generic accent fill.
