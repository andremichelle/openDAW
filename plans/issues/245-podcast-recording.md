# Podcast Recording (#245)

**Doability:** ⭐⭐☆☆☆ (2/5 overall) — a bundle of 8+ independent features of wildly different sizes; the one hard architectural blocker (in-memory recording buffer) needs to be fixed before any "long podcast episode" workflow is safe. Per-feature doability below.
**Type:** feature, very large, multi-part
**Scope:** large

## What is asked
Podcast production support: host/guest/soundboard track types, workflow stages, chapter markers (images/links, anchored across edits), soundboard, chapter-tagged export (ID3), per-channel MIDI cough button, Auphonic integration, and voice FX (deesser, leveler, LUFS meter, true-peak limiter, ducking). Plus an explicit ask to address long-recording memory/crash behavior honestly.

This is not one feature. Below it's split into independently shippable pieces with their own doability, plus the architectural question first since it gates everything else.

## Architecture question: long multitrack recordings in RAM
**This is a real, currently-unaddressed risk, not a hypothetical.** Verified in source:
- `RecordingWorklet` (`packages/studio/core/src/RecordingWorklet.ts:25,49-59`) accumulates every incoming audio chunk into `#output: Array<ReadonlyArray<Float32Array>>` — an ever-growing in-memory array, one entry per `RenderQuantum` block, for the entire duration of the recording. Nothing is written to disk/OPFS until `#finalize()` (line 100) merges all chunks into one `AudioData` and hands it to `SampleService.importRecording`.
- This is fine for the current use case (short-to-medium single-take music recording) but for a podcast (multi-hour, multi-track: host + guest(s) + soundboard simultaneously) this is a genuine browser-tab memory ceiling problem: float32 stereo at 48kHz is ~660KB/sec/track; a 2-hour, 3-track session is roughly 4.7GB of raw float32 held live in JS heap simultaneously, before any effects/peaks buffers. Browser tabs commonly cap around 2-4GB (varies by platform/OS); this setup can crash the tab mid-recording, which for a podcast means losing an entire unrecoverable interview.
- **No streaming-to-disk capture path exists today.** `SampleStorage`/OPFS (mentioned in project memory as the sample cache) is only populated after recording finishes, not incrementally during capture.
- **Honest assessment**: shipping podcast-length recording without fixing this is irresponsible. The real fix is incremental OPFS writes during capture (flush `#output` chunks to an OPFS file periodically, keep only a small ring buffer live in memory for peak-metering/undo, reassemble/stream-decode on finalize instead of holding the full recording in one `AudioData`). This is itself a nontrivial, WASM/TS engine-touching change and should be scoped and shipped as its own prerequisite issue before any "podcast" feature work begins, since every sub-feature below assumes recording already works at podcast scale.

## Sub-features

### 1. Track types: host / guest / soundboard
**Doability: 3/5.** `TrackType` (`packages/studio/adapters/src/timeline/TrackType.ts`) is currently `Undefined | Notes | Audio | Value` — a rendering/behavior discriminant, not a semantic role. "Host/guest/soundboard" is a labeling/role concept layered on top of `Audio` tracks (color, icon, maybe default-routing conventions), not a new `TrackType`. Simplest approach: a track "role" metadata field (name/color preset) rather than new engine-level track types, to avoid touching every place that switches on `TrackType` (mixer routing, mute/solo, mixdown).

### 2. Workflow stages
**Doability: unclear, needs spec.** No description of what "workflow stages" means concretely (record → edit → export UI states? project templates?) — needs the reporter to clarify before scoping.

### 3. Chapter markers (images/links, anchored across edits)
**Doability: 3/5.** Marker infrastructure already exists and is a good starting template: `MarkerBox` (`packages/studio/forge-boxes/src/schema/std/timeline/MarkerBox.ts:5-16` — `track` pointer, `position` in ppqn, `plays` (loop-play count, not chapter semantics), `label`, `hue`), rendered via `MarkerRenderer.ts`/`MarkerTrack.tsx`/`MarkerTrackBody.tsx`/`MarkerContextMenu.ts` (`packages/app/studio/src/ui/timeline/tracks/primary/marker/`). Positions are stored in ppqn, so they naturally stay anchored to musical/timeline position across edits (same mechanism regions use) — the issue's "staying anchored across edits" requirement is already satisfied by this pattern, no new anchoring logic needed. What's missing: `MarkerBox` has no image/link fields — needs new fields (e.g. `imageUrl: string`, `linkUrl: string`) or a separate `ChapterMarkerBox` schema, plus UI to attach an image/link per marker.

### 4. Soundboard
**Doability: 3/5.** No existing "trigger one-shot sample instantly" UI beyond the note-based clip launcher (Playfield/clip infra). A soundboard is essentially a grid of one-shot audio clips (like `AudioClipBox`/clip launcher) with hotkey/MIDI-note triggering — closer to porting/repurposing the existing clip-launch UI than building new engine primitives.

### 5. Export with chapter metadata (ID3)
**Doability: 3/5.** Export pipeline entry points: `Mixdowns.exportMixdown()`/`exportStems()` (`packages/app/studio/src/service/Mixdowns.ts:18,68`), using `OfflineEngineRenderer` + `FFmpegConverter`/`FFmpegWorker` (`@opendaw/studio-core`) for MP3/FLAC/WAV encoding. No ID3/chapter-tag writing exists. FFmpeg (already a dependency for MP3 encoding) supports chapter metadata via `-metadata:s:` / chapter files, so this is an extension of the existing FFmpeg-based encode step rather than a new dependency — feed it chapter marker positions/labels from sub-feature 3.

### 6. Cough button per channel via MIDI
**Doability: 2/5.** No existing infra for binding a MIDI note/CC to a momentary mute toggle. `MIDIControllerBox` (`packages/studio/forge-boxes/src/schema/std/MIDIControllerBox.ts`) and `Pointers.MIDIControl` currently target automatable float32 parameter fields (`AutomatableParameterFieldAdapter.ts:32,219`), not boolean fields like track/strip mute. Needs either a boolean-field MIDI-binding path, or a dedicated "momentary mute while note held" mechanism outside the general MIDI-control-mapping system.

### 7. Auphonic integration
**Doability: 2/5.** Pure third-party API integration (upload audio, receive processed result) — no blockers in this codebase, but entirely new (auth, API keys, upload flow, async job polling, result re-import). Scope as its own small integration project once the export pipeline (sub-feature 5) can produce a stems/mixdown file to hand off.

### 8. Voice FX: deesser, leveler, LUFS meter, true-peak limiter, ducking
**Doability: 3/5 each, mechanical given the existing pattern.** The stock-device porting pattern (Box schema → adapter → processor → editor, mirrored in Rust for WASM, per `project_stock_device_porting` memory) has already been used for 10 devices (Compressor, Maximizer, Gate, etc.) — a leveler/limiter are variations on the existing Compressor/Maximizer devices' gain-reduction machinery; a deesser is a frequency-selective compressor (sidechain EQ + compressor, both patterns exist); a true LUFS meter and true-peak limiter need new DSP (loudness integration per ITU-R BS.1770, true-peak oversampling) not currently in the codebase — check `crates`/`packages/studio/dsp` for any existing loudness code before assuming from scratch. Ducking (auto-lower music under speech) is a sidechain-triggered gain reduction, close to the existing sidechain-compressor pattern (`project_tape_fx_and_sidechain_tap` memory: sidechain tapping already exists and was a hard-won fix).

## Risks / open questions
- This issue as filed is really a mini product-roadmap, not a single implementable feature. Recommend the maintainer split it into separate GitHub issues per sub-feature (track roles, chapter markers, soundboard, ID3 export, cough button, Auphonic, each voice-FX device) so each can be estimated, prioritized, and shipped independently.
- The memory/RAM architecture question is the one item that should block everything else: if the recording pipeline cannot survive a 2+ hour multitrack session without a crash, none of the podcast-specific UI matters. Recommend a dedicated prerequisite issue: "streaming/incremental recording capture (OPFS-backed, not all-in-RAM)."
- "Workflow stages" has no concrete spec in the issue body — needs clarification before scoping.
- Several sub-features (chapter markers, soundboard) can reuse existing box/adapter/rendering patterns closely enough that they are more "adapt an existing feature" than "build new," which is reflected in their 3/5 scores despite the overall epic being large.
