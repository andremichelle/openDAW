# Horizontal Clip Scrolling (#185)

## Problem

The clip launcher has no horizontal scrolling. `timeline.clips.count` is the ONLY number: it is the model
(how many columns exist), the view (how many are shown), and the CSS grid width (`--clips-count`). So:

1. A clip moved past the visible columns lands in shadowed space and can only be reached by widening the view.
2. Widening the view is the only way to reach far columns, and nothing stops it from pushing the region view
   off screen.
3. Boot derives the count from `getMinFreeIndex()`, which is the first GAP, not the highest occupied column.
   A project with clips at 0 and 5 opens with three columns and clip 5 hidden.

PR #351 capped the count at nine. Rejected: projects need at least 16 columns and a cap makes them unreachable.

Bitwig and Logic (Live Loops) both separate scene count from visible width: the launcher is a pane next to the
arranger with its own horizontal scrollbar, unlimited scenes, and edge auto scroll while dragging.

## Design

This PR fixes both reported issues together: navigation and offset-aware editing must agree so that actions
operate on the displayed column. Horizontal drag edge scrolling is an optional follow-up, outside this PR.

Column snapped scrolling. The grid stays a CSS grid of `count` fixed width cells. Scrolling only changes which
model column a cell shows. No scroll containers, no transforms, no changes to the subgrid layout.

Three numbers replace the one:

| name       | meaning                                   | invariant                                  |
|------------|-------------------------------------------|--------------------------------------------|
| `columns`  | scene count (model)                       | `>= 16`, `> highest occupied index`        |
| `count`    | cells shown (resizer)                     | `1 <= count <= min(columns, max(1, fit))`   |
| `scroll`   | model index shown in the first cell       | `0 <= scroll <= columns - count`           |

`fit` = columns that leave the region view at least `MinRegionsWidth` (say 320px):
`floor((timelineWidth - headerWidth - MinRegionsWidth - 1) / ClipWidth)`.
Keep one visible column if the window is too narrow. Shrinking reduces the launcher width; widening does
not restore its previous width. The implementation uses `ClipWidth = 49` and `MinRegionsWidth = 320`.

Cell `i` shows column `scroll + i`. Every place that maps between pixels and column index adds or subtracts
`scroll`. Everything that spans the grid uses `count`. The existing `visible` boolean remains the launcher toggle.

`columns` grows only on commit, never during a drag: when a move is approved, a clip is dropped, or a clip is
created in column `columns - 1`, columns becomes `index + 2` so there is always one free column after the last
clip. During a drag the delta is clamped to `columns - 1 - index`. Undo retains the added empty columns.

## Model

`packages/app/studio/src/ui/timeline/ClipsView.ts`, held by StudioService as `timeline.clips`:

```ts
class ClipsView {
    readonly visible: MutableObservableValue<boolean>   // existing toggle (header checkbox, shortcut)
    readonly columns: ObservableValue<int>
    readonly count: ObservableValue<int>
    readonly scroll: ObservableValue<int>
    setCount(count: int, fit: int): void      // clamps, then re-clamps scroll
    scrollTo(index: int): void                // clamps
    scrollBy(delta: int): void                // clamps
    ensureColumn(index: int): void            // columns = max(columns, index + 2)
    reveal(index: int): void                  // scroll so the column is inside the view
    reset(highestIndex: int): void            // boot: columns = max(16, highestIndex + 2), scroll = 0
}
```

Setters live in the class so the invariants hold in one place. Pure, no DOM, unit tested.

Boot (StudioService): replace the `getMinFreeIndex` reduce with the highest `indexField` over all clips, call
`reset`, keep `count` at 3 (or the previous value), and open the launcher when clips are present.

## Rendering with an offset

- `Timeline.tsx` retains `--clips-count` from `count`; existing CSS consumers are unchanged.
- `ClipLane`: cells count = `count`. `populatePlaceholder` maps `cell = index - scroll`, skips outside
  `0..cells.length`. Rebuild on `scroll` change too. `gridColumn` stays cell based.
- `ClipsHeader`: labels show `scroll + index + 1`. Play schedules column `scroll + index`; stop remains track-wide.
  Rebuild labels on `scroll` change.
- `UnitLane` and `ModulatorsLane` retain their existing `count` placeholder cells, no index semantics.
- `ClipsArea` xAxis: `valueToAxis(index) = (index - scroll) * ClipWidth + left`,
  `axisToValue(x)` clamps the local column to the visible range, then adds `scroll`.
  Drop preview x uses `index - scroll`.
- `ClipCapturing`: `clipIndex = floor(x / ClipWidth) + scroll`.
- Rectangle selection stores its anchor in model pixels, adding `scroll * ClipWidth`.
  `ClipSelectableLocator.selectablesBetween` uses those model coordinates; point capture subtracts the offset.
- `ClipDragAndDrop`: `floor(x / ClipWidth) + scroll`, captured before sample loading starts.
  Replacement stays inside the same edit transaction so one undo restores both clips.
- `ClipMoveModifier.update`: clamp each clip to `[0, columns - 1]`. `approve`: after the edit,
  `ensureColumn(highest new index)`. `cancel` unchanged. Same in the double click create path (`ClipsArea`)
  and the external drop path. Region-to-clip conversion grows and reveals the resulting clip.
- Cancel queued lane/header rebuilds when hiding or disposing the launcher.

## Input

- Resizer (`ClipsHeader`): compute `fit` once at drag begin from the timeline element and header width, then
  `setCount(begin + steps, fit)`. Dragging to zero still sets `visible` false as today.
  The timeline resize observer also clamps `count` when the window shrinks.
- Wheel over `ClipsArea`: `altKey ? deltaY : deltaX`, accumulate, step one column per `ClipWidth` px.
  The vertical wheel handler in `AudioUnitsTimeline` keeps working for ordinary vertical wheel input.
- Horizontal scrollbar: `Scroller` with `Orientation.horizontal` from `@/ui/components/Scroller.tsx`, placed in the
  `TracksFooter` row spanning the clip columns. Its `ScrollModel` is fed in pixel units
  (`contentSize = columns * ClipWidth`, `visibleSize = count * ClipWidth`, `position = scroll * ClipWidth`)
  and writes back `round(position / ClipWidth)`. Hidden when `columns <= count`.
- Existing vertical edge scrolling remains. Horizontal drag edge scrolling is deferred.
  Clip move previews refresh when the scroll offset changes, including with a stationary pointer.

## Phases (incremental commits within one PR)

1. **Model only.** `ClipsView` with tests, without changing existing callers.
2. **Offset rendering and capture.** Wire boot, rendering, editing, growth, and lifecycle handling together.
   Labels, clips, selection, move previews, and drop previews use the same offset.
3. **Input.** Resizer clamp with `fit`, wheel, horizontal scrollbar, and window resize bounds.
   Both reported issues are addressed by the completed PR.

## Tests

- `ClipsView.test.ts`: every clamp and invariant, boot reset with 0, 3, 15, 40 occupied columns, `reveal`
  from both sides, `setCount` shrinking past the current scroll.
- Regression tests cover selection coordinates, asynchronous drop destinations, replacement/undo,
  cell lifetime, and moving while scrolling beneath a stationary pointer.
- Manual checklist: scroll to off-screen clips and check playback/editing; compare scrollbar, horizontal
  wheel, and Option/Alt+wheel; check ordinary vertical wheel input; resize to one column, hide/reopen,
  and shrink the window; check last-column growth, replacement/undo, sample placement while loading,
  and off-screen region-to-clip reveal. Check the arrangement reservation where the window permits it.

## Out of scope

- Pixel smooth scrolling. Column snapping matches a launcher grid and keeps the subgrid layout.
- Persisting launcher width and `scroll` per project.
- Horizontal edge scrolling during drags.
- Merging the duplicated placeholder cell code in `UnitLane` and `ModulatorsLane` into `ClipLane`.

## Open decisions

- Minimum `columns`: 16.
- `MinRegionsWidth`: 320px. Both numeric values are proposed UX choices, open to maintainer adjustment.
- Scrollbar placement: this implementation uses the existing footer row.

## Implementation validation

On 2026-10-02, the current implementation passed 72 studio tests in 18 files and the studio type check.
These are local automated results, not CI or full browser coverage.

```sh
npm run test -w @opendaw/app-studio -- --silent
npm exec -- tsc --noEmit -p packages/app/studio/tsconfig.json
git diff origin/main --check
npm run build
npm run dev:studio
```

The contributor reported build/startup, off-screen playback/editing, and both issue symptoms working.
Option/Alt+wheel was corrected after feedback; browser retesting and the remaining manual checks
are pending. A short scrolling/resizing recording is also pending.

## AI assistance

Codex helped inspect and scope the implementation, retain existing property/CSS names, separate
optional drag edge scrolling, correct the wheel modifier, prepare incremental commits, and run tests
and type checks. This plan retains the original structure, with implementation details and validation
added. Automated checks do not replace the contributor's code review or browser validation.
