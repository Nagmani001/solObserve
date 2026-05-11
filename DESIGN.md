# SolObserve Design System

## Color strategy

Restrained. Tinted off-white surface, deep ink, one accent ≤10%. Status colors used only for actual state.

## Tokens (OKLCH)

### Surface

- `--bg`: `oklch(98.5% 0.004 80)` — warm paper
- `--bg-elevated`: `oklch(100% 0 0)` — pure white for inputs / data tables
- `--bg-sunken`: `oklch(96.5% 0.005 80)` — subtle recess (code blocks, signature pills)

### Ink

- `--ink`: `oklch(18% 0.018 250)` — primary text, slight blue tint
- `--ink-mid`: `oklch(45% 0.012 250)` — secondary text, labels
- `--ink-faint`: `oklch(65% 0.008 250)` — placeholder, disabled

### Lines

- `--line`: `oklch(90% 0.006 80)` — hairline divider, 1px
- `--line-strong`: `oklch(82% 0.008 80)` — focused input border

### Accent (one, used ≤10%)

- `--accent`: `oklch(58% 0.17 45)` — burnt-orange. CTAs, focused links, selected state.
- `--accent-soft`: `oklch(95% 0.04 45)` — accent backgrounds (pills, highlight rows)

### Status (semantic only, never decorative)

- `--ok`: `oklch(55% 0.13 145)` — green for success state
- `--fail`: `oklch(55% 0.18 25)` — red for error state
- `--warn`: `oklch(70% 0.13 75)` — amber for warning

## Typography

- **Sans** (UI, body, headings): system sans `ui-sans-serif, -apple-system, "Inter", sans-serif`
- **Mono** (addresses, signatures, code, numbers in data): `ui-monospace, "JetBrains Mono", "Geist Mono", monospace`

### Scale (ratio 1.333)

| Token         | px  | use                    |
| ------------- | --- | ---------------------- |
| `--text-xs`   | 11  | meta labels            |
| `--text-sm`   | 13  | body                   |
| `--text-base` | 15  | reading                |
| `--text-md`   | 17  | section headings       |
| `--text-lg`   | 24  | page titles            |
| `--text-xl`   | 36  | hero numbers / display |
| `--text-2xl`  | 48  | landing-only           |

Weights: 400 body, 500 emphasis, 600 headings. No 700/800.

## Spacing

Stepped, not linear. Forces rhythm.

| Token   | px  |
| ------- | --- |
| `--s-1` | 4   |
| `--s-2` | 8   |
| `--s-3` | 16  |
| `--s-4` | 24  |
| `--s-5` | 40  |
| `--s-6` | 64  |
| `--s-7` | 96  |

## Geometry

- Radius: 4px default (`--r`), 0 for full-width edges, 8px max (input groups). No 12px+ pill shapes.
- Borders: 1px hairline. No 2px+ side stripes ever.
- Shadows: avoid. Hairline borders carry separation. Single soft shadow allowed for popovers: `0 1px 0 rgba(0,0,0,0.04), 0 8px 24px -12px rgba(0,0,0,0.12)`.

## Motion

- Default duration: 160ms
- Easing: `cubic-bezier(0.22, 1, 0.36, 1)` (ease-out-quart)
- Only animate transform + opacity + color. Never width/height/padding/margin.

## Components

### Button

- Default: `bg: --accent`, `text: --bg`, weight 500, padding `8 16`, radius 4, hairline border `--accent` darker 10%.
- Secondary: `bg: transparent`, `text: --ink`, border `1px --line-strong`.
- Ghost: text-only, hover background `--bg-sunken`.

### Input

- `bg: --bg-elevated`, border `1px --line`, padding `10 12`, radius 4.
- Focus: border `--accent`, no box-shadow ring.
- Label sits above, `--text-xs`, `--ink-mid`, uppercase tracking 0.04em.

### Data row (no cards by default)

- Hairline bottom `1px --line`. Padding `12 0`. No container.
- Hover: `bg --bg-sunken`.

### Mono pill (address / signature)

- `bg: --bg-sunken`, `font: mono`, `--text-xs`, padding `2 6`, radius 4. Click to copy.

### Section

- Heading `--text-md` weight 600.
- Eyebrow above heading: `--text-xs` uppercase tracking 0.06em `--ink-mid`.
- Followed by hairline divider.
