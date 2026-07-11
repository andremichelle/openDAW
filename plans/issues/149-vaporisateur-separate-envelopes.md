# Separate envelopes for volume and filter in Vaporisatur (#149)

**Doability:** ⭐⭐⭐⭐ (4/5). Root cause is precisely identified, the fix is a well-contained addition to one voice class plus schema/adapter/processor plumbing and a WASM mirror.
**Type:** feature
**Scope:** medium

## What is asked

Vaporisateur currently drives both amplitude (VCA) and filter cutoff from one shared ADSR envelope, only the filter's *depth* (`filterEnvelope`, bipolar amount) differs from the amp path. The reporter wants two independent envelopes (their own attack/decay/sustain/release each) so filter and volume can have different shapes, e.g. a punchy filter sweep under a slow volume swell.

## Current behaviour / relevant code

Confirmed by reading the voice processor. `packages/studio/core-processors/src/devices/instruments/VaporisateurVoice.ts`:

- One `Adsr` instance per voice: `readonly env: Adsr` (line 38), set from the device's single set of envelope parameters (line 61): `this.env.set(this.device.env_attack, this.device.env_decay, this.device.env_sustain, this.device.env_release)`.
- `process()` fills `vcaBuffer` from that one envelope (line 111: `this.env.process(vcaBuffer, fromIndex, toIndex)`).
- The **same** `vcaBuffer` is then used for both signals:
  - Filter cutoff modulation, line 129-132: `cutoffBuffer[i] = flt_cutoff + this.filter_keyboard_delta + vcaBuffer[i] * flt_env_amount + lfo * lfo_target_cutoff`
  - VCA gain, line 134 and 155: `vcaBuffer[i] *= clampUnit(gain + lfo * lfo_target_volume)` then `const vca = this.gainVcaSmooth.process(clampUnit(vcaBuffer[i]))`
- `flt_env_amount` (the bipolar `filterEnvelope` parameter, schema key 18) only scales the shared envelope's **depth**, it cannot change its **shape** (attack/decay/sustain/release times are identical for both destinations).

Schema today, `packages/studio/forge-boxes/src/schema/devices/instruments/VaporisateurDeviceBox.ts`:
- key 16 `attack`, key 17 `release`, key 18 `filter-envelope` (bipolar depth), key 19 `decay`, key 20 `sustain` — one envelope's worth of fields, feeding both destinations.

Device processor holds the resolved values as plain fields, `packages/studio/core-processors/src/devices/instruments/VaporisateurDeviceProcessor.ts:74-77` (`env_attack`, `env_decay`, `env_sustain`, `env_release`) and 82 (`flt_env_amount`), subscribed at lines 213-229.

WASM mirror: `crates/stock-devices/device-vaporisateur/src/voice.rs` presumably has the same single-envelope structure and needs the same split (frozen-contract discipline, `project_wasm_frozen_contracts.md`).

## Plan

1. **Schema** — add four new fields to `VaporisateurDeviceBox.ts` for a second envelope, e.g. `filter-attack`, `filter-decay`, `filter-sustain`, `filter-release` (next free keys, after 27, before the object fields at 30/40/50/99 — use e.g. 60-63 to leave room). Keep existing `attack`/`decay`/`sustain`/`release` (16/17/19/20) as the volume/amp envelope, unchanged for backward compatibility with existing projects (old presets keep working, filter envelope defaults should mirror the amp envelope's current effective defaults so existing patches don't suddenly sound different — decide exact default values with the maintainer, e.g. copy the amp envelope's defaults as the filter envelope's defaults).
2. **Regenerate boxes** — `npm run build` from `packages/studio/forge-boxes` per the existing device-adding workflow (see `plans/vocoder.md`'s "Schema + regenerate" step for the exact command).
3. **Adapter** — `packages/studio/adapters/src/devices/instruments/VaporisateurDeviceBoxAdapter.ts`, add four `AutomatableParameterFieldAdapter` wraps for the new fields, same `ValueMapping`/`StringMapping` shape as the existing attack/decay/sustain/release wraps.
4. **Processor** — `VaporisateurDeviceProcessor.ts`, add `filter_env_attack`/`filter_env_decay`/`filter_env_sustain`/`filter_env_release` fields (mirror lines 74-77) and their parameter bindings/subscriptions (mirror lines 213-229).
5. **Voice** — `VaporisateurVoice.ts`:
   - Add `readonly filterEnv: Adsr` alongside `env`, constructed and gated the same way (`gateOn()`/`gateOff()`/`forceStop()` on both in `start()`/`stop()`/`forceStop()`).
   - Add a second scratch buffer (reuse the `mint(Float32Array, RenderQuantum)` pattern at the top of the file, e.g. `filterEnvBuffer`).
   - `this.filterEnv.set(this.device.filter_env_attack, this.device.filter_env_decay, this.device.filter_env_sustain, this.device.filter_env_release)` alongside the existing `env.set(...)`.
   - In `process()`, add `this.filterEnv.process(filterEnvBuffer, fromIndex, toIndex)` next to the existing `this.env.process(vcaBuffer, ...)`.
   - Change line 131 from `vcaBuffer[i] * flt_env_amount` to `filterEnvBuffer[i] * flt_env_amount`.
   - Voice completion check (line 159, `this.env.complete && vca < SILENCE_THRESHOLD`) should probably also require `this.filterEnv.complete` (or just check `this.env.complete`, since silence is driven by the VCA path only — decide whether a lingering filter-release with a silent VCA should keep the voice alive, likely not, keep the completion check on `env`/`vca` only since that's what makes it inaudible).
6. **Editor** — `packages/app/studio/src/ui/devices/instruments/VaporisateurDeviceEditor.tsx` (confirm exact path), add a second small ADSR control group for the filter envelope, mirroring the existing amp-envelope control group's layout.
7. **WASM mirror** — `crates/stock-devices/device-vaporisateur/src/voice.rs`, apply the identical split (second `Adsr` instance, second scratch buffer, same field addition in the Rust box schema mirror). Check for a Rust ADSR test file analogous to `env-bug-ts-vs-wasm.test.ts` (per `project_mono_voicing_click.md`) and extend or add a parity test asserting the two envelopes are independently shaped.

## Risks / open questions

- Backward compatibility: existing saved projects only have one envelope's worth of data. New filter-envelope fields need sensible defaults so old patches don't change sound on load; simplest is to default the new filter ADSR to the same numeric defaults as the existing amp ADSR (attack 0.001-ish per current schema, etc.), which reproduces today's coupled behavior until the user diverges them.
- The `filterEnvelope` (key 18, bipolar depth) parameter name is easily confused with the new filter *envelope shape* fields, needs a clear UI label distinction (e.g. "Filter Env Amount" for the existing depth knob vs. "Filter Attack/Decay/Sustain/Release" for the new shape knobs).
- Two `Adsr` instances per voice doubles that part of the per-sample cost; `Adsr.process` is a simple per-sample state machine (see `packages/lib/dsp/src/adsr.ts`), the added cost should be negligible versus oscillator/filter processing, but worth a quick sanity check under max polyphony + unison.
- Must keep TS and WASM in lockstep per the project's frozen-contract rule, don't ship the TS side without the Rust mirror or the WASM engine will silently diverge in sound.
