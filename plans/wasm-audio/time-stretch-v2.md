# Time-stretch v2: content-adaptive granular, with a phase vocoder as a later mode

Goal: a better time-stretcher in openDAW. Keep the granular architecture (we mirror Ableton's Beats-style
transient grains) but make the grains **content-adaptive**: a new transient detector that emits per-segment
descriptors, and a runtime that auto-adjusts fades and loops from those descriptors so drums keep tight
attacks and pads respect their low-energy transients instead of audibly re-triggering. A phase vocoder is a
separate, later opt-in mode (the "Complex" tier), not a replacement.

## 1. Where we are

Playback (`engine/src/time_stretch.rs`, mirror of `core-processors` `TimeStretchSequencer` +
`OnceVoice`/`RepeatVoice`/`PingpongVoice`): a transient-synchronous granular sequencer. At each transient
boundary the timeline crosses, it spawns a short granular voice reading that segment at the warp-derived
rate, 20 ms linear voice crossfade between voices. When a segment is shorter than the output time it must
fill, the voice loops an inner region (`RepeatVoice`, 10 ms linear loop crossfade) or bounces it
(`PingpongVoice`, cos/sin). This is effectively Ableton Beats mode: transient-locked grains.

Detection (`lib-dsp/transient-detection.ts`, TS worker, synced to the engine as `TransientMarkerBox`
positions in seconds): mono, 3-band Linkwitz-Riley split, a 20 ms RMS energy envelope per band,
derivative-based onset picks against one global `ENERGY_DERIVATIVE_THRESHOLD`, energy-weighted greedy
selection with 120 ms minimum separation, valley refinement. It emits bare positions and nothing else.

## 2. Why pads sound grainy

The audible pad artifact is dominated by `RepeatVoice`'s loop crossfade, not the voice-to-voice fade. A
sustained segment with no internal transient must loop to fill stretched time, splicing loop-end back to
loop-start every cycle. Today that splice is:
1. fixed length (10 ms) regardless of material,
2. **linear**, so for uncorrelated tonal partials the power dips mid-fade, i.e. amplitude modulation at the
   loop rate, which is the sound of the grain restarting,
3. at an **arbitrary loop point** whose phase does not match, so the partials comb-filter and beat every
   cycle.

Fixed fades cannot serve both drums and pads: a drum wants a short fade to keep the attack; a pad wants a
long, aligned, equal-power fade to disappear. The fades must follow the material.

## 3. Direction

Keep grains as the default (mirrors Ableton, sample-accurate, cheap, no render-path FFT), but drive their
parameters from what the audio actually is:
- a richer detector that measures each segment (Part A),
- a runtime that picks fades and loops per segment from those measurements (Part B),
- a test harness that proves drums stay tight and pads stop re-triggering (Part D),
- a phase vocoder added later as an opt-in "Complex" mode for material where grains hit their ceiling
  (Part E).

## 4. Part A — new transient detector

Two upgrades over the RMS-derivative detector.

Onset function and picking:
- Replace the per-band energy derivative with **spectral flux**: half-wave-rectified sum of frame-to-frame
  magnitude increases from a short-hop STFT. This is the standard onset detector and is far more reliable
  than an RMS slope, especially for soft tonal onsets.
- Replace the single global threshold with **adaptive peak-picking**: the threshold is a local moving
  median/average of the flux plus a margin, so one constant no longer has to fit both a quiet pad and a
  loud drum loop. Keep the minimum-separation and density guards.

Per-segment descriptors (the new output, one set per transient, covering the span to the next transient):
- **onset strength**: attack sharpness at the boundary (flux magnitude / local crest). Drives fade-in
  length and whether the grain edge is sharp or soft.
- **fundamental period**: local pitch period via autocorrelation or YIN over the segment (or `0` if
  aperiodic). Drives pitch-synchronous loop length and loop-point alignment.
- **harmonicity**: tonal vs noisy, via spectral flatness. Drives loop crossfade length and whether to
  bother pitch-syncing at all.

## 5. Part B — descriptor-driven adaptive playback

Replace the fixed `VOICE_FADE_DURATION` / `LOOP_FADE_DURATION` / `LOOP_MARGIN_*` constants with per-segment
values computed from the descriptors, all still time-domain and allocation-free on the render path.

- **Fade length vs onset strength.** Strong attack (drum) → short fade-in so the transient stays tight.
  Weak/low-energy onset (pad) → long, soft fade so the boundary is inaudible. This is the core of
  "drums keep their attack, pads respect their low-energy transients".
- **Equal-power crossfade shape everywhere.** `RepeatVoice`'s loop fade is linear today; switch the voice
  and loop crossfades to equal-power (cos/sin, as `PingpongVoice` already does) to remove the power dip.
- **Pitch-synchronous loop.** When `fundamental period > 0` and the material is harmonic, snap the loop
  length to an integer multiple of the period and align loop-start/loop-end to the same phase, so the
  splice no longer combs or beats. Aperiodic/noisy segments fall back to the current arbitrary loop.
- **Loop crossfade length vs harmonicity.** Tonal → longer, aligned crossfade; noisy → short, since a
  noisy splice does not comb.

The grain mode still maps to Ableton's split: strong-onset short-grain behaviour is Beats, adaptive
long-grain tonal behaviour is Tones/Texture. Same engine, parameters chosen by content.

## 6. Part C — where the analysis lives

The descriptors need the source samples, which the engine already holds in WASM memory. Cleanest path:
keep the transient **positions** coming from the detector, and compute the **descriptors in Rust at region
bind** from the PCM we already have. This avoids a `TransientMarkerBox` schema change and a sync/parity
round, and keeps the render path clean (bind-time work, preallocated scratch).

Open sub-question for the user: does the new detector replace the TS `transient-detection.ts` outright
(TS is retiring, so a WASM-only detector is viable and unifies the code), or do we improve the TS detector
now and port later. Recommendation: build the new detector in Rust and drive both from it, since positions
and descriptors want the same STFT.

## 7. Part D — how we judge the outcome in tests

Two goals, two isolated metrics, each a self-contained Rust function in the test crate (deterministic, no
network, reuse our existing FFT). Capture the baseline on the CURRENT engine first, so every metric fails
before the fix and we can prove the direction of the change (per repo practice: reproduce the symptom as a
number first).

- **Drum attack tightness.** For each expected onset in the stretched output, measure attack rise time /
  local crest, and compare to the source's attack at the same onset. The ratio must stay near 1 (attacks
  not smeared). Regression fails if stretched drum attacks soften relative to baseline.
- **Pad grain modulation** (the pad symptom, isolated). Take the output amplitude envelope, remove the
  intended slow region-fade trend, and look for periodic energy at the grain/loop rate via envelope
  autocorrelation or an envelope-spectrum line at the loop frequency. High value = audible grains = fail.
  On a pure-sine stretch, the same shows up as sidebands at +/- loop rate around the partial (an AM/THD
  proxy). This metric must drop sharply after the adaptive fades and pitch-sync loop land.

Corpus: isolated drum loop, isolated pad, vocal, full mix, plus synthetic probes (sine, sine sweep, click
train), each at several stretch ratios (0.5x, 0.75x, 1.5x, 2x, 4x). Log any dropped case, never silently
cap coverage.

### Can `audio-analyzer-rs` help?

Yes, in two roles, but not as a CI dependency. It is a binary + MCP server (Symphonia + RustFFT, MIT) with
no clean `[lib]` target to depend on, and it exposes attack sharpness, onset detection/density, HPSS,
RMS/dynamics, spectral flatness/contrast, and a `compare` A/B diff.
- **Tuning-time cross-check.** During the magic-number loop, render outputs and run `compare` /
  `spectral_features` (via its CLI or MCP) to A/B a change against the previous best and sanity-check our
  own metrics with an independent implementation. Its attack-sharpness and onset tools map directly onto
  the drum goal, its dynamics/flatness onto the pad goal.
- **Algorithm reference.** Its MIT metric code is a reference for our own `stretch_metrics` module.

The automated regression gate stays our own self-contained metrics, so CI is deterministic and offline;
`audio-analyzer-rs` is the human-in-the-loop tuning and validation aid.

## 8. Phases

- **Phase 0 (measure first).** Corpus + the two metrics + baseline capture on the current engine. No DSP
  change yet. The pad grain-modulation number and the drum attack-tightness number must exist and encode
  the current behaviour before anything moves.
- **Phase 1.** New detector: spectral-flux onset + adaptive peak-picking, validated against the current
  positions on the corpus (no regressions in placement), plus the three descriptors.
- **Phase 2.** Descriptor plumbing: compute descriptors in Rust at region bind, preallocated scratch, zero
  render-path allocation.
- **Phase 3.** Adaptive playback: fade length vs onset strength, equal-power crossfades, pitch-synchronous
  loop, harmonicity-scaled loop fade. Prove the pad metric drops and the drum metric holds.
- **Phase 4.** Tuning loop with `audio-analyzer-rs` cross-checks; retune detector and playback constants.
- **Phase 5.** TS decision: WASM-only new detector/playback vs keeping the TS path; UI surface and project
  migration.

## 9. Part E — phase vocoder as a later opt-in mode

Time-domain granular has a ceiling: splicing an arbitrary tonal loop never fully removes the phase
discontinuity, which is why Ableton keeps Complex Pro (spectral) alongside the grain modes. After the
adaptive grain work lands, add a phase-vocoder mode for pads and full mixes:
- STFT (Hann, 2048/4096, 75% overlap) built on a generalised `dsp::fft` (extend the fixed-size
  `analyser.rs` FFT; no new dependency),
- phase propagation via instantaneous frequency, peak/identity phase locking (Laroche-Dolson) for
  vertical coherence,
- phase reset at each transient (Rubber Band model) so attacks stay sharp,
- surfaced as a new `transientPlayMode` / warp mode, not the default.

Licensing note for reference material: Rubber Band is GPL (study only), Signalsmith Stretch is MIT (the
best licensed reference; pure-Rust ports exist and claim no_std). We implement on our own FFT to stay
no_std-clean and dependency-light.

## 10. Risks

- Descriptor accuracy: bad pitch/harmonicity estimates pick bad loops. Guard with the aperiodic fallback
  and test on the corpus.
- Bind-time cost: descriptor analysis runs per region at bind; keep it off the render path and measure.
- Equal-power change alters existing renders slightly; verify frozen/stems render identically online and
  offline.
- Time-varying warp ratio interacts with pitch-synchronous loop length; cover with a warp-ramp test.
- Phase-vocoder mode (later) is FFT-heavy; measure on the `/performance` A/B page before shipping.

## 11. Open decisions for the user

- New detector replaces the TS one (WASM-only) vs augments it for now.
- Descriptors computed at bind in Rust (recommended) vs stored on `TransientMarkerBox` (schema + sync
  change).
- Box surface for the adaptive grains (reuse existing modes vs a new mode) and, later, the phase-vocoder
  mode value.
