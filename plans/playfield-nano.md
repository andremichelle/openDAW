# Playfield plays Nano: replace the slot player

Status: planned 2026-11-02, phase 1 committed (0fe8e500c), dry run 2026-11-03 (issues folded in below, open
decisions at the end).

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
   The slot device filters AFTER the unit midi-fx (`wire_cluster`: SlotRoute, unit midi-fx, cell midi-fx,
   instrument), so a Pitch effect on the Playfield changes which pad plays, while exclude still sees the raw
   pitch. That mismatch exists today.
4. The cell-based composite branch only gates `midi_out` and mutes at the cell strip. It has no note-start drop
   and no `route_owners` gating (first pad wins on a shared key).
5. The cell composite registers a sum meter at the Playfield bare address and layer meters at the cell uuid.
6. Nano (#467, 0aa4db2d8) has Mono/Poly, Pan, One-Shot, Fixed, exclude fade, 64 voices steal oldest, reverse
   (start > end), loop with crossfade and loop points.
7. `plans/wasm-audio/composite-unification.md` planned folding Playfield into cells with the slot kept as the
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
3. Routing sits AFTER the Playfield's own midi-fx and BEFORE the pad's midi-fx, like the slot filter today. This
   is a new pull step, not `SlotRoute` at the base. A note start passes when its pitch equals the pad key and is
   rewritten to the pad `key`. A note complete follows its start by id, so changing the pad key or `key` during
   a sounding note never hangs a note.
4. Exclude moves with the routing, so it sees the same pitch as the routing: a pad with `exclude` set is
   silenced when a sibling pad with `exclude` set receives its pad key.
5. Note completes by id: Nano releases by id, but later instruments like MIDI Output release by pitch, so the
   router remembers the rewritten pitch of every note it passed. Fixed table, size needs approval (decision 2).
6. Two pads on one key: the first pad owns it (`route_owners`), the others drop it, as today.
7. Mute drops note starts on the pad (a spec flag, Instrument Composite keeps strip mute). Solo likewise.
8. Pad on/off: cells have no `enabled` field. The slot `enabled` (22) migrates to Nano `enabled`.
9. Sidechain: a pad is a sidechain source today, `InstrumentCompositeCellBox` lacks `Pointers.SideChain` in its
   pointer rules. Add it, register the pad output at the cell uuid, keep the label.

## Engine

1. Playfield spec switches to cells: `childrenField` = new `pads` field, `cellInstrumentField` 2, midi 3,
   audio 4, `indexKey` 5, `excludeKey` = cell exclude, mute / solo / volume / pan = cell 41 / 42 / 40 / 43.
2. Mute semantics differ today: a Playfield pad drops note starts (a ringing voice keeps sounding), a cell
   silences at its strip. The spec gets a flag that picks one, Playfield keeps note-start drop.
3. New pull step for routing + remap + exclude between unit midi-fx and cell midi-fx (`wire_cluster`), with
   `route_owners` gating on the cell branch.
4. Meters: pad meters at the cell uuid, the Playfield sum at the bare address. The Playfield UI reads them there.
5. Native tests in `audio_unit/tests.rs`: pad key routing, remap to `key`, key edits during a sounding note,
   exclude across cells, two pads on one key (first wins), a Pitch effect on the Playfield changes the pad,
   pitch-based release through the id table, mute drops starts only, sidechain from a pad.

## Nano gaps against the slot

To render a migrated default pad bit-identical, Nano still differs in (snapshot and voice cap are accepted
deviations, see Decisions). Which ones get built depends on decision 1:

1. Envelope lengths: the slot truncates attack, release and fast release to whole samples, Nano keeps
   fractions. Changing Nano conflicts with its `legacy_parity` test.
2. Release shape: the slot holds full level for the attack length after the attack and uses another release
   formula, a release during the attack behaves differently.
3. Fast release (5 ms on mono retrigger or exclude) has other semantics.
4. Gain multiply order differs, so rounding differs.
5. Gate Off end: the slot releases past `sample-end` (chopped pads keep ringing into the release), Nano cuts.
   The slot also checks `num_frames`, Nano checks the window end.
6. Reverse writes one sample more in Nano.
7. Gate On has a 5 ms fade before the end in the slot, Nano none.
8. Loop without crossfade over the whole start..end window (`loop-fade` min is 0.001 s today).
9. Tune: the rate formula rounds differently (`exp2f` split).
10. Sub-frame windows (shorter than one frame) are handled differently.
11. Broadcast: pad playheads read slot positions at the bare address and peaks at [1001], the Playfield UI must
    read Nano's broadcast instead.

## Schema and migration

1. `PlayfieldDeviceBox`: add `pads` (field 11, accepts `InstrumentCompositeCell`), deprecate `samples` (10).
2. `InstrumentCompositeCellBox`: add `exclude` and `key`.
3. `PlayfieldSampleBox`: deprecated, kept for deserialization only. The crate stays until migration is proven.
4. `migratePlayfieldDeviceBox` (2nd pass, on `boxes().slice()`), per slot:
   1. cell: `index` = slot index, `key` 60, gain = volume, pan, mute, solo, exclude, the slot's midi-fx.
   2. Nano: file, tune = pitch, sample-start / end, attack, release, root 60, every value written explicitly:
      polyphone false unless set (slot default mono, Nano default poly), Nano volume 0 dB (default -3 dB),
      Fixed Pitch on (the slot ignores note cent and pitch), `enabled` = slot `enabled`.
      Gate Off = one-shot, On = gated, Loop = loop with loop points = start / end and no fade.
   3. Audio-fx move to the cell, then the slot box is deleted.
   4. EVERY incoming pointer on the slot moves to its new target: automation, modulation, MIDI learn, sidechain,
      editing, selection. A pointer left behind is deleted by `migrateUnsatisfiedMandatory`.
   5. Unmapped fields: `icon`, `minimized` and the label go to the cell / Nano. `gate` automation has no single
      Nano target. The release range differs (slot 5 s, Nano 8 s), so normalized automation is rescaled.
5. No version gate: migration runs on every load and decides from the box state (a Playfield with `samples` and
   no `pads`). Two clients in a live room must not both migrate and create duplicate cells.
6. Presets, the devices clipboard and paste-as-layer never run migration. They need the same migration hook.
7. Regenerate boxes, Rust registry, `all-boxes.od`.
8. Render test: `core-wasm/test/fixtures/projects/playfield.od` before and after migration, stems compared.

## UI and other consumers

About 40 TS files touch the Playfield boxes. Each one moves to cells + Nano:

1. Cell adapter: `InstrumentCompositeCellBoxAdapter.compositeDevice()` assumes an `InstrumentCompositeBox`
   parent and throws for a Playfield. This breaks the device host, sibling lookup and every Nano on a pad.
   Make it parent-generic or add a pad cell type.
2. Layer commands (duplicate / delete layer in the menu, `ProjectApi`, scripting) renumber cell `index` densely.
   On a Playfield the index is the pad key and must stay.
3. Playfield editor: grid, slot editor (becomes the pad's Nano editor), octave selector.
4. Cell editor: shows `index + 1` and the label "Nano". A pad shows its note name and the sample name.
   Swapping a pad's instrument already works there (drag, preset), earlier than phase 6.
5. Drag and drop between pads (`SlotDragAndDrop`) searches all boxes by `index` and must stay inside one
   Playfield.
6. Removing a sample (`SampleSelector`) deletes the slot today. See decision 3.
7. `PlayfieldDeviceBoxAdapter` (`samples`, `chop`, `reset`, `labeledAudioOutputs`), `InstrumentFactories`, the
   chop dialog and auto-chop create cells with Nano.
8. SDK: the exported adapter API and the documented `chop` behaviour change. Keep old names working.
9. Scripting: `PlayfieldSlot` (`gate` 0/1/2), `addSample`, `SideChainSource`, the acid and inventory examples.
10. `TracksManager` / `TrackOrder` `#watchLayers` only follow Instrument Composite cells. Device panel visitors
    that handle only `PlayfieldSampleBox` move to cells.
11. Presets (`PresetEncoder.playfield.test.ts`) and the clipboard tests.
12. Sample usage needs no work: Storage "Delete unused", SampleGarbage and bundle export find samples through
    `AudioFileBox`, which migration keeps. `Pointers.Sample` stays (Werkstatt and others use it).
13. Drum editor: `plans/drum-editor.md` is built on `samples` and the slot file label. Rewrite it for cells: pad
    keys from the cell `index`, labels from the instrument.
14. Tests to rewrite: `playfield-unit-arp`, `device-live-data`, `param-mapping-parity`, `differential-audio`,
    `instrument-composite-nesting` (core-wasm).

## Phases

1. Note Filter MIDI-FX: box, crate, adapter, editor, native + wasm tests. Committed 0fe8e500c.
2. Nano gaps (per decision 1), plus a parity test: one slot versus Nano in a routed cell, all gate modes,
   reverse, mono, exclude, chopped pads, at default parameters.
3. Engine: cell-based Playfield spec, routing step after the unit midi-fx, remap, exclude, id table, owner
   gating, mute flag, pad sidechain, meters, tests.
4. Schema + migration (all pointers, presets / clipboard hook, live room safe) + `playfield.od` render test.
5. UI: cell adapter, layer commands, Playfield editor, cell editor, drag and drop, chop, SDK, scripting,
   track visitors, drum editor plan, tests. Browser checkpoint per step.
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

## Open decisions

1. Bit identity costs about ten Nano changes (Nano gaps 1 to 10). Options:
   1. A slot-compatible playback mode inside Nano.
   2. Accept small differences, the parity test gets a tolerance.
   3. Old projects keep the slot player inside cells, only new pads use Nano.
2. How many held notes the pad router tracks (Pad routing 5).
3. Removing a sample from a pad: delete the cell, or keep an empty pad.
