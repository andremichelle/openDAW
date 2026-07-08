# Convert Playfield into a generic one-shot grid (#288)

**Doability:** ⭐⭐ (2/5). Clear direction, but it is a real architectural refactor of a device that is currently sample-only end to end, not a config toggle.
**Type:** feature / large refactor
**Scope:** large

## What is asked

Let any device (Apparat, Vaporisateur, etc.) be inserted into a Playfield pad instead of only a sample, so pads can trigger generative/synthesized sounds. As a follow-on, port Playfield's per-pad sample-shaping features (start/end, pitch, gate, attack/release, mono/poly, mute/solo/exclude) into the Nano sampler so Nano keeps "vanilla" single-sample behaviour at parity with what Playfield had. Related to #174 and #85.

## Current behaviour / relevant code

Playfield's pad model is a `PlayfieldSampleBox`, one per pad, and it is **hard-wired to a sample file**:

`packages/studio/boxes/src/PlayfieldSampleBox.ts` fields: `file: PointerField<Pointers.AudioFile>` (key 11), plus per-pad `midiEffects`/`audioEffects` chains (keys 12/13, so each pad already has its own effect chains, that part is reusable), `index` (pad-to-note mapping), and sample-shaping fields `mute`/`solo`/`exclude`/`polyphone`/`gate`/`pitch`/`sampleStart`/`sampleEnd`/`attack`/`release` (keys 40-49).

Processor side, `packages/studio/core-processors/src/devices/instruments/PlayfieldDeviceProcessor.ts`: one `SampleProcessor` per pad (`Playfield/SampleProcessor.ts`), which directly loads `adapter.file()` and constructs a `SampleVoice` (`Playfield/SampleVoice.ts`) that reads PCM frames from `AudioData` and applies start/end/pitch/attack/release/gate directly against sample-frame math (`this.#position += rateRatio` etc, `SampleVoice.ts:71-115`). There is no abstraction between "pad" and "sample playback", they are the same class.

Note routing: `PlayfieldSequencer.handleEvent` (`packages/studio/core-processors/src/devices/instruments/Playfield/PlayfieldSequencer.ts:43-49`) uses the incoming note's **pitch as a pad index** (`this.#device.optSampleProcessor(event.pitch)`), i.e. each MIDI note number selects a fixed pad rather than transposing a shared sound. This is drum-rack style routing, confirmed while investigating #174, and it is the reason a pad's "pitch" field today is just a per-pad fine-tune, not a chromatic transposition.

## Plan

1. **Introduce a pad-content abstraction.** Today `PlayfieldSampleBox` conflates "this is a pad" with "this pad plays a sample." Split it: a pad box that owns `index`, `mute`/`solo`/`exclude`/`polyphone`/`gate`, `midiEffects`, `audioEffects` (the parts that are truly pad-level, not sample-level), plus a pointer to **pad content**, which is either a sample reference (today's `file`/`sampleStart`/`sampleEnd`/`pitch`/`attack`/`release`) or a nested device slot (an instrument box, e.g. a Vaporisateur or Apparat instance).
2. **Nested device slot precedent** — there is no existing "a box field can hold either a sample or a full instrument device" pattern to copy directly. The closest structural precedent for "a pad box owns a nested device" is how an `AudioUnitBoxAdapter` owns its instrument via `Pointers.InstrumentHost` (`packages/studio/boxes/src/VaporisateurDeviceBox.ts` field 1, `host: PointerField<Pointers.InstrumentHost>` — every instrument box already points back at a host). A generic-content pad would need its own `Pointers.InstrumentHost`-accepting slot, i.e. each pad becomes a miniature audio-unit-like host. This is the crux of the refactor: pads currently are not device hosts, they need to become one (or delegate to one) without dragging in unrelated audio-unit concepts (tracks, sends).
3. **Processor split** — `PlayfieldDeviceProcessor` currently assumes `SampleProcessor` for every pad (`packages/studio/core-processors/src/devices/instruments/PlayfieldDeviceProcessor.ts:42-51`, `adapter.samples.catchupAndSubscribe` constructs a `SampleProcessor` unconditionally). This needs a visitor/factory that constructs either a `SampleProcessor` (today's behaviour) or a generic `DeviceProcessor` wrapping whatever instrument occupies that pad, both implementing the same `eventInput`/`audioOutput` surface `PlayfieldSequencer`/`MixProcessor` already expect (`Playfield/MixProcessor.ts`).
4. **Note routing stays pad-index-based** for generic-content pads (this is the "generative sounds" use case — one pad, one fixed trigger note, whatever plays underneath). Chromatic per-note playback of a nested instrument across the pad grid is out of scope for this issue (it would mean re-deriving per-note pitch inside the pad, which is what #174 is separately grappling with for Tape).
5. **Port sample-shaping features to Nano** (this is #85's exact scope, sequence it as a sub-step of this refactor or as a follow-up, see `085-nano-sampler-playfield.md`). Once Playfield's sample-specific fields move out of the generic pad box into a dedicated "sample content" box, that same content box (or its fields) is what Nano should gain, so Nano becomes the standard single-sample instrument with full shaping (start/end/pitch/gate/attack/release/mono-poly), independent of the grid.
6. **UI** — `packages/app/studio/src/ui/devices/instruments/` Playfield editor needs a per-pad "insert device" affordance (drag a device onto a pad, or a pad context-menu "Replace with instrument") alongside the existing "load sample" affordance. No existing UI to mirror for this exact interaction; closest conceptually is dropping a device onto a track's instrument slot.

## Risks / open questions

- This is the largest refactor in the batch after #139/#141. `PlayfieldSampleBox`, `PlayfieldSampleBoxAdapter`, `SampleProcessor`, and `SampleVoice` are all sample-shaped end to end; every one of them needs a content-agnostic split, not just new fields.
- Backward compatibility for existing `.od` projects with sample-only Playfield pads is essential — the migration must keep old pads loading as sample-content pads under the new model, this needs a schema migration step, check how prior Playfield schema changes were migrated (grep box schema version bumps) before designing the new fields.
- Decide up front whether a pad-hosted instrument gets its own nested audio-effects chain (pads already have one, key 13) or whether that's sufficient, versus needing a nested MIDI-effect chain too for e.g. an arp on a single pad — likely already covered since pads have `midiEffects` (key 12).
- Polyphony/voice-stealing semantics differ meaningfully between a `SampleVoice` (today, simple position-based playback) and a full instrument's own voice pool (e.g. Vaporisateur's polyphonic voice allocator) — retriggering, `exclude`/`polyphone` semantics need to be re-derived for the nested-instrument case, they don't fall out of the existing sample code for free.
- Recommend sequencing: land #85 (Nano gets Playfield's sample features) first as an independent, smaller, valuable change, then do this refactor once the "what belongs on a pad vs. what belongs on sample content" split is proven by having ported it once already.
