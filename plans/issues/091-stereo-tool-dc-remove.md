# Stereo Tool / DC remove button (#91)

**Doability:** ⭐⭐⭐⭐⭐ (5/5) — one new boolean field, one existing biquad call, both engines already share the exact filter primitive.
**Type:** feature
**Scope:** small

## What is asked
Add a "DC remove" toggle button to the Stereo Tool device that engages a low cut around 1-2 Hz to strip DC offset, without audibly affecting the signal.

## Current behaviour / relevant code
- Schema: `packages/studio/forge-boxes/src/schema/devices/audio-effects/StereoToolDeviceBox.ts:7-29` — fields `volume`, `panning`, `stereo`, `invert-l`/`invert-r`/`swap` (booleans, field keys 13/14/15), `panning-mixing` (int32 enum). No filter stage exists on this device today.
- Adapter: `packages/studio/adapters/src/devices/audio-effects/StereoToolDeviceBoxAdapter.ts:54-70` wraps `invertL`/`invertR`/`swap` as `parametric.createParameter(box.invertL, ValueMapping.bool, StringMapping.bool, "Invert Left")` — the exact pattern a new `dcRemove` parameter follows.
- Processor: `packages/studio/core-processors/src/devices/audio-effects/StereoToolDeviceProcessor.ts` — uses `StereoMatrix`/`Ramp.stereoMatrix(sampleRate)` (line 16-24) for gain/pan/width, no per-sample filter stage. `processAudio` calls `this.#matrix.update(...)` then processes frames (lines 84-95).
- Reusable filter: `packages/lib/dsp/src/biquad-coeff.ts:42` — `BiquadCoeff.setHighpassParams(cutoff: unitValue, resonance = Math.SQRT1_2)` where `cutoff = frequency / sampleRate` (same convention Revamp uses). At 1-2 Hz and 48kHz, `cutoff ≈ 0.00002-0.00004`, well inside the filter's valid range — no math changes needed. Processing wrapper: `packages/lib/dsp/src/biquad-processor.ts` (`BiquadMono`), used the same way in `RevampDeviceProcessor.ts` for its high-pass band.
- WASM mirror exists at `crates/stock-devices/device-stereo-tool` — needs the identical addition for parity (project rule: WASM/TS frozen contracts must stay in lockstep, `// WASM CONTRACT:` markers where applicable).

## Plan
1. Schema: add `16: {type: "boolean", name: "dc-remove", pointerRules: ParameterPointerRules}` to `StereoToolDeviceBox.ts` (next free field key after `swap`=15).
2. Adapter: wrap it exactly like `invertL`/`invertR` — `dcRemove: this.#parametric.createParameter(box.dcRemove, ValueMapping.bool, StringMapping.bool, "DC Remove")`.
3. Processor: add one `BiquadCoeff` + `BiquadMono` pair per channel (L/R), coefficients set once via `setHighpassParams(cutoff, Math.SQRT1_2)` with a fixed cutoff constant (e.g. 2 Hz — not user-adjustable, matches the issue's "should not affect sound quality" ask, avoiding an extra frequency knob). Subscribe to the `dcRemove` boolean field; when enabled, run the highpass stage before (or after) the `StereoMatrix` processing; when disabled, pass through unfiltered.
4. Editor: add a `Checkbox`-based button next to the existing invert/swap buttons in `StereoToolDeviceEditor.tsx:79-105`'s button row, same `AutomationControl` + `Checkbox` + `Icon` pattern.
5. WASM: mirror the schema field, and add the same `BiquadCoeff`/highpass stage to `device-stereo-tool`'s Rust processor.
6. Optional: add a small regression test (extend an existing StereoTool test or add one) asserting near-zero DC offset on a DC-biased test signal with the toggle on, and no gain/phase change at audible frequencies (e.g. 1kHz) with the toggle on vs off, within a small tolerance.

## Risks / open questions
- Toggling any filter stage mid-playback can introduce a small discontinuity (see the related lookahead/automakeup click bug, #79) — at 1-2 Hz cutoff the filter's state is very slow-moving, so any click risk is minimal, but worth a quick listen test when toggling during playback with strongly DC-biased material (rare in practice).
- Confirm whether the cutoff should be a fixed constant (simpler, matches "should not affect sound quality") or exposed as a hidden/fixed-but-documented value — the issue only asks for a button, not a frequency knob.
