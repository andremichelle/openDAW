# 07 — Testing & parity harness

Correctness is verified by **tests, not code review** (we don't read the Rust/WASM). The current TS
engine is the behavioral **reference**; the harness proves the Rust engine matches it. This is the
load-bearing doc of the whole project.

## Prerequisite: deterministic offline render

- Both engines must render **headless/offline** — N blocks synchronously, no `AudioContext`. TS
  already has this (`core-workers` offline engine); Rust gets an equivalent entrypoint.
- Determinism required for comparison: fixed sample rate + block size, single-threaded (decided), no
  wall-clock, and **all randomness seeded** with a shared reproducible seed (note `chance`, any
  dithering). Same seed → same output on both sides.

## Levels (pyramid)

- **Unit (native Rust, `cargo test`):** DSP primitives with known I/O — ppqn/tempo conversion, ramps,
  interpolation, fade curves, resampler, envelopes. Fast, run constantly.
- **Parity / golden (the core net):** feed an identical fixture (box graph) + transport to **both
  engines offline**; compare rendered audio + telemetry per block.
- **Property / fuzz:** randomized projects / params / note patterns; assert invariants (no NaN,
  in-range, finite) **and** TS↔Rust agreement.
- **Contract tests:** per-device param / value-mapping / telemetry parity; **box codec round-trip**
  (serialize in TS → parse in Rust → compare).

## Comparison & tolerance

- Prefer the **null test**: subtract the two outputs, measure residual (peak abs diff / RMS / SNR)
  against a threshold. Bit-exact where achievable.
- Expect float divergence (→ epsilon, not bit-exact) from: transcendentals (JS `Math` vs Rust libm),
  summation order in mixing, SIMD vs scalar, denormal flush. Set tolerance per primitive/category.

## Two Rust targets

- **native** (`cargo test`): fast — dev loop + CI bulk.
- **in-wasm**: the **shipping** artifact; wasm float/SIMD behavior can differ from native, so run a
  wasm parity subset. **wasm-vs-TS is the real check**; native is for speed.

## Fixtures

- A growing corpus of box-graph project files — one (or more) per mechanic in
  `feature-inventory.md`: empty, single note, looped region, automation curve, tempo & signature
  change, sample + soundfont playback, count-in, loop-wrap edge, each device, plus generated random
  projects. Fixtures are read-only box graphs fed to both engines.

## Workflow rule

A feature-inventory item is **"done" only when it has a passing parity test**. Port → test → green →
next. This is how we make progress without reading the code.

## CI

- Unit + native parity on every commit; wasm parity subset in CI; full wasm parity nightly.
  Any regression = red.

## Open

- Tolerance thresholds per category — decide empirically as the first primitives land.
- Whether to pin shared transcendental implementations for tighter exactness.
- Fixture authoring: hand-written vs captured from the UI / existing projects.
