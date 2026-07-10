# Time-Stretch v2 — adaptive playback with a self-judging harness

Status: **planning**. Supersedes the sketch in [`plans/wasm-audio/time-stretch-v2.md`](../wasm-audio/time-stretch-v2.md).

The goal: replace the audio-region time-stretch with a system that sounds great on *different input
styles* — drums stay punchy, pads stop graining — and prove every step with numbers, not opinions.
Developed in isolated crates, matured through a measurement loop (TRL-style: nothing advances a
phase without passing its gate), connected to the engine only at the end.

## 1. The problem (measured against the current code)

`crates/engine/src/time_stretch.rs` mirrors Ableton's Beats mode — transient-locked granular — but
with fixed parameters:

- Loop splices are a fixed **10 ms linear** crossfade at an **arbitrary** file position. Linear fades
  of uncorrelated material dip in power mid-fade (AM at the loop rate — the "grainy pad" sound), and
  an arbitrary splice point makes partials comb and beat every cycle.
- The detector (`packages/lib/dsp/src/transient-detection.ts`) emits **bare positions, no strength**.
  The runtime cannot tell a kick from a pad swell, so one constant set must serve both — impossible:
  drums want ~5 ms fades, pads want long, phase-aligned, equal-power fades.
- `VOICE_FADE_DURATION` (20 ms) triple-serves as fade length, lookahead, and drift threshold — the
  constants cannot be tuned independently.

## 2. Signalsmith Stretch — evaluated (source-level), a live contender

MIT, single C++ header, pure STFT phase vocoder. **No side data, no pre-analysis, fully streaming**:
`process(in, nIn, out, nOut)` — the stretch ratio *is* `nIn/nOut` per call; pitch is independent.
Its quality comes from amplitude-weighted complex phase prediction, two-pass horizontal→vertical
prediction, and a non-linear frequency map. Findings that matter to us:

- **Transients: none.** The word does not appear in the source. No detection, no phase reset; the
  only related mechanism is `maxCleanStretch = 2`, beyond which per-bin time factors are randomized.
  Attacks smear across the 120 ms analysis block — the author calls it "a juddery smudge" and lists
  it as his top TODO. Best at 0.75–1.5×.
- **Playback model costs in a DAW:** ~150 ms input pre-roll (`seek()`) after every discontinuity
  (jump, region start, loop wrap, clip launch); one full PV instance per playing region (FFT-heavy
  vs a few interpolated reads for granular); single-threaded engine → CPU must be measured.
- **Cannot be used in the engine as-is:** C++ does not fit our no_std custom-PIC wasm build. Engine
  use means a pure-Rust port (~1000 lines core on our own FFT).
- **Can be used in the lab as-is:** the `signalsmith-stretch` Rust FFI wrapper crate (wraps the real
  C++) works native-only — so it renders in our judge matrix from day one as a measured reference.

The two architectures are complements (Ableton ships both as Beats/Complex). Our transient
descriptors are exactly what a Rust PV port would need to beat Signalsmith on attacks (phase reset
at transients — the upgrade its author never built). **Which path leads — granular-first or
spectral-first — is an OPEN decision, made after Phase 0 with the reference scores on the table.**

## 3. Architecture (proposed)

Two new workspace members. Repo conventions throughout (edition 2021, `no_std` + alloc core with
native tests, minimal deps, homebrew DSP).

### `crates/stretch` — the DSP under test (no_std core, future engine dependency)

- **Analyzer**: PCM in → transient markers + per-segment descriptors out. Spectral-flux onset
  detection (short-hop STFT, adaptive median threshold, valley refinement) replacing the
  RMS-derivative detector. Two entry points so the storage question can stay open: `analyze()`
  (detect + describe) and `describe()` (descriptors for externally supplied / user-edited positions).
- **Stretcher**: the granular sequencer, started as a **copy** of `time_stretch.rs` and evolved —
  the control logic (drift continuation, lookahead, start-position-pop clamp) encodes hard-won
  fixes a rewrite would rediscover the hard way. Adaptive changes: equal-power fades everywhere,
  fade lengths scaled by onset strength, loop length/points chosen per segment (longer, pitch-
  aligned loops for weak/harmonic material — the user directive), all constants in one `Tuning`
  struct the harness can sweep. `Tuning::legacy()` reproduces the current engine ONCE (Phase 1
  anchor proving the copy is faithful) — never a sound-preservation goal; output diverges by design
  from Phase 4 on. No TS-audio comparison anywhere.
- **A general FFT** (radix-2, runtime power-of-two size, homebrew) — none exists in `crates/` yet
  (`dsp/analyser.rs` is fixed-1024/private); sized for onset STFT now, PV blocks later.
- Deliberately does NOT depend on `engine-env`/`abi`; slice-based I/O so the lab drives it natively
  and the engine adapter later maps `abi::Block`/`AudioBuffer` in ~20 lines.

**Descriptor sketch — illustrative draft, fields and formulas are NOT locked in; the harness
validates or kills each one:**

```
TransientDescriptor: position (s), strength [0..1], period (samples, 0 = aperiodic),
                     harmonicity [0..1], rms, precomputed loop_start/loop_end
```

Candidate algorithms (same status — drafts): strength from flux-peak-over-threshold or crest proxy;
period via YIN-lite (CMNDF); harmonicity via spectral flatness; loop points via correlation-aligned,
period-snapped search. Every constant lives in `Tuning`, tunable.

### `crates/stretch-lab` — the self-judging harness (std, native-only, never wasm/prod)

Deps: `stretch` + path crates + `audio-analyzer-rs` **as a lib** (we add a `[lib]` target to that
repo exposing the analysis modules; tokio/rmcp stay bin-only) + `signalsmith-stretch` FFI wrapper.
Neither reaches any wasm artifact — wasm builds are per-package; they only appear in `Cargo.lock`.
Homebrew WAV codec, Goertzel, TSV/JSON writers.

- **Corpus**: synthetic probes generated from recipes (sines, sweep, click train, detuned-partial
  padchord, noise bursts) + the real samples in `test-files/samples/` (drums: AttackHitLoop 175,
  Techno Top 128; pads: derelict 125, borealis 85, alien-sine-drone 135; tonal-with-attacks: guitar
  chords, dub chords 125; + TKNVLT). Hand-checked onset ground truth (`.onsets.txt`) committed per
  fixture. Matrix: every entry × ratios {0.5, 0.75, 1.25, 1.5, 2.0, 4.0} × play modes. Skipped
  cells are printed, never silent. Welcome later: a dry vocal phrase, a full-mix excerpt.
- **What "good" is judged against — never merely "better than the old engine":**
  1. *Synthetic probes → literal perfect reference*: the ideal stretched output is generated from
     the same recipe on the stretched timeline (a sine 2× = the same sine, twice as long). Metrics
     measure distance to that rendered ideal.
  2. *Real material → per-property ideals*: every metric has a mathematically perfect value (attack
     ratios = 1.0, spectral/level delta = 0 dB, loop-rate modulation = −∞, duration error = 0).
     Reports show **baseline / current / ideal** — improvement AND remaining headroom.
  3. *Reference engines*: Signalsmith in the matrix (live column); optional Ableton Beats-mode
     exports of the fixtures in `reference/` → measured "realistically excellent" targets.
- **Metrics** (self-contained, deterministic, CI-gating; drafts to be calibrated by self-tests):
  duration/tail, attack rise + crest ratio vs source (onsets from ground truth mapped by the ratio,
  never from a detector), pad modulation depth at the *known* loop rate (Goertzel) + envelope
  autocorrelation guard, sine sidebands/THD, spectral band delta + level delta (anti-gaming),
  detector recall/precision (advisory). **Metric self-tests come first**: injected AM must read
  back within ±1 dB, pass-through must score ideal — the judges are judged before they judge.
- **The judge loop** (`cargo run -p stretch-lab --release --bin judge`):
  - `judge baseline` — render matrix through a **frozen verbatim copy** of today's
    `time_stretch.rs`; commit `snapshots/baseline.tsv` once. The baseline must *encode the pain*
    (pad modulation bad, drum attacks good) or the metric is wrong.
  - `judge` — render through `stretch`, print delta table vs baseline/best/ideal/references,
    verdict `Improved | Mixed | Regressed`. **Improved requires a target metric to move AND every
    guard to hold simultaneously** (muffling trips spectral delta, ducking trips level, smearing
    trips rise — paired gating is the anti-gaming core).
  - `judge accept` — refuses unless Improved; updates `best.tsv` committed with the change, so
    `git log snapshots/best.tsv` is the improvement ledger.
  - `judge listen` — playlist of worst-delta source→baseline→current triples. **Human listen
    required at every phase gate**; audio-analyzer-rs metrics run in-judge as an independent
    second-opinion column set (different code, different bugs).
  - One iteration = edit `stretch` → `judge` → read deltas (Claude analyzes scores + listens via
    analyzer) → `accept` or revert. This is the system that develops itself.
- **CI**: default `cargo test` = unit + metric self-tests + fast synthetic gate (seconds). Full
  matrix with real fixtures behind `--ignored` (the existing `fast_math` perf-test pattern).

## 4. Phases and gates

| Phase | Deliverable | Gate (exit criterion) |
|---|---|---|
| 0 | Harness: lab crate, corpus, metrics + self-tests, frozen baseline, Signalsmith reference, `baseline.tsv` | Baseline encodes the pain (pad mod ≥ −20 dB bad, drum rise ratio ∈ [0.8, 1.2] good). **Decision: granular-first vs spectral-first, with reference scores on the table** |
| 1 | `crates/stretch` scaffold, FFT, copied sequencer, `Tuning::legacy()` | Golden-buffer parity with frozen baseline (one-time measurement anchor) |
| 2 | New detector (flux + adaptive picking) | Recall/precision ≥ TS detector on annotated fixtures; sine f0 within 1% |
| 3 | Descriptors (`analyze`/`describe`) | Synthetic sanity: sine → known period, noise → aperiodic, clicks → strength ≈ 1 |
| 4 | Adaptive playback (`Tuning::default()`) | Pad modulation improves ≥ 12 dB and ≤ −40 dB absolute; sidebands ≤ −40 dB; ALL drum/spectral/level guards hold; listening sign-off |
| 5 | Tuning loop (judge/accept iterations, analyzer cross-checks) | `best.tsv` monotonic in git history; full matrix green; listening sign-off |
| 6 | Engine integration (separate plan + approval) | `/performance` + in-studio listening. NO ts-vs-wasm audio parity for stretch content — the new playback diverges by design; retire those cases, the suite keeps guarding untouched paths |

Every threshold above is an initial value, revisable when the numbers teach us otherwise.

## 5. Open decisions (deliberately NOT locked in)

- **Granular-first vs spectral-first** — after Phase 0, with measured scores per material class.
  If spectral leads: pure-Rust Signalsmith-style PV + transient phase reset becomes the main line,
  adaptive granular stays for percussive.
- **`TransientDescriptor` exact fields/algorithms** — the sketch above is a starting hypothesis;
  each descriptor must earn its place by moving a metric.
- **Descriptor storage** — box schema (visible/editable, needs migration) vs bind-time compute
  (no schema change, auto-improves old projects). Decided at Phase 6; `analyze()`/`describe()`
  keeps both open.
- **All tuning constants** — that is what the harness is for.
- **Detector replacement rollout** — new positions will differ from the TS detector on existing
  projects; needs a position-parity check before becoming the default writer.

## 6. Amendments from external research review (2026-07-10)

A reviewed survey of the warping-engine landscape confirmed the plan's premise (no single TSM
algorithm suits all material; adaptive, mode-plural processing is the commercial norm; import-time
cached analysis matches our bind-time descriptor decision) and contributed:

- **Complex-domain spectral flux** (Bello et al. 2005) as a Phase 2 detector variant next to
  magnitude flux — strongest on soft tonal onsets (our pad case). The harness arbitrates the two.
- **Recall-weighted detector gate**: for TSM a missed onset (smeared transient) costs more than a
  spurious marker — the Phase 2 gate weighs recall over precision.
- **Spectral-tier candidates widened**: HPS-hybrid (Driedger-Müller-Ewert 2014; implicit transient
  preservation, but heaviest CPU per region and openDAW needs explicit transients regardless) and
  RTPGHI (Průša-Holighaus) join the Signalsmith-style PV + transient-reset candidate. Judge matrix
  decides, same as everything else.
- **Rubber Band CLI as an optional reference column** — GPL binds shipped code only; rendering the
  corpus through its CLI is license-clean and gives the R3 quality bar, measured.
- **Ellis DP beat tracking** (~200 lines, ISC reference in librosa) — pointer for a future
  auto-warp feature; out of scope here.

Reading order for the spectral tier: Driedger-Müller TSM review → Laroche-Dolson → Bello onset
tutorial → Ellis beat tracking → JOS TSM notes.

## 7. Risks

- Metrics gamed → paired gating + independent analyzer + mandatory listening.
- YIN octave errors pick bad loops → aperiodic fallback, correlation alignment.
- Fade/lookahead/drift coupling → split into named constants + boundary-timing regression test.
- Dense weak transients can't host long fades/loops → segment caps; corpus needs a dense case.
- Signalsmith FFI wrapper quality/behavior differences from upstream → verify against its WASM demo
  output on one case before trusting the reference column.
- Bind-time analysis cost (later, engine) → measure; keep off the render path.
