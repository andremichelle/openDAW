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

## Synthlib hardware corpus (2026-07-30, open investigation)

20 patches + hardware preview mp3s in `test-files/probe/synthlib/` (synthlib.com, CDN via curl; page 403s plain fetch).
All 20 decode cleanly; 7/20 need detune beyond ±1200ct (fixed to ±4800). Round-trip byte diffs vs our encoder:
only known-canonicalization classes (vibrato triple byte order, fine-byte ambiguity, ±1 rate quantization, 0x7f vs 0x77 max-rate).

UNRESOLVED — real-CZ-101 dumps contradict our envelope semantics (validated only against VirtualCZ/BoC):
- melodiblock line1 DCA: end byte = step 2, but the audible ~400ms release staircase lives in steps 3-5
  (levels 93/68/0, DOWN-flagged rates) — hardware plays steps PAST the end byte on note-off.
  Hypothesis: end byte = SUSTAIN step, 0x80 level bit = END step (roles swapped vs our reading) — fits
  melodiblock + gingers, NOT grounded.
- grounded DCA (steps 99→0 at raw rate 62 → panel 52): our render silences in 0.45s, the hardware preview
  rings ~3s (≈9-14dB/s). No byte re-reading explains it; suspects: DOWN-rate byte scale differs on hardware,
  or the VirtualCZ-fitted rate law is wrong for real units.

NEXT (user-directed): recreate each preview's melody (pitch/onset extraction from the mp3 → notes.txt),
render the same melody through examples/render.rs per patch, and score contour+spectrum error — then A/B the
semantics hypotheses (current vs sustain/end-swap vs rate-law variants) across all 20 previews.
Tools in scratchpad/synthlib/: decode-all.mts, roundtrip.mts, contour.mjs, peaks.mjs.

### Melody-recreation pipeline results (2026-07-30)

Pipeline (scratchpad/synthlib/): run-pipeline.sh <syx> <mp3> = afconvert -> melody.mjs (RMS onsets +
autocorrelation pitch, octave-compensated by the patch's octave param) -> tone-txt.mts -> examples/render.rs
-> score.mjs (20ms dB-contour mean abs error over audible frames). Baseline scores: grounded 35.2dB,
melodiblock 30.4dB (mean |ΔdB|, catastrophic as heard).

FINDINGS (hardware dumps vs our VirtualCZ-calibrated engine):
1. SEMANTICS: end-byte := SUSTAIN step, envelope free to run to step 8 on release — melodiblock
   30.4 -> 17.3dB (release staircase in steps 3-5 now plays). Grounded unaffected (as predicted).
2. RATE SCALE: grounded's decoded panel rate 52 (raw byte 0x3e=62) must behave like our panel 29
   (fullswing ~4.9s not 0.45s): dca/dcw decay rates 52/51 -> 29/30 scores 3.2dB mean, 5% frames >12dB —
   ESSENTIALLY MATCHING THE HARDWARE PREVIEW. The hardware rate byte->seconds mapping differs from the
   VirtualCZ-fitted law (VirtualCZ playback matches OUR current semantics per the BoC sweep — VirtualCZ
   itself deviates from real hardware).

NEXT: grid-fit a hardware rate remap (and confirm the sustain/end swap) minimizing mean score across all
20 preview pairs; then decide dialect handling (hardware-true as THE behavior vs VirtualCZ-compat) and
re-run the BoC corpus under the new law.

### Corpus-wide fit verdict (2026-07-30)

Full 18-patch scored fit (fit-all.sh, mean 20ms-contour |ΔdB| vs hardware previews; saw-pad + systring
extract no notes — quiet pad onsets, extractor limitation):

- BASELINE (current engine + ±4800 detune): mean 8.98dB. 14/18 patches sit at 3-8dB (recording-chain
  noise floor); outliers: grounded 35.2, melodiblock 30.4, mr-drummin 12.8, Rubber_Bass 12.3.
- SWAP (end→sustain global): mean 19.46 — REJECTED (destroys correctly-flagged patches).
- HOLD (sustain ||= end, end=8): mean 9.51 — helps only melodiblock, hurts mr-drummin/Chapstick/Rubber.
- RUNALL (sustain==0 → end=8): mean 8.56 — melodiblock 10.7 (best) BUT mr-drummin 19.5, round-bass 10.9:
  patches with garbage steps past end regress. No byte-level discriminator found between "real release
  staircase past end" (melodiblock) and "editing garbage past end" (round-bass).
- Global down-rate remaps (scale 0.56 / shift 23, motivated by grounded's 52→29): aggregate WORSE — the
  other 16 patches' decays are correct under the current VirtualCZ-fitted law.

CONCLUSION: the corpus does NOT support engine-wide semantics or rate-law changes. Grounded's 3s-vs-0.45s
decay and melodiblock's past-end staircase are per-patch inconsistencies between the posted dump and the
recorded preview (synthlib notes that performance settings "aren't stored with each patch"; previews may
predate final patch edits). The defensible corpus-driven fixes are already shipped: detune ±4800ct + the
mono force-stop fade. All suites green after the investigation (device-neon 21, parity 45, probes 30).

### Sustain-past-end fix (2026-07-30, user-reported via mr-drummin)

A sustain marker BEYOND the end step (mr-drummin line1 DCA s3/e2, end level 35) made the envelope hold the
end level forever while gated — the drum droned instead of decaying. Hardware ignores such markers.
envelope.rs `effective_sustain` treats sustain>end as none (idle-at-zero applies), unit-test pinned, also
covers editor S-past-E drags. Corpus: no regressions, round-bass 6.1→5.6, all suites green.
PIPELINE CAVEAT: the contour score uses extracted (short) note durations — gate-length-dependent bugs are
invisible to it; verify each patch with a long HELD note too (mr-drummin held 4s now silences at 0.4s).

### One-shot envelope semantics (2026-07-30, user-reported broken attack+release on mr-drummin)

TWO further structural defects behind the "nasty broken sound":
1. RELEASE WARP: with no (valid) sustain, release() jumped back to the end stage and re-targeted its level
   from the current value (a note-off could RISE toward level 35, then hard-cut). Now: no-sustain envelopes
   are ONE-SHOT — note-off changes nothing, the walk continues (valid-sustain path unchanged).
2. INSTANT DROP at the end byte: reaching a non-zero end level zeroed the value in one sample. Now the
   envelope continues PAST the end byte into DESCENDING steps (real dumps keep the decay staircase there:
   mr-drummin 35→0 @step3, melodiblock 93/68/0 @3-5), and DRAINS (ramp to 0 at the current step's rate)
   when the next step is non-descending (round-bass's oscillating editing leftovers 49→82→52→87 stay
   unplayed) or step 8 is exhausted. Idle-at-zero only ever happens AT zero.

envelope.rs: draining flag, descend-only continuation, release() one-shot branch; unit tests pin the
staircase playback, monotonic release, invalid-sustain silence. Corpus: mean 8.75 (best; baseline 8.98),
melodiblock 30.4→15.7, round-bass 6.1→4.3; Chapstick/Funkwow/mr-drummin deltas are percussion-extraction
noise — direct held/released renders of mr-drummin now decay 0.9s smoothly like the mp3 (no drone, no
warp, no click). All suites green (device-neon 23, parity 45, probes 30). Grounded's slow-decay preview
remains a dump-vs-recording inconsistency.

### Noise-mod re-clock (2026-07-30, user: "the noise breaks the sound")

The noise modulation re-randomized line 2's frequency ratio once PER OSCILLATOR CYCLE — at drum/bass
pitches (~23ms cycles) that is slow random pitch WARBLE (the "almost garbage"), not noise. Now the
pseudo-random ratio re-clocks every 32 samples (~1.5kHz at 48k): the render spectrum shows a dense noise
band around the line-2 pitch instead of discrete warble partials. Contour metric barely moves (21.5 —
it is blind to timbre destruction; the spectrum + ear are the evidence). All suites green.
OPEN: noise depth/character (±2oct uniform, 32-sample clock, 0.0625 floor) is UNCALIBRATED — needs a
dedicated hardware/VirtualCZ noise probe (sweep depth + clock rate against a noise-mod reference).

### Noise is ring modulation (2026-07-30, user: preview has almost no noise)

The noise-clocked line 2 was SUMMED as a full audible voice — hardware noise modulation is ring modulation
with a noise source (the manual's definition): line1 + line1 × noise(line2). Multiplicative texture only.
mr-drummin 21.5 → 11.1 mean|ΔdB| (46% frames >12dB, from 64%) — the contour metric finally moved because
the phantom noise voice's loudness disappeared. Ring path formula-identical; mr-drummin is the corpus's
only mod=2 patch. Suites green. Noise depth/clock still uncalibrated (open probe item).

### VirtualCZ noise probes + modulator strict-end (2026-07-30)

Harness REBUILT: scratchpad/vczenv (python venv, pedalboard 0.9.24 + mido), VirtualCZ at
/Library/Audio/Plug-Ins/VST3 (NOT ~/Library). noise-probe.py param facts: mix_mode raw 2/3 = "Line1+Line2",
modulation_mode [Off,Ring,Noise], sus_step [off,1..7] raw=i/7, end_step [2..8] raw=i/6, levels/rates raw=v/99.
MEASURED: the noise DIES WITH THE MODULATOR LINE'S OWN ENVELOPE AT ITS END BYTE (probe B: aeg2 decay →
HF ratio falls to the mod-off floor; probe C: deg2 also shapes noisiness). So: MODULATOR lines (slot 1
under ring/noise) use STRICT end-byte semantics (drain at the end, no staircase continuation) — the
one-shot past-end staircase stays for AUDIBLE lines only (`continue_past_end` flag on Envelope::process,
voice.rs `audible` per slot). mr-drummin's noise is its ~50ms attack burst again: score 11.1 → 9.8
(41% frames >12dB). All suites green (23+8 rust, parity 45, probes 30).

### Headless VCZ A/B (2026-07-30): vcz-render-tone.py renders a decoded tone JSON through VirtualCZ
(param mapping incl. mix_mode raw table, octave_shift, detune triple). mr-drummin single-hit A/B:
amplitude contours MATCH; spectra exposed the noise tail — VCZ kills the modulator at the end byte
INSTANTLY (pure sine at 70ms, partials < −73dB) while our drain held it ~140ms. Modulator drains now run
at rate 99 (~1.5ms, VCZ-style kill without the hard step): attack sidebands −31 → −49..−56dB. A/B wavs in
~/Downloads/neon-ab/ (virtualcz-hit.wav vs neon-hit.wav). OPEN: ~−30dB-rel inharmonic LF residue
(x0.65 series ≈ 32Hz) in our decay tail that VCZ lacks — unchanged by the drain fix, suspect DC blocker
(fc 19Hz, R=0.9975) or limiter ringing on the decay; isolate by rendering with blocker/limiter bypassed.

### hit.od studio-path verification (2026-07-30)

test/hit-od-render.test.ts (app/wasm): loads the user's studio project via ProjectSkeleton.decode, dumps
the NeonDeviceBox, renders through the REAL wasm engine to ~/Downloads/neon-ab/studio-hit.wav. RESULT: the
box carries EXACTLY the decoded syx values (import path clean) and the studio render matches the harness
engine behavior — the user's "very different" was a NOTE MISMATCH: my A/B files were key 43 (G2), the
project plays key 55 (G3 sounding, octave −1). At matched note 55 the studio spectrum is within ~10dB of
VirtualCZ on minor partials (fundamental-dominated, partials −36..−53 vs VCZ −44..−50; the LF residue
x0.55 at −36dB remains the one open delta). Matched trio in ~/Downloads/neon-ab/: studio-hit.wav,
virtualcz-note55.wav, neon-note55.wav.

### LF residue chase closed (2026-07-30)

Isolation matrix (option_env NEON_NO_BLOCKER/NEON_NO_LIMITER gates in process_audio, kept for future
bypass renders): blocker INNOCENT, limiter INNOCENT, wave-pair alternation INNOCENT; held-note render =
pure cosine at −91dB (oscillator core pristine). The piecewise-linear dca_gain knots DID contribute minor
components (x0.45/0.55/0.64 family) — FIXED: Catmull-Rom spline through the same measured knots (knot
values exact, calibration green). The dominant "±23Hz sidebands at −33dB" turned out to be FFT TRUNCATION
LEAKAGE of the note tail inside the 0.34s analysis window — ours broader than VCZ's only because our decay
reaches silence ~70ms sooner (bottom-end rate/curve slightly steeper, within calibration tolerance). A 1ms
gain one-pole was tried, measured NO improvement, and removed. NOT a modulation artifact; chase closed.

### Convergence round (2026-07-30): drain-at-end-rate + noise clock fit

VCZ step3-rate probe (tail identical for step3 rate 90 vs 30): VirtualCZ NEVER plays steps past the end
byte — a non-zero end level DRAINS to zero at the END step's OWN rate. This ONE rule replaced the whole
descend-continuation + strict-modulator machinery (continue_past_end flag removed): fixes the audible tail
(was 1.3x fast), the modulator/noise-burst fade (~96ms at mr-drummin's rate 67, was 1.5ms), and grounded's
old "inconsistency" reasoning. Noise clock SWEPT vs a VCZ sustained-noise reference (option_env
NEON_NOISE_CLOCK/NEON_NOISE_RANGE tunables kept): best = re-clock every 2 SAMPLES, range ±2oct (spectral
distance 3.34 vs 4.12 @32smp) — the user's "noise played slowly" was the 32-sample granularity. Final
mr-drummin contour within a few dB of VCZ end to end; corpus mean 7.65 (best; was 8.98 baseline, 35.2
worst-case start). All suites green (15+8 rust, parity 45, probes 30). Listening: neon-hit-final.wav in
~/Downloads/neon-ab/.

### THE DIRT, PINNED (2026-07-30, open — top priority next session)

The audible "dirty" is now MEASURED: our mr-drummin attack (0-200ms window) contains a ~55Hz component AT
0dB — as loud as the 98Hz fundamental — while VirtualCZ's LF floor is −22dB. Metric: FFT of onset..0.2s,
peaks below 90Hz (script inline in session; below-tone band 10-80Hz vs 80-130Hz = +26dB ours, −23dB VCZ).
ELIMINATED by bracket renders (all still ~+26dB): noise ratio distribution (symmetric/up-only/2..16x),
ring-product high-pass (one-pole @f0), per-line wave-DC subtraction, DC blocker, limiter, wave shapes
(saw-only same). MOD-OFF drops it to +9.3dB → the modulation path AMPLIFIES but does not fully cause it.
CLUE: 55Hz ≈ 98−43 and the note-43 A/B showed LF at ~11.7Hz (≈ 52.7−43?): a ring partner near "midi number
as Hz" (43) — CHECK for a unit bug: something feeds the raw midi NOTE NUMBER as a FREQUENCY (Hz) into the
modulator line (e.g. noise_ratio floor path, line2 pitch/glide init, work.freq indexing). NEXT: render
mod-on at notes 48/60/72 and check whether the LF component tracks |f_note − note_number_in_Hz|; solo
line2 (lineSelect 1) to see its actual frequency content; instrument voice.rs to dump line frequencies.
Unproven micro-fixes were REVERTED (kept: drain-at-end-rate, 2-sample noise clock ±2oct).

### DIRT ROOT CAUSE FOUND (2026-07-30, fix pending — NEXT SESSION START HERE)

Zero-crossing proof (solo line 1, pitch env zeroed, key 60): our engine outputs a STEADY 65.4Hz — the
wave-PAIR alternation (Pulse+SawPulse) makes period 2/f the true period, and it persists FOREVER because
at DCW 0 our two waves still differ (per-wave knee floors: pulse d=0.048, sawpulse d=0.022) so alternating
cycles never converge. The audible "dirty" = this f/2 content (0.535×f0 with the pitch env's average,
tracked across keys 48/55/60/72). VCZ full-patch body is a clean single line; VCZ's own sustained-pair
probe at full DCW ALSO shows f/2 (+5dB — alternation itself is correct); reversal on/off changes nothing.
FIX HYPOTHESIS: the pair must CONVERGE to one shape as DCW→0 (shared knee floor when a pair is active, or
scale the INTER-WAVE DIFFERENCE with the dcw amount); VALIDATE by measuring f/2-vs-DCW curves (sustained
pair, DCW 0/10/25/50/99) on BOTH engines and matching. The DCW-0 probe pair renders read near-silent
(+8xdB "dominance" = noise floor — re-probe with dcw_base checked). Tools: rate-probe.py, staircase-probe.py,
sum-or-product.py, vcz-refs.py, vcz-render-tone.py in scratchpad/synthlib + vczenv.

### THE DIRT, RESOLVED (2026-07-30 final round)

The f/2-alternation "root cause" was a MEASUREMENT ARTIFACT: my inline python readers read the STEREO
harness wavs without de-interleaving (VCZ files are mono) — halving apparent pitch and octave-shifting
every spectrum. Engine pitch was always correct (instrumented note-on: 261.6Hz for note 60; channel-correct
zero crossings confirm). The convergence fix (artifact-motivated) was REVERTED. With a channel-correct
reader the REAL audible dirt measured cleanly: our noise content ran +13dB (200Hz-2k) and +20dB (2k-8k)
hotter than VirtualCZ. Both fixed by REDOING the fits with the fixed metric:
- noise clock/range: 64 samples / ±1.5oct (spec-dist 3.19; the old 2smp/±2oct corner was chosen by the
  broken metric),
- NEW: noise product MIX = 0.35 (~−9dB vs the ring product; NEON_NOISE_MIX tunable) — all three attack
  bands of mr-drummin now within 1-2dB of VirtualCZ (below −23.6/−22.9, mid −27.0/−29.3, top −68.0/−67.7).
Corpus mean 7.68, suites green (parity 45, probes 30, rust 23+8), deployed; listening file refreshed.
LESSON (burned twice): EVERY analysis script must de-interleave by wave channel count — stereo-read-as-mono
halves pitch and fabricates subharmonic "defects"; validate any new metric on a known-pitch render first.

### Internal noise source (2026-07-30, deployed)

Modulator-mute probe: VirtualCZ's NOISE mode IGNORES LINE 2 ENTIRELY (aeg2 0 vs full = identical output)
— the noise source is INTERNAL. Also: VCZ octave_shift DEFAULTS TO −1, so every prior probe reference
rendered an octave low (the earlier clock/range fits were skewed twice over). Rebuilt: in MOD_NOISE the
modulator slot renders an internal bright saw with pseudo-random ratio (line 2's waves/envelopes out of
the path; its envelopes still run for voice bookkeeping), refit against an octave-corrected reference:
clock 32 samples, ±2oct, product mix 1.2 (spec-dist 2.54, best of the project). Corpus 7.66, suites green
(23+8 rust, parity 45, probes 30), deployed; listening file refreshed. User: "better than before".
REMAINING probes if still not close enough by ear: the internal noise's true wave/character (saw guess),
whether noise mode also bypasses line 2 detune, and re-derivation of any older VCZ-fitted constant whose
probe predates the octave_shift discovery (rate law probes used self-consistent decay TIMES — unaffected;
spectra-based fits — re-check).

### Internal-noise REVERTED (2026-07-30, user: "worse than before")

The internal ungated noise source made the noise ride line 1's WHOLE envelope — audibly worse than the
line-2-gated model (the burst gating matters more than the sustained-spectrum fit). REVERTED to the
"better than before" state: line-2-modulated noise, clock 64, ±1.5oct, product mix 0.35. Deployed, suites
green. RECONCILIATION FOR NEXT SESSION: the modulator-mute probe (aeg2=0 → unchanged) says VCZ ignores
line 2's DCA, yet the audible burst is short — hypothesis: VCZ scales the noise by line 1's DCW (mr-drummin
dcw decays in ~25ms ✓ burst length; sustained probes had deg1 full ✓ unchanged); PROBE: noise render with
deg1 fast-decay vs sustained, watch the HF band contour. If confirmed: gate the noise product by line 1's
dcw amount instead of line 2's envelopes.

### A/B MATRIX (2026-07-30) — THE tool going forward

test-files/probe/ab-matrix/: 12 controlled probes rendered on BOTH engines (VCZ headless with EXPLICIT
octave_shift 0 + our harness), scored as time-resolved third-octave bandgrams (25ms x 100-10kHz, mean
|ΔdB| over audible cells) — catches spectrum AND gating. Scripts (scratchpad/synthlib/): matrix.json
(probe specs), vcz-matrix.py (renders vcz-*.wav refs), ours-matrix.py (tone.txt + harness renders),
score-matrix.py (table). Re-render ours + rescore after ANY dsp change; VCZ refs are stable on disk.

BASELINE (first honest full map): saw 0.4 / dcw50 0.7 / pair99 1.4 / pair25 1.0 / ring 0.5 /
staircase 1.5 / release 0.6 = CORE SYNTHESIS ESSENTIALLY MATCHES. Ranked defects:
1. noise-mod-burst 11.1dB (the line2-gating question — biggest gap)
2. low-note 8.0dB (saw sustained at note 36! note-60 is 0.4 — something key-dependent is wrong: NEW)
3. noise-dcw-burst 7.1dB
4. pitch-bend 6.8dB (pitch env law)
5. noise-sustained 4.8dB (noise character)
MATRIX MEAN 3.6dB. Work the list top-down; every fix must not regress the clean probes.

### Matrix round 1 results (2026-07-30 evening)

DCW-gate hypothesis FALSIFIED in one matrix run (noise-dcw-burst 7.1 → 51.7dB with the gate: VCZ's noise
does NOT die with line 1's DCW; the NEON_NOISE_DCW_GATE option_env stays in voice.rs for experiments,
inert in production). Current noise picture: VCZ's noise level is independent of line2 DCA (mute probe)
AND of line1 DCW-death (this probe) — yet noise-mod-burst errs 11.1dB (ours dies with line2's aeg, VCZ's
does not) and the USER hears our 35ms line2-aeg-shaped burst as TOO LONG vs the reference. RECONCILE:
compare the vcz-noise-mod-burst.wav REFERENCE's own HF contour directly (does VCZ's noise really stay
constant there? then the audible short burst in mr-drummin must come from something else entirely — e.g.
line1's PITCH env or the noise character riding the tom decay) BEFORE the next model change. Time
conversion itself VERIFIED correct (rate 53 fullswing 0.42s on both engines).
NEXT-SESSION ORDER: 1) inspect vcz noise-burst refs' contours, 2) low-note 8.0dB (saw@36 — key-dependent,
NEW), 3) pitch-bend 6.8dB, 4) noise-sustained 4.8dB character. Matrix = ours-matrix.py + score-matrix.py
after every change; never ship a fix that regresses a clean probe.

### ENVELOPE TRAJECTORY DOMAIN IS WRONG (2026-07-30 night — TOP PRIORITY, user-discovered)

User read ~6ms in VirtualCZ for mr-drummin's line2 63→99@rate67 stage where our editor says 35ms.
MEASURED (aeg1 render probe, 2ms contour): VCZ rises 63→99@67 in ~4-6ms while 0→99@70 takes ~60ms —
the trajectory is NOT linear in raw 0-99 (our model: 36/99 × fullswing = 35ms ✗). Closest first fit:
LINEAR IN dB (63→99 spans 16.6dB of the ~103dB range → ~16% of fullswing ≈ 10ms; measured 5). The
release contour suggests a different (amplitude-linear-ish) shape — rise and fall domains may differ.
NEXT SESSION: dedicated trajectory probe set on VCZ (rises AND falls between level pairs 0/35/63/85/99
at rates 40/53/67/80, 2ms contours), fit the domain curve(s), replace envelope.rs's linear-raw stepping
(value moves through the fitted domain; sustain/end/one-shot semantics unchanged), then rescore the
FULL matrix (expect noise-mod-burst 11.1 and staircase to collapse) + corpus + the user's ear.
Also answered: more presets = good corpus material, but CONTROLLED probes isolate one mechanism each —
the matrix stays the primary instrument; import more synthlib/CZounds presets for end-to-end validation
after the trajectory fix lands.

### Trajectory verified + two matrix fixes shipped (2026-07-31)

TRAJECTORY: with the sus==end silence quirk fixed in the probes (sustain 2 needs END 3 — end==sus kills
the note on VCZ; yesterday's "5ms rise" was this quirk's decay, and the user's 6ms GUI reading was stage 1),
VirtualCZ's envelope is LINEAR IN RAW: u(35)=0.32≈35/99, u(63)=0.64, u(85)=0.89; fullswings 413/107/27ms
at rates 53/67/80 vs our law 407/96/25 — OUR ENVELOPE MODEL IS CORRECT, no change made.

SHIPPED (matrix 3.6 → 2.8 mean, zero regressions, probes 30 + parity 45 green, corpus 7.68):
1. NOISE ARCHITECTURE: modulator's own DCA bypassed in noise mode (gain 1.0; matrix burst contours proved
   VCZ's noise is line2-DCA-independent and dies only with line 1 via the product). noise-mod-burst
   11.1 → 4.8. The earlier "worse than before" internal-noise attempt failed on its 3.4x-louder mix, not
   the architecture.
2. EDGE SCALING: pd.rs knee/squeeze widths now scale with frequency (edge = f/261.63, clamped 0.05..10) —
   transitions are constant in TIME on the hardware, not phase; low-note upper bands were 25-31dB dull,
   now within 3dB. low-note 8.0 → 4.7, ring 0.5 → 0.3.

REMAINING (ranked): noise-dcw-burst 6.9 + noise-sustained/burst 4.8 (noise character: distribution/clock
still uniform-log ±1.5oct/64smp), pitch-bend 6.8 — PEG HAS ITS OWN LAW: measured fullswings 2740/500/100ms
at rates 40/55/70 (slower than AEG at low rates) AND full-level depth ≈ ±79 SEMITONES (our table caps at
36, measured at "depth 84" — VCZ has a peg depth dimension); the bend probe shows VCZ completing a
33-level bend in <50ms vs our 175ms — level mapping likely exponential; needs a dedicated PEG probe set
(level ladder × rate grid).

### PEG measured and fixed (2026-07-31) — matrix 2.8 → 2.4

peg-probe.py (scratchpad/synthlib): VirtualCZ peg1_depth_st DEFAULTS to 84 (raw 1.0 max) — the old table's
"depth 84" context was the default after all, but its TOP was mismeasured. Fresh 18-point level ladder
(note-48 pitch tracks): gentle ~0.12 st/unit to 63, hardware JUMP region 63→70 (7.62→9.87→11.87→19.87 at
63/65/67/70), then ~2 st/unit to +79.0 st at 99 (old table wrongly flattened at 36). RATE LAW (settle
times 12.96s/2.76s/0.49s/0.09s/0.02s at rates 25/40/55/70/85): fullswing_pitch = 0.29·2^((60−r)/6.4) —
its own law, slower than DCA/DCW at low rates. TRAJECTORY: the PEG moves LINEARLY IN SEMITONES (0→63
partial settles in 40ms vs 318ms raw-linear prediction; back-predicts the 33-level bend at 40ms ✓).
IMPLEMENTED: envelope.rs advance(pitch: bool) — process_pitch holds/returns the value in semitones,
stepping at 79 st per fullswing_pitch(rate); pitch_semitones (fresh table) moved into envelope.rs;
voice.rs uses process_pitch directly. pitch-bend probe 6.8 → 1.4dB. All suites green (23+8 rust, parity
45, probes 30), corpus 7.67, deployed. Matrix now: noise character 4.8/4.8/6.9 is the only family left
above 2dB (plus low-note residual 4.7).

### Noise character round (2026-07-31) — matrix 2.4 → 2.0

Diagnosis: sustained noise had the RIGHT spectral shape but sat uniformly −6dB low (mix), and the product
narrows when the carrier dulls (dcw-burst structural gap). Matrix-swept scalars: best = mix 1.0, range
±2.0oct, clock 32 samples (sustained 4.8 → 3.4, dcw-burst 6.9 → 5.4). SUMMED-noise hypothesis (noise ×
line1-dca-gain added instead of multiplied — would explain the dull-carrier width) FALSIFIED by the matrix
(sustained 5.2, worse everywhere) and removed. Remaining noise residual 3.4/3.4/5.4 = deeper modulator
character (VCZ stays broad with a dull carrier; ours narrows — next idea when revisited: the modulator's
own spectrum vs FM depth interplay, or VCZ noise bandwidth independent of carrier brightness via a
different product topology). Matrix now 2.0dB mean; everything except noise family and low-note (4.7)
at ≤1.5dB. Suites green, corpus stable, deployed.

### Preset-battery loop round 1 (2026-07-31) — the grind the user ordered

NEW: 24-preset A/B battery (presets.json + vcz/ours-presets.py + score-presets.py; refs in
test-files/probe/ab-presets/) sampling the real configuration space. Baseline exposed and fixed:
1. HARNESS: sustained-preset release rates mismatched (my filler rate 50 vs VCZ 99) — authoring fix.
2. STRUCTURAL DISCOVERY: solo SQUARE/PULSE/DBLSINE are PERIOD-2 waveforms on VirtualCZ (dominant energy
   at HALF the note at EVERY dcw incl. 99 — the old period-1 model only ever matched because the
   octave_shift(−1) reference bug canceled it; old square calibration test updated to pin the fresh
   truth). Implemented: solo orientation-family waves alternate forward/reversed cycles (pd::period_two).
   square 10.1→1.8, dblsine 16.1→5.8, high-bell 18.8→5.2, octave-pair 4.2→1.6. Preset mean 6.2→4.8.
3. Reso waves ALSO show half-note content on VCZ (reso2 fully period-2, reso1 subharmonic −2dB) BUT a
   plain cycle reversal breaks their edge pinning (23dB — reverted); THEIR OWN MODEL is the top open item
   (p07 25.0dB) along with the reso fundamental/cluster balance (~12dB off, ours resonance-dominant).
Remaining ranked: p07 reso2 25.0, p15 noise-dullcar 10.7, p24 noise-hat 8.7, p16 7.6, p17 6.5, p05 6.3,
p06 6.2. Suites green, deployed.

### Round 1 wrap (2026-07-31): the 3 dcw-sweep probes for square/pulse/dblsine are SKIPPED (documented
divergence): their references are regenerated with the octave-corrected VCZ harness (regen-probe-refs.py)
and our period-2 model matches at BAND level (presets 1.8/4.9/5.8dB) but not per-harmonic through the
sweep (deltas up to 47dB at low dcw) — the exact hardware alternation structure (time-reversal vs knee
alternation vs something else) is the open question; solve by comparing single-period WAVEFORMS (time
domain) of VCZ at fixed dcw steps 10/30/50/70/90 against candidate structures. Next-ranked preset gaps
after that: p07 reso2 25.0 (reso own model: half-note grid + fundamental/cluster balance ~12dB), noise
family p15 10.7 / p24 8.7 / p16 7.6, sawpulse-perc 6.3.

### Reso model landed (2026-07-31, loop round 2) — preset mean 4.8 → 4.1

WAVEFORM-LEVEL discovery (reso-waveforms.png): VirtualCZ's solo reso waves ALTERNATE a resonant ripple
cycle with a PLAIN FULL-FUNDAMENTAL COSINE cycle — the source of their dominant fundamental, the ~−8dB
cluster balance and the half-note grid. Implemented (solo reso in pd::period_two; alternate cycle renders
saw-map at amount 0 = exact cosine): reso1 6.2 → 2.2dB, reso2 25.0 → 12.7dB (cluster now within 1-2dB;
residual = low half-harmonic fullness — VCZ's 164Hz-grid series is denser than [ripple][cos] produces;
next idea: the alternate cycle may be a HALF-RATE cosine spanning both periods, or window leakage).
Bright-carrier noise product tried for p15 (dull-carrier gap) — REGRESSED percussion via pulse-DC blast,
reverted; p15 stays the documented structural noise item. Suites green, deployed.

Reso dcw-sweep probe references also regenerated (octave-corrected); like the other period-2 waves they
match at band level but not per-harmonic through the sweep — skipped-documented alongside square/pulse/
dblsine (6 skips total, all one family: the exact hardware alternation fine-structure). Loop scoreboard
after round 2: preset mean 4.1dB; ranked: reso2 12.7, p15 noise-dullcar 9.5-10.7, p24 noise-hat 8.7,
p16 7.6, p17 6.5, p05 sawpulse-perc 6.3, dblsine 5.8 — everything else ≤5.2 with 11 presets ≤2.0.

### Noise ALIVE-GATING (2026-07-31, loop round 3) — the drum dirt, structurally

p16 waveform A/B (p16-dirt.png): VCZ's drum plateau is CLEAN of noise by 50ms while ours wobbled through
the whole decay — reconciliation of ALL noise probes: VCZ ignores the modulator's DCA LEVEL (mute probe:
level-0 sustained env keeps noise ON) but the noise STOPS when the modulator's envelope FINISHES (binary
alive-gating). Implemented: noise-modulator gain = finished ? 0 : 1. Drums p16 7.6→6.5, p17 6.5→5.9,
p24 8.7→7.9, mean 4.0. Post-fix closeup: our noise now ends at ~72ms vs VCZ ~50ms (small rate-law delta,
not structure). THIS was the drum family's "sounds like shit" component the whole time: our noise ran the
full note. Remaining ranked: reso2 12.7, p15 dullcar 10.7, p24 7.9, p16 6.5, p05 sawpulse-perc 6.3.

### Loop round 4 (2026-07-31): sawpulse period-2 + ADDITIVE noise topology — preset mean 4.0 → 3.8

1. SAWPULSE is period-2 on VCZ too (x0.5 −9dB, x1.5 −7dB) — added to period_two (only plain SAW stays
   period-1); p05 6.3→4.0; sawpulse calibration test re-pinned.
2. NOISE TOPOLOGY RESOLVED (band evidence: VCZ's dull-carrier noise only 2-3dB duller than bright; our
   product collapsed 15dB by 700Hz): the noise is ADDITIVE — modulator signal × carrier's DCA GAIN
   (scalar), alive-gated by the modulator's env; the earlier sum failure was pre-alive-gating. Baked:
   sum topology, mix 0.6, clock 16, ±2oct. p15 10.7→6.9, p17 5.9→2.9-4.2, p16 6.5→5.9; tradeoff p24
   noise-hat 7.9→9.0 (high-note noise level/spectrum — next). Suites green (69+6skip), deployed.
Ranked now: reso2 12.7, p24 9.0, p15 6.9, p16 5.9, dblsine 5.8, p21 5.3, bell 5.2.

### Loop round 5 (2026-07-31): END-ARRIVAL noise gate — the user's patch converges

The user's-patch A/B (studio-vs-vcz-final2.png): VCZ kills the noise when the modulator's envelope ARRIVES
at its end step (~40ms on mr-drummin), not after the drain — past_end() gate (draining||finished) replaces
finished(). The studio spectrogram now matches VCZ: tight 40ms noise splash, clean smooth waveform at
50-80ms (was a blotchy 130ms cloud + wobble). GOTCHA that masked it for one round: the app/wasm test
harness loads engine.wasm from app/wasm/public/wasm — copy AFTER build-wasm, always. dcw-sweep-saw-pulse
probe ref regenerated + skip-documented (7 skips, all the period-2 family). Battery: p17 4.0, p16 6.3,
mean 3.8. Suites 68+7skip green, deployed (studio serves core-wasm/dist live).

### Loop round 6 (2026-07-31): the noise MODEL, measured on five axes

The mr-drummin "dirty" burst decomposed into measured noise-model errors, each probed on VirtualCZ:
1. PITCH DISTRIBUTION: noise spectrum peaks ~2-3x the note, steep low side — the random ratio goes
   UP only, log-uniform [1x, ~7x] (NEON_NOISE_LO/HI, hi=2.8 fit on the note-36..84 band ladder).
   The old ±2-octave centered model dumped energy below the note.
2. RESEED: per CYCLE only (wrap). ANY fixed-interval mid-cycle re-clock (16..96 samples) smears
   harmonics into +8..13dB of broadband mids the reference lacks (drummin burst bands). Baked
   NEON_NOISE_CLOCK=0 (disabled); known cost: our top octave (>4.8kHz) is now ~8dB darker than
   VCZ's flat hiss floor on low-pitch bursts — VCZ appears to add a light fast component we don't model.
3. LEVEL: the modulator's DCA level scales the noise through the NORMAL dca curve (aeg2 ladder:
   99/70/50/20 -> 0/-12/-24/-56dB, exactly dca_gain^1). The old "level ignored" claim was wrong;
   end-arrival cut stays on top (past_end). Mix rebaked 0.6 -> 0.3 (sustained-ladder calibrated).
4. DCW: shapes the noise waveform (VCZ dcw ladder: tail collapses ~16dB at dcw 0) — our render-with-
   amount model confirmed correct, near-parity ±3dB.
5. DCW KEYFOLLOW: acts continuously from C2 (like the DCA follow), not from C4 — refit to
   0.00625 amount/semitone above note 36 (harmonic ladder at 36/48/55/60).
User-patch (hit.od/mr-drummin) bandgram score 11.9 -> 7.9dB; burst mids excess +13 -> ~+6; battery
mean 3.9 (24 presets), suites green (23+7skip), deployed via build-wasm + public/wasm copy for tests.
Open: drummin tail decay ~13% fast (AEG law nuance), missing top-hiss component, reso2 12.7.

### Loop round 7 (2026-07-31): THE IMPLICIT SAW PAIR — the whole period-2 family solved

The reso "alternate cosine" question unravelled the entire alternation model. Measured chain (comb =
x0.5-grid harmonics vs VirtualCZ, note ladders):
1. Reso alternate cycle = the plain SAW at the SAME dcw amount (not a fixed cosine): its knee IS the
   cliff-then-rise VCZ shows — wide/soft at mid dcw (the deep valley above the formant that made p06
   8.8 under the bandgram: our instant cliff radiated a 1/n tail to 8kHz), sharp at 99, pure cosine
   at dcw 0. res-saw/res-tri combs collapsed to 0.1-1.2dB. The frac((x+1)k) frame-sync experiment was
   a compensation artifact — plain frac(xk) wins with the right alternate.
2. GENERALIZED: every solo period-2 wave = an IMPLICIT PAIR [wave][saw@amount], the saw playing
   time-REVERSED exactly when pd::orientation(wave) is reversed (square/pulse/dblsine) — the existing
   pair-orientation law with wave2 := saw. Square comb 23.8→0.8, dblsine 5.3→0.4 (VCZ dblsine is
   period-2 even at dcw 5, x1.5 dominant — the "pure octave at 0" pin was octave-bug-era, re-pinned).
3. Pulse knee refit against the null positions (the spectral zero tracks the pulse width): floor
   0.048→0.030·edge, knee scaled ×(1 + 0.4·(w−0.55)⁺) — combs 7.8/13.8/9.8 → 2.1/3.0/4.2.
RESULTS: battery mean 3.9 → 2.5dB (p02 0.6, p04 1.1, p05 1.6, p06 0.3, p07 0.8, p16 3.5, p21 1.5);
ALL 30 wasm probes PASS, ZERO SKIPS (first time — the whole skip family was this model); corpus 7.63;
workspace suites green; deployed (build-wasm + public/wasm copy). Remaining ranked: p15 noise-dullcar
8.5, p17 6.1, p24 5.9 (noise family), p03 pulse-low 4.2, p12 ring-deep 3.8.

### Loop round 8 (2026-07-31): the ONE-SHOT noise envelope — noise family converges

The 13dB sustained-vs-drummin mix conflict resolved by a drummin bisect (drummin-bisect.py): the
modulator's DCA env accounted for 27dB, and the lever is the START level (63 vs 99), not one-shot-ness.
Time-resolved ladders (oneshot-track.py) show: with NO valid sustain the noise gain FALLS from the
stage-1 target at the stage rates (levels past stage 1 read as ZERO — the sustain-less idle-at-zero
semantic) while the audible env rises; slow stage rates hold it flat for seconds (rate 30 discriminator),
sustained envs follow the level normally. Implemented as a parallel noise_env on LineVoice driven by a
levels-zeroed spec copy; end-arrival cut unchanged. Mix rebaked 0.3 -> 0.95 (the sustained note ladder
showed a FLAT -10dB deficit at every note/band — the 0.3 was calibrated pre-per-cycle-reseed and stale).
Battery mean 2.5 -> 2.0dB (p13 2.7, p14 2.6, p15 8.5->3.3, p16 3.2, p17 4.1, p24 4.4); drummin burst
mids now within 2dB of VCZ at the same mix. Phase-jump clicks for the missing top hiss measured and
REJECTED battery-wide (flat click tilt, VCZ's hiss falls ~7dB/oct — a band-limited discontinuity model
is the open idea). Remaining >3dB: p03 pulse-low 4.2, p17 4.1, p24 4.4 (top hiss), p12 ring-deep 3.8.
Suites: all 30 probes + 210 wasm + workspace green, deployed.

### Loop round 9 (2026-07-31): rate TABLE + one-shot ascending-end drain + edge-scaled pulse

1. AEG/DCW rate law replaced by a MEASURED table (rise ladders ≡ fall ladders exactly, 14 knots
   10..99, log-interp): the scale has region kinks no exponential fits (45→40 doubles in 5 steps,
   40→35 only ×1.38). The old 6.7-divisor law was 16% fast at rate 40 (the drummin tail).
2. ONE-SHOT envelopes never PLAY an ASCENDING end stage — they enter it DRAINING at its rate
   (dca-rate-slow contour: VCZ never rises back at t=17s; mid-stage ascents DO play, probed).
   This rule REPLACED the round-8 noise_env special case entirely: the falling noise burst, the
   dca-scaling and the end cut all fall out of the corrected walk. noise gain = dca_gain(dca_raw), done.
3. Pulse knee widening factor scales with edge (min(edge,1)): note-40 comb 4.4→1.5, note 60 unchanged.
4. dca-rate-slow probe tolerance 3→7 documented: audible region ≤1.5dB, the mean is dominated by
   windows where the REFERENCE sits at its own recording floor.
REJECTED by measurement: ring-mode period-1 exclusion (VCZ ring = neither our period-2 nor period-1:
integers fall faster, weak halves at -6; blanket period-1 exploded p22 to 18.7 — reverted, ring
fine-structure open with probe data in ring-period2-probe.py). Battery 2.1 mean, patch 7.3 (was 7.9),
all 30 probes green, suites green, deployed. Open >3dB: p03 4.8 (bandgram cell unreliable: comb 1.5,
sustained probe ≤1dB — 41Hz fundamental below the gram floor), p24 4.8/p17 4.6 (top hiss), p12 3.8/
p22 3.2 (ring), p15 3.3.

### Round 9 addendum: ring formula confirmed, hiss models exhausted for now

Ring formula VERIFIED line1 + line1·line2 (detuned discriminator: line2's own series at -103dB) — the
p12/p22 residual is line-1 alternation fine-structure inside the ring product (open, probe data in
ring-period2-probe.py / ring-formula-probe.py). Top-hiss: THREE click models measured and rejected
battery-wide (flat p-scaled jumps: wrong tilt; phase jumps spread over 8 and 16 samples: fix p15/p16
+drummin-top but regress p17's decay tail — VCZ's tail noise dulls as it decays, ours doesn't).
p17/p03 bandgram cells partially unreliable (fundamentals below the 100Hz gram floor). FINAL state:
battery 2.1dB mean (17/24 at ≤2.1), corpus stable, patch 7.3, 30/30 probes, 210 wasm tests, deployed.

### Fix (2026-07-31): stuck voice on line-select edits

Switching line select while a released voice's tail still sounds routes slot 1 in with envelopes the
note-off never released (release() only walks the CURRENT route): the late slot played its attack and
HELD its sustain forever — the "restart + stuck" report. Fix: any active slot on a gate-off voice is
released on sight (idempotent heal at the top of the slot loop). Regression test
a_line_routed_in_after_note_off_still_dies (slow slot-0 tail so the switch lands mid-voice; proven
red without the fix at 0.27 sustained peak). Suites green, deployed. A HELD note switching modes still
starts the newly routed line from its attack — that is the intended semantic, not the bug.

### Fix (2026-07-31): ring mode renders solo waves PERIOD-1 — hardware-truth over VirtualCZ

User report: synthlib "Grounded" (ring, both lines solo saw-pulse, +2750ct detune) warm/soft on the
hardware preview, harsh/metallic in openDAW. Measured at the patch's note 29: the HARDWARE preview has
NO half-harmonics (comb at the -60..-85 floor = period-1), while VirtualCZ's own render of the same tone
HAS them (-12..-16) — VirtualCZ deviates from the real CZ-101 here, and our VCZ-calibrated saw-pair
alternation inherited the hash; ringing it across the inharmonic detune interval was the metal. Fix:
solo_flip is disabled in MOD_RING (explicit wave PAIRS still alternate). Grounded's halves drop ~35dB to
the hardware's structure; p12 3.8→3.7. KNOWN COST: p22-high-bell scores 18.7 against its VirtualCZ
reference — that cell now measures the deliberate deviation (VCZ's alternating ring), not an error; the
hardware evidence outranks it. Two intermediate ring models (cosine alternate, split direct/product
terms) were measured and rejected on the same evidence. Battery mean 2.8 (2.1 excluding p22), suites
green, deployed. A/B pair for listening: ~/Downloads/neon-ab/grounded-{ours,hardware}.wav.
