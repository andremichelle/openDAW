# Device 303

A state-of-the-art TB-303 instrument device for the openDAW wasm engine. This document is the complete handover: a fresh session (any model) must be able to continue from here plus the project memory. The working repo for all modeling and measurement is `/Users/am/Repositories/others/ar-303`; this openDAW repo receives the Rust port only at the end.

## Status update (2026-08-06): v3 is DONE, the port is next

Steps 1-5 below are complete. The v3 model lives in
`ar-303/web-app/src/dsp/tb303-v3.js` at tag **`final`** (commit c95b7e3): 52
constants, no lookup tables, calibrated over 49 gated A/B pairs (5 patterns x 11
presets) against a 21-dimension report card and a hard render-guard battery.
That file is the source of truth for the port and must not be "improved" during
it.

Known open at `final`, all measured, none blocking the port:
- step-boundary brightness spike on retriggered accents (+17.8 dB avg). Proven
  STRUCTURAL: with the boundary metric scored and five relevant parameters
  free, fitting moved it 0.5 dB. Needs a mechanism that closes the sweep at a
  boundary, not a parameter.
- HF deficit ~-16 dB above 3 kHz on cutoff-0 presets.
- `classic_squelch` +20 dB too bright above 3 kHz, unmoved by every lever tried.

Everything below this block predates the port and is retained as the record of
how the model was derived; the numbers in it (10-dimension card, ~20 constants,
v2 states) describe earlier generations, not `final`.

## Where the project stands (2026-08-03)

Three generations of the TS reference model exist in `ar-303/web-app/src/dsp/tb303-processor.js`:

- **v1 "ladder"** (`filterCore: "ladder"`): pole-spread ZDF + ~40 calibration tables. Shipped historically, structurally capped (cannot make the passband scoop or the ring-vs-note contrast). Do not invest further.
- **v2 "diode2"**: true coupled-node diode ladder (tridiagonal implicit solve, the correct physics) + a table stack that regrew to ~60 calibration keys during 20h of optimizer cycles. Best state: `measurements/optimize_v2_card_best.json`, ~14.6 total violation on the 10-dimension report card (v1 measures ~36 on the same card). The AB files in `measurements/ab/` are built from this state.
- **v3 (the current direction, user-decided)**: keep the diode2 filter core, rebuild the entire control side circuit-faithfully. Exactly two envelopes (MEG → cutoff CV via the envmod attenuator, VEG → VCA) plus ONE accent RC circuit feeding both paths the way the hardware schematic wires it, slide, and the measured gate logic. Parameter budget ≈ 20 physical constants. **The parameter set comes from circuit research and is then FROZEN** — the failure mode of v1 and v2 was letting the optimization loop grow the parameter space. Two research syntheses (hardware circuit analysis: Stinchcombe filter papers, Devil Fish docs, service manual; plus Open303 source constants and x0xb0x firmware timing) are being folded into `ar-303/docs/v3-circuit.md`. That document defines the v3 parameters; the user reviews it before code.

The filter core question that v3 research must settle: the reference shows **no resonance ring on short gated notes but slow-growing self-oscillation (~500 ms) on sustained notes**, while our core rings instantly and sustains less. The answer likely lives in the hardware's feedback-path components (frequency-dependent feedback, where limiting happens). Everything else about the diode2 core is validated against the drone-grid truth (slope, scoop, stopband floor, peak positions).

## The measurement system (the real asset — keep, never weaken)

All of it lives in `ar-303/scripts/`. The reference plugin renders bit-deterministically (take-vs-take = 0.00 dB), so every metric difference is real signal.

- **Oracle harness**: `lib/state.py` writes ANY pattern to ANY of the reference's 128 pattern slots programmatically (the pattern bank is plain XML inside the plugin state chunk; trigger note N plays slot N; GUI never needed). Captures via pedalboard (`.venv`) for pattern mode. `capture_*.py` scripts populate `measurements/<session>/`. Key sessions: `010_seqreal` + `012_userlab_seqreal` (the authoritative sequencer-truth pattern renders, 6 presets each), `013_scenarios` (9 isolation scenarios × 5 settings), `015_drone_grid` (5×5 cutoff×res all-tied drone = the static filter truth), `016_drone_pitch` (drones at +7/+12 semitones), `017_ring_isolation` (plain gated notes at static bright fc).
- **The report card** (`report_card.py`) is THE gate: 8 pattern pairs × 10 independent dimensions, each with its own audibility threshold, no aggregation. Dimensions: level, worst-octave balance, cutoff trajectory (centroid), movement (25 ms-smoothed level envelope — raw frames measure resonance beat phase, which two deterministic engines can never align), resonance prominence, tail rumble, gap bleed (model sound in reference-silent steps), bass-anchor dominance mismatch (is the fundamental or the ring the loudest line — the user's ear maps directly onto this), attack brightness (centroid excess over the first 30 ms of onsets — added after three user reports; attacks were invisible to every body-scale metric). A pair is done only ALL-PASS. **Present AB files to the user only from measured states; the user's ears have overruled every metric shortcut taken so far.**
- **Optimization loop**: `optimize_v2_card.py` (coordinate descent) alternating `optimize_v2_simplex.py` (Nelder-Mead, minimax objective sum+2·max; MUST pass an explicit initial_simplex — scipy's default step at x0 is microscopic and fake-converges) via `run_cycles.sh`, detached with nohup, one Monitor notification per block. Improvements checkpoint to disk continuously; the DONE log lines are the state backup (best-jsons get overwritten across stages — recover from logs, filtering for the current lock regime).
- **Diagnostic probes** (reuse before writing new ones): `probe_band_steps.py` (per-step octave diffs), `probe_ring_track.py` (per-10 ms dominant line + fundamental), `probe_attack_fine.py` (2 ms attack anatomy), `probe_band_trace.py`, `probe_movement.py`, `probe_fc_knee.py` (precise transfer knees), `probe_drone_current.py`, `probe_leak_zero.py` (generic variant runner — edit its `run(...)` list), `probe_meg_tau.py` (held-note envelope constants), `measure_threshold_standalone.mjs` (standalone diode2 self-osc threshold scan).
- **AB builder**: `make_ab_files.py` (refuses non-finite renders). The `SEQ_*` files are the valid listening references; `bench_*` note-mode A-sides are deprecated for judging.
- Render pipeline: `render_model.mjs` with `TB303_CAL` (JSON cal override), `TB303_ONLY` (bench/slow/scenario/drone sections), `TB303_BENCH` (pair filter), `TB303_DRONE_NOTE`.

## Validated semantic knowledge (measured, keep in v3)

- Sequencer: slide-on-N glides N into N+1 (Roland convention; the reference manual is misleading). Tied = previous.gate && previous.slide && gateOn. Gate fraction 0.60 of the step. One off per chain end.
- Accent: binary at velocity > 100; knob sets intensity. The accent/VEG charge is consumed by EVERY gate retrigger (not only accent fires) and re-arms on gate-off — an accent landing mid-chain is weak even if it is the chain's first. Tied accents boost the VCA far less than fired ones. Accent VCA is additive on top of the (depleted) VEG.
- The accent attack anatomy (2 ms resolution, scream preset): the reference stays bass-anchored for ~8 ms (centroid 150-300 Hz), bumps briefly to ~530 Hz at 12 ms, settles by 16 ms. A pure onset delay of the accent sweep reproduces this; the sustained sweep must remain for the step body (every attempt to replace it broke the body dimensions).
- The reference keeps playing ~2 steps after note-off (cap comparisons at 4.04 s); it has ZERO render latency (the apparent delay is the saw starting at ramp phase, period-dependent).
- MEG-to-cutoff is exponential in the audible domain (envCurveK ≈ 3 expo-converter curve); env-mod is bipolar (raises peak AND lowers floor); square must be input-scaled ~0.5 vs saw (the reference normalizes internally).
- Drone truth: at res ≥ 0.5 the sustained drone peaks are all +33..+42 dB, ~3 Hz-wide locked lines with ~500 ms buildup; the early window (0.05-0.28 s) gives the uncontaminated driven k-curve (steep: k100 > k80 > k60), the late window is ring-contaminated.

## Refuted hypotheses (do NOT retry parametrically — each cost hours)

satDrive/hfLeak against squelch upper harmonics; resStrength anchors in any keying (effective-fc space cannot separate scream accents from bright bodies — same range); excursion-keyed strength cuts; envmod-gated or envmod-faded k-bleed (both directions); sweep-rate k-bleed; amplitude-deadzone ring damping (fast AND slow-sustain followers); feedback high-pass in the diode core (drone rejects it, including joint k grids); fcLowShift (drone-metric noise, patterns catastrophic); slow note-off decay and VEG sustain floors (pattern gates genuinely release fast, ~4.8 ms); vcaLeak ≈ no-op; k100 into the limit-cycle regime (floods); replacing the sustained accent sweep with ring boost (kBoost) or spike in any combination; long decay floors (decayKnobMin > 40). The measured MEG decay mapping (t50 ≈ 110/650/1200 ms at knob 0/0.5/1.0) conflicts with the card optimum (~190 ms/1.2 s/7.8 s) — the card won for v2, but v3 should re-derive this from the circuit and re-measure with a level-independent method.

## Process rules (learned the hard way, binding)

- Every model edit: render one note, assert finite, before anything else (0×NaN=NaN; a zeroed flag does not protect a dormant path with an undefined companion).
- Edit scripts: assert-then-replace; verify wiring landed before interpreting probes (two identical probe rows = the tell that a parameter is not wired).
- Guard EVERY preset in the card — the deep preset drifted to double-digit violations while unguarded (the noisy attacks the user heard). Metric coverage gaps are where regressions hide.
- Single levers rarely survive: probe in isolation for diagnosis, but let the joint optimizer decide adoption.
- Never present listening files from unmeasured states. Never lower a gate to pass it; metric hardening (gap bleed, beat-phase smoothing, attack window) is how the card converges toward the user's ear.
- The static filter is locked to the drone truth; optimizers may not move filter constants (the card optimizer once silently corrupted the filter to patch dynamics — the 10.3 "best" was dishonest).
- Background work: detach with nohup (Bash tool timeout kills long foreground runs), one Monitor per block on process-exit, no per-event pings.
- Commits only when the user explicitly asks. The user pays per token: prefer the main loop over agents, batch probes, avoid re-deriving what this document and the memory already state.

## v3 build order

1. **Circuit document** (`ar-303/docs/v3-circuit.md`, in progress): the frozen parameter inventory with hardware values as priors. User reviews before code.
2. **Prune**: delete every neutral/refuted hook from `tb303-processor.js` and the CALIBRATION block. No behavior change expected; verify with the card.
3. **v3 control side**: MEG + VEG + one accent RC + slide + gate logic per the circuit doc, replacing the v2 accent/envelope table stack. The diode2 core and its drone-locked constants stay.
4. **Fit the ~20 physical constants**: drone grid for the filter (already done), scenario captures for envelopes, the attack/accent anatomy probes for the accent circuit (2 ms resolution; attack and accent are the user's declared character priorities and need the deepest measurement).
5. **Card loop to convergence** with the frozen parameter set. If a dimension cannot pass, the answer is a circuit insight, not a new table.
6. **Rust port** (`device-303` crate behind `abi`, AudioProcessor + NoteEventSource templates): mirror the v3 TS processor 1:1 — the small frozen parameter set is exactly what makes this port tractable. Param value mappings come from the TS adapter (createParameter), never the box schema. The gate/CV state machine is the trigger core; piano-roll notes are translated INTO 303 sequencer semantics (velocity threshold → accent, overlap → slide), raw note lengths are never gate lengths.

### 6a. Note input alongside the internal pattern (decided 2026-08-06)

The device runs an internal pattern AND accepts live notes. Decided behaviour:
pattern notes and live notes are **peers, merged by last-note priority into one
ordered stream before the voice sees anything**. Overlapping notes slide to the
new note (legato = slide); velocity above a threshold = accent. One voice,
always — the 303 has one.

The merge is the whole risk. Accent-cap depletion, slide-into-next-note and
envelope recharge are all order- and timing-dependent; two sources writing the
voice directly would reproduce, as bugs, the exact defects removed during
calibration (an accent firing on a stale cap, a slide that re-articulates).
So: merge first, voice second, never both.

### 6b. Layering

1. voice module — oscillator, ladder, MEG, VEG, accent. Pure, no ABI, no
   events. Mirrors tb303-v3.js statement for statement INCLUDING FLOAT OP
   ORDER (see the werkstatt stutter divergence: same ops, different order,
   audibly different result).
2. note merger — last-note-priority stack, derives accent/slide, emits voice
   commands.
3. `crates/stock-devices/device-cubed/src/lib.rs` — ABI surface: `state_size`,
   `kind` (`DEVICE_KIND_INSTRUMENT`), `process`, `init`; plus `process_events`
   if the pattern emits into the stream.
4. TS side: box schema, adapter, editor, and a `DEVICE_CRATES` entry in
   `packages/studio/core-wasm/build-wasm.sh`.

### 6c. Parity harness — build this BEFORE the device shell

The calibration is only worth something if the port is faithful.

- render the same pattern/preset set through tb303-v3.js and the Rust voice,
  compare sample-by-sample
- reuse `ar-303/scripts/lib/patterns303.json` so the cases are the ones already
  A/B'd
- port the report card as a regression test, not just a diff
- layer-by-layer green: oscillator, ladder, envelopes, accent, whole voice. Do
  not move up a layer until the one below matches.

### 6d. Open questions for the port

- Does the internal pattern emit notes into the event stream (like
  `device-arpeggio`'s `process_events`) or drive the voice directly? Emitting is
  more openDAW-native and makes the pattern visible downstream; driving directly
  keeps ordering trivially correct. Emitting is probably right but makes the
  merge a cross-crate concern.
- Pattern storage in the box schema (16 steps x gate/accent/slide/pitch/octave);
  automatable and/or clip-launchable?
- Accent velocity threshold: fixed constant (v2 measured >100) or a parameter?
- Internal `Sequencer303` timing (gate fraction, tie chains) vs openDAW's
  transport-driven stepping.
7. **openDAW integration**: box schema, adapter, editor UI (per-phase browser checkpoints; rebuild all dists/wasm/bundles before the first user test).

## Reference environment

- Reference plugin: licensed, driven headless via pedalboard (`.venv`, Python 3.13) for pattern mode; DawDreamer (`.venv-dd`, Python 3.12) hosts everything that needs a transport and runs all Python analysis (numpy/scipy/soundfile live there).
- Dev server for the `/tb303` page: `cd ar-303/web-app && npm run dev -- --port 8088` (https).
- The project memory holds the full session-by-session log including everything this summary compresses.
