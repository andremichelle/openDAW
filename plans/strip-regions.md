# Region tools in the ContentEditor strip

Implements the region-bound part of issue #298 (midi editor improvements).

## Goal

The `RegionBound` strip above the ContentEditor time axis was inert scaffolding: it painted the track's
regions, created an `ElementCapturing` with four hit zones and installed a cursor hook whose mapping was
commented out. Nothing was draggable, so the editor could change exactly one region value, `loopDuration`,
through the loop handle inside the editor body.

The strip is now the region-bounds tool of the ContentEditor, reusing the modifiers the tracks already use.

## Tools

| zone | tool | writes |
|---|---|---|
| left edge | `RegionStartModifier` | `position`, `duration`, `loopOffset` (content stays anchored) |
| right edge | `RegionDurationModifier` | `duration` |
| loop handle at `offset + loopDuration` | `RegionLoopDurationModifier` | `loopDuration`, grows `duration` |
| body | `RegionMoveInTrackModifier` (new) | `position` |

`RegionMoveInTrackModifier` is `RegionMoveModifier` minus everything that needs `TracksManager`: no
`deltaIndex`, no reparenting, no ctrl-copy, no shift-mirror. Horizontal move only, clamped so no region
crosses zero, committed through `project.overlapResolver.apply` like its siblings.

`RegionContentStartModifier` is deliberately not wired. Issue asks 1 ("edit the start point of a loop") and
3 ("offset the notes") are still open and both want a loop-offset tool that does not exist yet.

## Hit-test order: bounds before loop handle

`RegionCapturingTarget` now tests `region-complete` BEFORE `loop-duration`. The tracks separate the two by
row (label row = bounds, content row = loop), which a 14px strip cannot do, and `loopDuration` equals
`duration` for every freshly created region, so the loop handle would otherwise shadow the region end
completely and dragging the end would silently grow the loop instead. With bounds first, the right edge
resizes the region and the content starts looping, matching the tracks' label row; the loop handle is
reachable whenever the loop end sits inside the region.

Consequence: a loop end BEYOND the region end cannot be grabbed. Extend the region to reach it.

## Live preview in the editor body

The modifiers only write in `approve()`, so a drag has to be previewed through their
`RegionModifyStrategy`, the same mechanism `RegionRenderer` uses in the tracks.

- `RegionModifyContext` (new) holds the running modifier plus the region it grabbed, hands out
  `strategies()` / `strategyFor(region)` / `isModifying(region)`, and notifies on every update.
- `RegionBound` paints both passes through those strategies, keyed on `isModifying` rather than
  `isSelected`, so the preview does not depend on the selection flag being in sync.
- `RegionReader` reads `position`, `complete`, `duration`, `loopOffset`, `loopDuration`, `offset` and
  `contentDuration` through the strategy and merges the context notifier into `subscribeChange`. Every
  editor already renders from those getters and repaints on that subscription, so notes, audio and
  automation follow the drag for free. `keeoOverlapping` keeps reading the raw region, so the preview
  never triggers auto-scroll.
- `ClipReader` is untouched. Clips have no bounds and the strip ignores non-region boxes.

The strip auto-scrolls horizontally like the editor bodies do (`installEditorAuxBody`) and like the tracks:
`installAutoScroll` moving `range` by `Config.AutoScrollHorizontalSpeed` when the pointer leaves the canvas
during a drag, so a bound can be dragged past the visible range.

## Selection is not cosmetic

Every strip drag first does `regionSelection.deselectAll()` + `select(region)`. The overlap resolvers skip
regions flagged as selected (`RegionClipResolver.createTasksFromMasks`), so an unselected dragged region
would be clipped, or deleted, against its own mask on approve.

Side effect: touching a region in the strip collapses a multi-selection made in the tracks.

Frozen audio units are skipped, as in `RegionCapturing`.

## Edit-mode follows the strip, sealed into its own history entry

Touching a region in the strip brings it into edit-mode. Two constraints shape where that happens:

- NOT on pointerdown. The switch makes ContentEditor re-zoom the range, which invalidates the
  `pointerPulse` the running modifier captured, and the region jumps mid-drag. It runs in the drag
  process's `finally` instead.
- NOT unmarked. `UserEditing.edit` writes with `mark: false`, and `BoxEditing.modify` folds leftover
  unmarked pending into the NEXT marked entry, so an unsealed switch rides along with whatever the user
  edits next: change a loop duration, undo, and the editor jumps back to the previously edited region.
  The switch is wrapped in its own `editing.modify`.

The same defect existed in the tracks and was sealed the same way: the region and clip pointerdown
handlers in `RegionsArea` / `ClipsArea` now wrap BOTH edit pointers (timeline region/clip and the
`audioUnit` device chain) in one marked `editing.modify`, guarded so no empty transaction is opened when
neither pointer changes, and the clip double-click no longer passes `mark: false`.

Behaviour change: clicking a region or clip that is not the current edit target is now its own undo step.
That is what the region double-click already did.

Known quirk, unchanged by this work: the SELECTION is UI state that still folds into the next marked entry
by design (`VertexSelection.select` writes unmarked), so an undo can restore the previous selection
highlight while the edit target stays put.

## Files

- `packages/app/studio/src/ui/timeline/editors/RegionModifyContext.ts` (new)
- `packages/app/studio/src/ui/timeline/tracks/audio-unit/regions/RegionMoveInTrackModifier.ts` (new)
- `packages/app/studio/src/ui/timeline/editors/RegionBound.tsx`
- `packages/app/studio/src/ui/timeline/editors/RegionCapturingTarget.ts`
- `packages/app/studio/src/ui/timeline/editors/RegionReader.ts`
- `packages/app/studio/src/ui/timeline/editors/ContentEditor.tsx`
- `packages/app/studio/src/ui/timeline/tracks/audio-unit/regions/RegionsArea.tsx`
- `packages/app/studio/src/ui/timeline/tracks/audio-unit/clips/ClipsArea.tsx`

## Verified

Note regions and automation regions: all four drags, live preview in strip and body, Escape cancels,
one undo step per drag, loop repeat renders after extending past the loop end, click in the strip switches
edit-mode, undo after a change keeps the edit target.

Audio regions are unverified end-to-end: creating one needs a native drag-and-drop of a sample, which the
browser automation cannot synthesize. The path is shared with the other region types apart from the
seconds-based `resolveComplete` / `resolveLoopDuration`, which `RegionRenderer` already drives through the
same strategies in the tracks.

Note for testing: these drags update on `AnimationFrame`. A hidden or minimized window pauses
`requestAnimationFrame`, and every drag then silently does nothing.
