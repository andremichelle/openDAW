# Region grooves

Note and automation regions and clips get an optional groove. Audio regions come later.

## Decisions (André, 2026-11-05)

1. The groove starts where the region's loop starts and runs on across the loop cycles (it does not restart per
   cycle). Clips run it on the timeline grid they cycle on.
2. A View menu option shows the grooved positions as ghosts in the note and automation editors. Editing tools
   keep working on the straight positions.
3. A note the groove moves past its cycle end is not played (the same jump as the Zeitgeist loop wrap).
4. Note and automation clips get a groove too.
5. The groove is chosen in the region and clip context menu ("Groove" > None, the project's grooves).

## Phase 1: schema and engine

- `groove` pointer (`Pointers.Groove`, optional) on NoteRegionBox (18), ValueRegionBox (17), NoteClipBox (14),
  ValueClipBox (14).
- Note sequencer: with `origin` where the region's loop starts, a note at straight position `x` after it sounds at
  `origin + warp(x)` and ends at `origin + warp(x + duration)`. Only notes whose straight position lies inside the
  region are read. Ratchets likewise. Without a groove the code path stays as it is.
- Automation: a grooved region reads its curve at the content position of `unwarp(t - origin)`. Clips likewise.
- The sequencer reaches the engine's groove registry through the note content source (engine-env stays free of
  the registry).

## Phase 2: studio

- Context menu "Groove" for regions and clips.
- Grooves "Used by" lists regions and clips, deleting a groove clears their pointer.
- Copy, paste, duplicate, split and consolidate carry the groove like Zeitgeist does.
- Scripting API: `groove` on note and value regions.

## Phase 3: ghosts

- View menu "Show Groove" in the note and automation editors draws the grooved positions as ghosts.
