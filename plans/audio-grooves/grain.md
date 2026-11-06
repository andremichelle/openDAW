# Audio grooves: Grain

Status: done 2026-11-05 (Rust tests in `audio_region_player.rs`, full engine test `core-wasm/test/audio-groove.test.ts`).

Grain plays the audio segment by segment from transient to transient. That makes it the closest to notes: each
transient is an onset, and the groove moves the onsets. A transient at straight content position `x` starts at
`origin + warp(x)`. The segment between two transients plays at its usual rate until the next one starts. The pitch
never changes.

## Engine

1. The grain path in `play_region` walks the grooved passes from the core locator instead of `locate_loops`.
2. `TimeStretchSequencer::process` gets the content range of the block as `unwarp` of both block edges instead of
   `content_ppqn + pn`, so a transient fires in the block its grooved position falls in.
3. The fill (Once, Repeat, Pingpong) is decided from the straight gap, so a groove alone never loops or bounces a
   segment. A slower tempo still fills as without a groove.
4. A new voice starts where its transient lands on its grooved time.
5. When the groove makes a gap longer than its segment, the voice fades out before the segment end, so it never
   reaches the next attack. The rest of the gap stays silent. When it makes a gap shorter, the voice plays on to its
   segment end under the next one, so no material is lost.
6. A transient the groove moves outside the region does not fire. Content the groove ends before the region end
   rings out from there. Under an authored fade-out it gets a declick.
7. A transient fires block quantised, as today.

8. With a groove the segments are also cut at the groove grid: every sixteenth, or half the groove's cell when that
   is shorter. An offset has no grid. The cuts merge with the transients on the fly, nothing is allocated. So a hit
   without a transient moves with the groove too. A cut close to a transient continues the voice. The grid also
   closes the last segment at the end of the warp markers, so Repeat does not loop it.

## Tests

1. No groove renders bit identical to today, a zero offset within float tolerance.
2. An offset groove moves every onset by the offset (onset detection on a click file with transients).
3. A shuffle moves the off beat onsets to the expected positions, the on beat onsets stay.
4. A groove alone never loops a segment, a slower tempo still does. A 909 pattern with a shuffle plays every hat once,
   at its grooved position, in all three modes.
5. A looped region keeps the groove running across passes.
6. A transient pushed past the region end does not fire, one pulled before the region start does not fire.

## Manual

`grooves.md`: Grain moves each transient with the groove and keeps the pitch.

## Status (André, 2026-11-06)

Not done. Whether the groove plays right depends on the tempo:

1. Shuffles above 50% sound perfect at the file's own 120 bpm and again at 141 bpm, but at 130 bpm almost every second
   sixteenth hat is missing.
2. Shuffles below 50% are still a mess, also depending on the tempo.

The Groove menu still enables Grain, so this must be solved or the menu disabled for Grain before a deploy.
