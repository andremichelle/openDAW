# Clipping/click when toggling compressor lookahead or AutoMakeUp (#79)

**Doability:** ⭐⭐⭐⭐☆ (4/5) — root cause is pinpointed to two specific instant-switch discontinuities in one file; fix pattern (a `Ramp`) already exists and is used elsewhere in the same processor, just needs porting to both toggles and mirroring into Rust.
**Type:** bug
**Scope:** medium

## What is asked
Toggling the compressor's "lookahead" or "AutoMakeUp" buttons during playback produces an audible click/near-clip. Reporter has a repro project and video. Needs fixing in both engines (TS and WASM).

## Current behaviour / relevant code
Two independent discontinuities in `packages/studio/core-processors/src/devices/audio-effects/CompressorDeviceProcessor.ts`:

**1. Lookahead: frozen ring buffers create a stale-vs-live jump.**
`processAudio` (lines 244-251):
```ts
if (this.#lookahead) {
    this.#delay.process(this.#output, s0, s1)
    this.#lookaheadProcessor.process(this.#sidechainSignal, s0, s1)
}
```
`#delay` (`DelayLine`, `packages/lib/dsp/src/ctagdrc/DelayLine.ts:23-39`) and `#lookaheadProcessor` (`LookAhead`, `packages/lib/dsp/src/ctagdrc/LookAhead.ts:18-22`) only advance their ring buffers *inside this `if`*. `#lookahead` itself flips instantly with no ramp (lines 300-301):
```ts
if (parameter === this.parameterLookahead) {
    this.#lookahead = this.parameterLookahead.getValue()
}
```
While lookahead is off, both buffers are frozen/stale. Re-enabling reads from content that's discontinuous with the live signal — a hard sample jump.

**2. AutoMakeUp: instant gain snap using an already-accumulated smoother value.**
`#calculateAutoMakeup` (lines 290-297):
```ts
this.#smoothedAutoMakeup.process(-sum / (toIndex - fromIndex))
return this.#automakeup ? this.#smoothedAutoMakeup.getState() : 0.0
```
`SmoothingFilter` (`packages/lib/dsp/src/ctagdrc/SmoothingFilter.ts`) runs every block regardless of the toggle, so `getState()` can hold several dB by the time `automakeup` flips. The `this.#automakeup ? state : 0.0` branch is evaluated per block with no ramp between the two values — toggling snaps the applied makeup gain instantly, which is then exponentiated via `decibelsToGain` and multiplied straight into the output (lines 255-258). This is the "clipping" symptom.

**Existing smoothing pattern in the same file, not applied to either toggle:** `Ramp` is already imported and used for `#smoothInputGain` (line 3, 58, 94, per-sample at line 197, `set(target, smooth)` at line 317) — proof the fix pattern is already established here, just not extended to lookahead/automakeup. Also relevant: `packages/studio/core-processors/src/devices/instruments/Tape/RepeatVoice.ts:221-223` and `PingpongVoice.ts` implement crossfades specifically to avoid clicks at loop/buffer boundaries — a structural template for crossfading old-vs-new content across the lookahead toggle.

**Rust mirror — identical bug, confirmed cross-engine:** `crates/stock-devices/device-compressor/src/lib.rs` — automakeup snap at line 230 (`if state.automakeup {state.smoothed_auto_makeup.get_state()} else {0.0}`), lookahead bypass at lines 232-235, `state.lookahead` set instantly in `parameter_changed` (line 141). Same `dsp::ctagdrc::DelayLine`/`LookAhead` port, same frozen-buffer behavior.

**Existing tests:** `packages/app/wasm/test/compressor-device.test.ts` sets `lookahead`/`automakeup` once before rendering (lines 14-15) — no mid-playback toggle test exists. Harness `packages/app/wasm/test/helpers/effect-harness.ts`'s `renderEffect(source, quanta)` loops `engine.render()` with a fixed config and doesn't currently expose mutating a param mid-loop.

## Plan
1. **AutoMakeup fix**: replace the instant `this.#automakeup ? state : 0.0` branch with a smoothed target — either (a) always feed `this.#automakeup ? state : 0.0` as a *target* into a small additional `Ramp` (separate from the analysis `SmoothingFilter`, which must keep running continuously so its state doesn't itself jump) and apply the ramped value to the output gain, mirroring exactly how `#smoothInputGain`/`Ramp` already works in this file; or (b) keep `SmoothingFilter` always contributing but scale its contribution by a smoothly-ramped 0→1/1→0 blend factor on toggle. Prefer (a) since it reuses the existing `Ramp` primitive with minimal new code.
2. **Lookahead fix**: stop freezing the delay/lookahead ring buffers when disabled — always advance `#delay`/`#lookaheadProcessor` every block regardless of `#lookahead`, so their content never goes stale. Then treat the enable/disable transition as a crossfade between the "immediate" tap (no delay) and the "delayed" tap (current lookahead output) over a short window (a few ms), using the same linear/equal-power crossfade idiom as `RepeatVoice`/`PingpongVoice`, rather than a hard instantaneous switch. This avoids both the stale-buffer jump and the inherent look-ahead-latency step change.
3. Port both fixes to `crates/stock-devices/device-compressor/src/lib.rs`, keeping the TS and Rust implementations bit-for-bit aligned per the project's WASM-parity convention.
4. Extend `effect-harness.ts` (or add a new test) to toggle `box.lookahead`/`box.automakeup` mid-render (between two `engine.render()` calls within the same test, using the existing BoxGraph transaction API) and assert sample-to-sample continuity across the toggle boundary (e.g. max `|out[i]-out[i-1]|` under a threshold), plus a peak/clip check. This test must fail against current code and pass after the fix, per project convention (repro/test first).

## Risks / open questions
- Crossfade window length for the lookahead toggle is a judgment call — long enough to eliminate audible clicks, short enough not to feel like added latency; a few milliseconds (similar order to the existing lookahead delay itself) is a reasonable starting point, worth ear-testing against the reporter's repro project.
- Confirm the fix doesn't change the compressor's *steady-state* behavior when lookahead/automakeup are left on/off without toggling — the regression test should also cover the static-config case (already covered by `compressor-device.test.ts`) to guard against regressions there.
- The reporter's video/repro project should be used to verify the fix directly, not just synthetic tests — per project convention, don't claim "fixed" until the actual reported symptom is reproduced then resolved.
