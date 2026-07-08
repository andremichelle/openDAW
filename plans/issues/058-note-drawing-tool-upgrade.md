# Note drawing tool upgrade (#58)

**Doability:** ⭐⭐⭐☆☆ (3/5) — one of the four asks (audition sound) is already partly implemented; the other three (remembered defaults, ghost preview, vertical-drag velocity) are each small but touch the same hot-path class.
**Type:** feature
**Scope:** medium

## What is asked
1. The draw tool should remember the velocity and note length from the last selected/drawn note, instead of always using fixed defaults.
2. Show a ghosted note under the cursor previewing the next note's length before the user clicks.
3. While drawing (click-drag), moving the cursor up/down should change velocity.
4. Drawing a note should produce a sound (audition).

## Current behaviour / relevant code
The draw tool is Alt+drag on empty canvas in the Pitch/Note editor, wired in `packages/app/studio/src/ui/timeline/editors/notes/pitch/PitchEditor.tsx:117-133`:
```typescript
Dragging.attach(canvas, event => {
    if (!event.altKey) {return Option.None}
    const target = capturing.captureEvent(event)
    if (target !== null) {return Option.None}
    const clientRect = canvas.getBoundingClientRect()
    const pitch = positioner.yToPitch(event.clientY - clientRect.top)
    auditionNote(pitch, PPQN.SemiQuaver)
    return modifyContext.startModifier(NoteCreateModifier.create({
        editing, element: canvas,
        pointerPulse: range.xToUnit(event.clientX - clientRect.left) - reader.offset,
        pointerPitch: pitch, selection, snapping, reference: reader
    }))
}, {permanentUpdates: true})
```
Note **item 4 is already partially implemented**: `auditionNote(pitch, PPQN.SemiQuaver)` fires at drag-start. It uses a hardcoded `PPQN.SemiQuaver` duration and the drag-start pitch, not the note's actual eventual duration/velocity, so it's an approximation rather than "drawing a note produces a sound reflecting the note drawn" — worth confirming with the reporter whether the existing audition is already sufficient or needs to track the live duration as it's dragged.

The note itself is constructed in `packages/app/studio/src/ui/timeline/editors/notes/NoteCreateModifier.ts:58-73`:
```typescript
const position = this.#snapping.floor(pointerPulse)
const snapValue = snapping.value(position)
this.#creation = {
    type: "note-event", position, pitch: pointerPitch,
    duration: snapValue, complete: position + snapValue,
    cent: 0.0, chance: 100, playCount: 1, playCurve: 0.0,
    velocity: 1.0,     // <-- always hardcoded, never remembered
    isSelected: true
}
```
`velocity: 1.0` is a fixed constant (item 1, velocity half). `duration: snapValue` derives purely from the current grid snap setting, not from the last-drawn/selected note's length (item 1, length half).

`update()` (lines 94-104) only reacts to `clientX` (horizontal pointer movement → adjusts `duration` via `Snapping.computeDelta`); there is no `clientY` handling at all in this modifier, so vertical drag currently does nothing (item 3 is entirely unimplemented here).

There is no ghost/preview rendering before a drag begins — `showCreation()` (line 81) only returns a value once `NoteCreateModifier` exists, which only happens after a drag has started (`Dragging.attach`'s begin-callback already commits to creating the modifier). There is no hover-only preview path (item 2 is entirely unimplemented).

## Plan
1. **Remember last velocity/length (item 1):** introduce a small piece of state (owned by the note editor, e.g. alongside `selection`/`snapping` in `PitchEditor.tsx`, or a tiny class similar to how `RegionPaintBucket`/other tool-state singletons are scoped) that tracks `{velocity, duration}` and updates whenever a note is created (`NoteCreateModifier.approve()`) or selected (single-selection change in `selection`). Use these remembered values as `NoteCreateModifier`'s initial `velocity`/`duration` instead of the hardcoded `1.0`/`snapValue`.
2. **Ghost preview before click (item 2):** add a `pointermove` (non-dragging) listener on the canvas that, when Alt is held and no drag is active, computes the same position/pitch math as the drag-start branch and renders a low-opacity note using the remembered length from item 1. This likely reuses the existing `showCreation()`/painter path (`NotesRenderer`/`UINoteEvent`) by feeding it a transient preview object outside of `NoteCreateModifier`'s lifecycle, rather than instantiating a real modifier just to preview.
3. **Vertical-drag velocity (item 3):** extend `NoteCreateModifier.update()` to also read `clientY` from the `Dragging.Event` (already available, same as `RegionsArea.tsx:306` reads `dragEvent.clientY` for fade-slope dragging) and map vertical delta to a velocity delta, clamped to a valid range, updating `this.#creation.velocity` and notifying (same `change`/`#dispatchChange` pattern already used for duration).
4. **Audition reflects the real note (item 4 refinement):** move/extend the `auditionNote(...)` call so it fires with the live `pitch`/`duration`/`velocity` as they change during the drag (subscribe to `NoteCreateModifier`'s `subscribeUpdate`, similar to how `PitchEditor.tsx:252` already does `modifier.subscribePitchChanged(pitch => auditionNote(pitch, duration))` for the move modifier), rather than a one-shot fixed-duration blip at drag-start.
5. Update the remembered `{velocity, duration}` state after `approve()` (i.e. after the drawn note commits) so the *next* drawn note starts from what was just drawn, satisfying "remember from last drawn note."

## Risks / open questions
- Confirm with the reporter whether the existing drag-start `auditionNote` call already satisfies item 4, or whether they specifically want the sound to track the note's actual pitch/duration/velocity live — this changes the size of that sub-task.
- Vertical-drag-to-velocity (item 3) needs a decided sensitivity/range mapping (pixels-per-velocity-unit) and needs to not conflict with the existing horizontal-only duration drag — check whether simultaneous X and Y movement should affect both duration and velocity at once (likely yes) or whether a modifier key should disambiguate.
- The ghost preview (item 2) needs a design decision on what happens when the preview overlaps existing notes, and whether it snaps to the same grid as the eventual click-to-draw note.
