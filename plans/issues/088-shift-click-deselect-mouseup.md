# Shift+click should only deselect on mouseup, and only if the mouse didn't move (#88)

**Doability:** ⭐⭐⭐☆☆ (3/5) — root cause is exactly located in one shared component, but that component is used by five different editors, so the fix must be verified against all of them.
**Type:** feature (behaviour fix)
**Scope:** medium

## What is asked
When shift-clicking an already-selected note to multi-select and then drag-move the group, the clicked note is deselected immediately on mousedown and left behind (not moved with the rest). Expected: deselecting an already-selected item via shift+click should only happen on mouseup, and only if the pointer did not move (i.e. it was a click, not a drag). Selecting a not-yet-selected item on mousedown should keep working as-is (no change requested there).

## Current behaviour / relevant code
The shared rubber-band-and-click selection logic lives in `packages/app/studio/src/ui/timeline/SelectionRectangle.tsx`, used by the Pitch/Note editor, Property editor, Value editor, Regions area and Clips area (`grep` shows five importers: `PitchEditor.tsx`, `PropertyEditor.tsx`, `ValueEditor.tsx`, `RegionsArea.tsx`, `ClipsArea.tsx`).

The bug is in the `Dragging.attach` begin-callback, which fires on `pointerdown` (`SelectionRectangle.tsx:38-66`):
```typescript
Dragging.attach(target, (event: PointerEvent) => {
    ...
    const captured = Array.from(locator.selectableAt({u: u0, v: v0}))
    ...
    for (const selectable of captured) {
        if (selection.isSelected(selectable)) {
            if (event.shiftKey) {
                selection.deselect(selectable)   // <-- fires immediately on mousedown
            }
        } else {
            selection.select(selectable)
        }
    }
    if (captured.length > 0) {
        return Option.None   // no further drag Process is returned for this handler
    }
    ...
}, {permanentUpdates: true})
```
When the clicked item is already selected and Shift is held, `selection.deselect(selectable)` runs synchronously at mousedown, before any move/mouseup is known. Because this handler then returns `Option.None` (line 64-66) whenever something was hit, no `update`/`approve`/`cancel` lifecycle exists here to defer or undo that deselect later — the toggle is unconditional and immediate. A *separate* `Dragging.attach` registered on the same target (e.g. `PitchEditor.tsx:234`, which starts `NoteMoveModifier` for `"note-position"` hits) then proceeds to drag whatever is *still* selected — which no longer includes the note that was just shift-clicked, exactly matching the report ("not moved with the others").

Note the existing early-out at line 47-54 already special-cases the *non*-shift, single-already-selected case correctly (`return Option.None` without touching selection, so the drag-move handler elsewhere gets to run untouched) — the shift+deselect branch is the only path missing the "defer to mouseup, only-if-no-move" treatment.

## Plan
1. Change the shift-deselect branch so it does not call `selection.deselect(...)` inline at mousedown. Instead, record the set of "candidates to deselect on click" and return a `Dragging.Process` (instead of `Option.None`) that:
   - tracks total pointer movement during the drag (a small distance threshold, consistent with how other "was this a click or a drag" checks are done elsewhere in the codebase — search for an existing move-threshold constant before inventing one),
   - in `approve()`, if the movement stayed under the threshold, performs the deferred `selection.deselect(...)` for the candidates; if the movement exceeded the threshold, does nothing (leaves selection as-is, since a real drag-move happened and the other handler's `NoteMoveModifier`/`RegionMoveModifier`/etc. already used the pre-toggle selection).
   - in `cancel()`, does nothing (selection unchanged).
2. This requires the SelectionRectangle handler to stop returning `Option.None` unconditionally when `captured.length > 0` in the shift+already-selected case — but it must still return `Option.None` for the *other* already-covered cases (non-shift single click, and the "select a newly-clicked item" case) so the sibling move-modifiers in each editor keep working exactly as today.
3. Since `SelectionRectangle` is generic over `T extends BoxAdapter` and shared by five call sites, re-test all of them after the change: note multi-select+drag (`PitchEditor.tsx`), region multi-select+drag (`RegionsArea.tsx`), clip multi-select (`ClipsArea.tsx`), value events (`ValueEditor.tsx`), property line points (`PropertyEditor.tsx`).
4. Add a regression test if the selection logic can be exercised headlessly (it depends on synthetic pointer events via `Dragging.attach`/`lib-dom`); otherwise document a manual repro: select 3 notes, shift+click one of them and drag without releasing, release over a new position, assert all 3 notes moved.

## Risks / open questions
- `SelectionRectangle` is shared infrastructure — a naive fix could change shift+click behaviour for regions/clips/value-events too. That's likely desirable (same bug class), but confirm with the maintainer whether the fix should be scoped to notes only or applied universally; the code has no per-editor branch today so a universal fix is the natural shape.
- Need to find (or introduce) the project's standard "click vs. drag" pixel threshold; a search for an existing constant should happen before hardcoding a new one, to stay consistent with any existing drag-detection elsewhere (e.g. region drag has its own delta/snapping logic that might already define a similar threshold).
