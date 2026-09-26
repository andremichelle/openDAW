# Tubular editor (phase 4 of plans/tubular.md)

**Status 2026-09-26**: all five sections built and committed, he checks each in his studio (no browser rounds
for small UI). Components under `TubularDeviceEditor/`: frame + round 2×5 tab grid in `TubularDeviceEditor.tsx`,
`section.sass` (grid/cell mixins), `SectionControls.tsx` (knob, radioCell, SectionConstruct with selectTab),
`OutSection`, `LfoSection`, `PitchSection`, `OperatorSection`, `AlgorithmSection`, `DxEnvelopeEditor` (4-stage
widget, rate-proportional widths, drag = rate/level). Roles per algorithm: `Tubular.roles()` in the adapter
(bus walk mirrored from fm.rs, tested). ALGO diagram: canvas placed by `place()` (carriers bottom row,
modulators centred over targets, no overlaps in all 32).

## Frame

A tab column on the left, the selected section on the right, the device peak meter in the frame as now.
Cartridges and presets stay out of the editor (device menu: Load .syx…, Audition, Engine).

Tabs, top to bottom: `OP 1` `OP 2` `OP 3` `OP 4` `OP 5` `OP 6` `ALGO` `LFO` `PITCH` `OUT`.

## Sections

### OP 1 to OP 6 (one layout, reused)

Envelope widget (rates 1-4, levels 1-4, dragged like Neon's), Level, Mode (ratio / fixed), Coarse, Fine,
Detune (-7..+7), keyboard level scaling (Break point as a note name, Left / Right depth, Left / Right curve),
Rate scaling, Amp mod sens, Velocity sens, Switch. 22 controls per operator.

Header line: the operator's role in the current algorithm (carrier, or modulator → target), the switch, and
a miniature of the current algorithm with this operator highlighted, so the role is visible without leaving
the tab.

```
┌───────┬──────────────────────────────────────────────────────────────────┐
│ OP 1  │  OP 2 · modulator → 1     [ on ]      alg 5  6⟲ 4 2 / 5 3 1      │
│▶OP 2  │  ┌────────────────────────────┐   LEVEL  MODE   COARSE  FINE     │
│ OP 3  │  │  ENVELOPE                  │   ( )   [ratio] ( 14 ) ( 0 )     │
│ OP 4  │  │   ╱╲                       │   DETUNE  VELO   RATE SC  AMS    │
│ OP 5  │  │  ╱  ╲___                   │   ( +2 )  ( 6 )  ( 3 )   ( 0 )   │
│ OP 6  │  │ ╱       ╲_____             │                                  │
│ ALGO  │  │           R1 R2 R3 R4      │   KEY SCALING                    │
│ LFO   │  │   ( ) ( ) ( ) ( )  rates   │   BREAK  L DEPTH  L CURVE        │
│ PITCH │  │   ( ) ( ) ( ) ( )  levels  │   ( C3 ) ( 0 )    [-LIN]         │
│ OUT   │  └────────────────────────────┘          R DEPTH  R CURVE        │
│       │                                          ( 60 )   [-LIN]         │
└───────┴──────────────────────────────────────────────────────────────────┘
```

### ALGO

The algorithm picker as a drawn diagram (32 layouts, feedback path marked, stepper and direct pick),
Feedback 0-7, Osc key sync. Below it a six-strip overview: Level and Switch of every operator side by side,
carriers and modulators named, so balancing carriers against modulators needs no tab hopping. Clicking a
strip's label jumps to that OP tab.

```
┌───────┬──────────────────────────────────────────────────────────────────┐
│ OP 1  │  ALGORITHM  [ 5 ]  ◂ ▸        FEEDBACK   OSC SYNC                │
│ OP 2  │  ┌─────────────────────┐      ( 6 )      [ on ]                  │
│ OP 3  │  │  6⟲   4     2       │                                          │
│ OP 4  │  │  │    │     │       │      OP  1    2    3    4    5    6     │
│ OP 5  │  │  5    3     1       │     LVL ( )  ( )  ( )  ( )  ( )  ( )    │
│ OP 6  │  │  ═════════════ out  │      ON [x]  [x]  [x]  [x]  [x]  [x]    │
│▶ALGO  │  └─────────────────────┘                                          │
│ LFO   │  carriers 1 3 5 · modulators 2 4 6                                │
│ PITCH │                                                                   │
│ OUT   │                                                                   │
└───────┴──────────────────────────────────────────────────────────────────┘
```

### LFO

Wave, Speed, Delay, PM depth, AM depth, Key sync, Pitch mod sens.

### PITCH

The pitch envelope widget alone (rates 1-4, levels 1-4, level 50 = no shift, drawn around the centre line).

### OUT

Cutoff, Resonance, Output, Play mode (mono / poly), Transpose, Tune, Engine (Mark I / Modern).

## Open

- Tab labels as text (above) or icons with tooltips.
- The algorithm diagrams: one SVG per algorithm generated from the `ALGORITHMS` bus table in `fm.rs`
  (out bus, in bus, feedback flags) rather than 32 hand-drawn pictures.
- Envelope widget: reuse Neon's `EnvelopeEditor` with a 4-stage variant or write a DX-specific one
  (rates are speeds, not times, so the drawn segment lengths come from the measured rate scale in
  plans/tubular.md).

## Order of work

1. Frame with the tab column and empty sections, tab state kept per editor instance.
2. OUT and LFO (plain knobs, proves the grid).
3. PITCH (the envelope widget, 4 stages).
4. OP tab with the widget reused, key scaling block, role header.
5. ALGO with the generated diagrams and the overview strips.
