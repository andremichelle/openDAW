# Automating enable/disable of effects (#270)

**Doability:** ⭐⭐☆☆☆ (2/5) — the field exists and is boolean, but wiring it for smooth automated bypass touches audio-chain routing, not just a value read.
**Type:** feature, ux
**Scope:** medium-large (cross-engine)

## What is asked
Allow automating an audio effect's enabled/bypass state, the same way other device parameters can be automated.

## Current behaviour / relevant code
`enabledField` is a plain `BooleanField`, defined per-device-adapter, e.g. `packages/studio/adapters/src/devices/audio-effects/FoldDeviceBoxAdapter.ts:35`:
```ts
get enabledField(): BooleanField {return this.#box.enabled}
```
This pattern repeats across every audio-effect adapter (Compressor, Delay, Dattorro, Crusher, Vocoder, Revamp, Werkstatt, Modular, Reverb, Maximizer, Waveshaper, StereoTool, NeuralAmp, Gate, Tidal, Unknown — all under `packages/studio/adapters/src/devices/audio-effects/`). None of them route `enabled` through `ParameterAdapterSet.createParameter` (contrast with e.g. Playfield's `mute`, `.../PlayfieldSampleBoxAdapter.ts:156`, which does). So there is currently no `AutomatableParameterFieldAdapter` for "enabled" on any effect — nothing for the automation UI (track creation, "Create Automation" context menu, value editor) to attach to.

The power-button UI toggles it directly: `packages/app/studio/src/ui/devices/DeviceEditor.tsx:157`:
```ts
Events.subscribe(element, "click", () => editing.modify(() => enabledField.toggle()))
```
No `attachParameterContextMenu` on this control.

On the audio-thread side, `enabled` drives structural chain rewiring, not a continuous multiply: `packages/studio/core-processors/src/InsertReturnAudioChain.ts:50,67`:
```ts
device.adapter().enabledField.subscribe(() => this.invalidateWiring())
...
if (target.adapter().enabledField.getValue()) { ... }
```
Bypass is resolved by re-wiring which processor is patched into the chain, reactively on field changes. This is architecturally different from continuous automatable params (which are read per-audio-block via a bound `AutomatableParameter`, see `packages/studio/core-processors/src/AutomatableParameter.ts` and `AbstractProcessor.updateParameters`, `packages/studio/core-processors/src/AbstractProcessor.ts:63-69`). Automating bypass smoothly (without clicks, synced to playback position rather than to a UI click event) means the wiring-invalidation path needs to react to the *automated* value at the update-clock resolution, not just to direct field writes.

## Plan
1. Confirm the underlying box schema already has an `enabled: BooleanField` with an `Automation` pointer target available (check `PlayfieldSampleBox`'s `mute` field definition as the working example of a field that supports both direct writes and automation pointers) — if the schema doesn't support attaching an automation pointer to `enabled` on effect boxes, this needs a schema change across every affected box (`packages/studio/boxes/src/*DeviceBox.ts`).
2. Register `enabled` via `ParameterAdapterSet.createParameter(box.enabled, ValueMapping.bool, StringMapping.bool, "Enabled")` in each audio-effect adapter (or, if all effect adapters share a common base/mixin, add it there once — check for a shared base class across `packages/studio/adapters/src/devices/audio-effects/*.ts` before duplicating 15+ times).
3. Wire the power-button UI (`DeviceEditor.tsx:157`) with the standard automation-control wrapper (`attachParameterContextMenu` or the `AutomationControl` wrapper described in `plans/automation-wrapper.md`) so right-click offers "Create Automation".
4. Update `InsertReturnAudioChain` (and any MIDI equivalent, `MidiDeviceChain.ts`) to consult the bound `AutomatableParameter`'s automated value (updated per the update-clock) rather than only `enabledField.getValue()`/its change-subscription, so automation actually affects the wiring during playback.
5. Mirror in the WASM engine: locate the Rust equivalent of chain bypass/wiring (device enable/disable handling in `crates/engine/src/audio_unit/wiring.rs` or similar) and apply the same bind-and-resolve pattern.
6. Decide and test the audible behaviour at the moment of a bypass toggle mid-block (click-free switching, or an implicit short fade) — this is a design decision, not just plumbing.

## Risks / open questions
- Structural rewiring per automation event (rather than per user click) may need debouncing/click-avoidance that doesn't exist today — this is the main reason this scores lower than a typical "add automation to a parameter" task.
- Needs a maintainer decision on whether *all* effect types support this uniformly, or only entries with a chain topology simple enough to reroute cheaply (e.g. side-chained effects, effects with internal state/tails, might glitch on toggle).
- Cross-engine parity: WASM's chain-wiring model needs to be located and confirmed equivalent before estimating effort there.
