# Performance Test Suite Plan

## Goal

A `/performance` page that benchmarks every device processor using the real audio engine.
Each device is tested in its own project, rendered via `OfflineEngineRenderer` (runs in a Worker).
Results show per-device rendering cost with actual audio flowing through the pipeline.

## Approach

For each device to benchmark:
1. Create a project programmatically with a Tape instrument + sample (audio source)
2. Add the device under test as an audio effect (or as the instrument for instrument devices)
3. Add note/audio regions so audio is actually playing
4. Render a fixed duration (e.g. 10 seconds) via `OfflineEngineRenderer`
5. Measure total render time
6. Compare against a baseline project (no effects) to get marginal device cost

### Project creation

Use the scripting API (`ProjectImpl` + `ProjectConverter.toSkeleton`) for devices it supports.
For device types not yet in the scripting API, use the box API directly:
- `ProjectSkeleton.empty()` for the base
- `AudioUnitFactory.create()` for audio units
- `*DeviceBox.create(boxGraph, uuid, config)` for each device type

### Audio source for effects benchmarks

Create a Tape instrument with a programmatic sample (sine wave or noise via `AudioData.create`).
Add an audio region spanning the render duration so audio flows through the entire chain.

### Devices to benchmark

**Audio Effects:**
- CompressorDeviceBox
- CrusherDeviceBox
- DattorroReverbDeviceBox
- DelayDeviceBox
- FoldDeviceBox
- GateDeviceBox
- MaximizerDeviceBox
- RevampDeviceBox (EQ)
- ReverbDeviceBox
- StereoToolDeviceBox
- TidalDeviceBox
- WaveshaperDeviceBox

**Instruments** (as the sound source itself):
- VaporisateurDeviceBox (synth — needs note regions)
- TapeDeviceBox (sample playback — needs audio region + sample)
- PlayfieldDeviceBox (drum machine)
- NanoDeviceBox (simple sampler)
- SoundfontDeviceBox

**Infrastructure** (always present, measured via baseline):
- ChannelStripProcessor
- AudioBusProcessor
- Mixer

### Measurement

The `OfflineEngineRenderer` renders inside a Worker using the real `EngineProcessor`.
Timing is done around the `renderer.render()` call from the main thread. While this includes
message-passing overhead, it's constant across all devices so the relative comparison is valid.

For each device: `deviceTime = renderTime - baselineTime`

## Files

### `packages/app/studio/src/perf/DeviceBenchmark.ts`

Creates test projects and runs them through `OfflineEngineRenderer`:
- `createBaselineProject(service)` — Tape + sample, no effects
- `createEffectProject(service, deviceType)` — Tape + sample + one effect
- `runBenchmark(project, durationSeconds)` — renders and returns elapsed ms

### `packages/app/studio/src/perf/benchmarks.ts`

Device registry: list of all devices to test with their box creation functions.

### `packages/app/studio/src/ui/pages/PerformancePage.tsx`

Page at `/performance`. Shows:
- "Run All" button
- Progress indicator (which device is being tested)
- Results table: Device | render time (ms) | marginal cost (ms) | cost per quantum (us) | bar
- Sorted by cost, bar chart proportional to slowest

### `packages/app/studio/src/ui/pages/PerformancePage.sass`

Styling for the results table and bars.

### `packages/app/studio/src/ui/App.tsx` (modify)

Add route: `{path: "/performance", factory: PerformancePage}`

## Key dependencies

- `OfflineEngineRenderer` from `@opendaw/studio-core` — already works in a Worker
- `ProjectSkeleton`, `AudioUnitFactory` from `@opendaw/studio-adapters`
- Device box types from `@opendaw/studio-boxes`
- `Project` from `@opendaw/studio-core` — for creating renderable projects
- `StudioService` — available via PageContext, provides ProjectEnv

## Open questions

- Should instruments be tested separately (with notes playing) or only as the audio source for
  effect benchmarks?
- The `OfflineEngineRenderer.create()` is async and involves worker setup per benchmark. Running
  15+ benchmarks sequentially will take time. Is that acceptable, or should we batch devices into
  fewer projects (e.g., one device per track in a single project)?
- The render duration determines measurement accuracy vs. wall-clock wait time.
  10 seconds of audio at 48kHz = 375,000 quanta. At ~50% CPU, rendering should take ~5 seconds
  per device, so the full suite would take ~2-3 minutes.
