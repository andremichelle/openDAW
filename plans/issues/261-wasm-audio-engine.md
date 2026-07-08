# WASM Audio Engine (#261)

**Doability:** ⭐⭐⭐⭐☆ (4/5) — this is a tracking issue for an effort already largely built and shipped as the default engine; remaining work is finishing/hardening, not a from-scratch build.
**Type:** feature (tracking issue)
**Scope:** large

## What is asked
Tracking issue pointing at the design docs in `plans/wasm-audio/`. Goal: replace the real-time DSP core of the TS audio engine with a WebAssembly (Rust) module running in the AudioWorklet, for performance headroom and numerical robustness, without changing observable behavior versus the TS engine.

## Current behaviour / relevant code
`plans/wasm-audio/README.md` is the index; it references `packages/lib/dsp` (~74 files, the TS DSP behavioral reference), `packages/studio/core-processors` (the real-time TS path being mirrored), `packages/studio/core-workers` (offline render engine), and the Rust implementation in `crates/`. Status line in the README itself: **"planning — all docs drafted"** for the numbered design docs (01-language through 09-rollout, all decided/drafted), but that line is stale relative to actual progress — per this session's project memory, the WASM engine has been **the default engine since 2026-07-06** (`packages/app/studio/src/wasm-engine`, `packages/studio/core-wasm`), not merely planned.

Actual state, cross-referenced from project memory (accumulated across many prior sessions in this repo):

- **Shipped and default**: `EngineVariant` seam in `studio-core`, studio-contract processor, main-thread sync-bytes protocol, `/wasm-engine` assets, wasm-opt in the build (`build-wasm.sh`, binaryen). Toggle is dev+localhost-only; production users get WASM by default with a session-only opt-out fallback.
- **Ported and parity-tested** (per `project_stock_device_porting`): Waveshaper, Crusher, Fold, StereoTool, Maximizer, Compressor, Reverb, Dattorro, Velocity, Vocoder, plus Werkstatt/Apparat/Spielwerk (scriptable devices), Arp (full rate/mode/octave/gate port), NAM/Tone3000 (via a JS bridge to `@opendaw/nam-wasm` rather than a native Rust port). Only **NeuralAmp weight delivery internals** and **Modular** remain unported among devices.
- **Working subsystems**: bus/submix + aux sends, sidechain taps on device outputs, mixer solo, strip/send automation resolved at the update clock, note-clip launching (audio clips + soundfont), sample/soundfont handle lifecycle with generation-based recycling, live telemetry broadcaster (meters/spectra/note-activity) mirroring the TS `LiveStream`, mixdown/STEMS/freeze exports, recording + count-in, effects monitoring.
- **Known, tracked gaps** (per `project_wasm_feature_gaps` and `project_wasm_production_readiness`): MIDIOutput, markers, Zeitgeist's hardcoded 0.65 swing, cell live notes, terminate/bridge leaks (notably NAM device removal has no terminate export yet), loop-gating while recording, signature track, metronome preferences, DSP-load stats, base frequency, truncate preference, note ordering, unguarded worklet handlers, freeze-reboot state loss, `EventBuffer` render-time allocation, unmapped-param abort risk, and reactive engine binding (audio-region/clip/recording pieces of the box-graph→engine cascade are still one-shot rather than fully subscription-driven, per `project_reactive_engine_binding`).
- **Explicitly deferred**: time-stretch v2 (transient-aware phase vocoder — current time-domain granular approach sounds grainy on pads), JS-in-WASM scripting alternatives (researched, no viable path found as of the investigation), SDK packaging (`sdk-packaging.md` — publish as `@opendaw/studio-core-wasm` with a manifest-driven plugin path).
- Test posture per the last audit: 496+115 tests green, 28/28 parity contracts passing.

## Plan
This is a tracking issue, not an actionable unit of work in itself. Recommended handling:

1. **Update `plans/wasm-audio/README.md`'s status line** — it currently reads "planning — all docs drafted," which understates reality (engine is shipped and default). Replace with a status reflecting "core shipped as default engine; remaining work: NeuralAmp/Modular port, SDK packaging, hardening gaps below."
2. **Point this GitHub issue at the gap list**, not the design docs, since the design phase is done. The actionable remaining backlog is what's in `project_wasm_feature_gaps` and `project_wasm_production_readiness` (both openDAW-session memory files, not yet promoted into `plans/wasm-audio/*.md`) — consider writing those up as `plans/wasm-audio/remaining-gaps.md` so the tracking issue has a durable, in-repo target instead of only living in session memory.
3. Treat `sdk-packaging.md` (already in `plans/wasm-audio/`) as the next concrete milestone — it is marked "planned" and is the last item before the WASM engine can be consumed outside the studio app itself (e.g. by `opendaw-headless`).

## Risks / open questions
- The gap list above is sourced from session memory, not a repo file — worth confirming against current `crates/` and `packages/studio/core-wasm` state before treating it as authoritative, since it accumulated over many sessions and some items may already be closed.
- Modular and NeuralAmp are the two largest remaining device ports; NeuralAmp specifically has a known resource leak (no terminate export) that should be prioritized over the pure feature gaps since it is a stability issue, not a missing feature.
- Reactive engine binding (subscription-driven audio-region/clip/recording graph updates, replacing the current one-shot `build_audio_graph` snapshot) is architecturally the biggest remaining item and likely deserves its own tracked issue rather than living inside this umbrella one.
