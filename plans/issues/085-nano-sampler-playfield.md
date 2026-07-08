# Enhance Nano sampler with Playfield feature (#85)

**Doability:** ⭐⭐⭐⭐ (4/5). Nano is the simplest instrument box in the codebase, and every field it needs already exists verbatim on `PlayfieldSampleBox`, this is mostly plumbing.
**Type:** feature
**Scope:** medium

## What is asked

Bring Playfield's per-pad sample-shaping controls to the Nano sampler (image-only issue, no body text, cross-referenced from #288 and #174). Concretely, Nano should gain: sample start/end trim, pitch fine-tune, attack/release envelope, gate mode, and mono/poly (`polyphone`) voicing, all of which Playfield already has per pad.

## Current behaviour / relevant code

Nano today is deliberately minimal. `packages/studio/boxes/src/NanoDeviceBox.ts` fields: `host`, `label`, `icon`, `enabled`, `minimized`, `volume` (key 10), `file: PointerField<Pointers.AudioFile>` (key 15), `release` (key 20). No start/end, no pitch, no attack, no gate, no mono/poly.

Playfield already has every one of these, on `PlayfieldSampleBox` (`packages/studio/boxes/src/PlayfieldSampleBox.ts`, keys 44-49): `gate: Int32Field` (Gate enum: Off/On/Loop, see `packages/studio/core-processors/src/devices/instruments/Playfield/SampleVoice.ts:82-107` for the three gate behaviours), `pitch: Float32Field` (cents fine-tune, `SampleVoice.ts:73` `2.0 ** (pitch.getValue() / 1200.0)`), `sampleStart`/`sampleEnd: Float32Field` (normalized 0-1 positions into the sample, `SampleVoice.ts:43-44`, negative direction = reverse playback since `distance = end - start` and `sign = Math.sign(distance)`, `SampleVoice.ts:70-71`), `attack`/`release: Float32Field` (envelope in/out ramps, `SampleVoice.ts:41-42` and the `env` computation at `SampleVoice.ts:80-81`), and `polyphone: BooleanField` (mono/poly, consumed in `SampleProcessor.ts:83`: `if (!polyphone.getValue()) {this.#voices.forEach(voice => voice.release(true))}`, i.e. mono mode force-releases other voices on new note-on, "self-cutting").

The DSP that actually implements all of this, `Playfield/SampleVoice.ts`, is a self-contained per-voice class that only needs a `PlayfieldSampleBoxAdapter`-shaped set of named parameters (`Playfield/AutomatableParameters.ts`) and an `AudioData`. It is not entangled with pad-grid concerns (note-index routing, mute/solo/exclude are all in `SampleProcessor`/`PlayfieldSequencer`, not in the voice itself). This is exactly why Nano can absorb it without needing any of Playfield's grid machinery.

Nano's current processor: `packages/studio/core-processors/src/devices/instruments/NanoDeviceProcessor.ts` (confirm exact voice implementation, likely a simpler single-voice-per-note class without start/end/gate/pitch handling — read it before writing code, since the new fields need to slot into whatever voice class already exists there).

## Plan

1. **Schema** — add to Nano's forge schema (find `packages/studio/forge-boxes/src/schema/devices/instruments/NanoDeviceBox.ts`) the fields Playfield already has: `pitch` (bipolar cents), `sample-start`/`sample-end` (unipolar 0-1, default 0/1), `attack` (exponential seconds), `gate` (int constraint matching Playfield's Gate enum), and a `polyphone`/voicing-mode boolean or reuse Vaporisateur's `voicing-mode` int pattern (`VaporisateurDeviceBox.ts` key 22, `VoicingMode.Monophonic`/`Polyphonic`) for consistency across instruments rather than Playfield's raw boolean, worth asking the maintainer which convention to standardize on since this issue is explicitly about parity, not necessarily bit-for-bit field copying.
2. **Regenerate boxes** via forge-boxes build, per the standard device-schema workflow.
3. **Adapter** — `packages/studio/adapters/src/devices/instruments/NanoDeviceBoxAdapter.ts`, add `AutomatableParameterFieldAdapter` wraps for each new field, mirroring `PlayfieldSampleBoxAdapter.ts`'s `namedParameter` wraps for the identical fields (same `ValueMapping`s can likely be copied verbatim: unipolar for start/end, bipolar for pitch, exponential seconds for attack/release).
4. **Processor/voice** — read `NanoDeviceProcessor.ts` first to see its current voice shape, then either extend it in place or replace its playback math with the same start/end/gate/pitch logic as `Playfield/SampleVoice.ts` (that class is short and self-contained enough to adapt directly, keep the reversal-via-negative-distance behaviour, keep the three-gate-mode branch). Add mono voicing: on note-on, if not polyphonic, force-release existing voices first (mirror `SampleProcessor.ts:83`).
5. **Editor** — `packages/app/studio/src/ui/devices/instruments/NanoDeviceEditor.tsx` (confirm path), add knobs/controls for the new parameters. Consider whether a simple waveform-with-start/end-handles display (if Nano doesn't already show one) would help, no existing example in this codebase to mirror for that specific handle-drag interaction, keep it out of scope if it doesn't already exist, ship knobs first.
6. **WASM mirror** — check `crates/stock-devices` for an existing Nano device crate; if Nano is already ported to WASM, the same fields need the same mirror treatment for parity (frozen-contract discipline).

## Risks / open questions

- Backward compatibility: existing Nano projects have none of these fields, defaults must reproduce today's behaviour exactly (start=0, end=1, pitch=0, attack≈0 or very short, gate=Off, polyphonic=true) so old projects sound unchanged on load.
- Decide field-naming/enum convention consistency (Playfield's raw `polyphone` boolean vs. Vaporisateur's `voicing-mode` enum) before writing schema, this is a one-line decision but affects every layer above it.
- Confirm whether Nano is single-voice or already polyphonic today before adding a "mono/poly" toggle, if Nano currently has no voice-pool concept at all this needs a small polyphony mechanism first (check `NanoDeviceProcessor.ts`).
- This issue and #288 are closely related but distinct: #288 needs a pad-content abstraction split out of Playfield first; this issue does not depend on that refactor at all, Nano can gain these fields directly from Playfield's existing code without waiting on #288. Recommend doing this one first.
