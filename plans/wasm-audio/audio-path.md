# Audio Path (samples and sample playback)

A single merged plan for the next milestone: getting decoded sample audio into the wasm engine and playing
it back, ending with the Tape device (audio regions on the timeline) and the reusable sample-playback
primitives that later unblock the samplers (Nano, Playfield, Soundfont). Requirements here are merged from
`05-memory.md`, `device-engine-interface.md` (Routes B, C, F), `build-order.md` (Branch B), `feature-inventory.md`
(sections 5, 9, 11), `device-processing.md`, and `open-questions.md`.

## Principle

- Samples are a RESOURCE, decoupled from the timeline. The timeline only references samples (an audio region
  points at a sample), and a device may also carry its own sample references in its box (Playfield pads, a
  sampler's key zones). Sample handles, not file paths or buffers, are the device-facing currency.
- A device cannot read a foreign `SharedArrayBuffer`, so the main thread decodes audio off-thread and writes
  the f32 PCM INTO the engine's one shared linear memory at an engine-allocated offset. The engine exposes a
  sample resource keyed by handle. Render reads the frames by offset, zero-copy, and never decodes, loads, or
  touches a file. This is the same zero-copy principle as the TS `AudioData` path.

## Requirements

### 1. SAB-backed engine memory (prerequisite)  [05-memory, open-questions]

- DONE: the engine `Memory` is already a shared `SharedArrayBuffer`-backed memory (`shared: true` + `maximum`).
  It was switched on Day 3: `engine-modules.ts` creates it on the main thread and hands it to the worklet, and
  `build-wasm.sh` links the engine + devices with `--shared-memory --max-memory` (no atomics needed, the wasm
  is single-threaded). So the main thread can already write into the engine heap, and a device reads it by
  offset. This `05-memory.md` step assumed the early non-shared spike and is now superseded.
- The main thread allocates an arena / offset in the engine memory, writes the decoded PCM, then marks the
  reference ready (ready flag / pointer). A sample reference is "ready" only after the write completes.
- REMAINING: samples are large and dynamic, so `memory.grow` the shared memory OFF-THREAD as samples import
  (shared-memory grow does not detach the buffer). Never grow during render.
- Re-check the shadow-stack overlap risk noted in `05-memory.md` now that the memory is shared.

### 2. Asset delivery pipeline (main thread to engine)  [feature-inventory 11, 05-memory]

- Off-thread fetch + decode of a sample to f32 PCM, mirroring `SampleManagerWorklet` / `fetchAudio(uuid)`.
- `AudioData` = { channels, sampleRate, frames }, the frames living in the engine SAB.
- Reference by UUID / handle, plus sample metadata (name, duration, sampleRate, origin).
- OPFS storage (audio.wav + peaks.bin + meta.json) and the peaks pyramid are existing TS infra: reuse them on
  the main thread, do not re-port. The engine path only consumes the decoded frames.

### 3. Sample resource, Route F  [interface 2F, 3]

- `host_resolve_sample(handle: u32, out_ptr: u32) -> u32` (1 if resident, 0 if not), writing a `SampleRef`.
- `SampleRef`: `frames_ptr: u32, frame_count: u32, channel_count: u32, sample_rate: f32`.
- Loading is asynchronous and host-managed; a handle resolves to absent until the frames are resident.
- Two reference sources, one resource:
  - timeline-region samples, resolved by the host when answering the Route C audio-region query,
  - device-own samples, where the host reads the device box's sample handles and hands the device a slot table
    of resident samples, refreshed on box edits.

### 4. Audio buffers, Route B  [interface 2B]  (already in place)

- Stereo shared I/O buffers with the host owning order are done for the current devices. The audio path feeds
  these from sample-sourced buffers and needs no new route work here. Multi-output (Playfield) is later.

### 5. Timeline query, Route C (for Tape)  [interface 2C, 3]

- `host_query_audio_regions(from: f64, to: f64, out_ptr: u32, max: u32) -> u32`, scoped to the calling device's
  audio unit (distinct from `host_pull_events`, which gives the device's own input event stream).
- `AudioRegionRecord` (fields to finalize against the box schema):
  `sample_handle, frames_ptr (0 if not resident, region omitted that block), frame_count, channel_count,
  sample_rate, region_position, region_duration, loop_offset, loop_duration, file_offset_seconds, gain`,
  with a time-stretch handle deferred.
- The host resolves each region's sample handle via Route F and includes the frames offset in the record.

### 6. Sample-playback DSP primitives  [feature-inventory 9, build-order]

In the shared `dsp` / `engine-env` crates so Tape, Nano, Playfield, and Soundfont can all reuse them:

- read head with linear interpolation,
- playback-rate ratio (engine rate vs sample rate, times pitch),
- loop handling,
- voice fade (~5 ms) on kill / discontinuity,
- resampler (2x halfband polyphase),
- per-voice ADSR (the ADSR primitive already exists),
- the discontinuity flag resets read heads and voices.

### 7. Tape device (first audio instrument)  [interface 1, build-order, feature-inventory 9]

- A timeline-audio instrument: no note input, it reads the timeline via Route C.
- Enumerates every audio region across the unit's tracks, resolves each region's sample via Route F, and plays
  it at its placement.
- Voice states: direct, once, repeat, ping-pong. Play modes come from the audio region.
- Mirrors `TapeDeviceProcessor`.

### 8. Audio regions on the timeline  [feature-inventory 5]

- Audio-region model: file ref, timeBase (musical / seconds), waveformOffset, gain, fades, pitch-stretch,
  time-stretch, start / end markers, play mode.
- `LoopableRegion` math is already ported; reuse it for audio regions.
- Audio regions on tracks driving playback are the consumer of the Tape device.

## ABI additions (summary)

- Host imports to schedule: `host_query_audio_regions` (Route C), `host_resolve_sample` (Route F).
- Structs: `SampleRef`, `AudioRegionRecord`.
- `DEVICE_KIND_INSTRUMENT` already covers Tape (an instrument that reads the timeline). A manifest / capability
  flag may declare "reads timeline audio" so the host wires the Route C facade for it.

## Build order

1. SAB-backed memory switch: DONE (shared memory is already in place). Remaining prerequisite is off-thread
   `memory.grow` as samples import.
2. Asset delivery: main-thread decode, write PCM into engine memory, hand back a handle + ready flag. Prove it
   with a test that writes a known buffer and the engine reads it back.
3. Sample resource (Route F) with `host_resolve_sample` + `SampleRef`. Device-own sample slot table first (it
   is simpler than the timeline path).
4. Sample-playback DSP primitives (read head, interpolation, rate, loop, fade), native unit-tested.
5. A minimal sample-playing device (one device-own sample handle, no timeline) end to end in the browser, to
   prove the path.
6. Timeline query Route C + `AudioRegionRecord` + the audio-region model.
7. Tape device reading the timeline, with voice states and play modes.
8. Resampler + ADSR polish and the discontinuity reset.

## Open questions and risks

- The shared-memory switch is done; the remaining memory risk is the shadow-stack overlap noted in `05-memory.md`,
  to re-check now that the memory is shared [05, 06, open-questions].
- `memory.grow` only off-thread, never during render.
- `AudioRegionRecord` fields to finalize against the actual box schema.
- Pitch-stretch / time-stretch deferred (phase 2).

## Out of scope (this milestone)

- Soundfont SF2 parsing and playback (later, builds on the sample resource).
- Playfield granular and multi-output (later, builds on sample playback).
- OPFS asset storage and peaks-pyramid generation (existing TS infra, reused not re-ported).
- Audio-region fades / time-stretch.
