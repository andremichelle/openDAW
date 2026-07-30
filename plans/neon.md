# Neon — a Casio CZ-101 phase-distortion instrument

**Status 2026-07-29**: implemented through phase 4 + a minimal editor (preset row + .syx load button).
Playable in the studio (browser-verified). First calibration round DONE against two VirtualCZ Bitwig renders
(`test-files/probe/kiteracer-brass.*`, `test-files/probe/pete.*`, notes C4/D#4/G4 at 110 BPM from
`test-files/virtualcx.dawproject`), using the offline harness (`device-neon/examples/render.rs` +
scratch `analyze.mjs`):

- Phase maps are now KNEE-parameterized (DCW moves the knee, no crossfade) — the crossfaded maps measured
  10-25dB hot in high partials. Kiteracer sustain harmonics now match within ~1dB through h5.
- Envelope rate curve refit: `full_swing = max(1ms, 8.5ms·2^((99-r)/9) − 7ms)` (rate 76 ≈ 50ms, 58 ≈ 200ms).
- DCW curve `unit^0.4`, master level 0.25 (≈ −9dBFS single line). The VirtualCZ renders sit a constant
  ~18dB lower — its own output setting, not matched deliberately.
- Double sine is NOT an octave sweep: fitted to pete (DCW 99 sustained) as a slightly fast second
  half-cycle (h2 −25dB, h3 −30dB). ONE data point — a VirtualCZ DCW sweep render would pin the curve.

Round 2 (shimmer + a03): DCA level curve = SQUARE law in amplitude (kiteracer's isolated release passes
−12dB at mid-value); with that in place ONE exponential rate curve fits all references (a piecewise
low-rate branch fitted under the wrong level curve made shimmer too long — reverted); DCO pitch-env
level scale strongly EXPONENTIAL (a03's level-33 blip bends < 0.5 st; now 96·(2^(L·12/99)−1)/(2^12−1)).
Vibrato rate/depth now derive from the HARDWARE sysex increment tables (piecewise-doubling), scaled to
the a03 render (rate 25 ≈ 2Hz, depth 20 ≈ ±60ct; the 2Hz/4Hz AM pair = the LFO sweeping the detune beat
through zero), and vibrato bends the FIRST line only (identical modulation of both lines cannot produce
the reference's beat-rate AM). Double sine's wrap step raised to 0.22·w (pete's 1/n shelf −38..−44dB
through h12). A SimpleLimiter guards the output.

**Automated calibration campaign (2026-07-29, headless)**: Bitwig is NOT needed — VirtualCZ VST3 is
hosted headless via Python/pedalboard (`scratchpad vcz.py` harness), probes defined as parameter states
(sysex is filtered by the host; VirtualCZ exposes all engine params in native CZ units). CRITICAL harness
bug found: pedalboard parses the leading digit of "1 - Saw"-style enum strings as a VALUE, shifting every
shape by one — this also fully explains the "Bitwig sounds different" mystery (VST2 and VST3 engines agree;
the early headless renders had shifted waves). Shapes must be set via raw_value = index/7.

Measured fits now in the engine (all traceable to probe renders):
- Envelope rate: full swing = 0.1967s · 2^((60−r)/6.7), min 1.5ms (16 staircase segments, 2ms@95..6.7s@25).
- DCA level: sqrt law (level-staircase, top-compressed; full-curve probe rerun still pending).
- DCW amount: LINEAR (with corrected shapes the sweep lands each raw value on its knee-family spectrum).
- Wave maps: saw knee→0.07, square→0.04, pulse→0.06 (sweeps to a flat impulse), saw-pulse→0.10;
  DOUBLE SINE rewritten: always two full cycles, equal at DCW 0 (pure octave!), second cycle squeezed as
  DCW rises → fundamental + flat −24dB shelf at 99 (matches pete exactly).
- Ring: out = line1 + line1·line2 (ring-sine probe: equal −6dB sidebands at 0.5f/1.5f over full line1).
- Vibrato: rate = 0.00183Hz · hardware-increment (measured 1.54Hz@25, 4.62@50), depth = log-interpolated
  measured points (±23ct@10, ±56@30, ±185@60, ±611@99).

Preset validation vs headless references: kiteracer within 0.6-4dB (h2-h9), pete 1-5dB, shimmer exact h2 +
noise floor, a03 evens exact / odds 3-9dB hot, superbass ≤1.5dB except h4.

**Queue ground (same day, sustained-ladder probes)**: square knee = LINEAR d = 0.5−0.47w (three ladder
points fit exactly); double sine split a = 0.5+0.475w (linear, exact); DCA level = MEASURED dB table
(−3.3 @90 … −79.3 @10, no closed form — interpolated); pitch-env scale = MEASURED piecewise table with
the hardware's region jumps (fine steps to 63, whole-tone zone 64-70, slow zone to 93, top jump at 96);
resonance k = 1+15w confirmed EXACT (peaks h7/h12/h16 at DCW 40/70/99), windows consistent; DCA key
follow = 2^(kf/9·(note−60)·0.038), DCW key follow = 1 − kf/9·max(0,note−60)·0.00833 (both measured at
kf 9 across C2/C4/C6); ALTERNATION = per-cycle confirmed (f/2 dominates the square+saw pair); noise mod
= line2 dissolves into a ≈−30dB wideband bed (current impl equivalent); vibrato delay scale ≈ raw/99·3s
confirmed. NEW SEMANTIC: sustain OFF ends the note at the envelope's end step even while held (probe
went silent) — implemented + tested. Regression tests pin it all:
`crates/stock-devices/device-neon/tests/calibration.rs` (square/dbl-sine spectra, octave-at-zero,
DCA level 50 ≈ −23.7dB, rate-60 attack ≈ 197ms).

Still open (small): pete h2 −6.8dB (dbl-sine split micro-tune), superbass h4 +11dB (ring × wave-pair
interaction), a03 h5 +8.5dB (square knee at partial DCW under kf), global-vs-per-voice LFO, vibrato
delay ramp shape, resonance window A/B, editor phases from the original plan.

**Probe pack** (`test-files/probes/`, 30 synthetic .syx + README, generator
`packages/studio/adapters/scripts/generate-cz-probes.ts`): staircase probes isolate the DCA rate curve
(3 ranges), DCA/DCW level curves, per-wave DCW morphology sweeps, vibrato rate/depth/delay ladders,
RING on pure cosines (sideband levels read the mix formula directly), noise mod, wave1+wave2
alternation semantics, key-follow ladders, pitch-env level ladder. Render each through VirtualCZ per
the README, save `<name>.wav` beside the `.syx`, and the fits become exact. Known open mismatch:
superbass (ring + wave-pair) — neither per-cycle alternation nor wave2-on-primed-line reproduces its
spectrum with any α·ab+β·a+γ·b mix; the ring-sine/alternation probes will settle it.

Outstanding: the full editor layout (line strips + 6 envelope widgets, the table below), more calibration
probes (per-wave DCW sweeps, DCA level curve, vibrato rate/depth, ring/noise), real-file encode order for
the vibrato triples (Bitwig-written dumps carry the 2nd/3rd bytes swapped vs the youngmonkey table order the
encoder uses — decode is unaffected, it reads only the first byte), committing the two reference pairs as
fixtures with an automated contour/harmonic comparison test.

## Context

A new stock instrument emulating the Casio CZ-101 (1984, phase-distortion synthesis). Working name **Neon**: every CZ waveform is a cosine read through a bent phase map. Full `.syx` single-voice import is in scope, so the community preset packs (test corpus: the "CZ101 90s Boards of Canada Pack", Drive folder with per-album subfolders afot / hi scores / mhtrtc / otv2 / r35 / twoism of single-tone `.syx` files, plus VirtualCZ `.vstpreset` twins for A/B) load directly.

## Architecture (what the CZ-101 actually is)

Two **lines** (voices-within-a-voice), each: DCO → DCW → DCA.

- **DCO** (oscillator): phase accumulator `x ∈ [0,1)` pushed through a piecewise-linear phase map `m(x)`, output `cos(2π·m(x))`. Eight base shapes: saw, square, pulse, double-sine, saw-pulse, and three **resonance** shapes (windowed hard-sync: `window(x) · cos(2π·k·x)` with saw / triangle / trapezoid windows, `k` driven by the DCW value). Each line alternates between **two** selectable waveforms on successive cycles when both are set.
- **DCW** (waveshape): the distortion amount `d ∈ [0,1]` morphs the phase map from identity (pure cosine) to the full-bent target — the CZ's "filter". Driven by its own 8-stage envelope + key follow (0–9).
- **DCA**: amplitude, its own 8-stage envelope + key follow (0–9).
- **DCO pitch envelope**: a third 8-stage envelope bends pitch.
- **8-stage envelopes**: per step a rate (0–99) and level (0–99), one step flagged *sustain* (hold until note-off), one flagged *end*. Note-off jumps to the step after sustain from the current level. Rates/levels map through hardware tables (published reverse-engineered approximations; calibrate against VirtualCZ renders).
- **Line combination**: line select 1 / 2 / 1+1' / 1+2', with detune (octave/note/fine) on the primed line, plus **ring** (line1 × line2) or **noise** modulation.
- **Vibrato**: 4 waveforms, delay, rate, depth (0–99 each).
- Performance: octave range −1/0/+1, portamento, bend range. No velocity on the hardware (import maps nothing to velocity; the DCA key-follow stays the only dynamic).
- Character: 8-voice, early-80s digital — naive (aliasing) tables at engine rate are *authentic*; no oversampling in v1.

## Editor parameter table

Counts for layout. "Env" = one custom 8-stage envelope widget (per stage rate + level, drag sustain / end markers — one component, reused 6 times).

| Section | Parameter | Control | Range / values | Automatable |
|---|---|---|---|---|
| Global | line select | radio | 1, 2, 1+1', 1+2' | yes |
| Global | modulation | radio | off, ring, noise | yes |
| Global | octave range | stepper | −1, 0, +1 | yes |
| Global | detune note | knob | −11..+11 st | yes |
| Global | detune fine | knob | −60..+60 ct | yes |
| Global | volume | knob | dB (DefaultDecibel) | yes |
| Global | glide time | knob | 0..1 | yes |
| Global | bend range | stepper | 0..12 st | yes |
| Global | solo (mono) | toggle | off/on | yes |
| Vibrato | wave | radio | 4 shapes | yes |
| Vibrato | delay | knob | 0..99 | yes |
| Vibrato | rate | knob | 0..99 | yes |
| Vibrato | depth | knob | 0..99 | yes |
| Line 1 | wave 1 | select | 8 shapes | yes |
| Line 1 | wave 2 | select | off + 8 shapes | yes |
| Line 1 | DCW key follow | knob | 0..9 | yes |
| Line 1 | DCA key follow | knob | 0..9 | yes |
| Line 1 | DCO pitch envelope | Env | 8 × (rate, level) + sustain + end | no (v1) |
| Line 1 | DCW envelope | Env | 8 × (rate, level) + sustain + end | no (v1) |
| Line 1 | DCA envelope | Env | 8 × (rate, level) + sustain + end | no (v1) |
| Line 2 | wave 1 | select | 8 shapes | yes |
| Line 2 | wave 2 | select | off + 8 shapes | yes |
| Line 2 | DCW key follow | knob | 0..9 | yes |
| Line 2 | DCA key follow | knob | 0..9 | yes |
| Line 2 | DCO pitch envelope | Env | 8 × (rate, level) + sustain + end | no (v1) |
| Line 2 | DCW envelope | Env | 8 × (rate, level) + sustain + end | no (v1) |
| Line 2 | DCA envelope | Env | 8 × (rate, level) + sustain + end | no (v1) |

**Layout totals**: 21 simple controls (9 global + 4 vibrato + 4 per line) + **6 envelope widgets**. Each envelope widget owns up to 18 values (8 rates, 8 levels, sustain index, end index), 108 envelope values total. Line 2's four selects/knobs + three envelopes can be one shared component with Line 1 (a "line strip" rendered twice).

## 1. Schema

`packages/studio/forge-boxes/src/schema/devices/instruments/NeonDeviceBox.ts` via `DeviceFactory.createInstrument("NeonDeviceBox", "notes", …)`.

- Keys 10–30: the 21 automatable params (`ParameterPointerRules`, int32 for selects/steppers, float32 for knobs; ranges per the table, volume `constraints: "decibel"`).
- Keys 40–147: envelope storage as plain fields WITHOUT pointer rules (not automatable in v1): per envelope 8 × rate (int32 0–99), 8 × level (int32 0–99), sustain index (int32 0–8, 0 = none), end index (int32 1–8). 18 fields × 6 envelopes, blocked per envelope (40.., 60.., 80.., 100.., 120.., 140..).
- Regenerate: `npm run build -w @opendaw/studio-forge-boxes` (also regens `crates/studio-boxes/src/registry.rs`).

## 2. Adapter + factory

- `packages/studio/adapters/src/devices/instruments/NeonDeviceBoxAdapter.ts`: `InstrumentDeviceBoxAdapter` like Vaporisateur's; `createParameter` mappings mirror the schema (these mappings are the WASM value contract — `feedback_param_mappings_from_adapter`). Envelope fields exposed as plain fields for the widget.
- `InstrumentFactories.Neon` (defaults = the CZ init tone: line 1 only, saw, DCW env one fast step, DCA organ-ish), icon, `BoxAdapters` + index wiring, `DeviceEditorFactory` entry.

## 3. WASM device crate

`crates/stock-devices/device-neon` (own cdylib behind `abi`, `Instrument` template like device-vaporisateur):

- `pd.rs`: phase maps for the 5 bent shapes (identity↔target interpolated by DCW amount), the 3 resonance windows (windowed sync), dual-waveform cycle alternation. Shared cosine table.
- `envelope.rs`: the 8-stage machine (advance to end, hold at sustain, note-off jumps past sustain from current level) + the rate/level hardware-table mappings (data tables in the crate, sourced from published CZ reverse-engineering, then calibrated against VirtualCZ renders of the BoC presets).
- `voice.rs`: 2 lines × (DCO+pitch-env, DCW+key-follow, DCA+key-follow), detune, ring/noise combine, vibrato LFO, glide. Fixed voice pool (16, oldest-steal), solo mode force-releases like the mono strategies.
- `lib.rs`: bind the 21 params (`bind_parameter`), observe the 108 envelope fields via `observe_field` (plain fields, catch-up + edits), `map_parameter` parity export, `state_size`, meter broadcast like other instruments.
- Register in `engine-modules.ts` `DEVICES` (`/wasm/plugins/device_neon.wasm`, `boxType: "NeonDeviceBox"`) — workspace membership puts it into `build-wasm.sh`.

## 4. Editor

- `packages/app/studio/src/ui/devices/instruments/NeonDeviceEditor.tsx` + sass; layout by the table above (user lays out).

### Editor v6 — FINAL: canonical grid + LINE TABS (2026-07-30)

The user revisited their v4 objection: each line DOES have two waveforms, so the tabbed
"everything-for-one-line" view was the right interaction model after all (the v5 both-lines-visible
rows are retired). Final form:

- LEFT (4 canonical 3.5em columns, NO section strips): r1 Lines(span 2)·Mode·Play (titled radios,
  cream titles, radio content vertically centered across the cell's lower rows, Mode icons 12px),
  r2 Octave·Detune·Glide·(spare), r3 Vibrato(shape icons 11px)·Delay·Rate·Depth — ALL vibrato
  controls on ONE line.
- RIGHT (5 columns): LINE 1/LINE 2 attached TABS — the ACTIVE tab's background is IDENTICAL to the
  body background (one continuous surface), the inactive tab has NO background — over the body showing
  the SELECTED line: Wave 1 | Wave 2 (glyphs, name beneath) | KF DCW | KF DCA | "→ Lx" copy cell, then
  the envelope (PITCH/DCW/DCA + canvas + S/E lane). NO custom css cursors anywhere on the right
  (crosshair/ew-resize/grab/pointer all removed per user), taller tab padding (5px vertical).
- Cell titles + wave names use the knob-title cream hsl(65,20%,83%) — one title color everywhere.

##### Editor v5 — CANONICAL GRID + LINE ROWS (2026-07-30, FINAL, design-agent-reviewed spec)

Rebuilt on the app's canonical control grid (`mixins.ControlLayout` cells: 3.5em tracks, 0.25em gaps)
after the user rejected v4's flex rows ("no grid, no alignment") and the L1/L2-tabs-over-Wave1/Wave2
ambiguity. Spec reviewed by a design agent before implementation (DesignSync has NO openDAW project yet
— `list_projects` empty — so the grid foundation came from the codebase mixin).

- LEFT block, 3 columns: GLOBAL strip / Line·Mod·Play radios / Octave·Detune·Glide knobs /
  VIBRATO strip (the 4 shape icons aligned to the col-3 track INSIDE the 13px strip) / Delay·Rate·Depth.
- RIGHT block, 8 columns: LINES strip / row 1 = BOTH line rows always visible — [LINE 1 header | its
  Wave 1 | its Wave 2] [LINE 2 header | Wave 1 | Wave 2] + [KF DCW | KF DCA] knobs showing the SELECTED
  line / rows 2-3 = the envelope (108px: "LINE n · PITCH DCW DCA · COPY → Lx" header, full-width canvas,
  S/E lane). Selection = tinted header+wave trio connecting to the envelope body tint. This kills the
  one-wave-per-line misread: each line visibly owns its labeled wave pair.
- GOTCHA: a strip using `grid-template-columns: subgrid` places children by source order — a stray
  filler <span> steals a column slot and pushes the next child to an implicit second row (the
  icons-below-strip bug).

##### Editor v4 — HOUSE KNOBS + section strips (2026-07-30, browser-verified, 3rd agent review round)

User: "check all devices for the best controls" — 23 of the device editors use `ControlBuilder.createKnob`
(rotary ParameterLabelKnob with the name above), only 11 use bare label cells. Neon now uses the knobs:

- LEFT column (14.5em): GLOBAL strip → radios row (Line | Mod icons | Play) → knob row
  (Octave | Detune ct | Glide) → VIBRATO strip → one row (shape icons + Delay | Rate | Depth knobs).
- RIGHT column (19em): a NOTEBOOK — LINE 1 / LINE 2 as attached TABS over a tinted, framed body that
  contains EVERYTHING they switch (wave swatches with the wave NAME beneath, key-follow knobs, and the
  envelope editor), COPY → Lx uppercase on the tab bar; the active tab connects to the body tint, so
  the switch scope is visually explicit. (Replaced the v4 detail below:) LINE strip carrying chips →
  row (Wave 1 | Wave 2 glyph swatches, equal fixed size + KF DCW | KF DCA knobs) → the tabbed envelope
  canvas (flex-fills the column so both columns bottom out together) + S/E marker lane.
- Section strips: uniform 13px tinted title strips (GLOBAL blue, VIBRATO purple, LINE green) — one
  consistent band treatment instead of the v3 per-row name bands (which read "smashed + wasted space").
- Active tab/selection state now uses the house COLOR convention (no underline); Edit chips = filled
  pills; copy tooltip states its full scope (waves + kf + all three envelopes, undoable).

##### Editor v3 — TWO MAIN COLUMNS (2026-07-30, browser-verified)

User-directed final layout: GLOBALS LEFT, LINE+ENVELOPES RIGHT (both in the Vaporisateur band language).

- LEFT (4 × 4.3em): GLOBAL band rows [Line | Mod | Play-Mode | Octave] and [Glide | Detune], then the
  VIBRATO band [shape icons | Delay | Rate | Depth] in one line.
- RIGHT (6 × 4.3em): LINE band [Edit L1/L2 | Wave 1 | Wave 2 | KF DCW | KF DCA | copy → Lx] above the
  ENVELOPE block — the yellow band is the tab strip (L-chip, PITCH/DCW/DCA, live readout) over a TALL
  canvas (~120px, was 55) and the S/E marker lane.
- DETUNE is now ONE continuous parameter in CENTS (±1200): schema field 13 float32 "detune" replaces
  detune-note/detune-fine (14 removed), engine param DETUNE (path [13], detune_ratio = 2^(cents/1200),
  param indices renumbered — bind order is the parity contract), .syx import folds note+fine into cents
  and CLAMPS at ±1200 (hardware allows ±48 st — presets detuned wider lose the excess; the offline
  calibration harness keeps the full range via detune_ratio directly, so corpus sweeps are unaffected).
- The envelope readout shows STAGE DURATION IN TIME UNITS: seconds from the measured rate law
  (0.1967·2^((60−r)/6.7) scaled by the level swing), "245 ms" / "1.32 s" formatting.

##### Editor v2 (historical) — Editor v2 — Vaporisateur section language (2026-07-30, browser-verified, two design-agent reviews)

Final structure (replaces the 3×3.5em cell grid): SECTION ROWS in the Vaporisateur editor language,
7 columns × 4.3em, each section a tinted name band with the values beneath:

1. GLOBAL (blue): Line | Mod (icon radio) | Play-Mode | Glide | Octave | Detune | Fine
2. VIBRATO (purple, ONE line): shape icon radio | Delay | Rate | Depth
3. LINE (green): Edit L1/L2 selector | Wave 1 glyph | Wave 2 glyph | KF DCW | KF DCA | copy → Lx button
4. ENVELOPE (yellow band = the tab strip): [L-chip] PITCH/DCW/DCA tabs (active underlined) + live
   stage readout, the canvas, and the MARKER LANE: stage strip 1-8 where the S (orange) and E (blue)
   pill badges are DRAGGED to their stages (S left of stage 1 = off, bare-stage click moves E);
   stages past E dim; canvas handle drag stays relative (dx=rate, dy=level, shift=fine).
   The L1/L2 selector switches waves+kf+copy+envelopes together; the chip inside the tab row always
   shows the edited line. Wave-2 "Off" renders as a dashed flat line (intentional, not broken).

Verified interactions (Chrome, precise JS-rect coordinates): E click-move, S drag, S-off drag,
relative handle drag with live readout, L1/L2 rebinding, tab switching, silent cmd+s saves.

AUTOMATION-SAFE RELOADS: `localStorage["opendaw-suppress-unload-guard"]` makes boot.ts swallow every
beforeunload prompt (capture + stopImmediatePropagation) — set in automated sessions so scripted/HMR
reloads never hang on the native dialog. Scratch project "NeonUI" holds the test setup.

Design-agent feedback DEFERRED (noted, not implemented): left display-gutter mini-graphs per section,
per-column modulation dots (the Vaporisateur ● markers), click-to-type numeric entry on envelope
stages, larger pop-out envelope view, real units on the raw-99 values (falls out of the float-parameter
migration below).

#### Editor v1 (historical)
##### Editor IMPLEMENTED (2026-07-30, browser-verified)

Final layout (narrower than the first proposal after user feedback): three 3.5em control rows —
radios (line select / modulation / play MONO-POLY), octave/detune/fine, glide/bend, vibrato
(wave radio, delay·rate pair, depth), then ONE line-controls column (wave 1, wave 2, kf pair + copy)
and ONE envelope canvas. An L1/L2 selector in the canvas tab row switches the ENTIRE line section
(wave cells, key follows, copy target AND the envelopes — Vaporisateur's oscillator-switcher
pattern with replaceChildren). The canvas tabs select PITCH / DCW / DCA.

- Wave cells render one-cycle GLYPHS of the actual engine phase-map shapes (WaveDisplay canvas,
  full-DCW formulas from pd.rs; wave 2 index 0 draws a flat "off" line); drag to change.
- Envelope canvas: 8 equal stage slots, handle x inside the slot = (99−rate)/99, y = level; dragging
  grabs the NEAREST handle and edits rate+level RELATIVE to the grab (shift = ¼ fine), no snap-to-click;
  stage axis: click = END step, shift/alt-click = SUSTAIN toggle; readout row shows the dragged stage;
  sustain = dashed orange line; handles past END dimmed.
- Both canvases (wave glyphs + envelope) use the Vaporisateur display language: DisplayPaint stroke,
  gradient fill to the zero line, inset-shadow frame instead of a solid background.
- The .syx preset loader lives in the DEVICE MENU ("Load Casio CZ .syx…"), not on the editor surface.
- Neon has its own IconSymbol.Neon (circled-N, user-supplied SVG) in IconLibrary + the factory.
- Radio groups never wrap: modulation uses ICONS (Close / new IconSymbol.Ring two-circles / new
  IconSymbol.Noise zigzag), vibrato wave uses Triangle / Sawtooth / flipped Sawtooth / Square,
  line select stays compact single-line text.
- Files: NeonDeviceEditor.tsx/.sass + NeonDeviceEditor/EnvelopeEditor.tsx/.sass + WaveDisplay.tsx/.sass.
- GOTCHA verified live: an absolutely-positioned canvas inside the automation-control wrappers needs
  its own positioned .wave-frame ANCESTOR via descendant selector — the wrappers sit between the cell
  and the frame, and a bare canvas's intrinsic 300×150 stretches fixed grid rows.

### Planned: FLOAT parameters instead of raw 0-99 steps

The 0-99 integer domain is the HARDWARE sysex domain, not a UI contract. The parameters (DCW levels,
envelope rates/levels, vibrato values, key follows) should become CONTINUOUS floats: schema float32
fields with unit ranges, the engine mapping tables interpolating (they already interpolate), and the
.syx importer quantizing INTO the float domain (raw/99). Benefits: smooth automation curves, finer
dragging, unit-true display. Migration: new float fields alongside, importer writes both, engine reads
float; the 0-99 display stays available via StringMapping for CZ authenticity.

## 5. SysEx import (`.syx`)

- `packages/studio/adapters/src/devices/instruments/Neon/CzSysex.ts`: decode the Casio single-tone dump (F0 44 00 00 7n … F7, 128 tone bytes as 256 nibbles): line select/mod bits, detune, vibrato, per line wave selects + windows, key follows, three 8-stage envelopes with sustain/end flags. Map 0–99 hardware values onto the box fields (store RAW 0–99 in the envelope fields — the DSP owns the hardware tables, so import is lossless).
- Hook like sample/soundfont drop: dropping a `.syx` on the device (or the browser import path) creates/overwrites the box fields in one transaction. Preset name from the filename.
- Round-trip test: decode → encode → byte-identical (encoder is cheap once the decoder exists and doubles as an export later).

## 6. Tests

- Crate: envelope stepping (sustain hold, end stop, note-off jump-past-sustain from current level), golden single-cycle waveform snapshots for all 8 shapes at DCW 0 / 0.5 / 1.0, resonance window continuity (no discontinuity at window edges), ring/noise combine, detune ratios, vibrato delay ramp.
- `param-mapping-parity.test.ts`: add the neon case (envelope fields listed `tsOnly`-equivalent? No — they are `observe_field`s, not parameters; only the 21 params are checked).
- SysEx: decode fixtures — 2–3 dumps from the BoC pack checked field-by-field against VirtualCZ's display of the same preset; round-trip encode. (Pack is community-shared; keep the full corpus as a LOCAL fixtures dir, commit only the few small `.syx` used by tests after checking the pack's terms.)
- Listening A/B: load the same `.syx` in Neon and VirtualCZ (the `.vstpreset` twins in the Drive folder), compare envelope timing and spectra; document accepted deviations (this is emulation-vs-emulation, not bit parity).

## Order of work

1. Schema + regen + adapter + factory (device exists, inert).
2. Crate DSP core (pd + envelope + voice) with crate tests green.
3. Engine registration + parity-test entry; audible with default tone.
4. SysEx decoder + import hook + fixtures (BoC presets loadable).
5. Editor (envelope widget last — the biggest UI piece), browser checkpoint per phase (feedback: incremental UI reviews).
6. Calibration pass against VirtualCZ renders; adjust rate/level tables.

## Open points

- Exact noise-modulation behavior needs a research note before implementing (published docs disagree; VirtualCZ as behavioral reference).
- Envelope automation (per-stage params) deliberately out of v1.
- CZ-101's 4-voice limit in dual-line mode is not emulated (fixed pool instead) — flag if authenticity matters.

## Corpus sweep (2026-07-29, headless, 33 presets: BoC pack + local references)

Automated A/B: every `.syx` decoded → rendered in VirtualCZ (pedalboard) AND `examples/render` → per-harmonic
energy diff (50ms Hann sliding power over the full 3.5s note — robust to beat phase and decay timing; audibility
gated at ref > −30dB rel the loudest harmonic). Scripts: scratchpad `sweep.py` / `offenders.py` / `ladder2.py` /
`fitsawpulse.py` / `detune-kf.py` / `vibdepth.py`.

Fixes landed from the sweep (each measured, then pinned in `tests/calibration.rs` / lib unit tests):

- Knee laws unified: saw AND sawpulse d = 0.5 − 0.478w (min 0.022, was 0.07/0.10), pulse min d 0.048.
  The sawpulse map was structurally validated per-level by COMPLEX-spectrum fits (magnitude + phase
  invariants φ_n − n·φ_1); saw/square/pulse phases confirmed against VirtualCZ.
- Vibrato depth curve: ≈1.8 cents/step linear to 30 (measured 1.78ct @1), then log to 185ct @60 / 611ct @99.
  The old (0, 8ct) anchor made depth-1 presets wobble ±9ct and wrecked narrowband measurements.
- Vibrato bends BOTH lines (beat rate stays constant — vibrato-scope probe); the old line-1-only model
  chirped the detune beat.
- DCA key follow references C2 (note 36), NOT C4: dt × 2^(kf/9 · (note−36) · 0.026). DCW key follow slope
  0.013/semitone above note 60. Key follow tracks the OCTAVE-SHIFTED pitch (note 72 ≡ note 60 @ +1 oct).
- Wave-pair alternation ORIENTATION: each panel wave has a fixed hardware orientation
  (square/pulse/dblsine opposite to saw/sawpulse/reso1-3); the wave2 cycle plays TIME-REVERSED exactly
  when the pair's orientations differ. Verified on integer + f/2 sub-grids for square+saw, saw+sawpulse,
  saw+pulse, saw+dblsine, saw+reso1/2/3, square+pulse, pulse+reso1 (all cross-consistent).
- Ring formula (line1 + line1·line2) confirmed against the octave-pair fingerprint (nulls every 4th
  C3-harmonic).

Result: worst preset 3.5dB (eydiab_pad — sub-dB component errors amplified at deep two-line interference
nulls), 30/33 presets ≤ 2.1dB, 25/33 ≤ 1.5dB audible worst-harmonic error. Solo wave ladders match ≤ 0.5dB
at every DCW level for all five bent waves and reso1.

Remaining known deltas (documented, diminishing returns): eydiab_pad-family null depths (ref −40..−70dB),
superbass 1.8dB (DCW-decay trajectory under ring), a03 family beat-phase artifacts ≤ 0.7dB.

## Probe pack + wasm regression suite (2026-07-30)

`test-files/probe/` holds all 35 `.syx` with their VirtualCZ reference renders (headless pedalboard,
mono 16-bit 48k, peak-normalized to −1dBFS, trailing silence trimmed at −85dB — several staircase probes
legitimately end early because sustain-off finishes the note). The five preset wavs are the untouched
Bitwig originals. Pack size 29MB.

`packages/app/wasm/test/neon-probe-regression.test.ts` renders every probe through the REAL wasm engine
(fresh project + engine per probe, ~7s total) and compares against the reference wav with gain-aligned
metrics: RMS-contour delta, time-averaged harmonic-energy delta, and post-reference tail level. Per-probe
tolerances pin the 2026-07-30 calibration state.

Gotchas found while building it: the ProjectSkeleton default timeline LOOP AREA (4 bars) silently wraps
the transport at 8s and replays all notes — disable it in any offline-render test; mutating one shared
project across sequential captures left stale note bindings (missed note-offs), fresh engine per probe is
cheap and robust.

DEG rate gap CLOSED (2026-07-30): a DEG rise-time ladder (rates 25-95, h2-trajectory threshold crossings)
matches our AEG curve within 3% at every rate — the DEG and AEG rate tables are the SAME law. The real
cause of the dcw-level 13dB excess was a SEMANTIC: with sustain OFF an envelope IDLES AT ZERO past its end
step (measured: the DCW staircase falls to a pure cosine, h2 −71dB), it does not hold the final level.
`envelope.rs` now drops the value to 0 in that path (the earlier "DCA end finishes the note" was the same
rule seen through the amp envelope). dcw-level harm tolerance tightened 15 → 3dB; dca-level stays coarse
(8dB contour: a 0.4s burst of 2-20ms stages, one analysis-hop of timing drift dominates its mean).
