# Envelope on soundfont player (#241)

**Doability:** ⭐⭐⭐⭐ (4/5). Both engines already have a working per-voice `Adsr`, this adds a second, user-controlled envelope layer on top rather than building envelope DSP from scratch.
**Type:** feature
**Scope:** medium (TS + WASM parity)

## What is asked

Even very short/staccato notes on the Soundfont player cause long sustains that muddy a mix. Reporter wants an ADSR the user can control, so short notes can be shaped regardless of what the underlying SF2 patch encodes.

## Current behaviour / relevant code

The Soundfont player **already has an envelope**, but it comes entirely from the loaded `.sf2` patch's own generator data, there is no user-facing control over it. `packages/studio/core-processors/src/devices/instruments/Soundfont/SoundfontVoice.ts:52-60`:

```
const attackTime = isNotUndefined(attack) ? Math.pow(2.0, attack / 1200.0) : 0.005
const decayTime = isNotUndefined(decay) ? Math.pow(2.0, decay / 1200.0) : 0.005
const sustainLevel = 1.0 - (sustain ?? 0.0) / 1000.0
const releaseTime = isNotUndefined(release) ? Math.pow(2.0, release / 1200.0) : 0.005
this.envelope = new Adsr(sampleRate)
this.envelope.set(attackTime, decayTime, sustainLevel, releaseTime)
```

These four numbers are pulled from the SF2 preset/instrument zone generators (`getCombinedGenerator(presetGens, instGens, GeneratorType.*VolEnv)`). Many soundfonts, especially simple or GM-converted ones, either omit these generators (falling back to the ~5ms defaults above, which is *not* the reported symptom) or author patches (pads, organs, strings) with genuinely long sustain/release baked into the font, which the reported symptom matches: a short note still rings out because the patch's own authored envelope holds it open, and there is currently no way to override that from the device UI.

The Soundfont box itself carries no envelope fields at all today: `packages/studio/boxes/src/SoundfontDeviceBox.ts` fields are only `host`, `label`, `icon`, `enabled`, `minimized`, `file`, `presetIndex`. Compare to Vaporisateur, which has user ADSR fields (`packages/studio/boxes/src/VaporisateurDeviceBox.ts` keys 16/17/19/20).

WASM mirror already exists too: `crates/stock-devices/device-soundfont/src/voice.rs` has a faithful `Adsr` port (comment at line 1: "a faithful port of the TS `SoundfontVoice`"), driven by the same per-zone generator values. Any TS-side fix needs the identical Rust-side fix to keep parity (frozen-contract discipline, `project_wasm_frozen_contracts.md`).

## Plan

1. **Schema** — add a user ADSR to `SoundfontDeviceBox`'s forge schema (mirror Vaporisateur's `attack`/`decay`/`sustain`/`release` field shapes: exponential seconds for attack/decay/release, unipolar for sustain). Default values should make the new envelope a no-op multiplier on top of the existing patch envelope until the user touches it, e.g. attack≈0.001s, decay≈0.001s, sustain=1.0, release≈0.05-0.1s (fast enough not to be perceived as an added tail on top of the patch's own release, but present enough that shortening it has an audible, useful effect). Confirm exact defaults with the maintainer, since "no-op" and "useful default" can pull in different directions.
2. **Regenerate boxes** via the forge-boxes build.
3. **Adapter** — `packages/studio/adapters/src/devices/instruments/SoundfontDeviceBoxAdapter.ts`, wrap the four new fields as `AutomatableParameterFieldAdapter`s, same pattern as `VaporisateurDeviceBoxAdapter.ts`.
4. **Voice** — `SoundfontVoice.ts`: add a second `Adsr` instance (`readonly userEnvelope: Adsr`), constructed and `gateOn()`'d alongside the existing patch-derived `this.envelope`, `gateOff()`'d alongside it in `release()`. In `processAdd`, multiply the final `amp` by the user envelope's value in addition to the patch envelope's (`this.envelope.process(envBuffer, ...)` already fills a buffer per block, add a second buffer for the user envelope and multiply both into `amp` at line ~80: `const amp = (sample / 32768.0) * gain * this.#gainSmooth.process(envBuffer[i]) * userEnvBuffer[i]`). Update the voice-completion check (currently `this.envelope.complete && ...`) to require **both** envelopes complete, otherwise a fast user-release could cut the voice's return value early while the patch envelope is still notionally open (or vice versa, pick whichever is actually more correct once both are wired, the safe rule is "voice is done when both envelopes are idle and gain is below silence threshold").
5. **Processor** — `SoundfontDeviceProcessor.ts`, bind the four new parameters (mirror how `presetIndex`/`file` are already read) and pass their resolved values into each `SoundfontVoice` at construction (mirror how `presetZone`/`instrumentZone`/`soundFont` are passed today).
6. **Editor** — `packages/app/studio/src/ui/devices/instruments/SoundfontDeviceEditor.tsx` (confirm path), add four ADSR knobs, same layout family as Vaporisateur's envelope section.
7. **WASM mirror** — `crates/stock-devices/device-soundfont/src/voice.rs`, add the second `Adsr` field, wire it the identical way (construct, gate on/off alongside the existing envelope, multiply into the output sample, extend the "voice done" predicate). Add/extend a parity test comparing TS vs. WASM output for a short note against a long-sustain patch, before and after the user envelope shortens it, following the project's TS-vs-WASM regression test convention (`env-bug-ts-vs-wasm.test.ts` precedent per `project_mono_voicing_click.md`).

## Risks / open questions

- Two `Adsr` instances per voice is a small added cost, `Adsr.process` is O(1) per sample, this should be negligible.
- Decide multiply-on-top vs. replace-entirely: multiplying on top (this plan's approach) preserves any looped-sample behaviour (`shouldLoop`) driven independently by the patch's `SampleModes` generator, replacing the patch envelope outright could interact oddly with patches that rely on their own release to avoid a loop-click. Multiply-on-top is the safer default.
- Must ship TS and WASM together, don't let the two engines diverge on envelope behaviour.
