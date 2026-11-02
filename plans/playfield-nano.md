# Playfield plays Nano: replace the slot player

Status: planned 2026-11-02, no code yet.

## Goal

1. Every Playfield pad becomes a cell holding a Nano, its own midi-fx and audio-fx chains.
2. A new MIDI-FX, Note Filter, sits first in each pad's midi chain. It passes one key and remaps it to the
   target key (default 60 = C3, Nano's default root key), so Nano plays the sample at its original pitch.
3. The slot player (`PlayfieldSampleBox` + `device-playfield-sample`) is retired. Old projects migrate on load.
4. Later: a pad accepts any instrument, because a cell already hosts any instrument.

## Where we are

1. `InstrumentCompositeBox` + `InstrumentCompositeCellBox` exist and run in the engine (`build_cell`, cell strip
   gain 40, mute 41, solo 42, pan 43, cell `index` 5). No note routing, no choke.
2. Playfield is registered as a direct-children composite (`engine-modules.ts` COMPOSITES): slot `index` 15
   routes, `exclude` 42 chokes, mute / solo drop note starts in `SlotRoute` (`lib.rs` `pull_from_slot_route`),
   the slot device filters by its own `index`.
3. Choke is computed in `SlotRoute` at the BASE of the pull chain from the raw pitch, before any midi-fx.
4. Nano (#467, 0aa4db2d8) has Mono/Poly, Pan, One-Shot, Fixed, choke fade, 64 voices steal oldest, reverse
   (start > end), loop with crossfade and loop points.
5. `plans/wasm-audio/composite-unification.md` planned folding Playfield into cells with the slot kept as the
   instrument. This plan supersedes it: same cell structure, but Nano replaces the slot.

## Note Filter MIDI-FX

1. `NoteFilterDeviceBox` (midi-effect): `note` int32 0..127 default 60, `target` int32 0..127 default 60.
2. Note starts with `pitch == note` pass with pitch rewritten to `target`, everything else is dropped. Note
   completes follow their start by id. Cent and velocity pass unchanged.
3. New crate `device-note-filter`, adapter, editor (two key selectors, note names via `MidiKeys`).
4. Useful on its own on any track (split a drum loop to one key), so it is a normal device in the menu.

## Where the pad note lives

The engine needs each pad's note for choke, the UI needs it for the grid and the drum editor mapping.
Recommendation: the Note Filter's `note` is the single source of truth.

1. The composite spec gains `router_box_type` + `router_note_key`. `child_infos` reads the note from the first
   enabled device of that type in the cell's midi chain. No filter = no routing note = no choke, plays all.
2. `exclude` moves to the cell (new cell field, e.g. 44), so choke stays a pad property.
3. Choke stays in `SlotRoute`, unchanged, fed by the notes read in 1.

## Engine

1. Playfield spec switches to cells: `childrenField` = new `pads` field, `cellInstrumentField` 2, midi 3,
   audio 4, `indexKey` 5, `excludeKey` = cell exclude, mute / solo / volume / pan = cell 41 / 42 / 40 / 43.
2. Mute semantics differ today: a Playfield pad drops note starts (a ringing voice keeps sounding), a cell
   silences at its strip. The spec gets a flag that picks one, Playfield keeps note-start drop.
3. Native tests in `audio_unit/tests.rs`: routing note from the filter, choke across cells, filter disabled,
   filter removed, two pads on one note (first wins), unit-level midi-fx below the pad chain.

## Nano gaps against the slot

To render a migrated default pad bit-identical, Nano still needs (snapshot and voice cap are accepted
deviations, see Decisions):

1. Loop without crossfade over the whole start..end window (`loop-fade` min is 0.001 s today).
2. Editor broadcast addresses: pad playheads read slot positions at the bare address and peaks at [1001],
   the Playfield UI must read Nano's broadcast instead.

## Schema and migration

1. `PlayfieldDeviceBox`: add `pads` (field 11, accepts `InstrumentCompositeCell`), deprecate `samples` (10).
2. `InstrumentCompositeCellBox`: add `exclude`.
3. `PlayfieldSampleBox`: deprecated, kept for deserialization only. The crate stays until migration is proven.
4. `migratePlayfieldDeviceBox` (2nd pass, on `boxes().slice()`), per slot:
   1. cell: `index` = slot index, gain = volume, pan, mute, solo, exclude.
   2. Note Filter: `note` = slot index, `target` 60, first in the cell's midi chain, then the slot's midi-fx.
   3. Nano: file, tune = pitch, sample-start / end, attack, release, polyphone, root 60.
      Gate Off = one-shot, On = gated, Loop = loop with loop points = start / end and no fade.
   4. Audio-fx move to the cell, then the slot box is deleted.
5. Regenerate boxes, Rust registry, `all-boxes.od`.
6. Render test: `core-wasm/test/fixtures/projects/playfield.od` before and after migration, stems compared.

## UI and other consumers

About 40 TS files touch the Playfield boxes. Each one moves to cells + Nano:

1. Playfield editor: grid, slot editor (becomes the pad's Nano editor), drag and drop, octave selector.
2. Chop dialog and auto-chop create cells with Nano + Note Filter.
3. Presets (`PresetEncoder.playfield.test.ts`), scripting API, SDK consumers (additive, old names kept).
4. Sample usage (Storage "Delete unused", SampleGarbage, bundle export) must find samples through Nano.
5. Drum editor `NoteMapping` (plan `drum-editor.md`) reads pad notes from the Note Filter, labels from Nano.

## Phases

1. Note Filter MIDI-FX: box, crate, adapter, editor, native + wasm tests.
2. Nano gaps 1 and 2, plus a parity test: one slot versus Nano + Note Filter in a cell, all gate modes,
   reverse, mono, choke, bit-identical at default parameters.
3. Engine: cell-based Playfield spec, router note, cell exclude, mute flag, tests.
4. Schema + migration + `playfield.od` render test.
5. UI: Playfield editor, chop, presets, scripting, sample usage. Browser checkpoint per step.
6. Later: any instrument on a pad (device browser on a pad, generic pad view, pad label from the instrument).

## Decisions

1. The Note Filter owns the pad note. Choke, the pad grid and the drum editor read it from there.
2. Pad mute keeps today's behaviour: new notes are dropped, a ringing note plays on.
3. The Note Filter's `target` is a free user setting, no automatic link to the instrument. Migration sets it to
   the Nano root key it creates (60).
4. Migrated pads accept two deviations: Nano reads parameters live (the slot snapshots them at note start), and
   Nano sounds up to 64 overlapping notes per pad (the slot 16). Both only differ under automation, edits during
   a sounding note, or more than 16 overlapping hits on one pad. Nano gains no snapshot mode and no voice cap.
