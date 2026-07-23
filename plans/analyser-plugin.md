# Analyser Plugin

A comprehensive metering and analysis audio-effect for mixing and mastering. It is an insert that
passes audio through untouched and observes the signal, presenting a configurable dashboard of
spectrum, level, loudness, phase and time-domain views.

The reference device throughout is **Revamp** (`device-revamp`): an audio-effect that already
broadcasts an FFT spectrum gated on UI subscription, so it exercises every subsystem this device
needs. Copy its shape.

## Delivery A: Mixer analysis panel (first)

Ship the analysis views first as a collapsible panel docked to the right edge of the Mixer, rather
than as a device. It analyses the currently selected channel strip (the edited audio unit), with an
option to pin a specific unit or the Master. This avoids the whole device registration and lets the
views mature against real signals quickly. The device plugin (Delivery B, below) reuses the same
renderers and DSP later.

Telemetry source: the engine already registers a per-strip meter (`wiring.rs` registers
`strip_meter` under the unit uuid, which is how `DevicePeakMeter` works). Extend the audio-unit strip
(`engine-env`) to also broadcast the spectrum / loudness / stereo / scope channels, keyed by the unit
uuid plus a sub-address, each gated by `broadcast_active` so a channel only runs while its card is
visible. The UI subscribes for whichever unit is selected. No new box, schema, or device crate.

Docking and state: a right region inside the Mixer view (strips | resizer | analysis). Default
closed, shown as a thin vertical rail with an "Analysis" tab; clicking opens it. Left-edge drag
resizes it (reuse `workspace/PanelResizer`). Open/closed and width persist. The card grid is
responsive; only visible/expanded cards subscribe, so engine cost scales with what is on screen.

### Layout: collapsed (default)

```
┌ Mixer ────────────────────────────────────────────────────────────┬───┐
│ ┌───┬───┬───┬───┬───┬───┐                                          │ ▏ │
│ │Kik│Snr│Bas│Syn│Pad│Mst│  » scroll                                │ A │
│ │▓ ▓│▓ ▓│▓ ▓│▓ ▓│▓ ▓│▓ ▓│                                          │ n │
│ │▓ ▓│▓ ▓│▓ ▓│▓ ▓│▓ ▓│▓ ▓│                                          │ a │
│ │▁ ▁│▁ ▁│▁ ▁│▁ ▁│▁ ▁│▁ ▁│                                          │ ◀ │
│ └───┴───┴───┴───┴───┴───┘                                          │   │
└────────────────────────────────────────────────────────────────────┴───┘
                                     click the ◀ rail to open the panel ┘
```

### Layout: open, wide (two-column card grid)

Spectrum spans the full width at the top; the remaining cards auto-flow into as many columns as fit.
`⇔` is the resizer between the strips and the panel.

```
┌ Mixer ─────────────────────────┬ Analysis · source [Master ▾]        [⚙][▶ close] │
│ strips …        [◀ scroll ▶] ⇔ │ ┌ Spectrum  [Line▾][Log][slope 4.5][FFT 4096▾][Hold][Avg][⚙] ┐ │
│                                │ │ 0dB                              ⌖ 1.20kHz  -18.3dB  (D6)   │ │
│                                │ │-30   ╱╲    ╱╲                                               │ │
│                                │ │-60╱╲╱  ╲╱╲╱  ╲___                                           │ │
│                                │ │-100                ╲____                                    │ │
│                                │ │  20   50  100  200 500  1k   2k   5k  10k  20k              │ │
│                                │ └────────────────────────────────────────────────────────────┘ │
│                                │ ┌ Level [dBFS▾][TP][Hold]┐┌ Phase ───────────┐┌ Gonio [L/R▾] ┐ │
│                                │ │ L R   0┐                ││ -1 ◄────●───► +1  ││     · ✦ ·     │ │
│                                │ │ ▓ ▓  -6┤ clip ● ●       ││    corr  +0.62    ││   · ✦✦✦ ·    │ │
│                                │ │ ▓ ▓ -18┤◀ K-ref         ││ width ▓▓▓▓▓░      ││     · ✦ ·     │ │
│                                │ │ █ █ -60┘ -3.1/-2.8      ││ L ▓▓▓|▓▓ R  M▓ S▓ ││              │ │
│                                │ └────────────────────────┘└──────────────────┘└──────────────┘ │
│                                │ ┌ Loudness R128 [reset]  ┐┌ Scope [Trig↗][10ms▾][L▾] ┐┌ VU  L / R ─┐ │
│                                │ │ M -14.2  S -13.8        ││   ╱╲    ╱╲    ╱╲          ││  ╲|╱   ╲|╱  │ │
│                                │ │ I -15.1 LUFS  LRA 6.2   ││──╱──╲──╱──╲──╱──╲──       ││  (●)L  (●)R │ │
│                                │ │ TP -1.0  ▁▃▅▆█▆▅▃▂▃▄    ││ ╱    ╲╱    ╲╱    ╲        ││ ref -18dBFS │ │
│                                │ └─────────────────────────┘└──────────────────────────┘└─────────────┘ │
└────────────────────────────────┴──────────────────────────────────────────────────────────────────┘
```

### Layout: medium (single column, vertical scroll)

```
┌ Analysis · [Master ▾] ─── [⚙][▶] ┐
│ ┌ Spectrum [Line▾][Log][⚙] ─────┐ │
│ │ …trace…                        │ │
│ └────────────────────────────────┘ │
│ ┌ Level [dBFS▾][TP] ────────────┐ │
│ │ …bars…                         │ │
│ └────────────────────────────────┘ │
│ ┌ Loudness R128 [reset] ────────┐ │
│ └────────────────────────────────┘ │
│ ┌ Phase / Gonio ────────────────┐ │
│ └────────────────────────────────┘ │
│ ┌ Scope [Trig↗][10ms▾] ─────────┐ │
│ └────────────────────────────────┘ │   ↕ scroll
└─────────────────────────────────────┘
```

### Layout: narrow (accordion, one card open, compact readouts on the rest)

```
┌ Analysis [Master▾]  [⚙][▶] ┐
│ ▾ Spectrum    [Line▾][Log]  │
│   …trace…                   │
│ ▸ Level      -3.1/-2.8 ▓▓▓░ │
│ ▸ Loudness   I -15.1 LUFS   │
│ ▸ Phase      corr +0.62     │
│ ▸ Gonio                     │
│ ▸ Scope                     │
└─────────────────────────────┘
```

### Per-view controls

- Spectrum: renderer (Line / Filled / Bars / Spectrogram), Log / Lin axis, slope (0 / 3 / 4.5 / 6
  dB/oct), FFT size, window, peak-hold, average. Gear: colormap, dB range, note grid, sidechain A/B
  overlay. Hover marker reads frequency, dB, nearest note.
- Level: scale (dBFS / K-12 / K-14 / K-20), true-peak toggle, peak-hold, clip reset.
- VU: reference point (-18 / -20 / custom dBFS), L/R or mono.
- Loudness: reset integrated, gating toggle, target line.
- Phase: correlation, width, balance, mid / side (mostly display; optional integration time).
- Gonio: L/R vs M/S orientation, persistence / fade, zoom.
- Scope: trigger toggle, timebase, source (L / R / M / S).

### Responsive rules

- The card grid uses an auto-fit wrap (each card a min width, roughly 240 px). Spectrum always spans
  the full width at the top; the rest flow into 1..N columns by available width.
- Below a threshold the grid becomes an accordion: one card expanded, the others collapsed to a
  header with a compact numeric readout.
- The panel resizes from its left edge and collapses to the rail. Width and open state persist.
- Card visibility drives subscription: a collapsed or hidden card unsubscribes, so the engine stops
  that channel's DSP. This is the same `broadcast_active` gating used everywhere.

Delivery B below is the same views packaged as an insert device (per-insert analysis anywhere on a
chain, and preset/automatable config). Everything under "Reuse", "New DSP" and the renderers is
shared between A and B.

## Delivery B: Analyser insert device (later)

Same views packaged as an audio-effect insert, for per-point analysis anywhere on a chain plus
preset and (where useful) automatable config. The telemetry channels, DSP and renderers below are
shared with Delivery A; only the producer differs (a device crate here, the audio-unit strip there)
and the registration glue is device-only.

- Audio-effect device, `accepts: "audio"`, passthrough (output = input).
- Multiple independent telemetry channels, each on its own broadcast sub-address, each gated by
  `broadcast_active` so a channel's DSP only runs while its panel is visible and subscribed.
- A configurable multi-panel editor. Each panel subscribes to one channel; hidden panels cost zero
  engine DSP. Panel selection and per-panel settings persist in the box.

## What it shows

### Spectrum (FFT)
One panel, several renderers selectable at runtime:
- Line / curve (the classic analyser trace, with grid + reference level + marker readout).
- Filled area (gradient under the curve).
- Bars at fractional-octave resolution (1/1, 1/3, 1/6, 1/12, 1/24).
- Spectrogram / waterfall (time on x, frequency on y, colour = dB, selectable colormap + dB legend).
- 3D waterfall (later, optional).

Spectrum controls:
- Frequency axis: log (default, `LogScale`) or linear (`LinearScale`).
- Amplitude: dB range (default about -100..0), and a slope / tilt (0, 3, 4.5, 6 dB/oct) to
  compensate the natural pink spectrum of music.
- Ballistics: peak-hold with decay, infinite hold, and running average over N frames.
- FFT size and window selectable (see "New DSP" for the size question).
- Cursor readout: hover shows frequency, dB, and nearest musical note (mirrors the Agilent-style
  marker in the reference image).
- A/B overlay: compare the main input against a sidechain input (frequency-collision view). Uses
  `bind_sidechain` / `resolve_input`.

### Level meters
- Digital peak (dBFS) with peak-hold and a clip indicator.
- RMS (window configurable).
- True peak (dBTP): the reconstructed inter-sample peak, found by 4x signal interpolation then
  peak detection (see "New DSP").
- Analog VU needles in stereo: separate L and R needles side by side (two `VUMeterDesign.Default`
  instances, as `VUMeterPanel` already does), each with a calibratable reference point
  (0 VU = -18 or -20 dBFS) and 300 ms integration. A mono/link option folds them to one needle.
- PPM ballistics (BBC / EBU / DIN).
- K-system scales (K-12 / K-14 / K-20): the same peak+RMS data drawn against a shifted 0 reference.

The meter panel is one widget with a scale selector (dBFS / K-12 / K-14 / K-20 / VU); the VU needle
is its own sub-view because it renders differently.

### Loudness (EBU R128 / ITU-R BS.1770)
- Momentary (400 ms), short-term (3 s), integrated (gated).
- Loudness range (LRA).
- Crest factor / PLR (peak-to-loudness ratio) / PSR.
- Numeric readouts plus a scrolling loudness-history timeline.

### Phase and stereo
- Goniometer / vectorscope (Lissajous), oriented for L/R or M/S, with a fading dot cloud.
- Phase-correlation meter (-1..+1) with mono / stereo / out-of-phase zones and a mono-compat warning.
- Stereo width and balance meters.
- Mid / Side level meters.
- Optional: per-frequency correlation view (correlation spectrum), later.

### Time domain and extras
- Oscilloscope (waveform), optionally zero-cross triggered, adjustable timebase.
- Level / sample histogram (amplitude distribution).
- DC-offset readout.
- Numeric stat panel: peak, RMS, LUFS-I, crest, correlation, dynamic range.

### Measurement tier (later, test-signal oriented)
THD+N, IMD, crosstalk, frequency response, noise floor. These are meaningful mostly with a test
signal (sweep / noise) rather than a live mix, so they belong to a later "measurement mode" that
pairs the analyser with a generator. Listed for completeness; low priority.

## Telemetry channels (engine → UI)

Each channel is a broadcast slot bound in the Rust device via `abi::bind_broadcast(&PATH, len)` on a
distinct sub-address off the device uuid (Revamp uses `[0xFFF]` for its single spectrum; this device
uses a small map of sub-keys), gated per block:

```
if abi::broadcast_active(id) { …run this channel's DSP…; write into abi::broadcast_ptr(id) }
```

Proposed channels (all `PACKAGE_FLOAT_ARRAY` unless noted):
- `spectrum`: magnitude bins (main input).
- `spectrum-side`: magnitude bins (sidechain, for the A/B overlay), bound only when the overlay is on.
- `meters`: `[peakL, peakR, rmsL, rmsR, truePeakL, truePeakR]`.
- `loudness`: `[momentary, shortTerm, integrated, lra, crest]`.
- `stereo`: `[correlation, balance, width, midLevel, sideLevel]`.
- `scope`: a ring of interleaved L/R samples (decimated) for the oscilloscope and goniometer.

The UI subscribes with `project.liveStreamReceiver.subscribeFloats(adapter.<channel>, values => …)`,
exactly like `RevampDeviceEditor` subscribes to `adapter.spectrum`. The worklet `#syncBroadcasts`
already round-trips the subscription flag into `broadcast_active`, so gating is free.

## Reuse (already exists)

- Spectrum DSP: `crates/dsp/src/analyser.rs` `AudioAnalyser` (NUM_BINS 512, FFT 1024, Blackman,
  allocation-free, `process(l, r)` / `bins()` / `decay`). TS twin `packages/lib/dsp/src/AudioAnalyser.ts`.
- Broadcast pattern: `crates/stock-devices/device-revamp/src/lib.rs` (`bind_broadcast` in `init`,
  `broadcast_active` / `broadcast_ptr` in `process_audio`).
- Spectrum rendering: `Revamp/Renderer.ts` `plotSpectrum` and `NeuralAmp/SpectrumRenderer.ts`
  (log freq axis 20..20000, dB grid, gradient fill). Both drive `CanvasPainter` / `CanvasUnitPainter`
  with `LogScale` / `LinearScale` from `@opendaw/studio-core`.
- Peak / RMS DSP: `crates/dsp/src/meter.rs` `StereoMeter` writes `[peakL, peakR, rmsL, rmsR]`
  (linear gain, 250 ms peak decay, 100 ms RMS). UI: `DevicePeakMeter.tsx`, `PeakMeter.tsx`,
  `HorizontalPeakMeter.tsx` (they convert gain to dB via `gainToDb`).
- Analog needle: `packages/app/studio/src/ui/meter/VUMeter.tsx` (`Geometry`, `StripeBuilder`,
  marker ticks). The reference point is a marker. Ready to reuse.
- Canvas + axes: `packages/studio/core/src/ui/canvas/painter.ts` (`CanvasPainter`,
  `CanvasUnitPainter`) and `scale.ts` (`LinearScale`, `LogScale`).
- Oscilloscope starting point: `packages/app/lab/src/Oscilloscope.tsx` (zero-cross sync,
  time-domain), but it drives a Web-Audio `AnalyserNode`; port it to consume the `scope` LiveStream
  channel instead.
- dB helpers: `packages/lib/dsp/src/utils.ts` (`gainToDb`, `dbToGain`), `crates/dsp/src/biquad.rs`
  for filters, `crates/dsp/src/rms.ts` / Rust `Rms`.

## New DSP (does not exist yet)

- True peak (dBTP): upsample the signal by 4x (polyphase FIR interpolation, the ITU-R BS.1770
  minimum), then take the peak of `|x|` on the reconstructed higher-rate signal. This catches
  inter-sample peaks that sample-peak misses (the reconstructed analog waveform can exceed every
  sample value). It is signal interpolation followed by ordinary peak detection, not oversampling of
  the detector.
- LUFS: K-weighting (a shelving + high-pass biquad pair on `crates/dsp/src/biquad.rs`), mean-square
  gating for momentary / short-term / integrated, and LRA. Build on the existing `Rms`.
- PPM and VU ballistics: per-sample integration (accuracy-critical ballistics belong in the engine;
  cosmetic display smoothing can stay in the UI).
- Correlation, stereo width / balance, mid / side levels: cheap per-block running sums.
- Goniometer / scope sample ring: decimated interleaved L/R capture.
- Histogram: amplitude bin counts.
- FFT size question: the shared `AudioAnalyser` is fixed at 1024. For a real analyser we want a
  larger, selectable FFT (up to ~16384) with a window choice. Options: (a) a device-local analyser
  with a max-size fixed buffer, staying allocation-free, size chosen at init and re-init on change;
  (b) keep 1024 for v1 and defer configurable size. Recommend (a), sized to a compile-time max.

## Editor and layout

- Large device editor built on `DeviceEditor` (`populateControls` returns the dashboard,
  `populateMeter` keeps the standard channel meter).
- A configurable grid of panels. Each panel is a self-contained widget that owns a `CanvasPainter`
  and subscribes to exactly one telemetry channel, so toggling a panel off unsubscribes and the
  engine stops that channel's DSP.
- Default layout: spectrum (large) + level meters + correlation + goniometer, with loudness and
  scope available.
- Per-panel settings (renderer, scales, ballistics, colormap, reference point) live in a small
  settings affordance on each panel.

## Box schema (config, not audio params)

The device barely touches audio, so most fields are view config stored on the box (they persist and
sync, they do not automate). Candidate fields (device-specific keys start at 10):
- `visible-panels` (int bitmask), plus per-panel layout order / size.
- `spectrum-mode` (int: line / filled / bars / spectrogram), `fft-size` (int), `window` (int),
  `freq-log` (bool), `db-floor` (float), `db-ceil` (float), `slope` (float), `hold-mode` (int),
  `avg-frames` (int), `colormap` (int).
- `meter-scale` (int: dBFS / K12 / K14 / K20 / VU), `vu-reference` (float dBFS), `true-peak` (bool).
- `scope-timebase` (float), `scope-trigger` (int), `gonio-mode` (int: LR / MS).
- `overlay-sidechain` (bool).

These are plain fields via `DeviceFactory.createAudioEffect`, not `ParameterAdapterSet` parameters,
since there is nothing to automate. (If any becomes MIDI-learnable later, promote it.)

## Registration checklist (mirror Revamp / Vocoder)

1. Schema: `packages/studio/forge-boxes/src/schema/devices/audio-effects/AnalyserDeviceBox.ts` via
   `DeviceFactory.createAudioEffect("AnalyserDeviceBox", { …fields… })`.
2. Register in `packages/studio/forge-boxes/src/schema/devices/index.ts` (`DeviceDefinitions`).
3. Run forge (`forge.ts`) to regenerate `packages/studio/boxes/src/AnalyserDeviceBox.ts` (+ index /
   visitor / io) and Rust `crates/studio-boxes/src/registry.rs`. Never hand-edit generated files.
4. Effect factory: add an `Analyser` `EffectFactory` object and an `AudioNamed` entry in
   `packages/studio/core/src/EffectFactories.ts` (Revamp object at lines 357–372, map at line 572).
5. Adapter: `packages/studio/adapters/src/devices/audio-effects/AnalyserDeviceBoxAdapter.ts`
   (`implements AudioEffectDeviceAdapter`, add a `get <channel>(): Address` per telemetry channel,
   like Revamp's `get spectrum()`). Register in the `adapterFor` visitor in
   `packages/studio/adapters/src/BoxAdapters.ts` and export from `adapters/src/index.ts`.
6. Manual URL in `packages/studio/adapters/src/DeviceManualUrls.ts`.
7. Icon in `packages/studio/enums/src/IconSymbol.ts` (reuse `Charts`, or add one).
8. Editor: `packages/app/studio/src/ui/devices/audio-effects/AnalyserDeviceEditor.tsx` (+ `.sass`,
   + an `Analyser/` subfolder for per-panel renderers). Register in
   `packages/app/studio/src/ui/devices/DeviceEditorFactory.tsx` `toAudioEffectDeviceEditor`
   (mirror the Revamp case at lines 319–324, plus the three imports).
9. Rust crate: `crates/stock-devices/device-analyser/` (`Cargo.toml` + `src/lib.rs` implementing
   `abi::AudioEffect`, `kind()` = `DEVICE_KIND_AUDIO_EFFECT`, passthrough `process_audio`,
   `bind_broadcast` per channel, gate each with `broadcast_active`). The `stock-devices/*` workspace
   glob picks it up.
10. Device→wasm map: add `{url: "/wasm/plugins/device_analyser.wasm", boxType: "AnalyserDeviceBox"}`
    to `DEVICES` in `packages/studio/core-wasm/src/engine-modules.ts`.
11. Build via `packages/app/wasm/build-wasm.sh`; verify `public/wasm/plugins/device_analyser.wasm`.
12. Optional: dawproject `BuiltinDevices.ts` and a migration if the schema later changes.

## Phasing

Phase 1, scaffold end to end:
- The full registration checklist as a passthrough that broadcasts the existing 512-bin spectrum and
  `[peak, rms]` meters. Reuse Revamp's spectrum renderer and `DevicePeakMeter`. This proves schema →
  forge → adapter → factory → editor → Rust crate → wasm → telemetry with minimal new DSP.

Phase 2, spectrum:
- Renderers (line / filled / bars / spectrogram), log/linear axis, slope, peak-hold / average,
  cursor readout, configurable FFT size + window.

Phase 3, level meters:
- True peak, VU needle (reuse `VUMeter`), K-system scales, PPM ballistics, clip hold.

Phase 4, loudness:
- K-weighting + momentary / short / integrated + LRA, numeric readouts, loudness-history timeline.

Phase 5, phase and stereo:
- Correlation meter, goniometer / vectorscope, mid / side levels, width / balance.

Phase 6, time domain and extras:
- Oscilloscope (ported off the lab demo), histogram, numeric stat panel, DC offset.

Phase 7, optional:
- Sidechain A/B overlay, 3D waterfall, measurement mode (THD+N / IMD / frequency response / noise
  floor with a test-signal generator), per-frequency correlation.

The configurable panel layout and its persisted config land in Phase 1 with a couple of panels and
grow each phase.

## Performance

- Everything heavy is gated by `broadcast_active`, so cost scales with visible panels.
- Keep the Rust crate allocation-free: fixed max buffers for FFT, scope ring, histogram; size chosen
  at `init`.
- The spectrogram broadcasts the same per-block magnitude frame; the UI accumulates frames into a
  scrolling image (no extra engine cost beyond the FFT already running for the spectrum panel).

## Open decisions to confirm

- Layout model: configurable panel grid (recommended) vs a fixed dashboard vs tabs.
- FFT: device-local configurable/larger analyser (recommended) vs reuse the shared fixed 1024.
- v1 scope: which panels ship in the first usable version (recommend spectrum + level + correlation).
- Colormap set for the spectrogram.
- Ballistics home: PPM / VU integration in the engine (accuracy) vs UI (simplicity).
