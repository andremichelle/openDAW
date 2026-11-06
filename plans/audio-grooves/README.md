# Audio grooves

Audio regions and audio clips get an optional groove, like note and automation regions already have
(plans/region-grooves.md). The groove moves the audio in time. How it does that depends on the play mode, so each
synced mode has its own sub-plan:

1. [Pitch](pitch.md) (TapeReel, `AudioPitchStretchBox`)
2. [Signalsmith](signalsmith.md) (`AudioSignalsmithBox`)
3. [Grain](grain.md) (`AudioTimeStretchBox`)

No Sync (no play mode, seconds time base) has no groove. Its audio is not on the musical grid, so there is nothing a
groove could move.

## Rules

1. Like regions with notes: the groove runs on from where the region's loop starts and across its loop passes. Clips
   run it on the timeline grid they cycle on.
2. Audio at straight content position `x` sounds at `origin + warp(x)`. At timeline position `t` the engine reads the
   content at `unwarp(t - origin)`.
3. Audio the groove moves outside its region is not played. A groove that plays late leaves silence at the region start,
   a groove that plays early leaves silence at the region end. Both edges get the usual declick.
4. Switching to No Sync removes the groove. Switching between Pitch, Signalsmith and Grain keeps it.
5. No ghosts: the editors and the timeline draw the waveform straight, like regions with notes.

## Decisions (André, 2026-11-05)

1. Pitch bends the pitch with the groove, like tape.
2. The Groove menu item is unselectable for No Sync audio.
3. Pitch first, then Grain and Signalsmith.

## Phase 1: schema and engine core (done 2026-11-05)

1. `groove` pointer (`Pointers.Groove`, optional) on AudioRegionBox (19) and AudioClipBox (15). Run the forge
   so `crates/studio-boxes/src/registry.rs` follows. WASM CONTRACT markers for both keys in
   `crates/engine/src/audio_unit/tracks/audio.rs`.
2. `read_audio_region` and `read_audio_clip` read the groove into `AudioRegion` (`groove: Option<Uuid>`, origin and
   bounds as for note regions). A region without a play mode reads no groove, whatever the pointer says.
3. A shared grooved cycle locator next to `locate_loops`: it maps the block to straight content positions with
   `unwarp`, clamps them to the region, splits them into loop passes and maps every pass back to timeline positions
   with `warp`. Each mode then reads its content along these passes. Without a groove every mode keeps its current
   code path, so ungrooved audio renders bit identical.
4. The groove registry reaches the audio region player the same way it reaches the value tracks.
5. Tests: the locator against hand computed passes (offset, shuffle, loop across passes, both region edges, clips).

The modes themselves land one by one through the sub-plans. Until a mode is done the engine plays it straight.

## Phase 2: studio (done 2026-11-05, Groove menu enabled for Pitch and Grain)

1. `Grooves.isTimelineBox` and `pointerOf` include AudioRegionBox and AudioClipBox, so Go to, Used by, delete with
   fallback, copy, paste, presets, split and duplicate carry the groove like they do for notes.
2. The Groove item in the region and clip context menus covers audio. It is disabled when the selection holds only
   No Sync audio, and it skips No Sync items in a mixed selection.
3. `AudioContentModifier.toNotStretched` clears the groove in the same modification.
4. Pasting or importing a No Sync region that carries a groove drops the pointer (in `normalizeGrooves`).
5. Flatten renders audio into a new No Sync region, so the groove is baked into the audio. Nothing to change.
6. Scripting: `groove` on audio regions and clips. Setting one where the engine plays none throws (No Sync, and for
   now Signalsmith). Scripts cannot change the playback mode, so there is nothing to clear.
7. Tests: switching to No Sync clears the groove, switching between synced modes keeps it, copy and paste across
   projects, delete with fallback, scripting.

The menu enables a mode only once its sub-plan is done, so no deploy shows a groove that does nothing.

## Phase 3: per mode

The sub-plans, each with its own engine work, tests and manual section. Order: Pitch (the easiest), Grain, Signalsmith.

## Phase 4: documentation

1. `grooves.md`: a section on audio with what each mode does with the groove, and that No Sync has none.
2. The audio region and clip manuals mention the groove item.
3. Announcement in announcements/temp.txt.
