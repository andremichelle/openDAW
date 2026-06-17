# 08 — Port order

**Principle:** each step ends with a passing parity test (`07`) before the next. The first steps are
**infrastructure proofs** (de-risk the unknowns), not features. Ordering within phases is by
dependency + difficulty; refine as we go.

## Phase 0 — Infrastructure spikes

1. **Toolchain + sine wave.** ✅ Done. `crates/audio-engine` (no_std, no deps, homebrew sine) →
   wasm; `packages/app/wasm` test app loads it into an AudioWorklet (`public/engine-worklet.js`) and
   plays it. Engine verified numerically in Node (zero imports, ±0.2 sine, ~440 Hz). Studio untouched
   (workspace glob picks the app up). Browser audible check: `npm i` then
   `npm run dev -w @opendaw/app-wasm`, click Play.
2. **Composition spike (`05`).** ✅ Done. `compose-engine` + `compose-device` share one imported
   `Memory`; engine generates a sine into its arena and calls the device's `process` wasm-to-wasm.
   Memory model **A validated** (no collision, ~250 ns/block Node / ~500 ns browser). Test page
   `/compose`. Hardened with two **stateful** devices chained (`/chain`: lowpass + feedback delay),
   each relocated via `--global-base` into a disjoint slab — bit-faithful vs an f32 reference, state
   isolated across 100k cross-calls, ~700 ns/block. Dynamic dispatch (`Table`/`call_indirect`) and
   SAB-backed memory deferred (see `open-questions`). **Plugin architecture de-risked.**
3. **Parity harness skeleton (`07`).** ✅ Done. Two levels wired + green: native `cargo test -p dsp`
   (DSP primitives vs std), and a wasm **null test** — `renderSineOffline` + `nullTest` vs a TS f32
   reference (`packages/app/wasm/src/parity/`), peak < 1e-5. Runs via `npm run test:parity` in a
   dedicated `parity.yml` (installs Rust); kept out of the main `turbo test` so that stays Rust-free.
   Reference is a TS sine placeholder for now, swapped for the real TS engine output as features land.

## Phase 1 — Foundation (the spine)

4. **Box-graph reader** (generic codec) + round-trip test. Nothing reads a project without it.
5. **Time & transport core** — PPQN, ppqn↔samples, fixed bpm, play/stop/seek, block descriptor,
   128-sample quantum loop.
6. **Signal graph + output** — audio-unit → output, summing, topological process loop.
7. **Channel strip** — gain / pan / mute (ramped).

## Phase 2 — First sound

8. **Notes + a sine instrument** — note region → note-on/off scheduling → trivial sine voice →
   channel strip → output. First musical output; exercises the whole spine end-to-end.

## Phase 3 — Content types (each parity-tested)

9. **Sample playback** — audio-region read head + interpolation + gain + fades; needs `AudioData`
   delivery (`fetchAudio`).
10. **Automation / value flow** — value events, interpolation, parameter application + smoothing.
11. **Regions & loops** — loopable-region math, loop area, markers.
12. **Clips + clip sequencing** — session launch / quantize.

## Phase 4 — Devices (behind the proven ABI)

13. **Device ABI v1** finalized; port instruments/effects **one at a time**, each a parity-tested
    plugin — simplest first (gain, sample-based) → complex (synths, reverbs).
14. **Scriptable-device backend** — wasm→JS bridge (`scriptable-devices.md`).

## Phase 5 — Accumulating details

15. Tempo & signature automation, count-in, metronome, full marker/loop behavior.
16. Metering / analysis + telemetry path.
17. External MIDI I/O, grooves, modular.
18. Recording / monitoring (capture → ring buffer → main thread persists boxes).

**Engine control & state sync** (command protocol + state stream) is wired incrementally from Phase 1
on — needed to drive/observe the engine from the UI.

Out of scope: multi-threading, offline export.
