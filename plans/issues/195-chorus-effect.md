# Chorus Effect (#195)

**Doability:** ⭐⭐⭐☆☆ (3/5) — every building block (fractional delay line, LFO, stereo width) already exists in the codebase; no direct chorus/flanger precedent to copy wholesale, so the voice-summing algorithm itself is new work.
**Type:** feature
**Scope:** medium

## What is asked
A chorus device with 2-voice and 8-voice modes, LFO controls (rate/depth), a dry/wet mix, stereo image width, and detuning.

## Current behaviour / relevant code
- No `Chorus`, `Flanger`, or `Phaser` device exists anywhere (`packages/lib/dsp`, `packages/studio`, `crates/` all confirmed empty for these terms).
- Fractional/interpolated delay line: `packages/lib/dsp/src/delay.ts` — `class Delay`, power-of-2 ring buffer with linear-interpolated read position and smooth offset ramping (`#processInterpolate`, offset setter). This is the exact primitive chorus needs (one delay line per voice, offset modulated by an LFO).
- Closest existing device to mirror the *structure* of: `DelayDeviceDsp.ts` (`packages/studio/core-processors/src/devices/audio-effects/DelayDeviceDsp.ts`) — already uses two `Delay` instances, a `BiquadCoeff`/`BiquadMono` filter pair, and a hand-rolled LFO modulating the delay offset (`#lfoPhase`/`lfoPhaseIncr`, `lfoDepth` box fields) plus a `Smooth` depth smoother. Dattorro reverb (`DattorroReverbDsp.ts`) also modulates delay taps with an LFO "excursion" for a similar purpose.
- Dedicated LFO class: `packages/lib/dsp/src/lfo.ts` — `class LFO { fill(buffer, shape: ClassicWaveform, frequency, fromIndex, toIndex); reset() }`, free-running Hz-rate phase accumulator with selectable waveform (sine/triangle/saw/square), used per-block in `VaporisateurVoice.ts` (fill a modulation buffer, then read per sample). Per project memory, LFO is already solid in both TS and WASM ("LFO/Modular = non-issues").
- Stepped 2/8-voice mode precedent: same `Int32Field` + constraint pattern as `Crusher`'s `bits` field or `StereoTool`'s `panning-mixing` (`{values: [...]}` constraint) — here `{values: [2, 8]}` (or a continuous voice-count if more granularity is wanted; the issue explicitly asks for 2 and 8 as the two modes).
- Stereo width knob precedent: `StereoToolDeviceBox`'s `stereo` field (bipolar %) and its `StereoMatrix` processing in `StereoToolDeviceProcessor.ts` — reusable for spreading chorus voices across the stereo field (e.g. panning odd/even voices or spreading LFO phase offsets left vs right).

## Plan
1. Schema: new `packages/studio/forge-boxes/src/schema/devices/audio-effects/ChorusDeviceBox.ts`, fields: `voices` (int32, `{values:[2,8]}`), `rate` (float32, Hz, exponential — mirrors `DelayDeviceBox`'s `lfoSpeed` field, e.g. 0.1-5 Hz), `depth` (float32, unipolar %), `detune` (float32, bipolar cents or %), `mix` (float32, unipolar %, dry/wet), `stereoWidth` (float32, bipolar %, spreads voice phase/pan across L/R).
2. Adapter `ChorusDeviceBoxAdapter.ts`: wrap all fields as automatable parameters following `DelayDeviceBoxAdapter`'s pattern for `lfoSpeed`/`lfoDepth`.
3. Processor `ChorusDeviceProcessor.ts`: allocate up to 8 `Delay` instances (from `packages/lib/dsp/src/delay.ts`), each with its own LFO phase offset (evenly spaced around the LFO cycle, e.g. voice `i` of `N` gets phase `i/N`) driving its delay-line read offset (base delay + `depth * LFO.fill(...)`); each voice gets a small fixed detune via a slightly different modulation depth or a pitch-shift-free "detune via delay-rate drift" approach (simpler: vary each voice's LFO rate slightly, ± the `detune` amount, which is the classic multi-voice chorus trick). Sum all voice outputs (scaled by `1/sqrt(voiceCount)` or similar), spread across L/R using `stereoWidth` (odd voices panned left-biased, even right-biased, or via `StereoMatrix`-style blend), then mix dry/wet via `mix`. When `voices=2`, only two delay lines run (cheaper); when `8`, all run.
4. Editor `ChorusDeviceEditor.tsx`: voices mode selector (`RadioGroup`, 2 vs 8 — mirrors `FoldDeviceEditor.tsx`'s `RadioGroup` on an int32 field), knobs for rate/depth/detune/mix/stereoWidth, optionally a small LFO-phase visualization per voice (nice-to-have, not required for v1).
5. Register in `EffectFactories.ts`, `DeviceProcessorFactory.ts`, `BoxAdapters.ts`, `DeviceEditorFactory.tsx`, `DeviceManualUrls.ts`.
6. WASM mirror: new crate `crates/stock-devices/device-chorus`. Rust already has an equivalent `Delay`/interpolated-line port (used by `device-delay`) and an `LFO` port (used by `device-vaporisateur`, per project memory "LFO/Modular = non-issues") — reuse both directly rather than reimplementing.

## Risks / open questions
- 8 simultaneous interpolated delay lines + LFO reads per sample is more CPU than any existing single-voice modulation device (Delay, Dattorro) — worth a quick perf check against the project's existing DSP-load stats infra, though still cheap relative to Reverb/Vocoder.
- Detune implementation choice (LFO-rate variance per voice vs. true fractional-resampling pitch shift) affects realism — the simple LFO-rate-variance approach is standard for chorus and avoids pulling in pitch-shift machinery (see #188, which doesn't exist yet), recommend starting there.
- Confirm stereo-image behavior expected: full stereo spread of independently-modulated L/R voice sets (richer, more CPU) vs. mono chorus core with a stereo-width post-process (cheaper, less "wide" character) — the issue mentions both "stereo image" and "8-voice" so likely wants true per-voice stereo spread.
