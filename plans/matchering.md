# Matchering: reference mastering

Masters the project to sound like a reference track, based on [Matchering](https://github.com/sergree/matchering)
by Sergree (GPL-3.0). It lives on the output channel strip: a "Mastering" button in the empty sends row opens a
device-like panel next to the output strip in the mixer. There you upload the reference, analyse the project mixdown
and make final touch changes. The result is stored in the project and the project always plays mastered from then
on. Not part of the SDK.

## License

1. Matchering is GPL-3.0. GPLv3 §13 permits combining it with openDAW's AGPL-3.0, the ported code stays GPL-3.0.
2. The port cannot be relicensed, so it is excluded from the commercial licence. README gets it under
   "Ported Plugins (Excluded in commercial license)", `manual/public/open-source.md` credits it.
3. Every ported file keeps the original copyright notice plus "Ported to Rust for openDAW".

## Layout

1. `crates/matchering` (GPL-3.0, `publish = false`, `cdylib`): Rust port of the DSP. Depends on `dsp` (rfft,
   biquad, convolution) and `math`. Nothing depends on it, so `engine` and `dsp` stay free of GPL code.
2. `packages/studio/matchering` (`"private": true`, GPL-3.0): ships `matchering.wasm`, a worker and a small TS API.
   lerna skips private packages, the SDK never sees it. Only `@opendaw/app-studio` depends on it.
3. The studio loads the panel with `dynamicImportWithRetry(() => import(...))` so neither the panel nor the wasm
   touch the main bundle. The runtime device is part of the regular engine (generic DSP, AGPL).

## Port scope

What to port from `matchering/`:

1. `stages.py`: the three stages (level matching, frequency matching, level correction) plus final limiting.
2. `stage_helpers/match_levels.py`: mid/side split, piece slicing (`max_piece_size` 15 s), RMS over loudest pieces,
   iterative RMS correction (`rms_correction_steps` 4).
3. `stage_helpers/match_frequencies.py`: averaged STFT magnitude of target and reference (`fft_size` 4096), ratio,
   LOWESS smoothing on a log axis (`lowess_frac` 0.0375, `lin_log_oversampling` 4), FIR from the smoothed curve,
   convolution on mid and side.
4. `limiter/hyrax.py`: not ported, the runtime uses `Maximizer`. Its Butterworth and `filtfilt` gain smoothing are
   the only users of those filters, so the analysis needs neither.
5. `dsp.py`: helpers (mid/side, normalize, amplify, clipping).
6. `checker.py`: only the validation rules (length limits, mono to stereo, clipping warnings), as Rust results with
   codes the page turns into messages.

Not ported: `loader.py`, `saver.py`, `log/`, temp folders, mp3 handling. Decoding and encoding stay in the browser
(`decodeAudioData`, the shared `AudioFormats`).

New Rust pieces with no counterpart in `dsp`:

1. LOWESS (statsmodels semantics: `frac`, `it`, `delta`), done in `crates/matchering/src/lowess.rs`.
2. Cubic interpolation (scipy `interp1d(..., "cubic")`, a not-a-knot spline with extrapolation), done in
   `crates/matchering/src/spline.rs`.
3. Resampling to the internal 44100 Hz if the input differs (or reuse `dsp/resampler.rs` if quality is close enough).

## Interface

The wasm exports plain functions over its own linear memory (no wasm-bindgen, like `stretch-wasm`):

1. `alloc_bytes` / `free_bytes`, the worker copies planar f32 in.
2. `analyse_reference` and `match_target` run the stages, `match_target` reports each stage through the imported
   `env.progress`.
3. Result: mid and side gains, smoothed mid and side curves, plus the reference analysis for the spectrum display.

The analysis is split in two steps, so a reference does not have to be an audio file:

1. `analyseReference(audio)` returns a `ReferenceProfile`: the averaged mid and side spectra and the RMS of the
   loudest pieces, everything Matchering reads from the reference. Phase 3 confirms that stages 1 and 3 need nothing
   else from the reference audio.
2. `match(target, profile)` returns the result above.

The TS API in `packages/studio/matchering` wraps both in a worker:
`Matchering.analyseReference(reference: AudioData, progress): Promise<Matchering.ReferenceProfile>` and
`Matchering.match(target: AudioData, profile: Matchering.ReferenceProfile, progress): Promise<Matchering.Result>`.

## Reference profiles

1. Built-in profiles ship with the package (e.g. Balanced, Warm, Bright, Punchy), a few KB each. The default profile
   is selected, so Analyse works without any file.
2. "From Audio File" analyses a file into a profile, the audio is never stored.
3. A profile from a file can be saved as a user profile and reused in other projects (stored like presets, travels
   with the cloud backup).
4. The reference section has the profile dropdown (built-in, then user profiles) and a folder button that opens a
   file picker for "From Audio File". Dropping an audio file on the reference section does the same.
5. The project stores the profile used (name plus data), so it reopens without the profile library.
6. Open: where the built-in profiles come from. They must be generated from audio we are allowed to use (tracks
   made with openDAW, commissioned or licensed material).

## Mixer integration

1. The output strip has no sends, its sends row (`AuxSendGroup` in `ChannelStrip.tsx`) shows a "Mastering" button
   instead. It shows the state: off, analysed, bypassed.
2. Clicking it opens the mastering panel right of the output strip in `Mixer.tsx`, styled like a device editor.
   The panel (studio code, `ui/mixer/MasteringPanel.tsx`) is a lazy chunk with the analysis package, boot only
   imports the device url (`@opendaw/studio-matchering/device-url`) to link the device.
3. The device attaches to the audio unit's own `mastering` field (27), never to the effect chain. The engine
   appends it after the chain only if its plugin is linked, so an SDK engine plays the project unmastered.
4. Compare is a local value the device observes at key 15 (no box field) and the panel sets through
   `EngineCommands.overrideDeviceField`, never
   written to the box, not undoable, not synced. The device plays the dry signal at the mastered loudness
   (K-weighted 3 s ratio) with the same delay.
5. Panel content, laid out like Logic's Mastering Assistant (draft in `ui/mixer/MasteringPanel.tsx`):
    1. Left: large display with the correction curve (±12 dB, 20 Hz to 20 kHz), the EQ amount as a vertical slider
       at its left edge.
    2. Right, stacked sections with headers: "Reference" (profile dropdown in one line), "Dynamics" (gain, ceiling,
       limiter on/off), "Spread" (width), "Meters" (peak, LUFS short-term and integrated, correlation).
    3. Bottom bar: section to analyse (`MixdownSection`), Analyse with per-stage progress, Compare (A/B at
       matched loudness).
6. Analyse renders the project mixdown with mastering bypassed (`OfflineEngineRenderer`, like `AutoEqAction`), runs
   the matching in the worker and writes the result into the project in one editing transaction (undoable).
7. From then on the engine applies it live (see Runtime device), the full mixdown includes it, stem export does not.
8. Meters: the device broadcasts peak, BS.1770 short-term and integrated loudness and correlation (`meters.rs`).

## Decisions

1. No standalone page, mastering exists only on the output strip.
2. The project stores the analysis only (gains, curves, reference profile), never the reference audio.
3. The device sits pre fader: after the output's audio effects, before the output volume.
4. Final touch controls: EQ amount (0 to 100 % of the match curve), gain, stereo width amount, limiter on/off with
   ceiling, bypass through the header's power switch (stored, affects export). Compare is a temporary loudness-
   matched A/B, never stored.
5. Linear phase, matching Matchering's output, delay compensation covers playback.
6. Full mixdown includes the mastering, stems do not.
7. The stored analysis stays until the user analyses again, no outdated hint, no automatic re-analysis.
8. Unlike Matchering, both curves are clamped to ±12 dB before the level correction (`CURVE_LIMIT_DB`). A narrow
   mix otherwise gets its side boosted by 40 dB and more, which sounded harsh with a wide reference.

## Tests

1. Rust tests per helper: LOWESS and the cubic spline against reference vectors generated with statsmodels and
   scipy (`crates/matchering/tests/fixtures/generate.py`).
2. Rust stage tests on fixture pairs against the original Python output, tolerance based (float FFT order differs).
3. A node test loading the built wasm and running a short pair end to end.

## Phases

1. Page mockup without functionality (done, design draft for the panel).
2. Crate skeleton + LOWESS + cubic spline with reference tests (done).
3. Analysis stages, end-to-end against Matchering 2.0.6 itself (done, `tests/stages.rs`, generated by
   `tests/fixtures/generate_stages.py`). The crate expects 44.1 kHz input, the TS side renders and decodes at that
   rate. Matchering ships no tests of its own, `LIMITER_TEST.md` is a visual limiter comparison and the limiter is
   not ported.
4. Private package, worker, TS API, build script (done). `@opendaw/studio-matchering` builds the crate into
   `dist/matchering.wasm` (turbo rebuilds it on crate changes), `Matchering.analyseReference` and
   `Matchering.matchTarget` resample to 44.1 kHz and run in a worker that exists only per job. The analysis reads
   mid and side on demand from the f32 input and keeps only the convolved mid in f64, about 170 MB for 4 minutes
   instead of about 700 MB. `test/matchering.test.ts` runs the built wasm against the Matchering fixtures.
5. Mastering box + runtime device (done). The TS engine has no device processors any more, the device is a wasm
   crate only. `MasteringDeviceBox` (schema, adapter) is shared data, `crates/device-mastering` (GPL-3.0, contains
   the Hyrax port) is built by the private package into `dist/device_mastering.wasm`, never by core-wasm.
   core-wasm gained an additive `extraDevices` option (realtime and offline) the studio uses to link it.
   Tests: Hyrax against Matchering's limiter, the FIR against Matchering's FIR, and engine renders with the
   device on the output (`packages/studio/matchering/test/mastering-device.test.ts`).
6. Mixer button + panel: reference profiles, analyse, store, final touch, A/B (implemented, not browser-checked).
   Built-in profiles are designed spectra (`crates/matchering/src/profiles.rs`) run through the reference analysis.
   Saving user profiles is not done yet.
7. License notes in README and manual.

## Runtime device

The engine part that applies the stored match live. It contains Matchering's limiter (Hyrax, made streaming with
16 attack lengths of lookahead for its backward smoothing), so it is GPL-3.0 and ships only with the studio.
The points below were written before that decision, point 2 and 3 are superseded.

1. The analysis stores the mid and side gains and the smoothed mid and side frequency curves in the project.
2. The device applies gains, mid/side FIR and `Maximizer` in place of Hyrax, whose `filtfilt` needs future samples.
3. The device contains no Matchering code, so the GPL port stays out of the engine. The stored gains and curves are
   output data, not code. The device is a generic gain, mid/side convolver and `Maximizer` chain.
4. The Convolver (`crates/dsp/src/convolution.rs`) runs two independent channels. The device encodes to mid/side,
   convolves channel 0 with the mid filter and channel 1 with the side filter, then decodes to left/right. No new
   convolver needed.
5. The match reflects the mix at analysis time, changing the mix needs a new analysis.
6. The output differs from the exported file when limited, without the limiter it should come very close.
7. Latency: the Convolver itself is zero latency (Gardner scheme), the delay comes only from the linear-phase filter
   shape, about 46 ms at 4096 taps and 44.1 kHz. Linear phase is kept to match Matchering, delay compensation covers
   playback, monitoring while recording stays delayed while mastering is active.
8. Sample rate: Matchering designs its filters at the internal 44.1 kHz, the engine often runs at 48 kHz. Storing the
   smoothed curves instead of raw taps lets the device build the filters at the engine rate, so point 6 holds at
   every rate.
