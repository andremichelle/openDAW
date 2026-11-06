# Audio grooves: Pitch

Status: engine done 2026-11-05 (Rust tests in `audio_region_player.rs`, full engine test `core-wasm/test/audio-groove.test.ts`).

Pitch plays the audio like tape: the warp markers set the speed, the pitch follows the speed. With a groove the
playhead through the content speeds up and slows down with the groove, so the pitch bends with it. An offset groove
only delays the audio and keeps the pitch.

## Engine

1. `render_region` (warp path in `crates/engine/src/audio_region_player.rs`) walks the grooved passes from the core
   locator instead of `locate_loops`.
2. Within a pass the read is computed in chunks of 32 samples. At each chunk edge: content ppqn = `unwarp(t - origin)`,
   then source seconds from the warp markers. Between two edges the read runs linearly, so the read is continuous and
   lands exactly on the groove at every edge.
3. A loop wrap happens at the grooved time of the pass boundary and reseats the read there, as today at the cycle
   boundary.
4. The release tail and the stop release keep the last chunk's rate.
5. Content the groove moves outside the region reads silence, with the declick at that grooved edge.

## Tests

1. No groove renders bit identical to today, a zero offset within interpolation tolerance.
2. An offset groove equals the straight render delayed by the offset, within interpolation tolerance.
3. A shuffle moves the onsets of an eighth note click file to the expected positions.
4. A looped region keeps the groove running across passes, and the wrap sits at the grooved boundary.
5. Region start and end edges stay silent where the groove moves content out, without clicks.
6. A tempo change and an automated tempo still follow the warp markers with a groove.

## Manual

`grooves.md`: Pitch bends with the groove like tape. An offset groove keeps the pitch.
