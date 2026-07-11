# Request - Volume Envelope Device (#102)

**Doability:** ⭐⭐⭐ (3/5) for a Tidal-oneshot-mode version. ⭐⭐ (2/5) for a freeform drawn-segments version, and either version inherits an open question about per-note retriggering that the current audio-effect chain cannot do today.
**Type:** feature
**Scope:** medium

## What is asked

An effect device to shape volume at the end of a chain (e.g. after Vaporisateur). Envelope drawn like an automation region (Bitwig "Segments" style), saveable as a preset. Reporter explicitly suggests: "Like Tidal but as a oneshot, or a oneshot option for Tidal."

## Current behaviour / relevant code

Tidal (`packages/studio/core-processors/src/devices/audio-effects/TidalDeviceProcessor.ts`) is the closest existing device: an audio-effect gain-shaper driven by a **bpm-synced, free-running phase**, not by note events. Per block (`processAudio`, lines 78-98):

```
const phaseL = (p0 + i * delta) * rateInvPulses + offset0
outL[i] = inpL[i] * this.#smoothGainL.process(this.#computer.compute(phaseL - Math.floor(phaseL)))
```

`phaseL - Math.floor(phaseL)` is the wrap that makes Tidal a **repeating** tremolo. `TidalComputer.compute` (`@opendaw/lib-dsp`) turns a 0-1 phase into a gain using `slope`/`symmetry` shape parameters, this is a parametric shape function, not a freeform drawn curve.

**Audio effects cannot see note events today.** Confirmed while investigating this issue: `packages/studio/core-processors/src/InsertReturnAudioChain.ts` wires the audio-effect chain purely audio-to-audio (`target.setAudioSource(source.audioOutput)`, `context.registerEdge(source.outgoing, target.incoming)`), with an explicit `// TODO Open this to MidiEffects as well` comment (line 12) confirming the maintainers already know audio effects don't currently receive MIDI/note context. A literal "retrigger this envelope on every note-on" design is **not achievable** with the current chain wiring without adding note-event propagation into the audio-effect chain, a nontrivial infra change (same gap identified independently while investigating #139/#141).

Because of that gap, and because the reporter explicitly floats "oneshot option for Tidal" as an acceptable design, the pragmatic path is a **transport-position-driven** one-shot, not a note-triggered one, see Plan below.

Existing curve-drawing UI to potentially reuse for a freeform "Segments" style envelope: `packages/app/studio/src/ui/timeline/editors/value/` (`ValuePainter.ts`, `ValueEventCapturing.ts`, `ValueContextMenu.ts`, `ValueSlopeModifier.ts`) is the existing value/automation-region curve editor in the timeline. It is the closest precedent for drawing and editing a multi-segment curve, though it lives in the timeline (editing automation lanes over time), not inside a device editor, adapting it to a fixed-length in-device envelope view needs investigation, not assumed to be a drop-in reuse.

## Plan

Two viable designs, present both to the maintainer, the reporter already signaled the first is acceptable:

### Option A — "oneshot" mode on Tidal (fastest path)

1. Add a `oneshot: BooleanField` to `TidalDeviceBox`'s schema.
2. In `TidalDeviceProcessor.processAudio`, when oneshot is set, skip the `phase - Math.floor(phase)` wrap and instead clamp the raw phase to `[0, 1]` (`Math.min(phase, 1.0)`), holding the curve's endpoint value once phase exceeds 1, instead of repeating. Retrigger point is then whatever already resets phase in Tidal today (transport start / discontinuity, confirm exactly where `#phase` gets reset to 0 in the existing code, likely on transport start given `Bits.every(flags, BlockFlag.transporting | BlockFlag.playing)` checks elsewhere in the codebase).
3. This reuses 100% of Tidal's existing DSP (`TidalComputer`, `slope`/`symmetry` shape), UI, and box, it is the cheapest way to satisfy the literal request. Shape is still parametric (slope/symmetry), not freeform-drawn, which is a gap versus "drawn like an automation region."

### Option B — new device with a freeform drawn envelope ("Segments" style)

1. New `VolumeEnvelopeDeviceBox` (audio effect, mirror `TidalDeviceBox`'s host/index/label/enabled/minimized shape), storing a **list of segment breakpoints** (time/value pairs plus a curve-shape per segment, e.g. linear/exponential, mirroring however the timeline's value-region curve segments are represented today, investigate `ValuePainter.ts`/the value-region box fields before inventing a new segment data shape).
2. Processor evaluates the segment list against the same transport-position-driven phase Option A uses (retrigger on transport start/discontinuity, hold last value after the final segment, same "oneshot" semantics).
3. Editor: adapt the timeline's value-region curve-drawing interaction into a compact in-device view. This is the biggest unknown, investigate whether `ValuePainter.ts`/`ValueEventCapturing.ts` can be reused as components outside the timeline, or whether they're tightly coupled to timeline geometry/scroll state and a new canvas-based drawer is warranted (closer to the Compressor/Revamp curve-canvas pattern, `packages/app/studio/src/ui/devices/audio-effects/Compressor/CompressionCurve.tsx`, `Revamp/Curves.ts`).
4. Preset save/load: confirm whether device presets are already generic (save/load any device's box fields) before assuming this needs new preset infra, likely already covered by the existing preset system since it's field-driven.

## Risks / open questions

- **Per-note retriggering is the elephant in the room.** If the maintainer actually wants this envelope to retrigger on every played note (which "for e.g. with Vaporisateur" suggests, shaping each note's tail rather than one broad transport-synced sweep), that requires note-event propagation into the audio-effect chain, which does not exist today (see the `InsertReturnAudioChain` TODO above). That is a prerequisite infra change, not something to build inside this device. Get an explicit answer on trigger semantics (transport-position-driven vs. per-note) before writing schema, since it changes the entire design.
- If per-note retriggering is required, this issue should probably be built on top of whatever routing/infra work happens for #139 (parameter-modulation controllers) or as a MIDI-effect-adjacent construct rather than a plain audio effect, since only instruments and MIDI effects see note events in the current pipeline.
- Reusability of the timeline's value-curve UI components outside the timeline is unverified, budget time to spike this before committing to Option B's UI approach.
- Option A is a much smaller, safely shippable v1 that satisfies the reporter's own fallback suggestion, recommend starting there.
