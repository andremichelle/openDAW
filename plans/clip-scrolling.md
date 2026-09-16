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

Column snapped scrolling. The grid stays a CSS grid of `visible` fixed width cells. Scrolling only changes which
model column a cell shows. No scroll containers, no transforms, no changes to the subgrid layout.

Three numbers replace the one:

| name       | meaning                                   | invariant                                  |
|------------|-------------------------------------------|--------------------------------------------|
| `columns`  | scene count (model)                       | `>= 16`, `> highest occupied index`        |
| `visible`  | cells shown (resizer)                     | `1 <= visible <= min(columns, fit)`        |
| `scroll`   | model index shown in the first cell       | `0 <= scroll <= columns - visible`         |

`fit` = columns that leave the region view at least `MinRegionsWidth` (say 320px):
`floor((timelineWidth - headerWidth - MinRegionsWidth) / ClipWidth)`.

Cell `i` shows column `scroll + i`. Every place that maps between pixels and column index adds or subtracts
`scroll`. Everything that spans the grid uses `visible`.

`columns` grows only on commit, never during a drag: when a move is approved, a clip is dropped, or a clip is
created in column `columns - 1`, columns becomes `index + 2` so there is always one free column after the last
clip. During a drag the delta is clamped to `columns - 1 - index` and the view auto scrolls at the edges.

## Model

`packages/app/studio/src/ui/timeline/ClipsView.ts`, held by StudioService as `timeline.clips`:

```ts
class ClipsView {
    readonly enabled: DefaultObservableValue<boolean>   // today's `visible` toggle (header checkbox, shortcut)
    readonly columns: ObservableValue<int>
    readonly visible: ObservableValue<int>
    readonly scroll: ObservableValue<int>
    setVisible(count: int, fit: int): void    // clamps, then re-clamps scroll
    scrollBy(delta: int): void                // clamps
    ensureColumn(index: int): void            // columns = max(columns, index + 2)
    reveal(index: int): void                  // scroll so the column is inside the view
    reset(highestIndex: int): void            // boot: columns = max(16, highestIndex + 2), scroll = 0
}
```

Setters live in the class so the invariants hold in one place. Pure, no DOM, unit tested.

Boot (StudioService): replace the `getMinFreeIndex` reduce with the highest `indexField` over all clips, call
`reset`, keep `visible` at 3 (or the previous value) and the auto open preference as is.

## Rendering with an offset

- `Timeline.tsx` sets `--clips-visible` from `visible` (rename of `--clips-count`, all 10 sass consumers).
- `ClipLane`: cells count = `visible`. `populatePlaceholder` maps `cell = index - scroll`, skips outside
  `0..cells.length`. Rebuild on `scroll` change too. `gridColumn` stays cell based.
- `ClipsHeader`: labels show `scroll + index + 1`. Play and stop schedule column `scroll + index`. Rebuild
  labels on `scroll` change.
- `UnitLane` and `ModulatorsLane` placeholder cells: `visible` instead of `count`, no index semantics.
- `ClipsArea` xAxis: `valueToAxis(index) = (index - scroll) * ClipWidth + left`,
  `axisToValue(x) = floor((x - left) / ClipWidth) + scroll`. Drop preview x uses `index - scroll`.
- `ClipCapturing`: `clipIndex = floor(x / ClipWidth) + scroll`.
- `ClipSelectableLocator.selectablesBetween`: both `floor(u / ClipWidth)` get `+ scroll`.
- `ClipDragAndDrop`: `floor(x / ClipWidth) + scroll`.
- `ClipMoveModifier.update`: clamp each clip to `[0, columns - 1]`. `approve`: after the edit,
  `ensureColumn(highest new index)`. `cancel` unchanged. Same in the double click create path (`ClipsArea`)
  and the external drop path.

## Input

- Resizer (`ClipsHeader`): compute `fit` once at drag begin from the timeline element and header width, then
  `setVisible(begin + steps, fit)`. Dragging to zero still sets `enabled` false as today.
- Wheel over `ClipsArea`: `shiftKey ? deltaY : deltaX`, accumulate, step one column per `ClipWidth` px.
  The vertical wheel handler in `AudioUnitsTimeline` keeps working for `deltaY` without shift.
- Horizontal scrollbar: `Scroller` with `Orientation.horizontal` from `@opendaw/studio-scrollbars`, placed in the
  `TracksFooter` row spanning the clip columns. Its `ScrollModel` is fed in pixel units
  (`contentSize = columns * ClipWidth`, `visibleSize = visible * ClipWidth`, `position = scroll * ClipWidth`)
  and writes back `round(position / ClipWidth)`. Hidden when `columns <= visible`.
- Auto scroll: `installAutoScroll(clipsArea, (deltaX) => ...)` already reports `deltaX`, which
  `AudioUnitsTimeline` ignores today. Step one column per ~150 ms while the pointer is outside, direction from
  the sign. Covers clip moves and external drops. The modifier reads the current `scroll` in `update`, so the
  preview follows the scroll without extra wiring.

## Phases (browser checkpoint after each, all dists rebuilt)

1. **Model only.** `ClipsView` with tests, boot uses the highest index, `--clips-visible` rename, `visible`
   wired where `count` was. `scroll` stays 0. Behaviour identical except the boot fix.
2. **Offset rendering and capture.** Every mapping above takes `scroll` into account. Verify by setting
   `scroll` from the console: labels, clips, selection, move preview, drop preview all shift together.
3. **Input.** Resizer clamp with `fit`, wheel, horizontal scrollbar. Issue point 2 closes here.
4. **Growth and auto scroll.** `ensureColumn` on approve, drop and create. Edge auto scroll during a drag.
   Issue point 1 closes here.

## Tests

- `ClipsView.test.ts`: every clamp and invariant, boot reset with 0, 3, 15, 40 occupied columns, `reveal`
  from both sides, `setVisible` shrinking past the current scroll.
- Manual checklist per phase in the browser: move a clip from column 0 to 20 with auto scroll, undo, resize to
  one column and back, wheel and scrollbar agree, region view never narrower than `MinRegionsWidth`.

## Out of scope

- Pixel smooth scrolling. Column snapping matches a launcher grid and keeps the subgrid layout.
- Persisting `visible` and `scroll` per project. Boot resets them.
- Merging the duplicated placeholder cell code in `UnitLane` and `ModulatorsLane` into `ClipLane`.

## Open decisions

- Minimum `columns`: 16.
- `MinRegionsWidth`: 320px, or derive from the header width.
- Whether the scrollbar sits in the footer row or as a floating overlay like the vertical one.
