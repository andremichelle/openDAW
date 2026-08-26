# SIMD-optimised FFT in Rust for WASM

We need a highly SIMD-optimised FFT in the Rust engine. The wasm build already ships with
`-C target-feature=+simd128` (see `packages/studio/core-wasm/build-wasm.sh`), but the only FFT we
have is the scalar radix-2 port in `crates/dsp/src/analyser.rs` (a mirror of lib-dsp `FFT.process`,
fixed size, strided twiddle access). That shape barely autovectorises, so we leave most of the
128-bit lanes unused.

## Consumers

- `dsp::AudioAnalyser` spectra (Revamp, NAM and Vocoder editors), currently the scalar radix-2
- The transient-aware phase-vocoder time-stretch (`plans/`/time-stretch v2) is planned "on our own
  FFT" and will run per voice per block, which makes FFT cost a render-thread budget item
- Future candidates: fast convolution (reverb/IR, NAM cabinet), spectral metering, pitch detection

## Requirements

- `f32`, explicit `core::arch::wasm32` v128 intrinsics (`f32x4` butterflies), not autovectorisation hope
- Real-input FFT via the half-size complex transform + post-twiddle (audio is real, halves the work)
- Sizes 256 to 8192, powers of two, plan-style precomputed twiddles per size
- Zero allocation after plan creation, in-place or ping-pong on caller buffers (talc allocator rule:
  never allocate during render)
- Forward and inverse, plus windowed helpers (Hann) for the phase vocoder overlap-add path
- Bit-exactness is NOT required against lib-dsp, but the analyser must keep its TS-faithful output
  contract where it feeds existing editor views (verify magnitudes within epsilon, not sample-exact)

## Design sketch

Radix-4 (or split-radix) decimation-in-time keeps butterflies wide enough to fill `f32x4` lanes:
process four complex values per instruction with split real/imag arrays (SoA), which avoids shuffles
that interleaved layout would force. The first stages after bit-reversal are lane-parallel by
construction, the last two stages need one shuffle each. Twiddles stored pre-splatted per stage so
the inner loop is pure `f32x4_mul`/`f32x4_add`.

Alternative worth benchmarking first: port/wrap `realfft`/`rustfft` (rustfft has wasm simd128
support since 6.x). If it reaches within ~20% of a hand-written kernel, prefer it (minimal
dependencies still favours our own small kernel over pulling the full rustfft feature set, so
measure before deciding).

## Verification

- Criterion-style micro benches native + wasm (node with `--experimental-wasm-simd` is default-on
  now), sizes 1024/4096, vs the current scalar radix-2
- Parity test against the analyser's existing sine-at-bin-center fixture
  (`crates/dsp/src/analyser.rs` tests) and white-noise round-trip forward→inverse error < 1e-5
- Swap `AudioAnalyser::fft` to the new kernel behind the same output contract, engine test suite green
