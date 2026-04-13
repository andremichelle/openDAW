# Unified Statistics Dashboard

Status: **shipped** (initial version live at `/stats`). Iterating on layout & content.

## Goal
Single statistics dashboard at `/stats`, replacing the four legacy stats sub-pages, styled with openDAW's existing color tokens (`--color-blue`, `--color-purple`, `--color-cream`, panel backgrounds), inspired by the Creative Tim dark dashboard reference.

## Current layout (as of 2026-04-12)
1. **Header** — `Statistics` title + `Updated <timestamp>`.
2. **Tiles row** — auto-fit grid (`repeat(auto-fit, minmax(22rem, 1fr))`). All tiles share the same `Tile` component (`label`, `value`, `icon`). Currently shows:
   - GitHub stars · GitHub forks
   - Discord members · Discord online
   - Errors fixed (percentage only, from `logs.opendaw.studio/status.php`)
   - Peak users (range) — only live KPI; updates when the range changes
3. **Hero card** — `Daily Peak Users` line chart (full width). The continuous range slider is **inside** this card, padded `40px` left / `16px` right to align with the chart's data area.
4. **Two compact cards** (half width each):
   - `Daily Live Rooms` — line chart
   - `Daily Live Rooms Hours` — bar chart (minutes from server are converted to hours via `minutesToHours`)

## File map
```
packages/app/studio/src/ui/pages/stats/
  DashboardPage.tsx        — page, grid, range model, tile/series wiring
  DashboardPage.sass       — grid + tiles + cards + range control
  charts.tsx               — LineChart, BarChart (both subscribe to ObservableValue<DailySeries>)
  components.tsx           — Card, Tile, RangeControl
  data.ts                  — fetchers + types + helpers
```

## Key architecture decisions
- **Charts subscribe to `ObservableValue<DailySeries>`** (not props). Created once, re-render on series-change OR resize. Avoids the recreation/lifecycle bug we hit when rebuilding charts on every range tick.
- **Range model**: shared `DefaultObservableValue<readonly [number, number]>` of indices into the union date list. On change, `StatsBody` slices the three series (`liveRoomsSeries`, `liveHoursSeries`, `peakUsersSeries`) and pushes them through their observables. Initial range = `[0, dates.length - 1]` (full range).
- **Tiles** are mostly static strings. The one mutable tile (`Peak users (range)`) captures a `<div className="tile-value"/>` element and writes `textContent` on range change.
- **No `try/catch`** anywhere; fetchers use `.catch(() => fallback)` and `tryCatch` from `@opendaw/lib-std` where applicable.
- **No `KpiCard`** — abandoned in favor of the simpler `Tile` for visual consistency.

## Data sources (live)
| Tile / Chart | Endpoint | Cache |
|---|---|---|
| Live rooms count series | `https://live.opendaw.studio/stats/rooms-count.json` | none |
| Live rooms duration series | `https://live.opendaw.studio/stats/rooms-duration.json` | none |
| Peak users series | `https://api.opendaw.studio/users/graph.json` (`credentials: include`) | none |
| GitHub stars/forks/etc. | `https://api.github.com/repos/andremichelle/openDAW` | 10 min sessionStorage |
| GitHub latest release | `https://api.github.com/repos/andremichelle/openDAW/releases/latest` | (same call) |
| Discord members/online | `https://discord.com/api/v10/invites/ZRm8du7vn4?with_counts=true` | 5 min sessionStorage |
| Errors fixed % | `https://logs.opendaw.studio/status.php` → `{Total, Fixed, Unfixed, Ratio}` | 5 min sessionStorage |

## Routing
- `/stats` → `DashboardPage`
- `/users` (legacy) → redirects to `/stats`
- All previous sub-routes deleted: `/stats/users`, `/stats/rooms-created`, `/stats/rooms-duration`

## Iteration log (in user request order)
1. Built initial dashboard.
2. Empty `card-body` bug — `Card` factory wasn't consuming children positionally; lib-jsx passes children as the second positional arg, not via props.
3. Nested `.chart` collapse — slot div had the same class as the chart it contained; renamed to `.chart-slot`.
4. Moved GitHub/Discord tiles to the top.
5. KPI cards restyled to match the GitHub/Discord tile look.
6. Added `Tile` component, merged everything into one auto-fit grid.
7. **Range slider dispatch fix** (root cause): we were *recreating* charts on each range tick, killing/replacing their resize observers faster than they could fire. Refactored charts to subscribe to `ObservableValue<DailySeries>` so they're created once and re-render reactively.
8. Removed duplicate `Rooms Created` chart (it showed the same data as the hero).
9. Renamed everything to "Live Rooms" terminology; duration in hours.
10. Added error stats (status.php).
11. `Daily Peak Users` promoted to hero (full width, first chart).
12. Tiles **doubled**: `minmax(11rem → 22rem)`, `min-height 5 → 10rem`, value font `1.4 → 2.8rem`, icon `2 → 4rem`.
13. Range starts at full range (`[0, dates.length - 1]`).
14. Range slider moved **inside** the hero card.
15. Range control border/background removed; padded `40px / 16px` to align with chart data area.
16. Errors tile shows percentage only.
17. `Peak users` tile moved to last position in the row.
18. Dropped tiles: `Errors total`, `Live rooms today`, `Live rooms (range)`, `Hours today`.

## Stats we could add next (brainstorm)

### Cheap (no new endpoints)
- **All-time totals** — single big numbers from existing data: total rooms ever, total hours ever, all-time peak users.
- **Average session length** — `sum(duration) / sum(count)` (server already gives both).
- **Busiest day-of-week** — derive from existing daily series.
- **GitHub contributors / latest release tag** — `fetchGitHubStats()` already returns these; just add tiles.
- **GitHub open issues** — same call.
- **Last commit timestamp** — already in repo response.

### One new endpoint each
- **NPM weekly downloads** for `@opendaw/lib-*`, `@opendaw/studio-*` — `https://api.npmjs.org/downloads/point/last-week/<package>`.
- **GitHub stars over time** — `api.github.com/repos/.../stargazers` (paginated; would need a small backend cache).
- **Active sessions right now** — surface the existing `UserCounter` heartbeat as a live tile (auto-refresh every 60s).
- **Build version + deployed-at** — read from `public/build-info.json` (already written by the dev script).

### Heavier / future
- **Geographic distribution** of users (country share pie/bar) — requires server-side IP→country lookup.
- **Browser & OS share** — requires anonymous telemetry.
- **WebSocket peak concurrent connections per server** — needs a new endpoint on `yjs-server`.
- **Most-used DSP devices** — anonymous project telemetry.
- **Average project size** (tracks/regions) — same.
- **Lighthouse / bundle size trend** — CI integration.
- **YouTube subs / Reddit members** — if/when those channels exist.

## Open
- Decide which "cheap" tiles to add next — recommended starter pack: **all-time total rooms · all-time total hours · GitHub contributors · NPM weekly downloads**.
- Range slider currently drives all three charts. If users find that confusing (since it lives inside the hero), we could either (a) make it visually global again or (b) scope it so it only affects the hero and let the two compact charts always show full range.
