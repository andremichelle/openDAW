# Enhance the Time-Stretcher — detector-first update

Status: **planned 2026-07-15, ready for implementation**. Supersedes the *status claims* of
[`plans/stretch/README.md`](stretch/README.md) (stale: says "Phase 4 iterating"; reality below) and absorbs the
still-valid parts of [`plans/wasm-audio/time-stretch-v2.md`](wasm-audio/time-stretch-v2.md). Companion issue plans:
[`plans/issues/114-editable-transients.md`](issues/114-editable-transients.md) (in scope),
[`plans/issues/201-classic-time-stretch.md`](issues/201-classic-time-stretch.md) (OUT of scope, unchanged).

The premise (user, 2026-07-15): **the playback system cannot be better than the detected transients.** This update
is detector-first: better transient *positions* through the *existing* pipe, plus the two pitch-stretch correctness
bugs (#311, #312) and in-studio transient editing (#114). Playback DSP is deliberately untouched.

## 0. Scope and non-goals

In scope:
- **A.** Version and wire the ground-truth loop (Transient Lab app + label importer into the judge harness).
- **B.** Detector v2: onsets in **volume AND spectrum**, sparse, with bounded subdivision — judged against
  hand-corrected labels.
- **C.** Swap the production detector to the new one, **positions-only**, through the unchanged
  `TransientMarkerBox` pipe.
- **D.** Fix issues #311 (seam discontinuity) and #312 (stacked crossfade dip) in the TS engine + regression
  tests in BOTH engines.
- **E.** Issue #114: move/add/delete transient markers in the studio.
- **F.** Documentation and repo hygiene (stale plan headers, untracked files).

Non-goals (explicit, decided):
- **Signalsmith is not touched.** `crates/signalsmith`, its play-mode, engine wiring, UI — all frozen.
- **No playback DSP changes.** No adaptive `Stretcher` re-land, no fade/loop-crossfade changes in
  `time_stretch.rs`/Tape mirror. Known consequence (measured): the pad loop-splice modulation
  (`mod_band_peak_db` +10…14 dB on `pad-derelict` in `crates/stretch-lab/snapshots/baseline.tsv`) remains; it is
  the natural NEXT update, with this update's trusted labels and metrics as its foundation.
- **No descriptor plumbing.** Strength/period/harmonicity/loop points stay inside the analyzer (`stretch-wasm`
  keeps emitting the 64-byte records); production consumes only `.position`. The markers.bin/SAB architecture
  (built in `ba7265ac`, reverted in `9770d9d9`) stays in git history for a later update.
- **No box-schema change.** `TransientMarkerBox` keeps its two fields (owner, position-seconds).
- Issue #201 (classic mode) is out.

## 1. Current state (verified 2026-07-15, file:line)

### 1.1 The playback system (what transhost positions feed)
- Rust granular (shipped): `crates/engine/src/time_stretch.rs` — `VOICE_FADE_DURATION=0.020` (:27),
  `LOOP_FADE_DURATION=0.010` (:28), `LOOP_MARGIN_START/END` (:29-30). Voices: `OnceVoice` (:230), `RepeatVoice`
  (:273, **linear** loop crossfade :327-329), `PingpongVoice` (:349, equal-power :410-413). Linear `Fade` state
  machine (:145-213). Dispatch `create_voice` (:704-710).
- TS mirror (source of truth by contract): `packages/studio/core-processors/src/devices/instruments/Tape/` —
  `constants.ts` (identical values), `TimeStretchSequencer.ts`, `OnceVoice/RepeatVoice/PingpongVoice.ts`.
  Rust cites TS line numbers in doc comments; the two MUST stay in lockstep (`tracks.rs:519` "WASM CONTRACT").
- Pitch/native play-mode: TS `TapeDeviceProcessor.ts` `#processPassPitch` + `Tape/PitchVoice.ts`;
  Rust `audio_region_player.rs` `render_region` (:405-475) — stateless read head, inline `fade_gain` (:498-518).
- History that matters: the adaptive `stretch::Stretcher` WAS wired into the engine (`ba7265ac`) and REVERTED
  (`9770d9d9` "deployable known-good baseline") when the spectral pivot produced the (now shipped, separate)
  Signalsmith play-mode. `crates/engine` does not depend on `crates/stretch` today (Cargo.toml:11 lists
  `signalsmith`).

### 1.2 The detection chain (production, today)
- Algorithm: `packages/lib/dsp/src/transient-detection.ts` — mono mixdown, 3-band Linkwitz-Riley (200 Hz/2 kHz,
  order 48), 20 ms sliding RMS per band, **energy-derivative** onsets vs one global threshold
  (`ENERGY_DERIVATIVE_THRESHOLD=0.0003`), band weights 1/4/8, greedy selection (120 ms min separation, 40/s cap),
  valley refinement. Returns bare `number[]` seconds. **Blind to spectral change at constant loudness**
  (pad chord changes are invisible) — the core deficiency this update fixes.
- Worker chain: `packages/studio/core-workers/src/workers-main.ts:12` (`transients` channel) ←
  `packages/lib/dsp/src/transient-protocol.ts` (`detect(audioData): Promise<number[]>`) ←
  `packages/studio/core/src/Workers.ts:54-61` (`Workers.Transients`).
- Callers: `packages/studio/core/src/project/audio/AudioContentModifier.ts:73` (`toTimeStretch`, only when the
  file has no markers yet), `AudioConsolidation.ts:96`, `AudioFileBoxFactory.ts:23,34` (+ `applyTransients` :7-11),
  `migration/MigrateAudioFileBox.ts:30`.
- Storage: `TransientMarkerBox` (forge schema `forge-boxes/src/schema/std/TransientMarkerBox.ts:4-9`; generated
  box fields owner + `position` f32 seconds). Owned by `AudioFileBox.transientMarkers` → **shared by every region
  using that file**.
- Engine read: `crates/engine/src/audio_unit/tracks.rs` — `AUDIO_FILE_TRANSIENTS_HUB_KEY=10`,
  `TRANSIENT_POSITION_KEY=2` (:526-528); `read_transients` (:673-682) → `AudioRegion.transients: Vec<f64>` (:562),
  read only when `time_stretch.is_some()` (:587-588). Positions only; nothing else crosses.

### 1.3 The v2 assets (built, disconnected)
- `crates/stretch` (no_std): `analyzer.rs` (`analyze()` :92, `describe()` :118), `onset.rs` (magnitude spectral
  flux, log-compressed HWR, local-median adaptive threshold, valley refinement — 137 lines), `tuning.rs`
  (~19-field `Tuning`; `legacy()` :54, `adaptive()` :79; **`Default` = `legacy()`** :95), `descriptor.rs`
  (64-byte `#[repr(C)] TransientDescriptor` :13 — position/loop_start/loop_end f64, strength/period/harmonicity/
  rms/loop_score/beat_seconds/loop_rms f32), plus `stft/warp/voice/sequencer/spectral`. 13 tests.
- `crates/stretch-wasm`: standalone analyzer wasm (own memory, std build) — `alloc_bytes/free_bytes`,
  `analyze(leftPtr,rightPtr,frames,sampleRate,outPtr,max) -> count` (:26), `record_size()==64`,
  `analyzer_version()==1`, `spectral_stretch` (:63, unused here). Built by `packages/app/transient/build-wasm.sh`.
- `crates/stretch-lab` (the judge): subcommands `baseline|run|accept|listen|annotate`
  (`src/bin/judge.rs:306-314`; `accept` :228-236). Metrics: attack rise/crest/extra-peaks, mod_band_peak_db /
  mod_acf_peak (Goertzel at the known loop rate), sine sidebands/THD, spectral/level deltas, trailing silence,
  spurious, + `audio-analyzer-rs` second-opinion columns (`src/second_opinion.rs`). Corpus: 8 real fixtures
  (`src/corpus.rs:213-222`) from `test-files/samples/` + synthetic probes. **`snapshots/baseline.tsv` exists and
  encodes the pain; `snapshots/best.tsv` was NEVER committed — zero accepted iterations.** Ground truth
  `fixtures/*.onsets.txt` (8 files, 512 lines) is MACHINE-generated by `judge annotate`
  (`src/metrics/annotate.rs`), flagged "REVIEW BY EAR", `trusted_onsets: false` (`corpus.rs:273`).
- `packages/app/transient` (Transient Lab, **untracked**): audition/edit markers vs Ableton overlay.
  `src/detector.ts` (wasm ABI, allocate-first, decodes 64-byte records), `src/asd.ts`
  (`.asd` = `06 49` header, uint32 count @2, uint32 sample positions @6, monotonic-validated),
  `src/view.ts:190-210` exports `<name>.transients.json` `{file, sampleRate, numberOfFrames, analyzerVersion,
  edited, markers:[{sample, seconds, strength}]}`. Serves `test-files/samples` via symlink. Functional.
- `test-files/samples/`: 8 `.wav` (tracked) + 8 `.asd` (untracked) — exactly the lab's `SAMPLE_FILES` and the
  lab-crate `FIXTURES`.
- Known quality gap: current `analyze()` finds ~38 markers on `175_F_AttackHitLoop` vs Ableton's 244
  (`packages/app/transient/README.md:40-41`). NOTE: Ableton's 244 is a bounded [15,30] ms quasi-grid, NOT sparse
  onsets — see decision 2.2; we are NOT chasing that number.

### 1.4 Issues #311/#312 (pitch-stretch) — root causes located
- **#311** "sample-level discontinuity at touching region seams" — TS only:
  - (a) `TapeDeviceProcessor.ts:213-215` — `bpn = (bp1 - bp0) | 0` floors the SPAN; write covers
    `[bp0|0, bp0|0 + bpn)` (:261) which can end one sample short of `bp1|0` when fractional parts straddle an
    integer → the seam sample is never written. Same latent pattern in `#processPassTimestretch` (:337).
  - (b) `TapeDeviceProcessor.ts:189-194` — ended regions are only detected in the NEXT block's
    `removeByPredicate`, so `startFadeOut(0)` begins one block late at offset 0 instead of at the true end
    offset. `PitchVoice.startFadeOut(blockOffset)` (:46-53) + the `fadeOutBlockOffset` hold (:86-88) already
    support the correct call.
- **#312** "PitchVoice multiplies its 20 ms fade-in by the region clip-fade" — TS only:
  `PitchVoice.ts:99` `finalAmplitude = amplitude * fadingGainBuffer[i]` stacks the internal linear voice ramp
  with the authored linear region fade → quadratic entry, measured −1.2 dB dip at a linear crossfade midpoint.
- **The Rust engine has NEITHER bug** (verified): `sample_of` floors ENDPOINTS independently (:479-482) so
  touching regions tile exactly (`begin..end` :454); fades combine via `min` + authored-fade-replaces-declick
  (`fade_gain` :498-518, header comment :12-13). Rust behavior is the target model for the TS fix.
- Parity constraint: TS↔wasm tape parity is enforced at RMS/peak dB level (e.g.
  `packages/app/wasm/test/indahouse-ts-vs-wasm.test.ts` `TOLERANCE_DB=0.1`), NOT sample-exact — fixing TS toward
  Rust behavior tightens parity. **No test in either engine currently asserts seam continuity or crossfade
  unity** — this update adds both.

## 2. Decisions (user, 2026-07-15)

1. **Positions-only first.** No descriptors leave the analyzer; no schema, cache, or SAB work. The existing
   `TransientMarkerBox` pipe is the integration surface. Rationale: most of the audible win at a fraction of the
   risk; the descriptor architecture stays recoverable from git history.
2. **Sparse true onsets; the Ableton quasi-grid target is DROPPED — and the `.asd` artifacts removed.** Markers
   must mean "a new event starts here" — no populating sustained material with near-nothing transients. The
   reverse-engineered format knowledge is preserved in notes; the files and the lab's `.asd` parser/overlay go.
3. **Onsets in volume AND spectrum.** The detector must fire on energy rises AND on spectral change at constant
   loudness (pad chord changes). This is the production detector's core deficiency.
4. **"A few more" markers only when segments get too long**: bounded subdivision at energy valleys above a
   generous max-segment cap (tunable, judged by ear) — not a grid.
5. **No playback DSP changes this update** — not even the equal-power loop-fade fix. Documented as the follow-up
   with its baseline number (see non-goals).
6. **#114 in scope; #201 out.**
7. **Signalsmith untouched.**

## 3. Workstream A — version + wire the ground-truth loop

The judge is only as good as its labels, and today's labels are machine-generated and untrusted. Fix that first.

1. **Commit `packages/app/transient/`** (the lab) — remove its compiled `public/stretch_wasm.wasm` from the
   commit (gitignore it; it's a build artifact of `npm run wasm -w @opendaw/transient`). Verify the
   `public/samples` symlink survives git (or replace with a vite `resolve`/server alias if symlinks are a
   problem on CI).
   **Delete the 8 `test-files/samples/*.asd` files and strip the lab's Ableton layer before committing**: remove
   `src/asd.ts` and the orange-overlay wiring (`main.ts` load + `view.ts` render). They served their purpose —
   the format is decoded and documented, Ableton is no longer the target, the judge never read them, and
   proprietary-derived artifacts don't belong in a public repo. **Repurpose the second overlay layer** to render
   a loaded `.transients.json` as a comparison set — this is what the §11 old-vs-new detector A/B listening
   check uses.
2. **Label importer**: extend `stretch-lab` (`src/corpus.rs` / a new `judge import` subcommand) to read the lab's
   `<name>.transients.json` exports and write `fixtures/<id>.onsets.txt` with a `trusted: true` header
   (`corpus.rs:263-273` currently keys trust on the annotate header). Positions in seconds; keep the existing
   file format so nothing else changes.
3. **Labeling pass (user, by ear)**: for each of the 8 fixtures — audition slices in the lab, correct
   (drag/add/delete), Export JSON, `judge import`. This is the one step only the user can do; the plan's detector
   gate is meaningless without it. Estimated effort: ~15-30 min per fixture.
4. **Recall/precision on trusted labels**: `stretch-lab` already computes detector recall/precision (advisory).
   Promote it to a gated metric once labels are trusted, **recall-weighted** (a missed onset smears a transient —
   worse than a spurious marker; per the 2026-07-10 research amendment in `plans/stretch/README.md` §7).

## 4. Workstream B — detector v2 (volume + spectrum)

All in `crates/stretch` (`onset.rs`, `analyzer.rs`, `tuning.rs`); iterated through the lab + judge, NOT in the
engine. Current `onset.rs` is magnitude-flux only, mono, 137 lines — the base is sound, the upgrades:

1. **Complex-domain onset function** (Bello et al. 2005) alongside magnitude flux: predicted-vs-actual complex
   spectrum deviation catches spectral change at constant energy (THE pad-chord case) and energy rises in one
   function. Implement as a second flux vector from the same STFT (`stft.rs` already streams frames);
   fuse: `flux_fused = a·flux_mag_norm + b·flux_complex_norm` (weights in `Tuning`, judge-swept), or pick per
   candidate whichever exceeds its own adaptive threshold (union with dedup). Start with the union — it directly
   encodes "volume OR spectrum onset".
2. **Multi-band energy confirmation (optional, judged)**: the production detector's 3-band energy weighting has
   one virtue — band-weighted salience. If the fused flux under-performs on the drum fixtures, add per-band flux
   (low/mid/high from the same STFT bins, weights in `Tuning`) rather than resurrecting the RMS-derivative path.
3. **Adaptive picking density**: the ~38-marker sparsity on the attack loop is a threshold/median-window problem.
   Sweep `median_window_seconds`, `absolute_floor_fraction`, `log_gamma`, min-separation via the judge against
   the trusted labels (recall-weighted). Add a `Tuning` field for min separation (currently const).
4. **Max-segment subdivision** ("a few more, if too less"): after picking, any inter-onset gap >
   `max_segment_seconds` (Tuning; start ~0.4 s) is subdivided at the most valley-like points
   (reuse `refine_to_valley`'s short-RMS scan over the gap) until every segment ≤ cap. Subdivision markers are
   flagged internally (analyzer-only; positions look identical downstream). Ground truth does NOT include them —
   they are judged by playback metrics + ear, not recall.
5. **Stereo**: `analyze()` takes L/R but onset detection runs on a mono mix — verify sum vs max-of-channels on
   the stereo fixtures; keep whichever the judge prefers.
6. **Gates (all on trusted labels)**:
   - Recall ≥ 0.9 / precision ≥ 0.75 on drum fixtures (drums-attack, drums-top); recall-weighted F on all 8.
   - Pad fixtures: every audible chord change in `dub-chords`, `guitar-chords`, `pad-derelict` yields an onset
     within ±30 ms (these become label entries during the labeling pass).
   - Sine/click synthetic probes keep passing `tests/analyzer.rs`.
   - Listening sign-off in the lab (slice audition = does each slice start at an attack and contain one event?).

## 5. Workstream C — production swap (positions-only)

Replace WHAT computes positions; change NOTHING about where they go.

1. **Detector host**: the core worker loads `stretch_wasm.wasm` and runs `analyze()`; only positions are kept.
   - Build: add a build step that compiles `stretch-wasm` and ships it with `@opendaw/studio-core-workers`
     assets (mirror how other wasm artifacts reach `dist/`; the transient app's `build-wasm.sh` shows the cargo
     invocation).
   - `packages/studio/core-workers/src/workers-main.ts:12`: swap `TransientDetector.detect(audioData)` for the
     wasm call (port `packages/app/transient/src/detector.ts`'s allocate-first ABI — it is exactly this code;
     move it into a shared lib (`lib-dsp` or a small `core-workers` module) so lab and worker share one binding).
   - `TransientProtocol.detect` keeps returning `number[]` seconds — zero changes downstream of the worker.
2. **Keep `transient-detection.ts`** in `lib-dsp` for now (other SDK consumers may use it); mark deprecated in
   its header. Delete in a later major once the SDK story is settled.
3. **Existing projects are safe by construction**: markers are only computed when a file has none
   (`AudioContentModifier.ts:65-94` checks first; `AudioFileBoxFactory.applyTransients` likewise). No migration,
   no position-parity concern. Add a "Re-detect transients" studio action only if #114's UX wants it (optional).
4. **Fallback**: if wasm fails to load in the worker (CSP, packaging), fall back to `TransientDetector.detect`
   with a console warning — temporary safety net, removed once proven in production.
5. **Tests**: worker-level test comparing wasm-detector positions on a fixture against a committed snapshot
   (guards ABI/regressions); an integration test that `toTimeStretch` on a fresh file creates sorted, deduped,
   ≥2 markers.

## 6. Workstream D — pitch-stretch correctness (#311, #312)

TS-engine fixes toward the (already correct) Rust model. Exact sites:

1. **#311(a)** `TapeDeviceProcessor.ts:213-215, 261`: make the write cover `[bp0|0, bp1|0)` — compute
   `bpn = (bp1|0) - (bp0|0)` (endpoint flooring, exactly the Rust `sample_of` model, `audio_region_player.rs:479`)
   instead of flooring the span. Keep `#fadingGainBuffer` fill length (:255/:257) consistent with the new `bpn`.
   Apply the same endpoint fix to the duplicated pattern in `#processPassTimestretch` (:337).
2. **#311(b)** in `#processPassPitch`: when the cycle is the region's final cycle (region end inside this block),
   call `voice.startFadeOut(bp1 - blockStart)` so the fade starts at the true end offset in the SAME block; the
   block-tail `removeByPredicate` (:189-194) remains as the catch-all for regions that vanish (deleted/muted).
3. **#312** `PitchVoice.ts:99`: suppress the internal voice fade-in when the region clip-fade already covers the
   voice's entry (i.e. `fadingGainBuffer` is ramping over the fade window) — mirroring Rust's
   authored-fade-replaces-declick rule (`fade_gain` :498-517). Keep the internal fade for entries with NO
   authored fade (it is the anti-click). Do not switch to equal-power here — the authored crossfade's shape is
   the user's linear intent; the bug is the stacking.
4. **Tests** (new, both engines):
   - TS (`core-processors` or wasm-app integration): two touching regions, 440 Hz sine — assert max sample-delta
     across the seam ≈ clean-signal baseline (the #311 repro); two regions with a 40 ms authored linear
     crossfade — assert summed level ≥ −0.1 dB through the overlap (the #312 repro).
   - Rust: equivalent assertions added to `audio_region_player.rs` tests (it should already pass — these are
     regression guards; `region_end_declicks_to_avoid_a_seam_click` :628-642 is the template).
   - Run the `*-ts-vs-wasm.test.ts` parity suite after — the TS fix should tighten, never widen, the dB deltas.

## 7. Workstream E — #114 editable transients (studio)

Follow `plans/issues/114-editable-transients.md` (which builds on the in-repo design doc
`packages/app/studio/src/ui/timeline/editors/audio/transient-editing.md`), mirroring `WarpMarkerEditing.ts`:

1. Add `Selectable` members to `TransientMarkerBoxAdapter` (mirror `WarpMarkerBoxAdapter`).
2. New `TransientMarkerEditing.ts`: FilteredSelection, drag-move (clamp between neighbors ± 50 ms, seconds-domain
   — NOT the ppqn constant from warp markers), double-click add/delete, right-click menu, Delete key,
   `project.editing.modify/mark` undo grouping. Wire into `TransientMarkerEditor.tsx`.
3. Decisions to make during implementation (flagged in the issue plan):
   - Coordinate conversion: keep `TransientMarkerUtils.secondsToUnits` (warp-based) — consistent with rendering.
   - Shared ownership: markers live on `AudioFileBox` → editing affects every region using the file. Surface via
     tooltip/hint; per-region overrides are OUT of scope.
4. **Engine already follows live edits**: `tracks.rs` subscribes region + play-mode + markers (the Signalsmith
   session generalized this — verify transient-marker boxes are covered by the same subscription pattern as warp
   markers; if not, extend `build_audio_region` the same way).
5. Tests: adapter-level (add/move/delete updates the sorted engine set), plus a manual studio checklist.

## 8. Workstream F — docs + hygiene

1. Update `plans/stretch/README.md` header: status → "superseded by plans/enhance-stretcher.md; granular
   integration was reverted (9770d9d9); Signalsmith shipped separately."
2. Add a pointer in `plans/wasm-audio/time-stretch-v2.md` → this plan.
3. Commit the lab (Workstream A) and gitignore its build artifacts.
4. `crates/stretch-lab/.venv` and `calibration/` — leave untracked; add to the lab crate's gitignore if noisy.

## 9. Execution order

Workstreams D and E are independent of A→B→C and can be done first or in parallel (D is the smallest,
highest-certainty win; do it first to bank it).

1. **D** — #311/#312 fixes + both-engine seam/crossfade tests. Gate: new tests green, parity suite deltas ≤ prior.
2. **A** — commit lab, importer, THEN the user's labeling pass (the only human-gated step; everything after
   depends on it).
3. **B** — detector v2 iterations through the judge until the §4.6 gates pass. (This is the credit-heavy loop:
   each iteration = edit `onset.rs`/`tuning.rs` → `cargo test -p stretch` → `judge run` → read deltas → lab
   listen.)
4. **C** — production swap behind the unchanged protocol; worker + integration tests.
5. **E** — #114 editing UI (can interleave with B/C; only depends on nothing else touching the same files).
6. **F** — docs, final cleanup, update this plan's status header.

## 10. Verification matrix

| change | proof |
|---|---|
| #311 fix | TS seam test: max seam-band sample-delta ≈ baseline; Rust regression twin |
| #312 fix | TS crossfade test: linear crossfade sums ≥ −0.1 dB; Rust regression twin |
| parity after D | `packages/app/wasm/test/*-ts-vs-wasm.test.ts` deltas ≤ before |
| trusted labels | `fixtures/*.onsets.txt` headers `trusted: true`, imported from lab exports |
| detector v2 | judge recall/precision gates (§4.6) on trusted labels; `cargo test -p stretch` |
| chord-change detection | pad/chord fixtures: onset within ±30 ms of each labeled chord change |
| subdivision | no segment > cap on all fixtures; listening: no added artifacts on sustains |
| production swap | worker snapshot test; `toTimeStretch` integration test; wasm-app suite green |
| existing projects | unchanged (markers only computed when absent — verified by code path, no migration) |
| #114 | adapter tests + manual checklist; engine follows live marker edits |
| Signalsmith untouched | `git diff` clean on `crates/signalsmith*` + its studio/UI files |

## 11. Risks

- **Labeling bottleneck**: everything after A waits on ears. Mitigation: fixtures are short; import tooling
  first so labeling is one sitting.
- **Detector regressions on drums while chasing pads**: recall-weighted gates on drum fixtures are hard gates;
  the judge's paired gating (attack metrics must hold) is the guard.
- **wasm-in-worker packaging** (CSP/asset path): the transient app proves the instantiation path; the fallback
  (§5.4) covers production surprises.
- **#311 rounding ripple**: `bpn` feeds buffer fills and voice writes — an inconsistent fix trades a gap for an
  overlap. The seam test asserts BOTH no-gap and no-double-write (level, not just continuity).
- **#114 shared ownership surprise**: users editing one region change all regions on the file — explicit hint
  text; revisit per-region overrides only if users complain.
- **Denser/better markers change how NEW time-stretch regions sound** vs old detector output: intended, but
  listen before shipping (lab A/B: old detector positions vs new on the same fixture).

## 12. Open items

- `judge import` naming/UX — trivial, implementer's choice.
- Whether #114 wants a "Re-detect transients" action (§5.3) — decide during E.

## 13. Notes for the implementing session

- **Do not touch** `crates/signalsmith*`, the Signalsmith play-mode wiring, or `StretchSelector`/Signalsmith UI.
- TS↔Rust granular parity contract: any change to `time_stretch.rs` requires the Tape mirror change — this plan
  makes NONE; if you find yourself editing those files outside Workstream D's listed sites, stop.
- Rust tests: `cargo test -p stretch -p stretch-lab -p engine` from `crates/`; wasm suite:
  `npx vitest run --config vitest.config.ts` in `packages/app/wasm` (full parity run ~3.5 min; the freeze tests
  dominate).
- The judge: `cargo run -p stretch-lab --release --bin judge -- run` (baseline already committed; `accept` writes
  `snapshots/best.tsv` — commit it with the change it blesses, per the ledger convention).
- Commit style: small, per-workstream commits to `dev` (no branches — repo convention).
- The lab: `npm run wasm -w @opendaw/transient && npm run dev -w @opendaw/transient` (https://localhost:8082).
