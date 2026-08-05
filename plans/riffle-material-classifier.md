# Audio material classifier for Riffle (pad vs drum loop)

Status: DESIGN ONLY (approved scope 2026-08-05). Not implemented.

## Goal

Riffle (an external company on the openDAW SDK, automation-first UX) wants imported audio
auto-routed to the right stretch algorithm without user input: percussive material to the granular
transient mode (`AudioTimeStretchBox`, their "Ableton timestretch" case), tonal/sustained material
to the phase vocoder (`AudioSignalsmithBox`).

Deliverable: an async SDK function that runs offline analysis on an imported sample and returns a
small set of measured features, plus a heuristic probability, that Riffle turns into the pad vs
drum-loop decision. Riffle may use our probability directly or compute their own from the features.

## What already exists (do not rebuild)

- `crates/stretch` analyzer. `Analyzer::analyze` / `describe` (analyzer.rs) already computes, per
  transient segment, the discriminating features. See `TransientDescriptor` (descriptor.rs, `#[repr(C)]`
  64 bytes):
  - `strength` 0..1: attack sharpness. ~1 drum hit, ~0 pad swell.
  - `harmonicity` 0..1: tonality from mean spectral flatness, gated by aperiodicity.
  - `period`: YIN fundamental in samples, 0 = aperiodic.
  - `rms`, plus `beat_seconds` (envelope beat period) and loop fields we do not need for classification.
- `crates/stretch-wasm` exposes the raw ABI: `analyze(left, right, frames, sampleRate, out, max) -> count`,
  `record_size()` (64), `analyzer_version()`, `alloc_bytes` / `free_bytes`.
- A working TS loader already decodes the records: `packages/app/transient/src/detector.ts`
  (`TransientDetector.load(url)` + `detect(audio: AudioData)`), built by
  `packages/app/transient/build-wasm.sh` (`cargo build -p stretch-wasm --target wasm32-unknown-unknown`).
- Both destination boxes exist: `AudioTimeStretchBox`, `AudioSignalsmithBox`
  (forge-boxes/src/schema/std/timeline), with engine playback pools already wired
  (`crates/engine/src/audio_region_player.rs`: `signalsmith_pool`, `TimeStretchSequencer`).

The `stretch` analyzer crate is NOT a dependency of `crates/engine` (engine depends on `signalsmith`
only). The analyzer is `stretch-wasm` exclusively, so exposing it to the SDK duplicates no engine code.

## Public API

Lives in a dedicated package (see Packaging). Input is `AudioData` from `@opendaw/lib-dsp`, the type an
imported sample already decodes to (`frames: Float32Array[]`, `numberOfFrames`, `numberOfChannels`,
`sampleRate`).

```ts
export interface AudioMaterialFeatures {
    readonly durationSeconds: number
    readonly onsetCount: number
    readonly onsetsPerSecond: number      // transient density
    readonly strengthMean: number         // 0..1 attack sharpness
    readonly strengthMedian: number
    readonly harmonicityMean: number      // 0..1 tonality (spectral flatness)
    readonly harmonicityMedian: number
    readonly pitchedFraction: number      // fraction of segments with period > 0
    readonly percussiveFraction: number   // strong attack and low harmonicity
    readonly beatRegularity: number       // 0..1 from inter-onset-interval consistency
    readonly rms: number                  // overall linear RMS
    readonly drumLoopProbability: number  // 0..1 heuristic, documented and replaceable
    readonly analyzerVersion: number      // from analyzer_version(), for cache invalidation
}

export const analyzeAudioMaterial = (audio: AudioData): Promise<AudioMaterialFeatures>
```

`analyzeAudioMaterial` lazy-loads the wasm on first call and caches it (see Packaging). The wasm
`analyze` itself is synchronous once loaded, so only the first call pays the load cost.

## Aggregation

Run `analyze` to get the descriptor array, gate out near-silent segments (`rms` below a small floor,
reuse the analyzer's own gate value), then reduce:

- `onsetsPerSecond = onsetCount / durationSeconds`.
- `strengthMean/Median`, `harmonicityMean/Median`: over gated segments.
- `pitchedFraction = count(period > 0) / count`.
- `percussiveFraction = count(strength >= STRONG && harmonicity <= NOISY) / count`. Start
  `STRONG = 0.6`, `NOISY = 0.4`, calibrate.
- `beatRegularity`: inter-onset intervals `ioi[i] = position[i+1] - position[i]`. Use
  `1 / (1 + CV(ioi))` where `CV = std/mean`. Drum loops have near-constant IOIs so CV is low and
  regularity approaches 1. Fewer than 3 onsets means undefined, return 0.
- `rms`: whole-file linear RMS (compute in TS from the channels, or average segment `rms`).

Heuristic probability (logistic over a weighted sum, all terms 0..1, weights to calibrate):

```
z = w0
  + w1 * squash(onsetsPerSecond / DENSITY_REF)   // rhythmic density, DENSITY_REF ~ 4/s
  + w2 * strengthMedian                            // sharp attacks
  + w3 * (1 - harmonicityMedian)                   // non-tonal
  + w4 * (1 - pitchedFraction)                     // unpitched
  + w5 * beatRegularity                            // regular grid
drumLoopProbability = 1 / (1 + exp(-z))
```

Provide sensible default weights, mark the whole formula as a heuristic in the doc comment, and keep
the raw features first-class so Riffle can ignore it.

## Packaging and single-load (answers "avoid loading the same code multiple times")

Create one package `@opendaw/stretch-wasm` that OWNS the binary and the loader. Everyone (Riffle, the
studio import path, the transient demo) depends on it instead of shipping their own copy.

- Build step compiles `stretch-wasm` to `stretch_wasm.wasm` and includes it as the package asset
  (reuse `packages/app/transient/build-wasm.sh` logic).
- The loader keeps a module-level cached `Promise<WebAssembly.Module>` (compile once) and reuses one
  instance for all `analyzeAudioMaterial` calls in a realm. N imports never recompile or refetch.
- If Riffle runs analysis off the main thread, expose the compiled `WebAssembly.Module` so it can be
  `postMessage`d to a Worker (structured cloneable) and instantiated there without a second compile.
- Because the analyzer is not in `engine.wasm`, there is no duplication with the realtime engine. The
  binary is small (onset + analyzer + fft + spectral only).
- Version the cache with `analyzerVersion` so recomputation is forced when the analyzer changes.

Migrate `packages/app/transient/src/detector.ts` into this package as the shared loader and delete the
app-local copy (the demo then imports the package).

## Calibration

Thresholds (`STRONG`, `NOISY`, `DENSITY_REF`) and logistic weights must be fit on a labeled corpus of
drum loops, pads, and melodic one-shots/loops. The `crates/stretch-lab` harness already dumps
descriptors (`examples/features.rs`, `examples/descriptors.rs`); extend it to emit the aggregate
features per file and fit the weights there. Keep the fitted constants in the package, versioned.

## Record decoding note

`detector.ts` currently parses only through `rms` (offset 36). `beat_seconds` is at offset 40; parse
it if we want an envelope-beat signal in addition to onset-IOI regularity. Onset-IOI regularity alone
is enough for the first cut, so `beat_seconds` is optional.

## Non-goals

- No realtime/worklet path. This is offline, one-shot at import.
- We do not auto-apply the stretch box here. The SDK returns features/probability. Whether Riffle (or
  the studio importer) sets `AudioTimeStretchBox` vs `AudioSignalsmithBox` is the consumer's call.
- Not a general genre/instrument classifier. Only pad/sustained vs percussive/rhythmic.

## Open questions

- Do we also want a coarse `suggestedStretch: "granular" | "signalsmith"` convenience in the return,
  or leave that entirely to Riffle? (Currently left out, probability only.)
- Mono downmix vs per-channel analysis for stereo material. The wasm takes left+right and mono-izes
  internally, matching the demo. Confirm that is acceptable for Riffle's stereo drum loops.
