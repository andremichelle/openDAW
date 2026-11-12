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
    use<T>(user: Func<AudioData, T | Promise<T>>): Promise<T> // new: acquire, run, end the lease
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

## Dry run: letting go of the frames on the main thread (2026-11-12)

Walked through every source file that names `AudioData` (84 files) and every caller of `loader.data`,
`file.data`, `file.audioData`, `getAudioData`, `getOrCreateLoader` and `SampleStorage.load`. Nothing was built.

### A. What changes in the core

1. `lib-dsp/audio-data.ts`: `AudioInfo` added, `AudioData = AudioInfo & {frames}`. `AudioData.create` and
   `AudioData.count` stay.
2. `adapters/sample/SampleLoader.ts`: `info` and `acquire` added.
3. `core/samples/DefaultSampleLoader.ts`: `#info` (kept), `#data` strong only under `"always"` or while a lease
   lives, else a `WeakRef`. `setLoaded` fills `#info` from the data. `invalidate` clears both.
4. `core/samples/GlobalSampleLoaderManager.ts`:
   1. The setting `"always"` | `"while-used"`.
   2. `#cache` (`CachedSample.data`) is a second strong reference. Under `"while-used"` it keeps peaks, meta and
      info only.
   3. `#load` returns the load as a promise. An `acquire` that arrives while the load is pending is answered
      from that load, so the engine's fetch at project start shares the one read. No grace timer.
   4. `getAudioData` stays and answers through `acquire`.
5. `core/samples/SampleStorage.ts`: `load` reads audio, peaks and meta in one go. A first load therefore always
   reads the frames (peaks may have to be rebuilt from them). Later: a header-only read for `info`.
6. `core/RecordingWorklet.ts` (its own `SampleLoader`): gets `info` and `acquire`. Holds `#data` strongly until
   `importRecording` resolved, for ever when it was rejected.
7. `app/perf/DeviceBenchmark.ts`: its injected loader keeps its data (never stored). Uses `setLoaded`, so the
   default loader needs a way to be told "not in storage, keep".

### B. Every reader of a loader's frames

Needs the frames, becomes `acquire` (14):

1. `core/EngineWorklet.ts:251` `fetchAudio`. Reads `handler.data.unwrap` on "loaded". The lease ends when the
   promise handed the data to the port.
2. `core/OfflineEngineRenderer.ts:96` `fetchAudio`, same shape. Every offline render reads all samples again.
3. `adapters/audio/AudioFileBoxAdapter.ts:37` `#audioDataPromise`. MEMOIZED: the resolved promise holds the
   frames for the life of the adapter. This alone would defeat the release. Must not memoize the data.
4. `adapters/audio/AudioFileBoxAdapter.ts:77` `get audioData`, users below.
5. `core/AudioMonoConversion.ts:62` `await file.audioData`, one mixdown.
6. `core/project/audio/AudioContentModifier.ts:84` `await adapter.file.audioData`, transient detection in a worker.
7. `core/project/AudioWavExport.ts:9` `owner.file.data.unwrap(...)`, synchronous in an async function.
8. `core/dawproject/DawProjectExporter.ts:70` `sampleManager.getOrCreate(uuid).data.ifSome(encode)`, synchronous
   inside a box visitor. The export has to collect the files first and await them.
9. `app/service/SampleEditorService.ts:64` and `:71` open a sample. The `SampleDocument` keeps the audio while
   the editor is open and replaces it by its own edits.
10. `app/ui/timeline/tracks/audio-unit/TimelineDragAndDrop.ts:88` `getAudioData`, for transient detection in
    `AudioFileBoxFactory.createModifier`.
11. `app/ui/devices/instruments/PlayfieldDeviceEditor/ChopTrigger.ts:18` `getAudioData`, the `ChopDialog` keeps
    it while it is open.
12. `app/service/WclapFrame.tsx:230` `getAudioData`, encodes a WAV for a drop into a WebCLAP.
13. `app/ui/devices/instruments/SamplerDeviceEditor/SamplerExporter.ts:16` waits for the loader, then encodes.
14. `app/ui/timeline/tracks/audio-unit/regions/RegionContextMenu.ts:258` (Detect BPM) and `:271` (Analyze
    Material), `region.file.data.ifSome(async ...)`.

Asks for the frames but does not need them (4):

1. `app/service/NeuralDemux.tsx:272` and `app/service/StudioService.ts:366` call `getAudioData` only to wait
   until the sample is loaded. They become a wait for the loader state.
2. `core/project/ProjectMigration.ts:75` with `migration/MigrateAudioFileBox.ts:17` waits for the frames to
   compute seconds from frame count and sample rate. `info` is enough.
3. `core/dawproject/DawProjectExporter.ts:186` reads duration, channels and sample rate. `info`.

Reads frame count, sample rate or channel count on a paint or menu path, becomes `info` (10):

1. `app/.../NanoDeviceEditor/WaveformPainter.ts:31`, `PlayheadPainter.ts:12`.
2. `app/.../PlayfieldDeviceEditor/SlotEditor.tsx:116`, `BusySlot.tsx:122`.
3. `app/.../SamplerDeviceEditor/SamplerZoneMap.ts:316`, `SamplerZoneEditor.tsx:112` and `:142` (`framesOf`),
   `SamplerZoneTable.tsx:25` and `:65` (the type of `framesOf`).
4. `core/AudioMonoConversion.ts:14` `canConvert`, decides a menu entry.

Unchanged, reads the OPFS itself (7): `core/cloud/CloudBackupSamples.ts:82`, `core/cloud/SharedFolderSync.ts:231`,
`core/project/ProjectBundle.ts:142`, `p2p/AssetServer.ts:161`, `app/ui/browse/SampleDialogs.tsx:148`,
`app/service/SamplePlayback.ts:69`, `app/service/TestAudioProject.ts:36`.

Unchanged, uses state, peaks or meta only: `AudioRegionBoxAdapter`, `AudioClipBoxAdapter`, `NanoDeviceBoxAdapter`,
`PlayfieldSampleBoxAdapter`, `SamplerZoneBoxAdapter`, `NanoDeviceEditor.tsx:86`, `SampleDropZone.tsx:41`,
`SlotUtils.ts:16`, `SampleView.tsx:46`, `AudioContentModifier.ts:150`, `Project.ts:632`, `RecordAudio.ts:217`,
`BrowserAudioInput.ts:185` and `:428`.

Unchanged, owns an `AudioData` that never was a loader's:

1. Render results: `OfflineEngineRenderer` (create), `AudioBounce`, `AudioConsolidation`, `Mixdowns`,
   `MasteringPanel` (keeps a mixdown per project), `Contest`, `AudioFormats`, scripting `mixdown`.
2. Fresh decodes on import: `SampleService`, `SampleUploadPage`, `MetronomeControl` (click sounds),
   `SampleEditorService#decode`, `SampleRecorder`, `OpenSampleAPI.load`, `boot.ts` provider, the p2p providers.
3. The sample editor's own documents: `SampleDocument`, `SampleEdits`, `SamplePainter`, `SamplePlayer`.
4. Frozen units: `AudioUnitFreeze` keeps its `audioData` and the engine holds a copy. A second case of two
   copies, not part of this change.
5. Scripts: `Api`, `ApiImpl`, `ScriptHostProtocol`, `ScriptWorker`, `ScriptRunner`, the code editor examples.
   `addSample` takes data a script made. Werkstatt and Apparat `// @sample` read the engine's resident frames
   (`core-wasm/script-bridge.ts`), not the main thread's.
6. Engine protocols and commands: `protocols.ts`, `Engine`, `EngineFacade`, `EngineVariant`, `processor.ts`,
   `offline-worker.ts` (`fetchAudio`, `loadClickSound`, `setFrozenAudio` signatures).

Unchanged, functions that take an `AudioData` as an argument: `audio-splice`, `wav-file`, `transient-detection`,
`audio-material`, `sample-effects/*`, the worker protocols, `Workers.ts`, `core-workers/*`, `AutoEq`,
`AudioMaterialAnalyzer`, `WasmBpmDetector`, `BpmDetector`, `Matchering`, `AudioFileBoxFactory`, `SampleStorage.save`
and `loadPeaks`. A worker that received the shared buffer holds it until its call returns.

Not sample data at all: `ShadertoyRunner.audioData` (a spectrum texture), `WebCodecsVideoExporter` and
`AudioFormats.ts:294` (the browser's own `AudioData`), `Footer.tsx:172` (shows `AudioData.count()`).

### C. What the dry run turned up

1. The memoized promise in `AudioFileBoxAdapter` is a hidden third reference besides loader and cache.
2. A lease's end frees nothing by itself. Whoever still holds the `AudioData` keeps it alive, and whoever dropped
   it without ending the lease only keeps the loader's strong reference. So a forgotten lease leaks quietly.
   The alternative without leases (`frames(): Promise<AudioData>`, the loader holds a `WeakRef` only) was
   offered and turned down. DECIDED 2026-11-12: with leases. What keeps them from leaking:
   1. A lease is a `Terminable`. Inside the studio it is owned by a lifecycle (`lifecycle.own(lease)`), so it
      ends with the editor, dialog or action that took it.
   2. One-off users go through a helper that ends the lease whatever happens:
      `loader.use(audio => encode(audio))`, built on `acquire`.
   3. The loader counts its open leases. The count is shown next to `AudioData.count()` in the footer's debug
      line and checked by the headless test.
3. `getAudioData` is used as "wait until loaded" in two places. Under `"while-used"` that would read a file
   for nothing.
4. `SampleLoader.data` changes meaning under `"while-used"`: loaded no longer implies `data` is filled. Every
   `data.unwrap` after "loaded" is a crash there. The six such sites are all in the lists above.
5. The offline renderer and every new engine read all samples from the OPFS. The read is one pass per sample
   with a float decode. To measure on a large project before deciding the studio's setting.
6. `sampleManager.invalidate` (sample editor overwrites a sample) already makes the engine fetch again. No change.
7. A sample dropped into the engine while the engine's copy fails (`sample not loaded: ... does not fit`) leaves
   no main thread copy either. Preview and editor still work, they read the OPFS.

## SDK update note

For SDK consumers, to go out with the release that carries the change. Written against what is built
(branch `sample-bits`, 2026-11-12).

### Samples take less memory and less storage, if you switch it on

Nothing changes unless you ask for it. All of this is additions.

New in `@opendaw/lib-dsp`:

1. `AudioInfo`: `sampleRate`, `numberOfFrames`, `numberOfChannels`. `AudioData` is `AudioInfo & {frames}`, field
   for field what it was.
2. `PcmData`: sample frames in the format they are stored in, `"float32"` or `"int16"`. `PcmData.isExact16`,
   `smallest`, `floats`, `quantize`, `measure`.
3. `WavFile.encodePcm` and `WavFile.decodePcm`. `encodeFloats`, `encodeInts16`, `encodeInts24` and `decodeFloats`
   write and read exactly what they did.
4. `SampleConversion`: what a float sample can become as 16 bit (`judge`, `convert`).

New in `@opendaw/studio-adapters`:

1. Three optional members on `SampleLoader`: `info` (the three numbers of a loaded sample), `acquire()` (the
   frames until the lease is terminated) and `pcm()` (the frames as stored, for the engine). Optional, so a
   loader you wrote before still compiles and still works.
2. The `SampleLoader` namespace is how they are read, it serves old and new loaders alike:
   `acquire(loader)`, `use(loader, user)` (leases for the run of a function, ends the lease also when it
   throws), `frames(loader)`, `loaded(loader)`, `stored(loader)`, `infoOf(loader)`.
3. `AudioFileBoxAdapter.info`.
4. `EngineToClient.fetchSample?`, optional, next to `fetchAudio`, announced by `fetchSample: true` in
   `EngineProcessorAttachment` and `OfflineEngineInitializeConfig`.
5. `SampleRetention`: `"always"` or `"while-used"`.

New in `@opendaw/studio-core`:

1. `new GlobalSampleLoaderManager(provider, {retain})`. The second argument is optional, `"always"` is the default.
2. `SampleStorage.get().format`: `"float32"` (default) or `"smallest"`.
3. `SampleStorage`: `loadPcm`, `loadStored`, `readAudio`, `store`, `replaceAudio`, `convert`, `settle`.

What stays as it was with the defaults:

1. A loaded sample keeps its frames, `loader.data` stays filled, a finished recording keeps its data.
2. Samples are written as 32 bit float, the engine holds floats, renders are bit-identical.
3. `AudioData`, `getAudioData`, `AudioFileBoxAdapter.data` and `.audioData`, the `SampleProvider` signature.
4. Project files and stored samples. Every project opens as before.

The two switches:

1. `SampleStorage.get().format = "smallest"`: a sample whose every value is exact in 16 bit is written as 16 bit
   PCM, half the size. Everything else stays float. The engine then holds such a sample as 16 bit too and plays
   it bit-identically. Reading goes by the WAV header, so files of both kinds mix freely, and builds since
   2026-01 read them.
2. `new GlobalSampleLoaderManager(provider, {retain: "while-used"})`: a loader holds frames only while they are
   leased and reads them back from the OPFS when asked again. Then:
   1. "loaded" no longer means `loader.data` is filled. Replace `loader.data.unwrap()` by
      `SampleLoader.acquire(loader)` or `SampleLoader.use`.
   2. For sample rate, frame count and channel count read `SampleLoader.infoOf(loader)`.
   3. End every lease. A lease that is never ended keeps its sample in memory.
   4. Samples must stay in the OPFS while the page runs. Do not clear `samples/v2` under a running project.

Nothing asks for code with the defaults, also not a `SampleLoader` you implement yourself.

## Findings of the three deep dives (2026-11-12)

### Consumer: opendaw-test (SDK 0.0.184, fresh clone)

1. Supplies samples through a `SampleProvider` object and `new GlobalSampleLoaderManager(provider)`. Implements
   no sample interface, never reads a stored file. So: the manager's setting is an OPTIONAL constructor argument.
2. Six sites read `loader.data.frames` right after "loaded", all on a finished `RecordingWorklet`. Under
   `"always"` a recording keeps `data` filled for as long as it lives.
3. Its export audit hashes renders over 308 rows and expects "identical". Holds, because only exact samples
   become 16 bit and a 16 bit sample plays bit-identically.
4. Its pages delete `samples/v2` on page load. Under the SDK defaults nothing may depend on reading a sample back
   from storage. A failed read back falls back to the held floats.
5. No PR needed. Their routine SDK upgrade PR refreshes docs that quote `SampleStorage.save` and `fetchAudio`.

### Storage and import

1. A sample's uuid is a hash of the bytes handed to `importFile` (or given), never of `audio.wav`. Changing the
   stored format changes no uuid. Callers must keep their pre-encoding.
2. `SampleStorage.save` is the one decision point: import, cloud download, provider fetch (stock, p2p).
3. SF2 import already hands an exact 16 bit WAV to `importFile`, it only becomes float in `save`. No Sampler
   change needed.
4. `WavFile.encodeInts16` scales by 32767 and alters every value above -6 dB. Not usable. A new exact writer
   (`* 32768`, no rounding, no clamp) is needed, the old function stays byte for byte.
5. `-0.0` passes a naive exactness test and returns as `+0.0`. DECIDED: a sample holding `-0.0` is not exact.
6. Every reader of `audio.wav` in `main` decodes by header (`decodeFloats`, 16 bit since 2026-01) or copies raw
   bytes. Bundles, shared folder, cloud backup and live rooms work both ways between old and new builds.
   8 bit and WAVE_FORMAT_EXTENSIBLE would break every current build. DECIDED: 8 bit is dropped. The header is
   always canonical (tag 1, 44 bytes).
7. No format field in `meta.json`. The WAV header is the single truth.
8. `OpfsWorker.write` truncates in place. The conversion page needs a safe write: temp file, verify, replace.
9. Raw copies from old builds (bundles, shared folder) bring float files back. Conversion must be repeatable.
10. DECIDED: writing 16 bit is a setting the studio switches on. The SDK default keeps writing float.

### Engine

1. `SampleRef` (16 bytes, `repr(C)`) has three literals. Two JS bridges read it through a 16 byte scratch:
   `script-bridge.ts:553` (Werkstatt, Apparat `// @sample`, zero-copy float views) and
   `wclap/wclap-bridge.ts:944` (copies planes into the plugin). Both must follow a grown struct in one commit.
2. Soundfont does not use `SampleRef` (own blob, f32). Out of scope. Frozen audio and click sounds too.
3. The interpolations are not one formula: region player and Playfield are the same text, Nano, Soundfont and
   Signalsmith differ at the last frame, granular and Convolver use `a + t * (b - a)`, Sampler is cubic. A shared
   `linear()` would change bits. So the plan's `SampleView.linear/cubic` is dropped.
4. DECIDED design: the format is matched once where a reader resolves its sample, the readers become generic
   over the frame type (`trait Pcm { fn to_f32(self) -> f32 }` for `f32` and `i16`). For `f32` the code is what
   it is today, expression for expression. Existing tests keep compiling unedited.
5. `value as f32 * (1.0 / 32768.0)` equals `int16 / 32768` in JS for all 65536 values (checked).
6. `sample_allocate` already takes bytes. A second export `sample_set_ready_i16` instead of a changed signature.

## Final design (2026-11-12)

### Rust

1. `crates/math`: `trait Pcm: Copy { fn to_f32(self) -> f32 }`, `impl` for `f32` (identity) and `i16`.
2. `crates/abi`: `SAMPLE_FORMAT_F32 = 0`, `SAMPLE_FORMAT_I16 = 1`, `SampleRef.format: u32` appended (20 bytes),
   `enum SampleView<'a> { F32 {left, right}, I16 {left, right} }`, `SampleRef::view()` (mono answers right with
   left), `set_native_sample_i16`. `plane()` stays for floats.
3. `crates/engine/src/sample.rs`: `Slot.format`, `set_ready(…, format)`. Export `sample_set_ready_i16`.
4. Generic readers: region player (`render_region`, `render_one_tail`, `interpolate`, the Signalsmith calls),
   `time_stretch.rs` (`Source<T>`, `read_interp`), `signalsmith` (`process_stream_stereo`, `resample_read`),
   `dsp::convolution` (`begin_load`, `load_step`, `read_resampled`), Sampler, Nano, Playfield sample voices.
5. Proof: step A (floats only) by the existing suites unedited. Step B by rendering the same content as `f32`
   and as `i16` through every reader and comparing `to_bits()`.

### Host (`core-wasm`)

1. `boot.ts` `drainResourceRequests`: asks `fetchSample(uuid)` (new, next to `fetchAudio`), writes `Int16Array`
   planes and calls `sample_set_ready_i16`, or floats as today.
2. `script-bridge.ts`: 20 byte scratch. A 16 bit sample is handed to scripts as a float copy, cached per handle.
3. `wclap-bridge.ts`: 20 byte scratch, converts while copying.

### TypeScript

1. `lib-dsp`: `AudioInfo`, `AudioData = AudioInfo & {frames}`. `PcmData = AudioInfo & ({format: "float32", frames:
   Float32Array[]} | {format: "int16", frames: Int16Array[]})` with `PcmData.exact16(audio)` (test),
   `PcmData.smallest(audio)`, `PcmData.floats(pcm)`, `PcmData.measure(audio): {exact16, peak}`.
   `WavFile.encodePcm(pcm)`, `WavFile.decodePcm(buffer)`. Existing `WavFile` functions untouched.
2. `SampleStorage`: setting `format: "float32" | "smallest"` (default `"float32"`). `save` encodes by it.
   `load` unchanged. `loadPcm(uuid)` reads `audio.wav` only and returns `PcmData` without inflating 16 bit.
3. `SampleLoader`: `info`, `acquire()`, `use()`, optional `pcm?()`. `DefaultSampleLoader` and `RecordingWorklet`
   implement them.
4. `GlobalSampleLoaderManager(provider, options?)`: `{retain: "always" | "while-used"}`, default `"always"`.
5. Protocol `EngineToClient.fetchSample(uuid): Promise<PcmData>` next to `fetchAudio`. `EngineWorklet` and
   `OfflineEngineRenderer` answer it with `loader.pcm?.()` or the loader's floats.
6. `DefaultSampleLoader.pcm()`: reads `SampleStorage.loadPcm`, on failure the held or acquired floats.
7. The studio (`boot.ts`) switches on `"smallest"` and `"while-used"`.
8. All readers move as listed in the dry run (14 to `use`/`acquire`, 4 to a state wait or `info`, 10 to `info`).
   `AudioFileBoxAdapter` no longer memoizes the data.

### Conversion page (`/storage/samples`, sibling of `/storage`)

1. A one-off worker scans every stored sample: format from the header, `exact16`, peak.
2. Classes: already 16 bit. Exact (converts without loss). Below 0 dB but not exact (converts by rounding, shown
   apart, not preselected). Up to 0.1 dB over (converts by scaling to 0 dB, then rounding). Above: stays float.
3. Convert: write `audio.wav.tmp`, read it back, compare against the expected floats, replace, invalidate the
   loader. Repeatable, since old builds bring float files back.

### Steps

1. ~~S1 Rust generic readers, floats only. All existing tests unedited and green.~~ 1556 tests, one test needed
   a type hint (`read::<f32>(&[], 0.0)`).
2. ~~S2 Rust and host 16 bit, bit-equality tests per reader, bridges.~~
3. ~~S3 `lib-dsp` types and codec with tests.~~
4. ~~S4 Storage setting, `loadPcm`, studio switch, SF2 lands as 16 bit.~~
5. ~~S5 Loader members, manager option, protocol, all readers.~~
6. ~~S6 Conversion page.~~
7. S7 Review and browser rounds until clean.

### What turned out differently while building

1. `use` is a function in the `SampleLoader` namespace, not a member, so an implementer has two members to add.
2. `fetchSample` and `pcm` are optional. A client or loader without them is served through `fetchAudio` and
   its floats.
3. The engine gets 16 bit only where `SampleStorage.format` is `"smallest"`, also under `"always"`: there the
   loader converts its held floats, it never reads the OPFS for it.
4. Under `"while-used"` the first load reads `audio.wav` once and hands the same frames to the engine's first
   fetch. Requests at the same moment share one read.
5. A recording keeps its frames for as long as its loader lives, under both settings. Letting them go after the
   store is confirmed is open.
6. `replaceAudio` writes the new file as `audio.wav.pending` first. A load that finds a broken `audio.wav` and a
   good pending file completes the replacement.
7. The conversion page scans in the storage worker and reads only the header of 16 bit samples. A converted
   sample keeps its uuid and its peaks. The cloud backup keeps its float copy.
8. The Signalsmith stagger depends on the region's uuid, so a test must render both formats from one project.

### What the review rounds changed

1. A stored sample whose file is gone is fetched from the provider again and stored (`"while-used"`).
2. `replaceAudio` writes `audio.wav.commit` once the pending file is complete and verified. From then on the
   pending file is the truth: a load completes the replacement, also over a torn file that still decodes. A
   pending file without the mark is discarded. A mark without a pending file means the replacement had finished.
3. Scripts and WebCLAP plugins read floats. The engine keeps one float copy of a 16 bit sample once such a
   reader asks (`host_resolve_sample_floats`), shared by all of them, built with a budget of 32768 values per
   render block over all samples. Until it is complete the sample counts as not loaded yet, as while loading.
   An offline render lifts the budget (`set_sample_float_budget`) and has the sample at the first ask. Both
   bridges are the float code they were. Such a sample costs 2 + 4 bytes per value.
4. `SampleRef::plane` is private. `info` and `acquire` are optional on `SampleLoader`.
5. A read that started before an `invalidate` no longer writes its frames back.
6. The dawproject export leases only samples that are loaded, and gates the file and its reference on the
   same data again.
7. The host announces `fetchSample` in the processor options and the offline config. A worklet paired with a
   host that does not is asked for floats, so mixed package versions keep loading samples.
8. `SampleStorage.readAudio` completes a cut-off replacement for the readers that pass the file on (project
   bundle, shared folder, live room).

### Measured in node on the built engine (2026-11-12)

Eight audio tracks reading one 20 s stereo sample at 44.1 kHz, median time per quantum, `test:bench`
(`sixteen-bit-bench.test.ts`):

1. Native read: float 13.0 us, 16 bit 13.2 us. Ratio 1.02.
2. Granular stretch: 11.6 us both. Ratio 1.00.
3. Signalsmith: float 158.6 us, 16 bit 161.3 us. Ratio 1.02.

So reading 16 bit costs nothing that matters, and the float path is the code it was.

### Measured in the browser (2026-11-12)

1. A project with 55 piano samples: the count of live sample buffers is 55 right after the load and 0 after the
   next garbage collection, about 20 seconds later.
2. The same project plays, the sample zone window shows waveforms and lengths, Analyze Material, Flatten and
   the sample editor work, each reading frames on demand.
3. 131 stored samples: 100 convert without loss, 29 by rounding, 2 stay 32 bit. Converting all would free
   119 of 241 MB.

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
2. ~~Lossy sources: always float, or offered as 16 bit with a clip check.~~ Float on import, the conversion
   page offers rounding below 0 dB and lowering up to 0.1 dB over.
3. Depth of new recordings. They are float today and can be converted on the page.
4. 24 bit in memory: packed three bytes or widened to 32 bit integers. Not started.
5. Recordings letting go of their frames once stored.
6. Reading only the header on a first load under `"while-used"`. Needs a partial read in the OPFS protocol.
7. Frozen tracks hold their audio on the main thread and in the engine.
8. Soundfont device: its blob holds floats made from 16 bit data.
9. A 16 bit sample used by a script or a WebCLAP plugin keeps a float copy in the engine until its file box
   goes. A plugin copies the frames into its own memory anyway, so it could convert while copying.
10. Converting a sample checks the written file byte by byte on the main thread. The check could move into
    the OPFS worker.
