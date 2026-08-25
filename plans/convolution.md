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
- [x] `packages/app/wasm/test/convolver-bench.test.ts` (wasm speed gate)
- [x] param-mapping-parity entry + regenerated `test-files/all-boxes.od`
- [x] full `build-wasm.sh` + typecheck + full test run green (cargo workspace + 87 vitest files)
- [ ] DeviceBenchmark entry: skipped — that harness cannot feed an IR sample, so it would only
      measure the dry pass-through; the dedicated wasm bench above is the real number

## Results

Native (Apple Silicon, `cargo test --release --test convolution_bench -- --ignored --nocapture`,
per 128-frame quantum, stereo, budget @48 kHz = 2666 us):

| layout                              | ir frames | mean       | worst        |
|-------------------------------------|----------:|-----------:|-------------:|
| canonical 128 / 128+1024+8192       |     4800  |  24 us  0.9% |  107 us  4.0% |
| canonical 128 / 128+1024+8192       |   384000  |  27 us  1.0% |  186 us  7.0% |
| uniform B=128 (textbook FDL)        |    24000  |  14 us  0.5% |   31 us  1.1% |
| uniform B=128 (textbook FDL)        |   384000  | 193 us  7.2% |  234 us  8.8% |
| two-level 128 + 8192                |   384000  |  18 us  0.7% |  160 us  6.0% |

The canonical non-uniform layout is FLAT in IR length (the tail cost is spread across the period);
the textbook uniform FDL grows linearly and is already 5x more expensive at 8 s mean. The worst
quanta (~7%) are the two L3 16k-FFT steps — spread further only if it ever matters.

spectral_mac kernel: padding the bin count to a multiple of 4 buys the SIMD lanes
(1025 bins 4.6 Gcmul/s -> 1028 bins 6.7 Gcmul/s); the layout pads all spectra accordingly.

WASM (node 48 kHz, same SIMD128 modules the worklet runs, full engine render, 8 s stereo noise
IR, `convolver-bench.test.ts`): mean 37 us (1.4% budget), p99 230 us, worst real quantum
~250-290 us (~10% budget, the L3 FFT/IFFT quanta). Zero latency, no PDC needed.

Decision: canonical 3-level layout shipped (head FIR 0..128 direct, eager B=128 for 128..2048,
slack B=1024 for 2048..16384, slack B=8192 for 16384..385024, MAC spread + staged IFFT).

## Browser checkpoint (2026-08-25)

Verified in the running studio (dev server, Chrome): the Convolver appears in the Audio Effects
browser + add-effect menu, the editor renders (IR drop zone, Pre-Delay/Wet/Dry knobs, NRM/REV),
a sample drags onto the drop zone and binds (label shows the file), no console errors, no engine
reboot. GROUND TRUTH by offline mixdown export (WAV intercepted in-page and analyzed numerically):

- convolver ENABLED, no IR: peak -9.57 dB — identical to the dry chain (pass-through correct),
  and it matches the live strip meter reading (-9.7 dB) during realtime playback
- convolver ENABLED, TR-808 Cymbal IR (normalize on, wet -3 dB): peak -9.59 dB, RMS shifted
  -24.4 -> -26.1 dB, and the bounce auto-extended ~0.5 s for the convolution tail

The "-inf strip meter after insert" observation was chased to root cause (2026-08-25, second
session) and the convolver is fully exonerated:

- Headless repro of the worklet's #syncBroadcasts loop against the real engine
  (test/convolver-meter-live.test.ts): a mid-play convolver insert grows the wasm memory once,
  bumps the broadcast generation, the loop resubscribes, and the UNIT-strip FLOAT_ARRAY slot keeps
  reporting correct peaks. Engine + worklet broadcast path: healthy.
- In the live studio, subscribing to the unit address directly on the main-thread
  LiveStreamReceiver and pumping `receiver.dispatch()` manually: ~30 callbacks/s with correct
  peaks (0.317 vs 0.314 baseline) THROUGH a freshly inserted, enabled convolver — and the strip
  peak label immediately updated to the real value.
- ROOT CAUSE: `LiveStreamReceiver.connect` drives dispatch exclusively via `AnimationFrame`
  (lib-dom frames.ts), i.e. `requestAnimationFrame`, with no fallback. In a hidden/occluded
  Chrome window (`document.visibilityState === "hidden"` — the automation sessions ran unfocused)
  Chrome suspends rAF entirely: measured 0 rAF ticks/s while audio kept rendering. Every
  meter/telemetry label freezes at its last value. Actions that rebuild the devices panel
  (inserting a device, reselecting the track) recreate the peak label at its initial -inf, which
  then never updates. The non--inf readings between (-25.8/-51.6/-9.7) were single sparse
  dispatches sampling the engine-side DECAYING peak at random moments, hence the inconsistent
  magnitudes. The correlation with the convolver was coincidence: it was the action that rebuilt
  the panel inside the starved windows.
- No engine or device defect. If meters-under-hidden-windows ever matter (remote/live-room
  scenarios), the fix would be a timer fallback for the receiver's dispatch when rAF is
  throttled — noted as a product decision, not applied.

## Multithreading verdict

The engine's linear memory is deliberately non-shared (relocatable on grow, #1030), so worker
threads cannot see the heap: in-engine multithreading is off the table without re-architecting
memory. At 1.4% mean / 10% worst budget for the maximum IR there is no need — SIMD + the
non-uniform schedule already leave ~99% of the render budget free.
