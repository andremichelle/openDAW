# Euclid

A MIDI effect that plays Euclidean rhythms into the instrument of its unit, made to drive a Playfield: every lane
triggers one MIDI note (0 to 127), so every lane can play one pad. Branch `euclid` (from next-release d65a87749).

## Decisions (2026-11-14)

1. Name: Euclid.
2. Lanes: an open list, at most 127, added with a button. Each lane plays one note.
3. Accent: a second Euclidean ring inside the lane's circle. Accents spreads that many accents over the lane's hits,
   Acc.Rot shifts them. Accents (shown as Steps under ACCENT) goes up to the step maximum, the engine clamps it to
   the lane's hits. Accented hits play at full velocity, Velocity is the level of the other hits, so Velocity sets
   how much the accents stand out.
14. Bursts: a third Euclidean ring inside the accents. Bursts spreads that many bursts over the lane's hits, Burst Rot
    shifts them, Repeats is how many evenly spaced triggers a burst plays in its step (a roll like 3 in one step,
    2 to 8).
    Fade sets the level of the following triggers: at 0 every trigger plays at the hit's level, higher values let
    them fall towards silence. Bursts 0 is the default, so a new lane plays no bursts. Rolls leave the bursts alone.
4. Rates: 1/4, 1/8, 1/16, 1/32, each straight, triplet and dotted.
5. Note length per lane, two modes (Gate): Step (the note lasts one step at the lane's rate) or Next hit.
6. Patterns: 8 per Euclid. A pattern holds only the rhythm of every lane (Steps, Pulses, Rotate, Rate, Accents,
   Acc.Rot, Bursts, Burst Rot, Repeats, Fade), the lanes' notes, velocities, note lengths, mute and solo are shared by all patterns. A switch takes
   effect on the next bar. The pattern is automatable.
7. Randomizer: rolls the rhythm of all lanes or only the selected lane, in the current pattern. A roll changes Steps,
   Pulses, Rotate, Accents and Acc.Rot, never the rate or the bursts. Rolls are seeded and repeatable, the same roll gives the same result.
8. Global rate: ÷4, ÷2, ×1, ×2, ×4, automatable.
9. Pattern Length: one for all lanes, in steps of 1/16 at the global rate. 0 lets every lane cycle on its own, 32
   restarts every lane after 32 steps.
10. Grooves: one groove per pattern (as Surgeon).
11. Lanes have Mute and Solo, and are reordered by dragging them in the list.
15. Two lanes on the same note that hit at the same moment send one note-on, the louder one wins.
16. Off: a ninth tile next to 1 to 8 (as Surgeon). From the next bar the lanes are silent, incoming notes still pass.
17. Copy and paste a pattern: the focused tile answers Cmd+C and Cmd+V, its context menu has Copy and Paste. A pattern
    is the rhythm of every lane and its groove. Surgeon's pattern tiles get the same shortcuts (its context menu has
    them already).
18. Fade goes from -100 to 100 %. Below 0 the burst rises: the first trigger is the quietest, the last plays at the
    hit's level.
19. Chance per lane (0 to 100 %, default 100 %): the probability that a hit plays, seeded so a render repeats.
20. Export to region: the selected pattern written into a note region, as Cubed exports, to edit by hand.
21. The lane list shows a dot between note and name that lights when the lane plays a hit.
22. Note names: the instrument answers with a name only where it has one (a Playfield for its pads). Without one the
    list shows only the note, the name column stays empty, so an instrument that knows only note names never shows
    the note twice.
23. The editor fills the device body's full 176 px, the circle is 176 px square.
12. Incoming notes pass through to the instrument.
13. Note names: the editor asks the instrument of its unit for the name of every note. A Playfield answers with its
    pad names, every other instrument with the note names.

## Layout

```
┌─ (Euclid)  ⏻ Euclid ───────────────────────────────────────────────────────────────────────────────────────┐
│ ┌──────────────────────┐ ┌──── LANES ────────────────┐ ┌────────── RHYTHM ──────────┐ ┌──── PATTERN ─────┐ │
│ │        ●   ○         │ │ ▸ C1  Kick      5/16  M S │ │  Steps   Accents  Bursts   │ │ [1][2][3][4]     │ │
│ │    ○   ·   ·   ◉     │ │   D1  Snare     2/16  M S │ │   16       2        1      │ │ [5][6][7][8]     │ │
│ │      ·  ˙   ˙  ·     │ │   F#1 Closed    7/12T M S │ │  Pulses  Acc.Rot  Burst Rot│ │  Length   Rate   │ │
│ │  ●  ·  ˙5/16˙  ·  ○  │ │   A#1 Open      3/8.  M S │ │   5        1        0      │ │   32       ×1    │ │
│ │      ·  ˙   ˙  ·     │ │   +  Add lane             │ │  Rotate  Velocity Repeats  │ │  Groove [None ▾] │ │
│ │    ○   ·   ·   ●     │ │  Note   [ C1  Kick     ▾] │ │   2       80 %      3      │ │                  │ │
│ │        ○   ●         │ │  Length [ Duration ▾] 1/16│ │  Rate             Fade     │ │ Roll [Lane][All] │ │
│ └──────────────────────┘ └───────────────────────────┘ │  1/16              30 %    │ └──────────────────┘ │
│                                                        └────────────────────────────┘                      │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
  outer ring: steps (● hit, ○ rest), middle ring (·): the accents over the hits, ◉ an accented hit,
  inner ring (˙): the bursts over the hits, the playhead lights the current step
```

## Phases

0. ~~Preview on /testing~~ (signed off 2026-11-14, removed once the device was built).
1. ~~Note names~~: `InstrumentDeviceBoxAdapter.noteName?(key)`, the Playfield answers with the label of the pad's
   instrument. The editor redraws on every graph update, so a renamed pad shows at once.
2. ~~Boxes~~: `EuclidDeviceBox` (pattern -1 to 7, length, rate, seed, the lanes hub, 8 `EuclidPattern` with a groove)
   and `EuclidLaneBox` (index, note, velocity, chance, gate, mute, solo, then the ten rhythm values of each pattern at
   keys 10 + pattern * 10, named `steps-a` to `fade-h`). New pointer type `Pointers.EuclidLane`.
3. ~~Engine~~ (`crates/stock-devices/device-euclid`): the lanes arrive as one table (`abi::observe_table`, a MIDI
   effect can export `table_changed` like any device). Pulses, Rotate and the accent and burst counts go up to 32 in
   the editor and the engine clamps them to the lane. Generated notes take ids from the upper half (0x8000_0000) so
   they never meet the ids of passing notes. 18 tests, plus `core-wasm/test/euclid.test.ts` in the full engine.
4. ~~Editor~~ (`EuclidDeviceEditor`): the preview's layout on real boxes, lane values with undo, Length and Rate
   automatable, the tiles follow the engine's report of the active and the waiting pattern.
5. ~~Randomizer~~: Roll Lane and Roll All in the editor, seeded by the device's seed field, one undo step each.
6. ~~Scripting, manual, tests~~: `unit.addMIDIEffect("Euclid")`, `addLane({note, rhythms: [...]})`, manual page
   devices/midi/euclid with screenshot. Export to Note Region writes Length steps (one bar without Length) at the
   playhead, without groove and with every hit (no chance).

## Preview review (2026-11-14)

1. Pattern first, after the circle. The group of Note and Gate is called NOTE (every group after it controls the
   selected lane too).
2. Length is gone, Gate is Step or Next hit.
3. Lanes are reordered by dragging them in the list.
4. ACCENT shows its count as Steps, up to the step maximum.
5. Burst dots fade the way the triggers do: equal at Fade 0, clearly fainter towards 100 %.
