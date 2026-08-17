# Stereo Tool / DC remove button (#91)

**Doability:** ⭐⭐⭐⭐⭐ (5/5), one new boolean field and one existing WASM biquad primitive.
**Type:** feature
**Scope:** small

## What is asked
Add a "DC remove" toggle button to the Stereo Tool device that engages a low cut around 1-2 Hz to strip DC offset, without audibly affecting the signal.

## Current behaviour / relevant code
- Schema: `packages/studio/forge-boxes/src/schema/devices/audio-effects/StereoToolDeviceBox.ts:7-29` — fields `volume`, `panning`, `stereo`, `invert-l`/`invert-r`/`swap` (booleans, field keys 13/14/15), `panning-mixing` (int32 enum). No filter stage exists on this device today.
- Adapter: `packages/studio/adapters/src/devices/audio-effects/StereoToolDeviceBoxAdapter.ts:54-70` wraps `invertL`/`invertR`/`swap` as `parametric.createParameter(box.invertL, ValueMapping.bool, StringMapping.bool, "Invert Left")` — the exact pattern a new `dcRemove` parameter follows.
- Processor: `crates/stock-devices/device-stereo-tool/src/lib.rs` owns the current audio path. It applies `StereoMatrixRamp` for gain, pan, width, invert, and swap. There is no longer a TypeScript Stereo Tool processor on `main`.
- Reusable filter: `crates/dsp/src/biquad.rs` provides `BiquadCoeff::set_highpass_params` and `BiquadMono`, already used by the WASM Revamp processor. At 2 Hz and 48 kHz, the normalized cutoff is about `0.00004`, well inside the filter's valid range.

## Plan
1. Schema: add `16: {type: "boolean", name: "dc-remove", pointerRules: ParameterPointerRules}` to `StereoToolDeviceBox.ts` (next free field key after `swap`=15).
2. Adapter: wrap it exactly like `invertL`/`invertR` — `dcRemove: this.#parametric.createParameter(box.dcRemove, ValueMapping.bool, StringMapping.bool, "DC Remove")`.
3. Processor: add one shared `BiquadCoeff` and one `BiquadMono` per channel, set once to a fixed 2 Hz Butterworth high-pass. Bind the `dcRemove` parameter and filter the post-matrix signal only while enabled.
4. Editor: add a `Checkbox`-based button next to the existing invert/swap buttons in `StereoToolDeviceEditor.tsx:79-105`'s button row, same `AutomationControl` + `Checkbox` + `Icon` pattern.
5. Tests: extend the Stereo Tool Rust tests to assert that a constant offset settles near zero and that 1 kHz RMS gain remains unity within tolerance.

## Risks / open questions
- Toggling any filter stage mid-playback can introduce a small discontinuity (see the related lookahead/automakeup click bug, #79) — at 1-2 Hz cutoff the filter's state is very slow-moving, so any click risk is minimal, but worth a quick listen test when toggling during playback with strongly DC-biased material (rare in practice).
- Confirm whether the cutoff should be a fixed constant (simpler, matches "should not affect sound quality") or exposed as a hidden/fixed-but-documented value — the issue only asks for a button, not a frequency knob.

## AI-assisted implementation record

AI assistance was used to audit the current schema, adapter, editor, generated Rust registry, and WASM processor, then prepare the first patch. The implementation was reviewed against the current source before verification. That review found that the older TypeScript processor referenced by the original plan is no longer present, so DSP work was limited to the current WASM processor.

Decisions made during implementation:

- Use field key `16`, the next free Stereo Tool parameter key.
- Keep the filter disabled by default for project compatibility.
- Use a fixed 2 Hz Butterworth high-pass after the stereo matrix.
- Reset both filter histories when the parameter toggles or transport resets.
- Add the toggle to the existing button grid using the shared high-pass icon.

Headless verification:

- `cargo test --manifest-path crates/Cargo.toml -p device-stereo-tool`: 7 passed.
- Nightly `wasm32-unknown-unknown` release build with the repository's PIC side-module flags: passed.
- `npm run build -w @opendaw/studio-boxes`: passed.
- `npm run build -w @opendaw/studio-adapters`: passed.
- `npx tsc --project packages/app/studio/tsconfig.json --noEmit`: passed after building internal workspace dependencies.
- `npm run build -w @opendaw/app-studio`: passed.

Strict workspace Clippy remains blocked by pre-existing warnings and denied approximate constants in shared `crates/dsp` files outside this change. The focused Stereo Tool tests and release WASM compile pass.
