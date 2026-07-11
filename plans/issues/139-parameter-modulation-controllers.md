# Request - Parameter Modulation Controllers (#139)

**Doability:** ⭐ (1/5) as a whole request. The individual controller devices are each buildable, but there is no modulation-routing infrastructure to hang them on yet, and building that infra is the real ask.
**Type:** feature (infra + 7 devices)
**Scope:** large

## What is asked

Generic modulation controllers that can modulate any parameter on any device: envelope follower, LFO controller, MSEG, step controller (trancegate), XY controller, keytracking controller, velocity controller.

## Current behaviour / relevant code

**There is no generic modulation-routing infrastructure in openDAW today.** Investigated specifically because the task asked to check for one:

- `Pointers.Modulation` exists on nearly every automatable box field (e.g. `packages/studio/boxes/src/VaporisateurDeviceBox.ts` field 14 `cutoff: Float32Field<Pointers.Modulation | Pointers.Automation | Pointers.MIDIControl>`), but it is only used to **label** a parameter's control source for display. See `packages/studio/adapters/src/AutomatableParameterFieldAdapter.ts:213-226`, `mapPointerToControlSource`, which maps `Pointers.Modulation` to the string `"modulated"` for UI purposes. Nothing produces a `Pointers.Modulation` edge from outside a device today, and nothing consumes one.
- Runtime parameter resolution lives in `packages/studio/core-processors/src/AutomatableParameter.ts`. Each block it resolves to exactly **one** value: either the automation curve at the current position (`updateAutomation`, line 47-54) or the box field's raw value (`getValue()`). There is no summing of multiple modulation sources, no depth scaling, no per-sample control-rate mixing.
- The **Modular device** (`packages/studio/adapters/src/modular/`, `packages/app/studio/src/ui/modular/`) is a separate, self-contained patchable audio-signal graph living inside one device slot (`ModularDeviceBox`, schema at `packages/studio/forge-boxes/src/schema/devices/modular.ts`). Its modules today are `ModuleGainBox`, `ModuleDelayBox`, `ModuleMultiplierBox`, and audio in/out (`packages/studio/adapters/src/modular/module.ts:32-46`, the `Modules` namespace visitor lists all four). There is **no LFO or envelope-follower module**, and its connections are `Pointers.VoltageConnection` between modules inside the same Modular device, not a bridge to any other device's `Pointers.Modulation` parameter target. It cannot today reach out and modulate, say, a Vaporisateur's cutoff on the same track.
- Vaporisateur has its own **hardcoded internal LFO** (`packages/studio/boxes/src/VaporisateurLFO.ts`), with three fixed target fields baked into the schema itself: `targetTune`, `targetCutoff`, `targetVolume`. This is device-internal modulation, not a generic controller that can target arbitrary parameters on arbitrary devices — it's schema-level, not routing-level.
- The existing per-parameter assignment UI (right-click a knob to assign automation/MIDI-learn) is `packages/app/studio/src/ui/components/AutomatableControl.tsx` calling `attachParameterContextMenu` from `packages/app/studio/src/ui/menu/automation.ts`. This is the natural extension point for an "Assign modulator" menu entry once routing exists.

## Plan

This has to be split into an infrastructure phase and a per-controller-device phase; building 7 controller devices without the infra first would mean re-deriving the routing mechanism 7 times.

### Phase 1 — modulation routing infra

1. Define a **modulation connection** concept: a source (a controller device's output, control-rate, one value per block or per sample) and a target (any `AutomatableParameterFieldAdapter` elsewhere in the graph, addressed the same way automation/MIDI-learn already address parameters), plus a depth/amount and polarity (bipolar/unipolar).
2. Extend `AutomatableParameter.ts` to **sum** contributions: base value (or automation-resolved value) plus Σ(modulator output × depth), evaluated at the same cadence automation already updates (per block, via something like `updateAutomation`). This is the crux of the infra — everything else is UI and controller DSP.
3. Decide the box-graph representation for a modulation edge — most consistent with existing patterns would be a `PointerField<Pointers.Modulation>` on the target field pointing at a new small "ModulationRouteBox" that carries the source reference + depth, mirroring how automation lanes reference their target today. Do not invent this from scratch without checking how `Pointers.Automation` edges are represented, mirror that structure.
4. UI: extend `attachParameterContextMenu` (`packages/app/studio/src/ui/menu/automation.ts`) with an "Assign modulator" path, and a way to pick from the project's existing modulation-controller device instances.

### Phase 2 — controller devices (each is its own small device, once phase 1 lands)

Each is a MIDI-effect-shaped or free-floating device producing a single control-rate output:
- **Envelope follower** — audio-rate input, needs an audio-effect-shaped device that can tap a signal (mirror the Vocoder's sidechain-tap pattern in `plans/vocoder.md` for how an effect reads another track's audio) and output an envelope.
- **LFO controller** — mirror the DSP already in `VaporisateurLFO`/`LFO` (`@opendaw/lib-dsp`), but as a standalone device rather than baked into one instrument.
- **MSEG** — a drawn multi-segment envelope, closest existing precedent is the automation-curve editor itself; reuse curve-drawing UI if it can be factored out.
- **Step controller (trancegate)** — mirror Tidal's bpm-synced phase clock (`packages/studio/core-processors/src/devices/audio-effects/TidalDeviceProcessor.ts`) but stepped/quantized output instead of a continuous shape function.
- **XY controller** — a 2D pad UI producing two simultaneous outputs, no DSP precedent needed, mostly a UI + two output ports problem.
- **Keytracking controller** — trivial once routing exists: reuse `MidiKeys.keyboardTracking`, already used in `VaporisateurVoice.ts:70` for `filter_keyboard_delta`, as a per-note-scaled static input rather than a per-voice-only value.
- **Velocity controller** — same, reuse `velocityToGain`/raw velocity already available per `NoteEvent` (see `packages/studio/core-processors/src/devices/instruments/VaporisateurVoice.ts:99`).

## Risks / open questions

- This is the largest architectural gap of the whole batch. Phase 1 alone touches the box schema layer, the adapter layer, the processor's core parameter-resolution path, and the UI context menu — it is a cross-cutting engine change, not a device addition.
- Per-voice vs per-device modulation: keytracking/velocity are naturally per-voice (per note), while LFO/envelope-follower/MSEG/step are naturally per-device (one shared modulation source for a whole device instance). The routing infra needs to support both, or explicitly scope v1 to device-level-only and treat per-voice modulation (keytracking, velocity) as the special case Vaporisateur already partially has.
- WASM parity: the Rust engine mirrors `Pointers.Automation`/`Pointers.MIDIControl` resolution today; a new modulation-summing path needs the same mirror, doubling the infra work.
- Recommend shipping infra + **one** controller (LFO, since its DSP already exists) as the v1 deliverable, then adding the other six once the routing surface is proven.
