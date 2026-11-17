# FX Composite: layer send

A per-layer SEND button in the FX Composite. Send gates the layer's INPUT only. With send off the layer receives
silence and its chain keeps running, so tails ring out. The layer's output is never touched by send.

## Decisions (2026-11-17)

1. One automatable boolean parameter per layer, default ON (send). Existing projects sound identical.
2. No mode selector. A short click toggles. Holding the button inverts the stored state while held and snaps
   back on release (off + hold = send while held).
3. MIDI learn as for any boolean parameter: a held note acts like holding the button.
4. A short fade (a few ms) when the gate opens or closes, no clicks.
5. FX Composite only. Not Stereo Composite, not Frequency Split, not instrument composite layers.

## Schema

`AudioEffectCompositeCellBox` field `44: {type: "boolean", name: "send", pointerRules: ParameterPointerRules,
value: true}`. The box is shared with Stereo Composite and Frequency Split. Their layers carry the field at its
default and show no button, so they behave unchanged. Mirror the field in `crates/studio-boxes/src/registry.rs`.

## Engine

1. `EffectCompositeSpec` gets `send_key` (0 = none). Only `AudioEffectCompositeBox` registers 44. Extending the
   registration call is a WASM contract change: TS registration and Rust side change together.
2. Each branch gets a gain stage between the distributor output and the layer chain, ramping to 0 or 1 over a
   few ms. Bound like mute: static field monitor, automation, modulation.
3. The input tap (dry) and sidechain tap stay ungated.

## Adapter + UI

1. `AudioEffectCompositeCellBoxAdapter.namedParameter.send`.
2. `CompositeCellStrip` gets an optional send button, passed only by the FX Composite's `AudioCompositeEntry`.
   Space reserved in the strip, no layout jump.
3. Interaction: pointerdown starts a hold timer. Release before it fires = toggle (one undo step). Fires =
   momentary: invert while held, restore on release / lost capture. During recording both write automation like
   any parameter edit.
4. Tooltip "Send audio into layer (click toggles, hold sends momentarily)".

## Scripting

`send` on the composite layer facade, documented in `api.declaration.d.ts`.

## Tests

1. Engine: send off = layer chain input silent, layer output (reverb tail) continues. Default on = bit-identical
   render of an existing FX Composite test project.
2. Engine: automated send toggles land on the block position, ramp has no step.
3. Stereo Composite / Frequency Split renders unchanged.
4. Browser: click toggle, hold momentary, MIDI learn, automation record + playback.
