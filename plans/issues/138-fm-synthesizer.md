# Request - FM (PM) Style Synthesizer (#138)

**Doability:** ⭐⭐ (2/5). Large new instrument, no unknowns block it but the operator/algorithm design needs a maintainer decision before coding starts.
**Type:** feature
**Scope:** large

## What is asked

A new FM/PM synthesizer instrument. Reporter wants Operator-style UI, Sytrus-style routing (freeform operator-to-operator modulation matrix), multiple modulators, and waveshaping. Acceptance criteria implied: a playable polyphonic instrument device with operators, adjustable modulation routing, and per-operator envelopes.

## Current behaviour / relevant code

No FM/PM device exists. The closest template is Vaporisateur, a subtractive synth:
- Schema: `packages/studio/forge-boxes/src/schema/devices/instruments/VaporisateurDeviceBox.ts` (uses `DeviceFactory.createInstrument`, an `ArrayField` of oscillator objects at key 40, a nested LFO object at key 30)
- Generated box: `packages/studio/boxes/src/VaporisateurDeviceBox.ts`
- Adapter: `packages/studio/adapters/src/devices/instruments/VaporisateurDeviceBoxAdapter.ts`
- Processor + voice: `packages/studio/core-processors/src/devices/instruments/VaporisateurDeviceProcessor.ts`, `VaporisateurVoice.ts` (per-voice oscillator/filter/envelope processing, `Voice` interface in `packages/studio/core-processors/src/voicing/Voice.ts`)
- WASM mirror: `crates/stock-devices/device-vaporisateur/src/voice.rs`

`VaporisateurVoice.ts` currently shares a single `Adsr` (see #149 below) between VCA and filter envelope, which is exactly the kind of coupling an FM device must avoid per-operator from day one.

`Waveshaper` namespace already exists in `@opendaw/lib-dsp` (6 equations: hardclip, cubicSoft, tanh, sigmoid, arctan, asymmetric), documented in `plans/waveshaper-device.md`. This is reusable for FM feedback/output waveshaping instead of inventing new curves.

No modulation-matrix infrastructure exists anywhere in the codebase (see #139's writeup) — an FM operator matrix is self-contained per-voice DSP, it does not need or benefit from the cross-device modulation-routing infra in #139, keep them independent.

## Plan

1. **Scope the operator model before writing schema.** A freeform NxN Sytrus-style matrix costs one modulation-depth read + phase computation per operator pair per sample; at 6 operators that's 30 cross terms per sample per voice, per polyphonic voice. Recommend a **fixed operator count (4 or 6)** with either:
   - DX7-style fixed **algorithms** (a small enumerated set of carrier/modulator summing graphs, selected by an `Int32Field` constraint list), which is cheap, well-understood, and still delivers "Operator-style" UI, or
   - A bounded matrix (each operator has a modulation-depth float toward every *higher-indexed* operator only, avoiding feedback cycles except an explicit self-feedback term), closer to Sytrus but still O(N²) bounded and acyclic by construction.
   Get this decision from the maintainer before implementation; it drives the schema shape.
2. **Schema** — new `packages/studio/forge-boxes/src/schema/devices/instruments/FMDeviceBox.ts` via `DeviceFactory.createInstrument`. Per operator (array field, mirror `VaporisateurOsc`): ratio or fixed-frequency mode, output level, feedback amount, waveform (sine plus a couple of others for PM color), and its **own** ADSR (attack/decay/sustain/release) — do not repeat the Vaporisateur single-envelope mistake (#149). Top-level fields: algorithm selector (or matrix depths), global pitch envelope, unison (mirror Vaporisateur's `unisonCount`/`unisonDetune`/`unisonStereo` fields 23-25).
3. **Adapter** — `packages/studio/adapters/src/devices/instruments/FMDeviceBoxAdapter.ts`, mirroring `VaporisateurDeviceBoxAdapter.ts`'s `#wrapParameters` pattern, one `AutomatableParameterFieldAdapter` per operator field.
4. **Processor + voice** — `FMDeviceProcessor.ts` (mirror `VaporisateurDeviceProcessor.ts`) and `FMVoice.ts` implementing the `Voice` interface. Per sample: compute each operator's phase-modulated output per the fixed algorithm graph, sum carriers, apply per-operator ADSR-scaled output level, optional feedback single-sample delay on self-modulating operators, then output waveshaping via `Waveshaper.process` before the mixer.
5. **Editor** — `packages/app/studio/src/ui/devices/instruments/FMDeviceEditor.tsx`. Operator grid (per-operator knobs: ratio, level, feedback, ADSR) plus an algorithm diagram (static SVG/canvas per selected algorithm, not a freeform patch editor for v1).
6. **WASM parity** — new `crates/stock-devices/device-fm` crate mirroring `device-vaporisateur`'s voice/lib.rs split, per the project's frozen-contract discipline (`project_wasm_device_architecture.md`).
7. **Factory wiring** — register in `packages/studio/core/src/InstrumentFactories.ts`-equivalent (find the instrument counterpart of `EffectFactories.ts`), `BoxAdapters.ts`, `DeviceProcessorFactory.ts`, `DeviceEditorFactory.tsx`, `DeviceManualUrls.ts`.

## Risks / open questions

- The single biggest open question is **algorithm vs. freeform matrix** — this changes the schema, the UI, and the DSP loop shape. Needs a maintainer call before any code is written.
- Real-time cost: per-operator ADSR (N `Adsr` instances per voice) plus phase-modulation cross terms, times polyphony, times unison — needs profiling once a voice count is chosen (compare against Vaporisateur's existing unison cost as a baseline).
- WASM parity roughly doubles the implementation work; consider shipping TS-only first and porting to Rust as a fast-follow, consistent with how other stock devices were phased in (`project_stock_device_porting.md`).
- No existing "Operator-style UI" component to mirror in this codebase — the operator grid and algorithm diagram are new UI, not a port of an existing editor.
