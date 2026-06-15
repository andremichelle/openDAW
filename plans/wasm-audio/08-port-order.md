# 08 — Port order

**Principle:** each step ends with a passing parity test (`07`) before the next. The first steps are
**infrastructure proofs** (de-risk the unknowns), not features. Ordering within phases is by
dependency + difficulty; refine as we go.

## Phase 0 — Infrastructure spikes

1. **Toolchain + sine wave.** Rust→wasm build, load into the AudioWorklet, emit a sine. Proves
   build + worklet load + output path end-to-end. Monolithic — no plugin system yet.
2. **Composition spike (`05`).** Engine wasm + one device wasm sharing `Memory` + `Table`, render a
   block **wasm-to-wasm**; validate memory model A, measure. **Gates the plugin architecture** — if
   this doesn't fly, the device design changes.
3. **Parity harness skeleton (`07`).** Rust offline render + null-test vs the TS offline engine, in
   CI, while there's something trivial to compare (silence/sine). Must exist before Phase 1.

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
