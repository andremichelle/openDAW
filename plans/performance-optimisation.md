# Performance Test Suite Plan

## Goal

Create a test suite that measures per-quantum CPU cost of the audio engine and all device processors
in isolation. Tests run in vitest (no browser needed) and report microseconds per quantum. Results
serve as a baseline — regressions are caught by comparing against stored thresholds.

## Approach

The device processors all implement the `Processor` interface (`process(processInfo: ProcessInfo)`).
Most extend `AudioProcessor` or `EventProcessor`. The key insight: their `processAudio(block)` /
`processEvents(block, from, to)` methods operate on plain `Float32Array` buffers and `Block` structs
with no dependency on `AudioWorkletProcessor` or Web Audio APIs. We can call them directly.

The test harness creates a mock `ProcessInfo` with a single block spanning one render quantum
(128 samples), feeds silence or a test signal, and measures the wall-clock time of N iterations
using `performance.now()`.

## Test Harness

**File:** `packages/studio/core-processors/src/perf/PerfHarness.ts`

```
- createBlock(sampleRate): Block — returns a single-block ProcessInfo for one quantum
- measureProcessor(processor, iterations): { totalMs, perQuantumUs, perSampleNs }
- warmup(processor, count): void — run N quanta to trigger V8 JIT before measuring
```

Since device processors need an `EngineContext` and box adapters to construct, and mocking the full
context is impractical, the tests will work at two levels:

### Level 1: DSP kernel benchmarks (no context needed)

Test the raw DSP functions that device processors call internally. These are pure functions operating
on Float32Arrays with no framework dependency:

- `FreeVerb.process` — reverb convolution
- `DattorroReverbDsp` — plate reverb
- `DelayDeviceDsp` — delay line read/write
- `SimpleLimiter.replace` — limiter
- `FadingEnvelope.fillGainBuffer` — fading envelope
- `Ramp.moveAndGet` (in a loop) — parameter smoothing
- `PitchVoice.process` — sample playback with interpolation
- `TimeStretchSequencer.process` — granular time stretch
- `AudioAnalyser.process` — FFT analysis
- `AudioBuffer.mixInto / replaceInto` — buffer operations

### Level 2: Processor-level benchmarks (mock context)

Create a minimal `EngineContext` stub that provides just enough for processors to construct and run.
This requires mocking: `boxGraph`, `boxAdapters`, `broadcaster`, `registerProcessor`, `tempoMap`.

Test each processor category:

**Audio effects** (AudioProcessor subclasses):
- CompressorDeviceProcessor
- CrusherDeviceProcessor
- DattorroReverbDeviceProcessor
- DelayDeviceProcessor
- FoldDeviceProcessor
- GateDeviceProcessor
- MaximizerDeviceProcessor
- RevampDeviceProcessor (EQ)
- ReverbDeviceProcessor
- StereoToolDeviceProcessor
- TidalDeviceProcessor

**Instruments** (process with note events):
- TapeDeviceProcessor (sample playback)
- VaporisateurDeviceProcessor (synth)
- NanoDeviceProcessor
- PlayfieldDeviceProcessor

**Infrastructure** (always active):
- ChannelStripProcessor
- AuxSendProcessor
- AudioBusProcessor
- MonitoringMixProcessor
- Metronome
- BlockRenderer
- UpdateClock

### Level 3: Full pipeline benchmark

Construct a minimal audio graph (instrument → effect → channel strip → output bus) and measure
the cost of rendering N quanta through the full `EngineProcessor.render()` path. This catches
overhead in graph traversal, event dispatch, and phase notification.

## Test Structure

```
packages/studio/core-processors/src/perf/
  PerfHarness.ts          — measurement utilities
  dsp.perf.ts             — Level 1: DSP kernel benchmarks
  processors.perf.ts      — Level 2: processor benchmarks (if context mocking is feasible)
  pipeline.perf.ts        — Level 3: full pipeline (if context mocking is feasible)
```

## Output Format

Each test reports:
```
[Processor]        | per quantum (μs) | per sample (ns) | iterations
CompressorDevice   |            12.3  |           96.1  |      10000
DelayDevice        |             8.7  |           68.0  |      10000
...
```

## Execution

- `npx vitest run src/perf/` — run all perf tests
- Tests use `performance.now()` (available in Node via `perf_hooks`)
- Each test does 1000 warmup iterations before 10000 measured iterations
- Results are printed to stdout; no assertions by default
- Optional: store baseline in `perf-baseline.json`, fail if any processor exceeds 2x baseline

## Implementation Order

1. **PerfHarness** — measurement utilities, Block/ProcessInfo factories
2. **DSP kernel benchmarks** — start with PitchVoice, FreeVerb, DelayDsp, SimpleLimiter
3. **Processor benchmarks** — start with the processors that don't need complex context
   (ChannelStripProcessor, AuxSendProcessor are simplest)
4. **Full pipeline** — deferred until context mocking is feasible

## Open Questions

- How much of `EngineContext` can be stubbed without the full box graph? The processors subscribe
  to box field changes during construction — a mock context may need to provide real box instances
  for the device under test.
- Should perf tests run in CI? They are timing-sensitive and may produce flaky results on shared
  runners. Consider running them only locally or on dedicated hardware.
