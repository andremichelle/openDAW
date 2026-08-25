# Convolution Effect (Convolver)

A stock AUDIO-EFFECT device that convolves the signal with an impulse response (IR) sample,
running inside the WASM audio engine as fast as possible.

## Constraints (from the engine architecture)

- Device crates are `no_std` PIC side modules, **no allocator**: all DSP state lives in one
  engine-allocated, zeroed block whose size is fixed by `state_size(sample_rate)`. Everything
  (FFT tables, spectra, delay lines) is built IN PLACE in `init` / on IR delivery
  (the soundfont/analyser "large-state-in-place-init" pattern).
- The engine's linear memory is **non-shared** (see core-wasm/build-wasm.sh): no SharedArrayBuffer,
  so **no multithreading inside the engine** without an architecture change. Speed must come from
  SIMD128 (already enabled via `-C target-feature=+simd128` for engine + all deps) and from the
  algorithm (partitioned FFT convolution). Multithreaded background-partition processing is noted
  as a possible future step (would require shared memory + a worker mirroring the tail partitions).
- Render quantum is 128 frames; `render_effect` splits blocks at parameter-update positions, so
  `process_audio` sees variable sub-chunks. The convolver buffers internally on a 128-sample grid
  (quantum-aligned, so no added latency from the split).
- IRs arrive as regular samples: the box gets a `file` pointer field, the device observes it with
  `abi::observe_sample` and resolves planar f32 frames with `abi::resolve_sample` (resident in
  shared linear memory) — same path as `device-playfield-sample`. `sample_changed` is a
  kind-agnostic device export, so effects can use it.

## Algorithm

Zero-latency non-uniform partitioned convolution (Gardner scheme), stereo in / stereo IR
(channel-wise: L * IR_L, R * IR_R; mono IR duplicated to both):

1. **Head, 0..128**: direct time-domain FIR (128 taps), SIMD — gives ZERO latency.
2. **Level 1, 128..8192**: uniform partitioned convolution, partition B1 = 128 (63 partitions),
   FFT 256, one FFT/IFFT per quantum + frequency-domain delay line (FDL).
3. **Level 2, 8192..end**: uniform partitioned convolution, partition B2 = 8192, FFT 16384,
   runs once every 64 quanta (its output is ready one B2 ahead of when it is needed).

The exact level layout (B1/B2, 2 vs 3 levels, uniform vs non-uniform) is DECIDED BY BENCHMARKS,
not assumed — see below.

Spectra are stored SPLIT (separate re[]/im[] arrays): the complex multiply-accumulate — the
dominant cost — becomes 4 mul + 2 fma per bin with straight-line f32x4 SIMD, no shuffles.

Real FFT of size 2B via complex FFT of size B (even/odd packing + post-twist), iterative
radix-4 (+ one radix-2 stage for odd log2), precomputed twiddles in state.

- Max IR length: 384000 frames (8 s @ 48 kHz). Longer IRs are truncated. Worst-case state
  ≈ 12–16 MB per instance (IR spectra 2ch + input FDL 2ch ≈ 8 × IR floats).
- IR transform is TIME-DISTRIBUTED: a few partitions per quantum on delivery; head partitions
  become audible first, the tail fades in over a few dozen ms — no render-thread spike.
- Latency: 0 samples (no PDC needed).

## Parameters (v1)

- `file` pointer → the IR sample
- wet dB, dry dB (default decibel mapping, as Reverb)
- normalize (bool): scale IR to unity energy so wet level is IR-independent
- predelay (exp seconds, as Reverb): delays the wet path
- reverse (bool): play the IR backwards (cheap, done at transform time)

## Benchmarks ("tests to see what is the fastest")

`crates/convolution` (lib crate, `no_std` core + std tests) with:
- correctness tests: partitioned output ≡ direct reference convolution (impulse, noise,
  random IRs, odd block sizes, IR swap mid-stream) within float epsilon
- native speed tests (`cargo test --release -- --nocapture bench`): per-quantum cost for IR
  lengths 0.1/0.5/1/2/4/8 s across variants:
  - uniform B = 128 / 256 / 512 / 2048
  - non-uniform 128+8192, 128+1024+8192
  - scalar vs SIMD-friendly cmul kernels
  reporting ns/quantum, worst quantum (spike), and ×-realtime
- wasm speed test in `packages/app/wasm/test/convolver-bench.test.ts` (node runs wasm with
  SIMD128): same variants through the real device module, so the wasm numbers decide

The device wires whatever wins.

## Integration checklist (Dattorro Reverb as template)

- [x] `crates/convolution` DSP lib + tests + benches
- [x] `crates/stock-devices/device-convolver` (AudioEffect, observe_sample)
- [x] `crates/Cargo.toml`: workspace member + `opt-level = 3` entries
- [x] `packages/studio/core-wasm/build-wasm.sh`: add to `DEVICE_CRATES`
- [x] `packages/studio/forge-boxes/.../audio-effects/ConvolverDeviceBox.ts` + index, regen boxes
- [x] `packages/studio/adapters/.../ConvolverDeviceBoxAdapter.ts` + BoxAdapters + index
- [x] `packages/studio/core/src/EffectFactories.ts` + `EffectBox.ts`
- [x] `packages/studio/core-wasm/src/engine-modules.ts`
- [x] studio UI editor (minimal: IR drop/pick + wet/dry/predelay/normalize/reverse)
- [x] `packages/app/wasm/test/convolver-device.test.ts` (parity + behaviour)
- [ ] full `build-wasm.sh` + typecheck + test run green

## Results

Native (Apple Silicon, `--release`, per 128-frame quantum, stereo, means over steady state):

| IR      | uniform B=128 | uniform B=512 | 128+8192 | 128+1024+8192 |
|---------|--------------:|--------------:|---------:|--------------:|
| (filled in by bench run) |

Decision: (filled in after benches)
