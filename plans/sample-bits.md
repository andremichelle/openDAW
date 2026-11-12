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

1. `AudioData` stays as it is, floats only (see "The main thread keeps floats" below). Superseded 2026-11-12:
   a format field on `AudioData` and `Int16Array` frames.
2. The format is a property of the stored file (its WAV header) and of `abi::SampleRef`, which gets a format
   field. Appending a field grows the struct, as `abi::Block` did.

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

## One reader in Rust (first step)

Decided 2026-11-12. Before any format work the engine gets one way to read sample frames.

1. Today every reader takes `sample.plane(0)` and `sample.plane(1)` as `&[f32]` and indexes them itself: 18 sites
   in six files (region player 10, Convolver 2, Nano 2, Playfield sample 2, Sampler 1, Soundfont 1). Each has its
   own interpolation.
2. A `SampleView` in the abi replaces the two slices:
   1. `frame(channel, index) -> f32`. A mono sample answers channel 1 with channel 0.
   2. `linear(channel, position)` and `cubic(channel, position)`, the interpolations that exist today, once.
   3. `copy_into(channel, range, &mut [f32])` for readers that take a stretch at once (Convolver load, stretch).
3. The format is decided per call or per block, never per frame.
4. Step A: the view with floats only, all six readers moved, output bit-identical (golden and parity tests).
5. Step B: 16 bit inside the view. No reader changes again.
6. A private interpolation is only replaced by the shared one where the maths is the same. Otherwise the reader
   keeps its formula and uses `frame()`.
7. Region player and stretch are the hot paths. They use `copy_into` or keep a float fast path, after measuring.

## Why a sample is in memory twice

1. The engine asks the main thread for a sample (`fetchAudio`), gets the `AudioData` and copies its frames into
   its own wasm memory (`sample_allocate`, `sample_set_ready` in `core-wasm/src/boot.ts`).
2. The main thread keeps its `AudioData` in the `DefaultSampleLoader` for as long as the loader lives.
3. With the TypeScript engine the audio thread read that same shared buffer, so there was one copy. The wasm
   engine cannot read outside its memory, so the copy became a second one.
4. What the main thread needs after loading is mostly not the frames: peaks draw the waveforms, the editors read
   the frame count and the sample rate. The frames are needed on demand only: sample editor, bounce, export,
   mono conversion, transient and BPM detection, preview, cloud upload.
5. Dropping the main thread's frames once the engine has them, and reading them back from the OPFS on demand,
   would halve sample memory for every format. To be weighed against stage 3.

### Checked 2026-11-12: can the main thread let go of the frames

Every path to the frames goes through `SampleLoader.data`, `AudioFileBoxAdapter.data` / `.audioData` or
`SampleLoaderManager.getAudioData`. 24 sites read them.

1. Already asynchronous (9): engine `fetchAudio`, offline renderer, mono conversion, transient detection, sample
   editor, project migration, Sampler export, cloud upload (reads the OPFS itself), `getAudioData`.
2. Synchronous but inside an asynchronous action (4): WAV export of a region, Detect BPM, Analyze Material,
   dawproject export. Each needs one `await`.
3. Synchronous every animation frame, but only frame count, sample rate or channel count (9): Nano waveform and
   playheads, Playfield slot and busy slot, Sampler map, editor and table, the stereo check of mono conversion.
   These need the three numbers kept, not the frames.
4. Nothing reads frames synchronously in a paint or audio path.

Samples that are not in the OPFS:

1. API, cloud and peer samples are stored before the loader reports loaded. A failed store is an error today.
2. A running recording has no `AudioData` at all, its peaks come from a writer. When it ends the data is built
   and stored. If storing fails the recording "stays playable until you close the tab": then the memory copy is
   the only one and must stay.
3. The device benchmark feeds synthetic data that is never stored.

Rule that follows: frames may go only for a sample the OPFS confirmed. Costs: `GlobalSampleLoaderManager` keeps a
second reference in its cache, every new engine (offline render, bounce, freeze, export) reads all samples from
the OPFS again, and `SampleLoader.data` is SDK surface, so letting go has to be a choice of the studio, not the
default. The engine memory is not shared with the main thread, so it cannot serve as the copy to read from.

## The main thread keeps floats and lets go of them (replaces 16 bit on the main thread)

Decided 2026-11-12. The main thread never gets a second sample format. 16 bit lives in the OPFS and in the engine.

```ts
// lib-dsp
export type AudioInfo = {
    sampleRate: number
    numberOfFrames: number
    numberOfChannels: number
}
export type AudioData = AudioInfo & {
    frames: ReadonlyArray<Float32Array<SharedArrayBuffer>>
}

// studio-adapters
export type AudioLease = Terminable & { readonly data: AudioData }

export interface SampleLoader {
    get data(): Option<AudioData>   // unchanged
    get info(): Option<AudioInfo>   // new: filled once loaded, stays filled
    acquire(): Promise<AudioLease>  // new: the frames, for as long as the lease lives
}
```

1. The loader counts its leases. The first `acquire` reads the frames from the OPFS, later ones share them.
2. While a lease lives the frames stay: the sample editor while it is open, the engine while it copies, an export
   while it runs.
3. When the last lease ends the loader lets go and keeps a weak reference, so an `acquire` shortly after gets the
   same data without reading the disk.
4. A recording holds its data until the OPFS confirms the store. If storing fails it never lets go.
5. The loader manager has the setting: `"always"` (default, today's behaviour, `data` stays filled) or
   `"while-used"` (the studio, `data` is filled only while a lease lives). Its cache follows the same setting.
6. The nine paint paths that read frame count, sample rate or channel count move from `data` to `info`.
7. The four synchronous readers inside actions move to `acquire`.
8. SDK: additions only. `AudioData` keeps its shape and its float frames. Nothing stored changes, so every
   project opens as before.
9. The engine gets a 16 bit sample as raw bytes from the OPFS file through a new call next to `fetchAudio`,
   not as floats it would have to shrink again.
10. To measure: the time a new engine (bounce, freeze, export, offline render) needs to read all samples of a
    large project from the OPFS.

## How the main thread releases the frames

JavaScript has no free. Releasing means no reference points at the shared buffer any more, then the garbage
collector takes it.

1. References to a sample's frames today: the loader (`#data`), the loader manager's cache, whoever asked for
   the data and kept it, and the other threads the shared buffer was sent to (audio thread, peak worker).
2. When the last lease ends, loader and cache replace their reference by a `WeakRef`.
3. The engine drops its reference by itself once it has copied the frames into its memory. A worker drops its
   reference when its task ends.
4. Not immediate: the browser decides when it collects. Until then `acquire` gets the same data back through
   the weak reference without reading the disk.
5. A reference kept after the lease ended keeps the data alive. Nothing breaks, it is only not freed. A leak is
   quiet.
6. The test: `AudioData.count()` already counts live buffers through weak references. After every user is gone
   it must fall back to the number of leased samples. Runs in a headless browser with exposed gc.
7. A copy made from the frames (a Web Audio buffer for preview) belongs to whoever made it.

## Order

1. One reader in Rust, floats only, bit-identical.
2. Measure: memory per sample on the main thread and in the engine, read cost of 16 bit in the region player.
3. Storage in source depth for new imports, decoded to floats on load.
4. Engine format field, 16 bit inside the shared reader.
5. Conversion of stored samples.
6. `AudioInfo`, leases and the `"while-used"` setting on the main thread.
7. 24 bit and 8 bit, if decided.

## Open

1. ~~The type of `AudioData.frames` for 16 bit.~~ Not needed, the main thread keeps floats.
2. Lossy sources: always float, or offered as 16 bit with a clip check.
3. Depth of new recordings.
4. 24 bit in memory: packed three bytes or widened to 32 bit integers.
