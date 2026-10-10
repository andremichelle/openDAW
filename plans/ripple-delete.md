# Ripple Delete

Remove a time range from the arrangement and close the gap. Everything after the range moves left by its length.
Requested on Instagram for podcast editing (cut an "uhm", a cough, a long pause, and keep all tracks in sync).

## What the user does

1. Set the loop area over the part to remove (it already snaps, is visible on every track, and is easy to adjust).
2. Timeline context menu or `Shift+⌫` runs "Ripple Delete Loop Area".
3. One undo step brings everything back.

A dedicated range tool (drag on the time axis or across tracks) can come later. The loop area is enough for v1.

## Scope of one ripple delete

Range `[begin, end)`, `length = end - begin`.

Region tracks (note, audio, value/automation tracks, all audio units)
Clear the range with `RegionClipResolver.fromRange(track, begin, end)` (splits, trims, deletes, already handles
loops, mirrored regions and the float32 boundary tolerance). Then every region with `position >= end` moves by
`-length`. The two halves of a split region end up abutting at `begin`.

Markers
Delete markers inside the range, shift markers at or after `end`.

Tempo track
Cut the value collection at `begin` and `end` with `ValueEventCollectionBoxAdapter.cut` (keeps the curve value at
the seams), delete events inside, shift the rest.

Signature track
Events are stored as `relative-position` in bars, not ppqn. Delete events inside the range. Events after it only
stay meaningful if the range is a whole number of bars in the signature that is active there. See open questions.

Loop area
Disabled after the delete (its range is gone). Left in place otherwise.

Not touched
Clip launcher clips, devices, mixer. The engine needs no change, this is a pure box transaction.

## Implementation

`packages/studio/core/src/ui/timeline/RippleDelete.ts`, a namespace with
`RippleDelete.range(project, begin, end, tracks)`, plus `ProjectApi.rippleDelete(begin, end)` that collects all
tracks and runs it. Must be called inside `editing.modify`.

Order inside the transaction:

1. Clear the range on every track (clip resolver).
2. Shift regions after the range in ascending position order (the gap is empty, so no temporary overlaps).
3. Markers, tempo events, signature events.
4. `RegionClipResolver.validateTracks` on all touched tracks.

Seconds-based audio regions keep their duration in seconds. Moving them across a tempo change changes their end
in ppqn. The existing tempo reconciler re-sizes them after the transaction. Needs a test with tempo automation
after the range so they do not grow into their successor.

## Phases

### 1. Core + tests

Vitest in `packages/studio/core/src/project/RippleDelete.test.ts`, written first:

- range in an empty gap: later regions shift, nothing else changes
- range splits a region: both parts abut at `begin`, right part `loopOffset` correct
- range covers whole regions: deleted, followers shift
- range starts or ends exactly on a region edge (no zero-width slivers)
- looped note region and mirrored region across the range
- seconds-based audio region before, inside, across and after the range, with and without tempo automation
- automation (value) regions follow their audio unit
- markers inside deleted, after shifted
- tempo events inside deleted, seam values kept, after shifted
- undo restores the project bit-identically
- range beyond the last region is a no-op except for tempo/markers

### 2. UI

Timeline context menu item, `RegionsShortcuts` entry `ripple-delete` (`Shift+⌫`), disabled when the loop area
is off or empty. Browser checkpoint with a real podcast-like project (two voice tracks plus music).

### 3. Optional follow-ups

- Short crossfade at the seam of split audio regions (opt-in, avoids clicks in speech)
- Ripple delete of selected regions (delete selection and close the gap on all tracks)
- Range selection tool on the time axis
- Ripple insert (push everything right by a range)
- Expose in the scripting API

## Open questions

1. Signature changes after a range that is not whole bars: shift them by rounding to bars, or refuse the edit, or
   only allow bar-aligned ranges when the project has signature changes? Recommendation: refuse with a dialog.
2. Should the loop area stay enabled after the delete (now looping the material that moved in)? Recommendation:
   disable it.
3. All tracks always, or only tracks that are not locked/muted? Recommendation: all tracks in v1, that is what keeps
   a podcast in sync.
