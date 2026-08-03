# Device 303

A state-of-the-art TB-303 instrument device for the openDAW wasm engine, built from three sources that cover each other's blind spots:

1. **ar-303 measurements** (`/Users/am/Repositories/others/ar-303`), real TD-3-MO hardware captures. Ground truth for the VCO spectrum, the MEG decay shape, and the VCF pole behavior.
2. **The reference plugin**, the calibration oracle for everything the measurements do not cover: original-303 parameter ranges, env-mod, accent (squelch and wow), slide, VEG, drive. Same role VirtualCZ played for Neon, black-box A/B, no disassembly.
3. **Open303** (Robin Schmidt) and Stinchcombe's diode-ladder analysis as the structural reference for the nonlinear filter and accent circuit topology. Verify the license before mirroring any code, mirror structure the way we mirror TS templates.

## What we already have

- VCO: measured harmonic spectra C1–C5, pitch-invariant, mip-mapped wavetable technique already implemented in the ar-303 web-app (`web-app/src/dsp/WavetableOscillator.ts`). Essentially done, port to Rust.
- VCF: parametric fit (3-pole ≈ 18 dB/oct diode ladder + AC-coupling high-pass ~45 Hz, resonance-cutoff interaction) but measured over the **TD-3-MO's extended range**. The MO (Devilfish-style mod) opens far wider than a stock 303. We need the stock window, not new measurements: the stock range is a sub-range of what was measured.
- MEG: decay-only shape captured (fast ~3 ms attack, constant peak, linear droop then S-collapse) but only decay 0–60%, env-mod and accent modes never run.
- Not measured at all: VEG, slide, accent circuit (squelch, C13 wow buildup on consecutive accents), drive/nonlinearity beyond one sweep, and the **sequencer** (gate/CV generation, see Phase 2).

## Shopping list

| Item | Price | Why |
|------|-------|-----|
| Reference plugin license | ~$95 | The oracle. The demo fades audio periodically, which corrupts automated captures, so a license is required. macOS AU/VST2/VST3, Apple Silicon native. |

That is everything. The plugin host for scripted rendering is free (see Phase 1). The existing TD-3-MO, PicoScope and buffer stay useful only if we later decide to verify a finding in hardware, no new hardware needed. A stock TD-3 would not help much anyway, it lacks the filter in/out jacks that made the MO measurable. A vintage TB-303 is explicitly not needed, the reference plugin *is* the distilled 303 target.

## Phase 1: Oracle harness

Scripted, reproducible reference-plugin rendering, mirroring the ar-303 measurement conventions (raw WAV + sidecar file per capture).

- Host the reference headless via **DawDreamer** (Python, free, JUCE-based). Found 2026-08-01: the reference's Note mode needs a host transport/playhead, so pedalboard (no transport) cannot drive it, while DawDreamer can. Setup lives in ar-303: `.venv-dd` (Python 3.12), `scripts/lib/abl3.py` (renderer + WAV/JSON sidecar capture), `scripts/abl3_configure.py` (one-time GUI pass that saves the Note-mode plugin state to `measurements/abl3/state/note-mode.dawdreamer`).
- Verified working: pitch follows notes, note-off gates, overlap slides (~150 ms glide both directions), velocity changes the sound, no demo fades. The modeled VCO free-runs across renders, so repeated renders are never sample-identical, metrics must be spectral/envelope-based (this was the plan anyway).
- Grids captured 2026-08-01 (`measurements/abl3/002_grids/`, 242 wavs via `capture_abl3_grids.py`): osc saw/square C1-C5, cutoff sweep, cutoff×res grid, envmod×decay grid, accent velocity probe, accented 16th runs at 3 resonances, slide intervals ±2/7/12/24. Analyzers: `analyze_abl3_osc.py`, `analyze_abl3_vcf.py`.
- RESOLVED accent law: binary trigger at velocity > 100 (104 renders like 127, 100 renders plain), intensity comes from the Accent knob alone (onset peak 0.57 plain → 0.93 at knob 50% → 2.06 at 100%, onset centroid 350 → 1070 Hz).

### Source verdicts from the reference-vs-TD-3-MO comparison (2026-08-01)

- **Oscillator: keep the TD-3-MO measured wavetables.** The measured saw is ideal 1/n to 0.02 dB mean; the reference's saw is the same ideal shape seen through its ~45 Hz output coupling high-pass (C1 fundamental sits ~4.4 dB low, which back-solves to a ~40-45 Hz corner, converging with the MO-measured 45 Hz AC coupling). The squares genuinely differ: the measured TD-3 square has stronger even harmonics (h2 at −14.9 dB vs the reference −18.5) and deep comb notches at h11/h13 (−37 dB) that the reference lacks, mean divergence 7.3 dB. The hardware capture is the richer, more authentic source. Model the ~45 Hz coupling HP explicitly, both sources agree it exists.
- **Filter: MO physics, reference range.** The reference's cutoff knob maps to fc ≈ 84·e^(2.40·knob) Hz, roughly 85 Hz to ~925 Hz (top end underestimated by the divide-by-open-reference method, true max is higher). The MO spans 11 to 1505 Hz, so the stock-303 feel is a narrower window sitting well above the MO's floor: remap our parametric model's knob curve to the reference's window. The resonance interaction is convergent between both sources (res 0→100 shifts fc ~3.3x at every cutoff, matching the MO's ~2.8x at res 80, and peak growth scales with cutoff, 7.7/10.0/13.2 dB at cutoff 25/50/75, the "303 loses resonance at low cutoff"), so the MO-fitted interaction structure stays.
- Two drive modes, both scripted:
  - **MIDI mode**: accent = velocity ≥ threshold (reference convention ~100), slide = overlapping notes. Matches how openDAW's piano roll will drive our device.
  - **Internal-sequencer mode**: probe patterns entered once in the reference GUI, plugin state saved per pattern (DawDreamer `save_state`/`load_state` via `abl3_configure.py`), scripts restore state and render with host sync. This is the authentic 303 trigger path. Confirmed: under DawDreamer's transport the internal pattern plays with zero MIDI input.
- Capture grids: every knob swept in steps with fixed companions, plus interaction grids (cutoff × resonance × env-mod, accent × resonance, decay × accent).
- Canonical test patterns: single notes per octave, accent pairs and runs (wow buildup), slide pairs up/down at several intervals, rests and ties, classic acid loop for perceptual A/B. Each exists as a MIDI clip AND a reference internal pattern.
- Output lands in ar-303 under `measurements/abl3/` so both projects share one data pool.

## Phase 2: Sequencer semantics

The 303 sequencer is half the sound: it generates gate and pitch CV directly, notes have no length, gate is a fixed fraction of the step, slide holds the gate through the step boundary so the MEG never retriggers. This phase produces a written gate/CV spec that everything downstream triggers through.

- **Hardware ground truth**: PicoScope DC-coupled captures of the TD-3-MO's gate and pitch CV while it plays the probe patterns from its own sequencer (same buffer/test-point setup as the MEG session). Measure: gate high fraction per step vs tempo, gate continuity across tied/slid steps, pitch CV glide curve and time constant during slide, accent flag timing, rest behavior, step timing jitter (expected: none, verify).
- **Reference diff**: render each probe pattern via the internal sequencer and via equivalent MIDI notes, subtract. The residual isolates exactly what the reference's sequencer adds over naive MIDI interpretation (gate regeneration, slide gating, retrigger rules).
- Deliverable: `docs/sequencer.md` in ar-303, the gate/CV state machine (step → gate/accent/slide/pitch) with measured constants. openDAW's note interpretation layer (Phase 8) implements this spec, so piano-roll notes are translated INTO 303 sequencer semantics rather than played as raw MIDI.

## Phase 3: Metrics and parity harness

The CZ was digital and deterministic, the 303 target is analog-modeled, so parity is spectral, not sample-exact.

- Per-frame log-band energy comparison (e.g. 1/6-octave bands, 10 ms hop), RMS envelope comparison, pitch track for slides.
- Tolerances defined per phase, tests must fail without the corresponding model feature (regression discipline).
- Runs the Rust DSP natively (cargo test) against stored the reference renders, same style as the existing wasm parity tests.

## Phase 4: Filter, stock-303 window

- Sweep the reference cutoff (res 0) and identify pole frequency endpoints and taper. This defines the original feel window.
- Re-fit the ar-303 parametric model restricted to that window. The MO measurements stay the source for pole interaction and resonance behavior inside the window, the reference defines the knob-to-frequency mapping and endpoints.
- Cross-check endpoints against Stinchcombe's stock component analysis. If measurement and the reference plugin disagree, document and prefer the reference for feel, hardware for physics.
- Resonance: the reference sweeps fill the sparse MO coverage (MO had only 5 settings). Self-oscillation onset and level from the reference.
- Nonlinearity/drive: A/B input-level grids, model saturation stages per Open303/Stinchcombe topology.

### Envelope and slide grid findings (2026-08-01, `analyze_abl3_env.py` / `analyze_abl3_slide.py`)

- **Env-mod is bipolar, confirmed**: raising Envmod raises the sweep peak (445 → 1312 Hz at full decay) AND pulls the base cutoff below the knob setting (floor 141 → 70 Hz from envmod 25% → 100%), matching the documented 303 behavior. Model needs both directions.
- **Decay knob range**: audible cutoff-sweep decay time runs ~0.16 s (knob 0) to ~1.75 s (knob 100%), mid-knob ~0.3-0.9 s, consistent in magnitude with the TD-3-MO MEG (~700 ms to 4% at pot 50%).
- **Shape divergence, hardware wins**: the reference's sweep decays near-exponentially in ln(fc) (t80/t10 ≈ 0.07-0.22 across all 24 grid cells) while the measured MEG voltage is the droop-then-S curve (t80/t10 ≈ 0.45). This is the one place the sources genuinely disagree. Decision: keep the measured MEG voltage shape as ground truth and calibrate the CV-to-cutoff mapping on top of it; re-verify with the planned TD-3-MO envmod/accent hardware session before locking the curve.
- **Slide is a plain CV RC glide**: 10-90% traversal 52-69 ms across intervals ±2/7/12/24, tau ≈ 24-31 ms in semitone space, near-constant over interval and direction (up ~24 ms, down ~29 ms). The folklore "60 ms slide" matches the traversal, not the tau. Gate stays open through the transition (level dip only −5 to −12 dB vs −51 dB for retriggered notes), envelope does not retrigger. Retrigger baseline is an instant jump.
- Method note: frame/FFT pitch tracking smears at these time scales, the working tracker is zero-crossing on the bandpassed fundamental (cycle-accurate).

## Phase 5: Envelopes complete

- MEG: keep the measured droop-then-S shape as the canonical curve family, extend decay mapping 0–100% via the reference, calibrate env-mod depth mapping (cutoff offset vs env-mod knob, including the known env-mod/cutoff interaction where env-mod reduces the base cutoff contribution).
- VEG: capture from the reference (fixed decay, gate behavior, ~8 ms click-avoidance attack), model.
- Accent: MEG swap to the faster accent decay, VCA boost, and the resonance-dependent smoothing (C13 wow) where consecutive accents sweep progressively higher. Calibrate with accent-run patterns at several resonance settings.

## Phase 6: Slide

- Exponential glide per the Phase 2 gate/CV spec, time constant cross-checked between the TD-3-MO CV captures and the reference pitch tracks (literature says ~60 ms RC, verify).
- Envelope behavior during slide (MEG does not retrigger, gate stays open), accent+slide combinations.

## TS reference model (DONE 2026-08-01, ar-303 web-app)

The complete voice is implemented and calibrated as a TS/JS reference model in the ar-303 web-app, which becomes the template the Rust device mirrors (the usual TS-first flow):

- `web-app/src/dsp/tb303-processor.js`: self-contained ES module, runs as AudioWorklet in the browser AND directly under Node for offline parity rendering. Voice = measured-wavetable osc (mip tables built from the spectra), coupling HP 45 Hz + resonant biquad + 1-pole at 3fc, measured MEG droop-S shape, bipolar env-mod, VEG (3 ms attack, 7.6 dB/s held decay, 12 ms release), binary accent with VCA boost + resonance-dependent C13 wow (charge 4+45·res ms, discharge 800 ms), RC slide tau 27 ms. All constants live in the `CALIBRATION` block.
- Sequencer303 in the same file: 16 steps {note, gate, accent, slide}, slide ties to previous step (gate held through boundary, no retrigger), gate fraction 0.55 (provisional until the Phase 2 hardware measurement).
- Parity loop: `scripts/render_model.mjs` (TB303_CAL/TB303_ONLY env overrides) renders the identical probe grids, `scripts/compare_model_abl3.py` + `calibrate_{cutoff,res,res_fit,env}.py` run identical metrics on both sides. Final state: cutoff corners within one comb bin, resonance peak positions exact with dB within ~1, env peaks/floors/decay times within ~20% (except intentional droop-S vs exponential shape divergences at envmod extremes), accent levels match, slide traversal within a few ms.
- UI: `/tb303` page (Tb303Page.tsx) with all 8 knobs (custom Knob component), BPM, play/stop, random + mutate pattern generator (`tb303/pattern303.ts`), editable 16-step grid (note drag, gate/accent/slide toggles), live step cursor. Verified in the browser.

### Movement pass (2026-08-01, after user feedback "sound close, movement isn't")

New oracle grids `003_squelch` (low cutoff × high res: steady corner, ring-down, 16th runs) and `004_envlow` (envmod 5-30%, long + short notes). Findings baked into the model:

- No post-note resonance ring in the reference at all, the squelch is entirely the sweep through the peak, the VEG chops hard. Ring-based Q calibration unnecessary.
- The sweep is large even at envmod 0 (~0.48 ln). The knob adds on top. The old low-end extrapolation to zero was the main reason the acid zone felt static.
- fc responds convexly to MEG volts (`envCurveK = 3`, the expo-converter curve): the audible cutoff falls fast right after the attack even while the measured droop-S MEG voltage is still near its peak. This reconciles the hardware voltage shape with the reference's audible movement, both stay in the model.
- Decay mapping restretched to compensate (min 18, span 66), resonance strength keyed by effective fc rather than the knob (matters mid-sweep).
- Verified: sweep trajectories now parallel the reference across envmod 5-30% at matching rates, env grid mostly within ±0.15 ln. Known residuals: one metric-bin brightness offset in the cutoff 0.2/res 0.85 corner, peak-dwell differences at instant decays (droop-S vs exponential, intentional).

### Character pass (2026-08-01, autonomous benchmark-driven)

New oracle sessions `005_attack` (ms resolution), `006_patterns` (shared benchmark patterns, log-mel distance scorer `benchmark_303.py`), `007_release`. Model changes, all probe-verified:

- Cutoff CV node is RC-smoothed (4 ms): gradual filter opening = the "wah" onset, and explains why the reference's level rise slows with env-mod depth.
- Env sweep depth compresses as the cutoff knob rises (applies to the accent sweep too).
- Fourth pole at 4.5·fc: the 3-pole stopband was ~20 dB too shallow above 3 kHz (audible fizz vs the reference).
- Oscillator: cubic interpolation + continuous mip crossfade, 8-sample control blocks (zipper noise).
- Accent contrast: the wow CV routes only on accented steps (it was brightening following plain notes for 800 ms). C13 discharge 400 ms keeps the run-to-run buildup.
- Accent tail: accented notes sustain past gate-off following the accent MEG, ~-17 dB body-relative, darkening as the filter closes (dB-linear VCA bleed, exp curve). Plain notes chop in ~4 ms. Measured directly in the release probe.
- Benchmark 16.2 → 13.8 dB mean log-mel distance (the probe-verified accent tails cost ~1.5 dB on this metric because log-domain gap frames overweight; kept anyway).
- Knob UI geometry fixed (arc and pointer share one angle convention, verified via DOM).

### Movement optimization (2026-08-01, benchmark-driven to convergence)

Movement became the optimized quantity: `movement_score.py` measures the dense (5 ms) brightness-trajectory error between model and the reference across all benchmark patterns, `optimize_movement.py` runs coordinate descent with the long-note env grid inside the objective (constraint discovered the hard way: optimizing on short notes alone inflates decay times to fake top-dwell). Result 0.294 → 0.245 ln mean trajectory error. Decisions:

- **The MEG-to-cutoff movement is exponential** (`megExpMix = 1.0`): tested head-to-head, the measured droop-then-S loses to pure exponential against the reference across every pattern. The measured shape stays available behind the mix parameter for the eventual hardware re-verification (the droop is voltage-domain truth, the audible movement is post-circuit).
- Decay mapping refit for the exponential + CV curve (effective t10 = 1.53·t50): decayKnobMin 19, span 56, envCurveK 2.5, cvSmoothMs 2.
- The sweep-vs-cutoff compression law was removed entirely, a droop-era compensation artifact.
- Per-preset trajectory error: rolling patterns 0.14-0.19 (excellent), classic 0.22-0.23, bright 0.36-0.42 = the remaining weak spot (accent 1.0 at cutoff 0.7, cause not yet isolated, top-anchor offset tested and excluded).
- A/B listening files (the reference then model per benchmark case): `measurements/ab/*_AB.wav`.

## Phase 7: Rust device

- New crate `device-303` (working name, final name TBD by user) behind `abi`, AudioProcessor + NoteEventSource templates like the other instrument devices.
- Signal chain: wavetable VCO (measured spectra, saw/square blend or switch per original), diode-ladder VCF with feedback high-pass and saturation, MEG/VEG, accent path, output stage with the AC-coupling high-pass.
- Params: waveform, tuning, cutoff, resonance, env-mod, decay, accent amount, volume, plus slide time and accent velocity threshold as the two "modern" conveniences. Value mappings defined in the TS adapter (createParameter), Rust mirrors the adapter, not the schema.
- The device contains the Phase 2 gate/CV state machine as its trigger core: incoming notes are translated to steps, gate is regenerated at the measured fraction, ties/slides/accents follow the spec. Raw note lengths are never used as gate lengths.
- Parity suite from Phase 3 green across the capture grid, including internal-sequencer renders.

## Phase 8: openDAW integration

- Box schema, BoxAdapter, device editor UI (per-phase browser checkpoints, per the UI-rework lesson).
- Note interpretation in the engine: velocity threshold → accent flag, overlapping notes → slide, then through the Phase 2 gate/CV state machine, matching the Phase 1 harness convention exactly so calibration transfers. Optional later: a dedicated step-pattern editor UI (303-style entry), which becomes a pure front-end over the same state machine.
- A/B in the studio: render the canonical acid loop through the device and through the stored the reference render for a final perceptual check.

## Order and checkpoints

Phases 1+2+3 first (harness and sequencer spec before model, measure before fixing). Then 4 → 5 → 6 as pure DSP with parity tests, each phase green before the next. 7 runs alongside 4–6 (the crate is where the DSP lives). 8 last. User checkpoints: after Phase 1 (capture quality), after Phase 2 (sequencer spec review), after Phase 4 (filter feel on the canonical loop), after Phase 7 (full chain parity), per-phase browser checks during Phase 8.
