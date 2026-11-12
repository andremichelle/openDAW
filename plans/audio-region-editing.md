# Audio Region Editing (#413)

The audio content editor becomes a sample editor for the region. Edits that only rearrange the source are non destructive and stored as markers. Edits that change the samples themselves create a new sample, always after a dialog the user approves.

## Rule

Every action that results in a new sample opens a dialog first. No silent sample creation.

## How other DAWs do it

1. Pro Tools: clips are ranges into the source file. Cut, shuffle (close gap) and paste never write audio. AudioSuite (reverse, normalize, invert) renders new files into the session "Audio Files" folder. Clip gain is a non destructive line, the waveform follows it.
2. Cubase / Nuendo: the Sample Editor range cut/paste and offline processes (reverse, normalize, phase reverse, gain) are non destructive. Processed parts are written to the project "Edits" folder, the Offline Process History can modify or remove any step later. Events have a volume envelope.
3. Ableton Live: no editing inside a clip, splitting happens in the arrangement. Reverse, Crop and Consolidate render new files into "Samples/Processed/<Operation>" inside the project, without asking.
4. Logic Pro: regions are non destructive ranges. The Audio File Editor is destructive on the file (selection based reverse, normalize, invert, silence) and warns before it writes.
5. Reaper: items and takes reference the source. Split, ripple delete and take volume envelopes are non destructive. "Reverse as new take" and glue render new files into the project media folder.
6. Bitwig: a clip holds audio events, each with its own sample start, gain and reverse flag. No new files for cut, paste or reverse.

Conclusion: nobody renders for rearranging (cut, delete, paste). Processing (reverse, invert) mostly renders a new file into a project folder. openDAW stores new samples like Convert to Mono does (sample storage + project bundle, original kept or replaced).

## Model

### Warped play modes (Pitch, Time Stretch, Signalsmith)

1. The warp table maps content ppqn to source seconds, linear between markers (`crates/stretch/src/warp.rs`).
2. A cut is a jump: at content position P the source seconds continue at a different value. In the engine table this is two entries at the same ppqn, `ppqn_to_seconds` already skips the zero length window.
3. `WarpMarkerBox` gets a new field `seconds-in`: the source seconds approached from the left. Equal to `seconds` (or unset) means no jump. The engine expands a jump marker into two table entries at the same ppqn. One box per position, `MarkerComparator` stays as is.
4. Playback at a jump: the old voice fades out reading past the cut point, a new voice fades in at the new source position (same mechanism as transient boundaries in `crates/stretch/src/sequencer.rs`).
4. Delete range [P0, P1]: remove markers inside, place the jump at P0 (from seconds(P0) to seconds(P1)), shift all markers at or after P1 left by P1 minus P0.
5. Transient markers live in source seconds and need no change.

### No-sync play mode

1. Today no-sync means an empty play-mode pointer and a seconds time base, the source plays at native rate from `waveform-offset`.
2. No-sync gains splice markers in a new box with positions in seconds. A marker means "from this region position on, play from this source position at native rate". No interpolation, one marker per segment.
3. The first cut creates the marker set: one marker at the left edge of the cut. An empty set keeps today's behaviour, no migration.

### Region extent

1. Delete shrinks `loop-duration` and `duration` by the deleted length.
2. Paste grows both by the pasted length.

### Splice playback

1. Every jump needs a short crossfade in the engine (pitch voice, time stretch voice, Signalsmith seek, no-sync reader).
2. The minimum range length is the crossfade length. A shorter cut or copied range opens a dialog that offers to render a new sample instead.

## Phases

### Phase 1: Range selection in the audio editor

1. Drag over the waveform selects a range, drawn across waveform and marker lanes.
2. Snaps to the grid, CMD held while dragging disables snapping.
3. Both edges are draggable afterwards, same snapping rule.
4. Keyboard: Delete, Cut, Copy, Paste, Escape clears.

### Phase 2: Splice model

1. Box schema for jump markers (warped) and splice markers (no-sync).
2. Adapters expose one segment list (region position, source seconds, rate) for both modes.
3. Engine reads it, crossfades at jumps. Parity tests TS vs Rust for the mapping.
4. Waveform painter draws segments from the list.

### Phase 3: Delete, Cut, Copy, Paste

1. Delete and Cut apply the jump and shrink the region.
2. Copy stores the segment list of the range (source seconds plus length).
3. Paste inserts the segments at the playhead or selection start and grows the region.
4. Paste from a region with another file opens a dialog that renders a new sample.
5. Range below the minimum length: dialog, render new sample.

### Phase 4: Processing that creates a new sample

1. Reverse (sample effect exists in `packages/lib/dsp/src/sample-effects/`).
2. Phase Invert (new sample effect, gain minus one).
3. Convert to Mono exists.
4. Each opens an approval dialog, keep original option like Convert to Mono.

### Reverse for a selection

Runtime reverse per segment (a reverse flag on a jump or splice marker), effort per mode:

1. No-sync: small. The reader steps backwards through the segment.
2. Pitch: medium. `voice.rs` reads `read_position += playback_rate`, a negative rate works, but segment end and fade checks assume forward reading.
3. Time Stretch: large. Grains start at transients and play forward, the descriptors (onsets, loop points, fades) are built for forward material. Reversed playback needs a reversed analysis of the range.
4. Signalsmith: medium to large. The vocoder must be fed reversed input blocks with a seek per block.

Alternative without runtime work: render a new sample with only the source range reversed in place. All warp markers stay valid because they point at source seconds. Transients inside the range get re-analysed.

### Phase 5: Normalize as region gain

1. Measure the peak over the source ranges the region actually plays.
2. Set the region `gain` so the peak hits the target. No new sample, no dialog needed beyond the target value.

### Phase 6: Clip gain envelope (the "volume automation" of the issue)

1. The reporter wants a volume curve drawn inside the region, like clip gain in Pro Tools or the event envelope in Cubase, and the waveform scaled by it so loudness is visible against other regions.
2. `AudioRegionBox` already has `events` (field 5, a value event collection), unused by the engine.
3. Engine applies it as gain, the editor gets a gain lane, the painter scales peaks.
4. Cut and paste must move the envelope events with the audio.

### Phase 7: Warp marker guide lines

1. Each warp marker draws a faint vertical line through the waveform in `AudioEditorCanvas`.

## Open questions

1. When a region loops (duration longer than loop-duration), should a cut shrink `duration` by the cut length, or by the cut length times the number of loop repeats?
2. Should reverse and phase invert on a selection render the whole file with only that range processed? That keeps other regions on the file intact.
3. Reversing a selection: render a new sample everywhere, or add reverse at runtime for no-sync and Pitch now and render for the other two?
4. Should the clip gain envelope stay in this plan or get its own?
