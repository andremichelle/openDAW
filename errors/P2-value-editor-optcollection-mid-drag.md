# Value editor — "optCollection" unwrap during rubber-band drag

- **status:** OPEN (crash site known, trigger not captured) · **priority:** P2
- **occurrences:** 1 · **ids:** [1130]
- **assessment:** The value editor was alive on a region (or clip) whose `events` pointer was empty. The rubber-band drag loop read `reader.content` every animation frame and hit the unwrap. The guard that the pitch and property locators have is missing in the value locator, but a guard alone only moves the crash to the painter one frame later. What cleared the collection of a region that stayed the edited vertex is not visible in the logs.

[< back to index](error-triage.md)

## Reports

### Error: Error: optCollection
- **occurrences:** 1 · **ids:** [1130] · **span:** 2026-09-18 14:20:49 · **builds:** 1 (87be8161) · **browsers:** Firefox 155 / Linux x86_64 (X11)
- **stack:** `unwrap("optCollection") → RegionReader.content (or ClipReader.content) → ValueSelectionLocator.selectablesBetween → SelectionRectangle drag update → AnimationFrame recurring loop (Dragging.attach permanentUpdates)`

## Log timeline (session tail)

```
…33981  approve(RegionLoopDurationModifier{deltaLoopDuration: 25440})
…41194  start(RegionMoveModifier{delta 0, copy false})        ← click on a region in the arrangement
…41201  shortcut stack: SoftwareMIDIPanel, DevicePanel/Effects, ValueEditor (0), …   ← ValueEditor mounted + focused
…41320  approve/finally(RegionMoveModifier{delta 0})
…48936  [ErrorHandler] Error: optCollection                    ← 7.6 s later, inside the drag frame loop
```

Nothing is logged between the click and the crash. Keyboard shortcuts and undo/redo are not logged, so the action that removed the collection is not in the report.

## What is proven from the code

- `ValueSelectionLocator.selectablesBetween` (`packages/app/studio/src/ui/timeline/editors/value/ValueSelectionLocator.ts:23`) reads `reader.content` unguarded. `PitchSelectionLocator` and `PropertySelectionLocator` both start with `if (!owner.hasContent) return Iterables.empty()`.
- `SelectionRectangle` attaches its drag with `permanentUpdates: true`, so `update` runs from `AnimationFrame.add` on every frame while the pointer is down, not only on pointer moves. That is why the crash lands in the rAF loop.
- Plain region deletion cannot produce this. `Box.delete` defers the UI `editingTimelineRegion` pointer, the notification fires synchronously at `endTransaction`, `ContentEditor` calls `runtime.terminate()` in that observer, and that tears down the `Dragging` process cycle including its `AnimationFrame` entry. Verified in `ContentEditor.tsx:241-244`, `dragging.ts`, `pointer.ts:90`, `graph.ts:110-130`.
- Therefore the edited region/clip box survived with `events.targetVertex = None`. The same state also breaks `ValuePainter.ts:87`, `ValueEventCapturing.ts:21`, `ValueTooltip.ts:50`, `ValuePaintModifier.ts:79/101/149` and about a dozen `reader.content` reads in `ValueEditor.tsx`. The drag loop was merely first in line (recurring rAF entries run before the painter's deferred once-entry in the same frame).

## What the window rules out (second pass)

- `ValueEditor` reads `reader.content` eagerly at mount (`ValueEditor.tsx:61`), so the collection existed when the editor came up at +986.2 s and vanished inside the next 7.6 s.
- Undo/redo (`console.debug("undo")`), consumed shortcuts (`consumed by …`) and menu triggers are all logged. None appear in the window, so Delete, Ctrl+Z and context menus are ruled out.
- The crash frame ran while the pointer was held in the value editor canvas with pointer capture (rubber-band drag). Unlogged gestures that can still mutate: value editor node edits, region strip drags above the editor (`RegionBound`, unlogged, go through `RegionClipResolver`), and asynchronous completions.
- Every deletion path checked (region, track, device, mirrored sibling, last value event) either closes the editor synchronously via the editing pointer or keeps the shared collection alive (`dependenciesOf` only follows `owners` when every incoming pointer is being deleted, `events` is not mandatory). No static path leaves a staged, edited value region with an empty `events` pointer.

## Candidate triggers (none confirmed)

- A collection box removed while a region still owns it. No direct `ValueEventCollectionBox.delete()` call site exists in studio/adapters/core, so this would have to come through `dependenciesOf` tracing on a mirrored region delete or a rollback.
- Undo/redo of a transaction that referred `events` on an already edited region (consolidate, transformer copy, automation record take) leaving the pointer at None.
- A lost `pointerup` on Firefox/X11 keeping the drag loop alive long after the user thinks it ended, so any later edit that clears the collection lands in the loop. Would explain the 7.6 s gap but not the missing collection itself.

## Proposed next step (not applied)

No fix is proposed yet. Every traced path already closes the editor synchronously, so subscribing to the `events` pointer in `ContentEditor` would only guard an unknown state and hide the report. The panic stays.

Capture the trigger instead: in `ValueRegionBoxAdapter` / `ValueClipBoxAdapter`, inside the existing `events.catchupAndSubscribe`, when the pointer goes empty while `userEditingManager.timeline.isEditing(box)`, log the updates of the transaction that did it (one line, debug level). The next recurrence then names the operation.
