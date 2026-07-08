# Mid-Side EQ (#90)

**Doability:** ⭐⭐⭐☆☆ (3/5) — mirrors Revamp's DSP twice (mid chain + side chain), the missing piece is M/S encode/decode and a switchable-focus editor UI.
**Type:** feature
**Scope:** large

## What is asked
A stereo EQ that encodes L/R into mid/side, lets the user edit mid and side bands independently (Revamp-style bands per side), and exposes three view/edit-focus buttons: "m" (edit mid, show mid waveform), "s" (edit side, show side waveform), "both" (mixed view). Optional prelisten (solo mid or solo side to the output for auditioning). Used for stereo-only problems, e.g. muddy low end concentrated in the side signal.

## Current behaviour / relevant code
- Revamp EQ is the template: schema `packages/studio/forge-boxes/src/schema/devices/audio-effects/RevampDeviceBox.ts:10-75` (7 bands: high-pass/low-shelf/low-bell/mid-bell/high-bell/high-shelf/low-pass, each a `Pass`/`Shelf`/`Bell` sub-schema), adapter `packages/studio/adapters/src/devices/audio-effects/RevampDeviceBoxAdapter.ts:55-143`, processor `packages/studio/core-processors/src/devices/audio-effects/RevampDeviceProcessor.ts` (7 `BiquadCoeff`, high/low-pass via `BiquadStack(4)` for order, bells/shelves via `BiquadMono`, `processAudio` runs L and R independently through the same coefficients — no stereo coupling today), editor `packages/app/studio/src/ui/devices/audio-effects/RevampDeviceEditor.tsx` with curve/spectrum canvas in `Revamp/Renderer.ts`, `Revamp/Display.tsx`, `Revamp/constants.ts`.
- No mid/side encode/decode utility exists anywhere (`grep -r "Mid\|Side\|MidSide"` in `packages/lib/dsp` and `core-processors` is empty). The closest related code is `packages/lib/dsp/src/stereo.ts` (`StereoMatrix`), which computes `midGain`/`sideGain`-style blending internally for its width parameter but exposes no public M/S codec.
- Boolean exclusive-mode buttons have a precedent: `StereoToolDeviceBox` `invert-l`/`invert-r`/`swap` fields (`packages/studio/forge-boxes/src/schema/devices/audio-effects/StereoToolDeviceBox.ts:20-22`) rendered as `Checkbox` in `StereoToolDeviceEditor.tsx:79-105`. An exclusive int-enum selector precedent is `FoldDeviceEditor.tsx:40-42` using `RadioGroup` bound to a raw int32 box field, and `StereoToolDeviceBox`'s `panning-mixing` field (int32 with `values` constraint).

## Plan
1. Add M/S encode/decode helpers to `packages/lib/dsp/src/stereo.ts` (or a new `mid-side.ts`): `mid = (l+r)*0.5`, `side = (l-r)*0.5`, inverse `l = mid+side`, `r = mid-side`.
2. New schema `packages/studio/forge-boxes/src/schema/devices/audio-effects/MidSideEqDeviceBox.ts`: duplicate Revamp's 7-band `Pass`/`Shelf`/`Bell` sub-schemas twice — once under a `mid` group, once under a `side` group (14 bands total, same field-key layout doubled). Add an `editFocus` int32 field (values `[Mid, Side, Both]`) and, if prelisten is in scope, a `prelisten` int32/boolean field.
3. Adapter `MidSideEqDeviceBoxAdapter.ts`: wrap both band groups the same way `RevampDeviceBoxAdapter` does, producing `midBands`/`sideBands` parameter sets.
4. Processor `MidSideEqDeviceProcessor.ts`: per block, encode L/R → mid/side, run the mid signal through the "mid" Revamp-style filter chain and the side signal through the "side" chain (reuse `BiquadCoeff`/`BiquadMono`/`BiquadStack` exactly as `RevampDeviceProcessor` does, just against `mid`/`side` buffers instead of `L`/`R`), then decode back to L/R. If prelisten is implemented, bypass the decode step and output the solo'd mid or side signal directly (mono-summed to both channels) when a prelisten flag is active.
5. Editor `MidSideEqDeviceEditor.tsx`: reuse `Revamp/Renderer.ts`'s curve-drawing code parameterized by which band set is active; add the m/s/both focus buttons (checkbox-style, mutually exclusive — mirror `StereoToolDeviceEditor.tsx`'s button row) that switch which band set's curve/waveform is drawn and editable; "both" overlays both curves faded. If prelisten is included, add solo buttons next to m/s using the same `Checkbox` pattern, wired so enabling one disables the other (radio-like behavior, not full `RadioGroup` since prelisten is momentary/toggleable).
6. Register in `EffectFactories.ts`, `DeviceProcessorFactory.ts`, `BoxAdapters.ts`, `DeviceEditorFactory.tsx`, `DeviceManualUrls.ts` (new entry `MidSideEq`), following the exact same registration list as documented in `plans/waveshaper-device.md`.
7. WASM mirror: new crate `crates/stock-devices/device-mid-side-eq`, cloning `device-revamp`'s biquad chain logic twice with the M/S codec, registered in the engine's device-factory table alongside `device-revamp`.

## Risks / open questions
- CPU cost: 14 active bands (vs Revamp's 7) is double the biquad work per instance — acceptable for a single device but worth noting in review.
- Prelisten is explicitly "optional" in the issue — recommend shipping without it first, add as a follow-up once the dual band-set editor is validated, since solo-to-output changes the device's output contract when active (needs to bypass mix/routing correctly, not just visually).
- UI complexity: the switchable-focus editor (redrawing curves for the active side, keeping both parameter sets alive) is the least precedented part — no existing device swaps its entire editable parameter set based on a button; this needs its own small design pass, not just a copy-paste of Revamp's editor.
- Decide whether "both" mode still allows editing (which band set does a drag act on?) or is view-only — the issue implies "both" is a mixed view, likely read-only overlay with edits only possible in m or s focus.
