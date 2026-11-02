# Playfield plays Nano: replace the slot player

Status: planned 2026-11-02, phase 1 built.

## Goal

1. Every Playfield pad becomes a cell holding a Nano, its own midi-fx and audio-fx chains.
2. The Playfield routes the notes: a pad receives only its own key (the cell `index`) and plays it as the pad's
   `key` (default 60 = C3, Nano's default root key), so Nano plays the sample at its original pitch. Moving or
   swapping an instrument never touches a midi-fx.
3. The Note Filter MIDI-FX (phase 1) stays a general device, independent of the Playfield.
4. The slot player (`PlayfieldSampleBox` + `device-playfield-sample`) is retired. Old projects migrate on load.
5. Later: a pad accepts any instrument, because a cell already hosts any instrument.

## Where we are

1. `InstrumentCompositeBox` + `InstrumentCompositeCellBox` exist and run in the engine (`build_cell`, cell strip
   gain 40, mute 41, solo 42, pan 43, cell `index` 5). No note routing, no exclude.
2. Playfield is registered as a direct-children composite (`engine-modules.ts` COMPOSITES): slot `index` 15
   routes, `exclude` 42 excludes, mute / solo drop note starts in `SlotRoute` (`lib.rs` `pull_from_slot_route`),
   the slot device filters by its own `index`.
3. Exclude is computed in `SlotRoute` at the BASE of the pull chain from the raw pitch, before any midi-fx.
4. Nano (#467, 0aa4db2d8) has Mono/Poly, Pan, One-Shot, Fixed, exclude fade, 64 voices steal oldest, reverse
   (start > end), loop with crossfade and loop points.
5. `plans/wasm-audio/composite-unification.md` planned folding Playfield into cells with the slot kept as the
   instrument. This plan supersedes it: same cell structure, but Nano replaces the slot.

## Note Filter MIDI-FX

A general device, usable anywhere (keyboard splits, one drum out of a loop, pads).

1. `NoteFilterDeviceBox` (midi-effect), all fields automatable:
   1. `min` int32 0..127, default 0
   2. `max` int32 0..127, default 127
   3. `set` boolean, default false
   4. `transpose` int32 -127..+127 st, default 0
   5. `key` int32 0..127, default 60 (C3)
2. Note starts pass when `min <= pitch <= max`, both inclusive. Min above max passes nothing.
3. Set off: pitch + `transpose`. A result outside 0..127 is ignored, never clamped.
4. Set on: every passing note plays as `key`.
5. Velocity and cent pass unchanged. A note complete replays the pitch its start was given (by id), so edits
   during a sounding note never hang a note. A complete whose start was ignored is ignored too.
6. Editor: vertical layout of ParameterLabels in two sections.
   1. Filter: Min, Max (note names via `MidiKeys`).
   2. Transpose: Set checkbox, then one row that reads Semitones (set off) or Key (set on). Label and value
      swap in place, no layout jump. Both values are kept.
7. New crate `device-note-filter` (template `device-pitch`), adapter, menu entry, manual page.

## Pad routing

1. The cell `index` (5) is the pad key: its grid position is the note that triggers it. Exclude, the pad grid and
   the drum editor read it there.
2. New cell fields: `exclude` (e.g. 44) and `key` (e.g. 45, int32 0..127, default 60), the key the pad plays as.
   `InstrumentCompositeBox` declares neither (spec keys 0), so its cells keep the full broadcast.
3. `SlotRoute` routes per pad: a note start passes when its pitch equals the pad key and is rewritten to the pad
   `key`, before the pad's own midi-fx. A note complete follows its start by id, so changing the pad key or
   `key` during a sounding note never hangs a note.
4. Exclude stays in `SlotRoute`: a pad with `exclude` set is silenced when a sibling pad with `exclude` set
   receives its pad key.

## Engine

1. Playfield spec switches to cells: `childrenField` = new `pads` field, `cellInstrumentField` 2, midi 3,
   audio 4, `indexKey` 5, `excludeKey` = cell exclude, mute / solo / volume / pan = cell 41 / 42 / 40 / 43.
2. Mute semantics differ today: a Playfield pad drops note starts (a ringing voice keeps sounding), a cell
   silences at its strip. The spec gets a flag that picks one, Playfield keeps note-start drop.
3. Native tests in `audio_unit/tests.rs`: pad key routing, remap to `key`, key edits during a sounding note,
   exclude across cells, two pads on one key (first wins), unit-level midi-fx below the pad chain.

## Nano gaps against the slot

To render a migrated default pad bit-identical, Nano still needs (snapshot and voice cap are accepted
deviations, see Decisions):

1. Loop without crossfade over the whole start..end window (`loop-fade` min is 0.001 s today).
2. Editor broadcast addresses: pad playheads read slot positions at the bare address and peaks at [1001],
   the Playfield UI must read Nano's broadcast instead.

## Schema and migration

1. `PlayfieldDeviceBox`: add `pads` (field 11, accepts `InstrumentCompositeCell`), deprecate `samples` (10).
2. `InstrumentCompositeCellBox`: add `exclude` and `key`.
3. `PlayfieldSampleBox`: deprecated, kept for deserialization only. The crate stays until migration is proven.
4. `migratePlayfieldDeviceBox` (2nd pass, on `boxes().slice()`), per slot:
   1. cell: `index` = slot index, `key` 60, gain = volume, pan, mute, solo, exclude, the slot's midi-fx.
   2. Nano: file, tune = pitch, sample-start / end, attack, release, polyphone, root 60.
      Gate Off = one-shot, On = gated, Loop = loop with loop points = start / end and no fade.
   3. Audio-fx move to the cell, then the slot box is deleted.
5. Regenerate boxes, Rust registry, `all-boxes.od`.
6. Render test: `core-wasm/test/fixtures/projects/playfield.od` before and after migration, stems compared.

## UI and other consumers

About 40 TS files touch the Playfield boxes. Each one moves to cells + Nano:

1. Playfield editor: grid, slot editor (becomes the pad's Nano editor), drag and drop, octave selector.
2. Chop dialog and auto-chop create cells with Nano.
3. Presets (`PresetEncoder.playfield.test.ts`), scripting API, SDK consumers (additive, old names kept).
4. Sample usage (Storage "Delete unused", SampleGarbage, bundle export) must find samples through Nano.
5. Drum editor `NoteMapping` (plan `drum-editor.md`) reads pad keys from the cell `index`, labels from Nano.

## Phases

1. Note Filter MIDI-FX: box, crate, adapter, editor, native + wasm tests. Built 2026-11-02, uncommitted,
   not browser-checked.
2. Nano gaps 1 and 2, plus a parity test: one slot versus Nano in a routed cell, all gate modes,
   reverse, mono, exclude, bit-identical at default parameters.
3. Engine: cell-based Playfield spec, pad routing + remap in `SlotRoute`, cell exclude, mute flag, tests.
4. Schema + migration + `playfield.od` render test.
5. UI: Playfield editor, chop, presets, scripting, sample usage. Browser checkpoint per step.
6. Later: any instrument on a pad (device browser on a pad, generic pad view, pad label from the instrument).

## Decisions

1. The Playfield routes, not a midi-fx: the cell `index` is the pad key, the cell `key` (per pad, default C3)
   is what the instrument receives. The Note Filter is a separate general device.
2. Pad mute keeps today's behaviour: new notes are dropped, a ringing note plays on.
3. The pad `key` is a free user setting, no automatic link to the instrument. Migration sets it to the Nano
   root key it creates (60).
4. Migrated pads accept two deviations: Nano reads parameters live (the slot snapshots them at note start), and
   Nano sounds up to 64 overlapping notes per pad (the slot 16). Both only differ under automation, edits during
   a sounding note, or more than 16 overlapping hits on one pad. Nano gains no snapshot mode and no voice cap.
5. The Note Filter tracks at most 64 held notes (like Pitch), approved.
