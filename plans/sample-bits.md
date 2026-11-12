# Sample bits

Samples keep the bit depth of their source, in the OPFS and in memory. Today every sample becomes 32 bit float as
soon as it is imported, which doubles the size of every 16 bit recording. Decided 2026-11-12, to be worked on later.
Not part of the Sampler (#538), which stays on floats until this lands.

## Goal

1. The original bit depth of a sample is preserved. 16 bit and 32 bit float are the minimum.
2. 24 bit and 8 bit are candidates, decided when the plan is implemented.
3. Every sample already in storage can be converted to its smallest format.
4. Nothing clips or loses precision without the user's consent.

## State today

1. `SampleStorage.save` writes `audio.wav` with `WavFile.encodeFloats`, `load` reads it with `decodeFloats`.
2. An import decodes the file to floats before anything else looks at it. The source depth is lost at that point.
3. `AudioData.frames` is `ReadonlyArray<Float32Array<SharedArrayBuffer>>`. About 100 files use `AudioData`, SDK
   packages among them.
4. The engine holds a sample as planar f32 (`crates/engine/src/sample.rs`). `abi::SampleRef::plane()` returns
   `&[f32]`.
5. Readers of sample frames in the engine: Sampler, Nano, Playfield sample, Soundfont, Convolver and the audio
   region player.
6. The main thread keeps its own copy of the frames for peaks, waveforms, the sample editor, preview playback
   through Web Audio, bounce and export.

## Format

1. `AudioData` gets an optional field for the format: `"signed16" | "float32"`. Absent means `"float32"`, so
   existing SDK code keeps working.
2. `frames` has to carry `Int16Array` for `"signed16"`. How the type expresses that without breaking readers that
   expect floats is the first design question.
3. `abi::SampleRef` gets the format as well. Appending a field grows the struct, as `abi::Block` did.

## Which format a sample gets

1. A lossless source (WAV, AIFF, FLAC) keeps the depth its header states. The header is read before the decode.
2. A lossy source (MP3, OGG, AAC) has no bit depth. Its decoder returns floats that can exceed full scale, so
   16 bit would clip them. It stays float unless the user decides otherwise.
3. The general rule for conversion: a sample moves to a smaller format only when every value survives the round
   trip exactly. A 16 bit recording stored as float passes that test, a decoded MP3 does not.
4. Anything beyond that (dither, normalise, accept a clip) is lossy and needs the user's consent.

## Storage

1. `audio.wav` is written in the sample's format. `WavFile` needs to read and write 16 bit, to be checked.
2. The content hash that finds a sample again must not change when only the stored format changes.
3. Cloud samples and cloud backup follow the stored format.

## Converting what is stored

1. A command converts all stored samples to their smallest exact format and reports what it saved.
2. Samples that were float all along stay float.
3. Open question: run it once on demand, or also when a project loads.

## Playback routines

1. Every reader of sample frames in the engine has to read both formats. One shared accessor in the abi instead
   of six conversions.
2. The cost per read (int to float in the interpolation loop) has to be measured before choosing between a
   generic reader and one loop per format.
3. Convolver impulse responses are transformed once, so they can convert on load.
4. Recordings are written as float today. Which depth a recording gets is open.
5. The main thread needs floats for Web Audio buffers and for the peak worker, either converted on demand or read
   through the same kind of accessor.

## Order

1. Measure: memory per sample on the main thread and in the engine, read cost of 16 bit in the region player.
2. `WavFile` and `AudioData` format field, storage in source depth for new imports.
3. Engine format field and shared reader, all six readers.
4. Conversion of stored samples.
5. 24 bit and 8 bit, if decided.

## Open

1. The type of `AudioData.frames` for 16 bit.
2. Lossy sources: always float, or offered as 16 bit with a clip check.
3. Depth of new recordings.
4. 24 bit in memory: packed three bytes or widened to 32 bit integers.
