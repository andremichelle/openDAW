# Audio grooves: Signalsmith

Signalsmith stretches the audio spectrally and keeps the pitch. With a groove the time stretch follows the groove,
so the audio is pushed and pulled in time while the pitch stays where it is.

## Engine

1. `play_signalsmith` walks the grooved passes from the core locator instead of `locate_loops`.
2. Within a pass the stream is fed in chunks. Each chunk's time factor is its content advance (source seconds between
   `unwarp` of both chunk edges, through the warp markers) over its output length. The pitch and resample factors stay
   as they are.
3. The stream reprimes only where it does today: entry, a transport jump, and a loop wrap, which now happens at the
   grooved time of the pass boundary. The primed snapshot cache keeps working, since a wrap reprimes to the same
   content position.
4. The stream's read position can drift from the content position over a long run. Measure it first. If it drifts
   beyond a few samples, nudge the time factor of the next chunk to pull it back.
5. The release keeps the last chunk's time factor.

## To check first

1. Whether `process_stream_stereo` takes a new time factor every 32 samples without audible artefacts. Try it in
   stretch-lab with a shuffle groove before the engine work. If small chunks smear, use larger ones.
2. Whether a groove close to its limit (stretch factor far from 1 over a short span) stays clean.

## Tests

1. No groove and a zero offset render bit identical to today.
2. An offset groove moves the onsets by the offset (onset detection, the stream is not sample comparable).
3. A shuffle moves the onsets of an eighth note click file to the expected positions, pitch unchanged (spectral peak).
4. A looped region keeps the groove running across passes, the drift stays inside the tolerance over 64 bars.
5. Region edges stay silent where the groove moves content out, without clicks.

## Manual

`grooves.md`: Signalsmith follows the groove in time and keeps the pitch.
