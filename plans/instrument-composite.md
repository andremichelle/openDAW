# Instrument Composite

One instrument slot that hosts N parallel layers. Every layer is a complete chain (midi-fx -> instrument ->
audio-fx -> strip), all layers read the same note stream, their audio is summed into the unit's strip. Covers
issue #141 (instrument / fx layer device). Sibling of the FX Composite (`AudioEffectCompositeBox`) and the
planned Midi Composite (`plans/midi-composite.md`).

## What exists today (on main, commit 7f0bb17b1 and followers)

- Schema: `CompositeDeviceBox` (instrument, field 10 `cells`) and `CompositeCellBox` (composite 1,
  instrument 2, midi-effects 3, audio-effects 4, index 5). `Pointers.CompositeCell`.
- Registration: second entry of `COMPOSITES` in `packages/studio/core-wasm/src/engine-modules.ts`
  (`indexKey 5`, cell fields 2 / 3 / 4, every other key 0).
- Engine: `build_cell` in `crates/engine/src/composite.rs` folds a cell's chains around its instrument through
  the shared `build_cluster`, on the full broadcast note stream. Cells are rebuilt wholesale on change.
- Cargo tests: `a_cell_composite_builds_its_hosted_instrument_and_keeps_it_across_reconcile`,
  `live_note_signal_reaches_a_cell_composites_sequencer`.

Missing: box adapters, `BoxAdapters` visitor, instrument factory, editor, per-layer strip / mute / solo / label,
preset + clipboard + project-transfer coverage, scripting facade, wasm end-to-end test, manual page. Nothing in
the studio can create one, so no saved project contains these boxes yet.

## Naming

The CELL is the chain host, not the composite. `CompositeCellBox` is an audio unit minus tracks and sends: it
holds an instrument host plus both effect hosts, and its adapter will be a full `DeviceHost`
(`hostsInstrument` true). `CompositeDeviceBox` is the instrument device that owns N of those hosts and the sum.

What is wrong with the current names is that they claim the whole family. There are four composites now
(FX, Stereo, Frequency Split, soon Midi), and only this one is called plain "Composite".

Decided (decision 1), matching `AudioEffectCompositeBox` / `AudioEffectCompositeCellBox` and `MidiCompositeBox` /
`MidiCompositeCellBox`:

- `CompositeDeviceBox` -> `InstrumentCompositeBox`
- `CompositeCellBox` -> `InstrumentCompositeCellBox`
- `Pointers.CompositeCell` -> `Pointers.InstrumentCompositeCell` (auto-numbered, never stored)

The rename is free NOW (no creator in the studio, so no project holds the class name) and becomes a migration
the moment the factory ships. It must be phase 0. Touches: the two forge schemas + `devices/index.ts`, enums,
the `COMPOSITES` entry, comments in `composite.rs` / `tests.rs`, `plans/wasm-audio/composite-unification.md`,
then enums build -> forge -> boxes build -> Rust `registry.rs` -> `npm run generate-all-boxes`.

If "host for a chain" should show in the name instead, the alternative for the cell is `InstrumentChainBox`.
That breaks the `*CompositeCellBox` symmetry with the other two families, so it is not the recommendation.

## Decisions (2026-09-19)

1. RENAME, as above, as phase 0.
2. Layer mute GATES AT THE STRIP, like an FX Composite entry: the layer keeps running, mute and solo are
   automatable, unmute is instant and in phase.
3. INFINITE NESTING, as in the FX Composite: a layer may host a Playfield or another Instrument Composite, at
   any depth. Engine work, see dry-run finding 4.
4. NO key / velocity split in this device. Splitting is done by new midi-effect plugins that filter notes
   (key range, velocity range), placed in a layer's own midi chain. Separate work, not in this plan. The cell
   carries no range fields.
5. Macros (#141 item 4) are OUT of this plan. They are a one-source many-target modulation router and belong
   on the modulation infrastructure, not inside this device.

Still open:

6. Relation to `composite-unification.md`. That plan folds Playfield into this box type. Keep it separate and
   AFTER this plan. Nothing here may block it: the cell keeps `index` as pure position, routing stays an
   instrument property.

## Schema additions (cell)

Keys 4 and 5 are taken on the instrument cell, so label / minimized cannot sit where the FX entry has them.
The strip block reuses the FX entry's numbers so both cells read alike.

- 6 `label` string
- 7 `minimized` boolean
- 40 `gain` float32 dB, `ParameterPointerRules`
- 41 `mute` boolean, `ParameterPointerRules`
- 42 `solo` boolean, `ParameterPointerRules`
- 43 `pan` float32 bipolar, `ParameterPointerRules`
- box `pointerRules` additionally accept `Pointers.Editing` (a layer is entered like an FX entry)

Registration then becomes `childMuteKey 41, childSoloKey 42, childVolumeKey 40, childPanKey 43`. The engine
already reads those keys from the child box, which for a cell composite is the cell
(`composite.rs:472 / 558 / 575`). Non-zero volume / pan keys give the layer its strip with today's code
(`build_slot_strip`). Mute / solo need new engine work, see dry-run finding 2.

## Known engine hazard: shared unit-level midi effects

`reconcile_composite` builds the unit's midi effects ONCE and hands the same `Rc<PluginMidiEffect>` instances
to every child (`wiring.rs:605`, folded in `wire_cluster` / `build_cluster`). Each child pulls them again per
block. Stateless effects (Pitch, Velocity) are fine. A stateful one (Arpeggio, Zeitgeist) is pulled N times over
the same window. Playfield has the same shape today, so this is not new, but layers make it the common case
(an arp in front of two stacked synths).

The fix is per-layer replicas of the unit-level midi effects, for CELL composites only (`midi-composite.md`
phase 4: pool key (box uuid, layer index), layer 0 owns the device-address broadcasts, automation and teardown
reach every replica). Playfield keeps its shared instances exactly as today. Write the failing test first (arp
at unit level, two layers, both layers receive identical note sets). Do not paper over it with a per-block
cache.

## Notes: reading the source N times with different windows

### Rule 0: nothing existing changes

A leaf unit and a Playfield run the SAME code and produce the SAME events as today, bit for bit. No existing
test assertion is edited. Every new behaviour is opt-in and switched on only by `build_cell`, a topology no
saved project contains. This rules out both fixes of the midi plan as written:

- Hashed chance changes which chance notes play in existing projects. The seeded stream is a
  TS parity contract (`the_chance_roll_stream_matches_the_ts_sequencer_seed`,
  `chance_gates_notes_on_the_seeded_stream`, the Open Up vocal). Not acceptable.
- An engine-driven clip advance with the UNWARPED block window changes a leaf unit that has a Zeitgeist and
  launched clips. Today its single sequencer advances the machine with the WARPED window. Not acceptable.

`midi-composite.md` findings 1 and 3 need the same correction before that plan is executed.

### What is already fine

Every layer owns a `NoteSequencer` (`build_cell`), so retainer, ids, raw and audition notes are per layer,
and region content is a pure read. A layer IS a feed. No merge, no re-id, notes die in the layer's instrument.
`NoteTimeline` / `NoteFeed` is not a prerequisite. Two shared, order-dependent pieces break once a layer has
its own Zeitgeist. Its window is then shifted BEHIND or AHEAD of the block depending on the groove amount
(Moebius ease per groove cell, `h` above or below 0.5), so a history-only log is not enough either.

### Clips: one advance per block, pure readers (opt-in)

`ClipSequencer::iterate` stays untouched, leaf units and Playfield keep calling it. For a unit whose
instrument is a CELL composite, and only there:

- The engine advances the unit's tracks ONCE per block with the canonical block window, through today's
  `iterate`, BEFORE any node processes. The quantum's blocks are collected up front (`lib.rs:1517`) and nodes
  then run node-major over all of them, so the hook sits right after block collection. It walks the
  cell-composite unit bindings (`AudioUnitBinding.track_sets`). `LiveClipInfo` is private to
  `note_sequencer.rs`, so the advance is a new public engine-env function next to it, not engine code.
- That advance records per track a bounded TRANSITION log (position, clip before, clip after), not sections.
  A discontinuous block clears the log.
- Cell sequencers run `ClipRead::Shared` (set in `build_cell`) and never mutate. `sections(track, from, to)`
  resolves behind the cursor from the log (most recent entry covering the position) and AHEAD of the cursor
  by running the handover rule on a COPY of `(playing, waiting)`. That is exact because the handover position
  is a pure function of state and position (`quantize_floor`), verified in `iterate`. Assumption to pin in a
  test: a window is shorter than the playing clip's duration (two boundaries inside one window would differ).
- Launch, stop and handover fire once, every layer sees the same sections, read order does not matter.
- Layer clips therefore hand over at the unwarped bar line. There is no legacy to preserve, no saved project
  has a cell composite.

### Chance: no change, one documented limit

The sequential seeded stream stays everywhere, cells included. Every sequencer has the same seed, so layers
agree as long as they pull identical windows, which is how Playfield slots agree today. One layer equals the
bare instrument exactly, chance notes included. Only exception: a unit-level Zeitgeist over launched clips,
where the bare unit hands over at the warped bar line and the composite at the unwarped one.

The one limit: a Zeitgeist INSIDE a layer shifts that layer's windows, its roll order drifts, and that layer
may keep or drop a chance note differently from its siblings. A Zeitgeist at unit level is harmless (every
layer sees the same warped window). Pin the limit with a test that documents it, and state it in the manual
page. If it ever matters, the fix is an identity roll (seeded from a hash of the note and the loop pass)
switched on for THAT composite only, never globally.

### Not new with layers, out of scope

A non-monotonic window when a groove amount is automated (a leaf unit with Zeitgeist has it today). Live
notes (already fanned out to every cell sequencer, `live_note_signal_reaches_a_cell_composites_sequencer`).
A Playfield slot with its own Zeitgeist over launched clips double-advances today. `ClipRead::Shared` would
fix it, but that is a behaviour change to an existing topology, so it is a separate decision, not part of this.

### Tests (cargo, engine-env + engine)

- Two shared readers, one shifted behind, one shifted ahead, around a launch, a stop, a non-looped clip end
  and a loop wrap: `Started` / `Stopped` fire once, both readers see identical sections.
- The ahead resolve equals what the later canonical advance records.
- Guard: every existing engine-env / engine / wasm test green with ZERO edits.
- Chance: two layers with identical windows keep / drop identically, and one layer equals the bare unit.
  A documenting test for the limit (Zeitgeist inside one layer, chance-heavy region).
- Zeitgeist inside layer A leaves layer B unshifted.
- Arp at unit level, two layers, identical note sets per layer.

## Testing rule: everything is proven by test code

Every behaviour in this plan is covered by an automated test, written FIRST and seen failing. Nothing counts
as done on a manual check alone. The browser checkpoint in phase 3 is additional, never a substitute.

- Engine-env (note / clip primitives): `crates/engine-env/tests/`, `cargo test -p engine-env`.
- Engine wiring (cells, strip, nesting, replicas, reconcile): `crates/engine/src/audio_unit/tests.rs`,
  with `crate::pull_lock()` around the global `PULL`.
- Audible end-to-end through the real `engine.wasm`: `packages/studio/core-wasm/test/`, helper
  `load-full-engine.ts`, template `composite-audio.test.ts`.
- Adapters, factory, copy paths: vitest next to the code (`CompositeAdapters.test.ts`,
  `PresetEncoder.composite.test.ts`, `DevicesClipboardHandler.test.ts`, `EffectFactories.test.ts`).
- UI: every decision the editor takes (which instruments a layer offers, add / remove / reorder / swap a
  layer, move effects across layers) lives in a `ProjectApi` / adapter function with its own vitest. The
  TSX only calls it.
- Rule 0 guard: the full existing suites run green with zero edited assertions after every phase.

## Dry-run findings (2026-09-19, read against the real code)

1. Rename touch points are complete: two forge schemas + `devices/index.ts`, `Pointers.ts`, the `COMPOSITES`
   entry, `registry.rs` (generated), five lines in `audio_unit/tests.rs`, comments, plans. Generated boxes are
   gitignored. `MenuItems.forCompositeCell` and `CompositeCellEditor` belong to the FX entry despite the name,
   they are NOT part of the rename. The wasm test app that once mounted a composite page is deleted
   (`72a65b5aa`), it built its graph in memory and never saved.
2. Layer mute / solo does NOTHING for cells today. `build_one_child` creates the `gate` cell, but `build_cell`
   pulls through `PullLink::Source`, not `SlotRoute`, so the gate is never read. With decision 2 the template
   is the FX entry, not the Playfield slot: `ChannelStripProcessor` with `mute` + `forced_silent` for the
   cross-layer solo, bound static + automated + modulated like `bind_entry_strip_params`
   (`effect_composite.rs:412`). The slot strip (`build_slot_strip`) only covers volume / pan.
3. A cell is rebuilt WHOLESALE on any change (`reconcile_wholesale_child`): adding a reverb to a layer tears
   down the layer's synth and every effect, voices and tails cut. A leaf unit and a Playfield slot are
   edge-only. Layers must be edge-only too: route the cell through `reconcile_slot_cluster` with the chain
   fields taken from the cell keys instead of `DeviceReg`. Part of phase 1. It is also the first engine step
   of `composite-unification.md`.
4. A composite or Playfield INSIDE a layer is not supported today. `build_cell` resolves the hosted instrument
   with `device_for_type` (leaf plugins only). Nesting works only for DIRECT children. Decision 3 requires it:
   `build_cell` checks `composite_for_type` on the hosted instrument first and, on a hit, builds a nested
   `CompositeBinding`. The nested composite's inherited midi fold is the parent's `unit_midi` PLUS this
   layer's own midi chain (replicated per nested child, finding 6), and the layer's audio chain + strip sit
   behind the nested sum. A nested subtree is rebuilt wholesale today (`composite_dirty`), so finding 3 has to
   reach nested bodies too, otherwise an edit deep inside cuts every voice above it. Cycle guard: a composite
   can never contain itself because boxes are owned, not referenced, confirm in the adapter test. Tape and
   MIDI Output are unit-level paths (`reconcile_tape`, `reconcile_midi_out`) and cannot sit in a layer, the
   layer's instrument picker excludes them.
5. TS side fits without new API: `InstrumentFactory.create` already takes the host FIELD, so an instrument is
   created straight into `cell.instrument`. Swapping needs a new function, see finding 10. Instrument adapters resolve
   `deviceHost()` through `Devices.isHost`, so a cell adapter with `class = "device-host"` is picked up, and
   `audioUnitBoxAdapter()` delegates upward as the Playfield slot does. `hostsInstrument` is read in one UI
   file only (`DevicePanel.tsx`), `inputAdapter` in eleven files, all to be checked in phase 3.
6. Unit-level midi effects are pooled per unit in `reconcile_composite` (`wiring.rs:596`). Replicas need the
   pool key (box uuid, layer index) there, and become edge-only together with finding 3.

## Second dry run (2026-09-19)

7. The clip hook sits right before `context.process(&ProcessInfo {blocks})` (`lib.rs:~1590`), after the
   quantum's blocks are collected. It must mirror the sequencer's own guard and advance only blocks flagged
   TRANSPORTING + PLAYING, a paused free-running quantum advances nothing. An EMPTY composite still advances,
   so clip `Started` / `Stopped` feedback works with zero layers.
8. `reconcile_slot_cluster` already takes the midi / audio uuids as ARGUMENTS (`wiring.rs:970`), only its
   caller reads them from `DeviceReg`. Edge-only cells (finding 3) need no change inside it, the cell caller
   passes the chains observed on the cell keys.
9. Live notes already recurse through nested bindings (`CompositeBinding::collect_note_sources`). A composite
   inside a cell needs the `Cell` arm to forward to its nested binding.
10. Correction to finding 5: `ProjectApi.replaceMIDIInstrument` casts the instrument's host to `AudioUnitBox`
    (`ProjectApi.ts:163`) and reads its capture. Swapping a LAYER's instrument needs a host-generic variant
    that creates into `target.host`'s field and skips the capture step. New function, the existing one stays
    untouched.
11. Copy paths carry no per-box code. Presets, clipboard and transfer walk `graph.dependenciesOf` with
    `alwaysFollowMandatory`. A layer's instrument and effects point at the cell, the cell points at the
    composite, both mandatory, so the subtree should travel as the FX entries do. Expect tests only. The case
    to pin: copying ONE effect out of a layer must not drag the cell, the composite or sibling layers along
    (the effect-preset path excludes `AudioUnitBox` only).
12. `DevicePanel.tsx:145` is the only UI read of `hostsInstrument`. CORRECTED by finding 13, the panel does
    need a new visitor arm.

## Third pass: plan vs code (2026-09-19)

13. Finding 12 was WRONG. `DevicePanel.getContext` (`DevicePanel.tsx:86`) resolves the panel context through a
    box visitor with three arms (audio unit, Playfield slot, FX entry) wrapped in `asDefined`. Entering a layer
    without a new `visitInstrumentCompositeCellBox` arm panics. The arm returns the cell host plus the cell's
    hosted instrument.
14. Nested chain hosts are enumerated by `instanceof` in several places, none is generic. Every one needs a
    layer arm, each with a test (close all gaps in one pass):
    `TracksManager.ts` (`nestedHost`, `deviceOrderKey`, `#watchDeviceChain`, which must also watch the layer's
    midi chain and cells collection), `SidechainButton.tsx:31` (walks up FX entries only, a layer in between
    stops the walk), `DeviceEditorFactory.tsx`, `AudioCompositeEntry.tsx`, `AudioCompositeEntryDnD.ts`,
    `CompositeCellEditor.tsx` (typed to `AudioEffectCompositeCellBoxAdapter`), `BoxAdapters.ts`, adapters
    `index.ts`.
15. Verified as written: node-major processing (every processor gets the whole `ProcessInfo {blocks}`), the
    leaf pull order Source -> Zeitgeist (so a leaf advances clips with the warped window), child keys read
    from the cell uuid, `reconcile_slot_cluster` taking chain uuids as arguments, the generic
    `dependenciesOf` copy paths, `InstrumentFactory.create` taking a host field, the chance tests, all file
    paths named in the testing rule.

## Status

- Phase 0 DONE (2026-09-19): rename, registry + `all-boxes.od` regenerated, wasm rebuilt.
- Phase 0b DONE (2026-09-19), uncommitted:
  - `ClipSequencer::advance` + `sections_shared` (canonical blocks ring, handover log, pure ahead prediction),
    `NoteSequencer::set_clip_read(ClipRead::Shared)`, `advance_clips`. `iterate` untouched.
  - Engine: `Engine.clip_read` is `Shared` while a cell composite's cascade builds (both entry points, so
    nested slot sequencers under a cell composite are shared too), `advance_shared_clips` runs before
    `context.process`, transporting + playing blocks only.
  - Every cell folds its OWN replica of each unit-level midi effect (`PluginMidiEffect::replica`, same box,
    same note-bits slot). Repro before the fix: two layers behind a unit-level arp sounded continuously,
    0 steps instead of 31.
  - Tests: 11 clip + 4 sequencer + 2 chance (engine-env), 2 engine, 2 wasm files
    (`instrument-composite-unit-arp`, `instrument-composite-layer-zeitgeist`). No existing assertion edited.
  - Automation on a replicated unit-level arp reaches every layer (31 -> 11 steps, bare and both layers), a
    leaving cell releases its replica's observations (`a_leaving_cell_releases_its_midi_replica`).
  - PLAYFIELD behind a unit-level arp (`playfield-unit-arp.test.ts`, RED, existing bug, engine without these
    changes behaves the same): silent even with ONE pad. Root cause: `pull_from_slot_route` (`lib.rs:1120`)
    writes the note-on with `duration: 0.0`, `pull_from_source` carries the duration, and the arp ignores a
    note-on with `duration <= 0` (`device-arpeggio ingest`). Fix = carry the duration, NOT applied (existing
    topology, needs a yes). The shared-instance question for several pads can only be answered after it.
  - Duration fix APPLIED (2026-09-19, `lib.rs` `pull_from_slot_route` carries `duration`): pads behind a
    unit-level arp sound now, no other test changed. Several pads: CONFIRMED broken, pad A's output changes
    when pad B joins (difference 0.5, left peak 0.5 -> 0.98), the shared arp instance is pulled once per pad.
    Fix APPLIED: every slot owns pooled replicas (`SlotCluster.unit_replicas`,
    `take_or_build_midi_replica`), edge-only like its other members. Proof that old projects run the same: a
    Playfield behind Velocity (random 0.8) + Zeitgeist renders the IDENTICAL checksum before and after
    (44693.71524412251). Stock unit-level effects: Pitch, Velocity (reseeds per note), Zeitgeist are
    pull-count independent, the arp was silent before. The one thing that changes: a STATEFUL Spielwerk
    script in front of a Playfield ran once per pad per block, now once per pad instance.

## Phases (each gated on green tests)

0. Rename (decision 1). All existing cargo + vitest suites green, `test-files/all-boxes.od` regenerated
   (`npm run generate-all-boxes` in studio/adapters, checked by `crates/studio-boxes/tests/all_boxes_fixture.rs`).
0b. Note groundwork (see "Notes"): canonical clip advance + transition log + `ClipRead::Shared`, per-layer
   replicas of unit-level midi effects. Active for cell-composite units only. Gate = Rule 0: every existing
   test green with zero edits.
1. Schema additions + registration keys, edge-only cells (finding 3), layer strip on the FX entry template
   (finding 2), nested composites inside a cell (finding 4). Cargo tests: adding / removing / toggling a layer effect keeps the layer's instrument
   processor and the sibling layers' processors, layer gain / pan reach the sum, mute and solo per
   decision 2, automation on 40 to 43 binds and terminates its `ValueCollection`s on rebind (leak test),
   layer add / remove / reorder keeps survivors' processors.
2. Adapters. `InstrumentCompositeBoxAdapter` (instrument adapter, `cells` as `IndexedBoxAdapterCollection`)
   and `InstrumentCompositeCellBoxAdapter implements DeviceHost, IndexedBoxAdapter`: both chains `Some`,
   `hostsInstrument` true, `inputAdapter` = the hosted instrument, `tracksField` / `audioUnitBoxAdapter()`
   delegate to the owning unit like `AudioEffectCompositeCellBoxAdapter` does. `BoxAdapters` visitor entries.
   Add the box to the `InstrumentBox` union (`adapters/src/factories/InstrumentBox.ts`) and the factory to
   `InstrumentFactories.ts` ("Instrument Composite", one empty layer). Rebuild the adapters dist.
3. Editor. Mirror `AudioEffectCompositeDeviceEditor` + `CompositeCellEditor` (entry list, label, gain, pan,
   mute, solo, enter). Entering a layer shows the normal device panel for that host, with the instrument slot
   enabled. Adding a layer picks an instrument. `AudioCompositeEntryDnD` and `ProjectApi.moveEffects` already
   work on `DeviceHost`. Every enumeration site of finding 14 gets its layer arm here, plus the panel arm
   of finding 13. Browser checkpoint before phase 4.
4. Copy paths. PresetEncoder / Decoder subtree (instrument + both chains per layer, nested composites),
   `DevicesClipboardHandler`, project transfer, modulators travelling with a layer (issue 385 paths). Tests
   mirror `PresetEncoder.composite.test.ts` and `CompositeAdapters.test.ts`.
5. Wasm end-to-end, `packages/studio/core-wasm/test/instrument-composite.test.ts`: one layer equals the bare
   instrument, two layers equal the sum, mute / solo, layer audio-fx only affects its layer, FX Composite
   nested inside a layer, Playfield inside a layer, composite inside a layer inside a composite, live notes reach every layer, the shared-arp test
   from the hazard section.
6. Scripting facade (`Api.ts`, `Facades.ts`, `DeviceBoxes.ts`, inventory example) and manual page
   `devices/instruments/instrument-composite.md` + `DeviceManualUrls`.

## Open questions

- Freeze, export stems and the per-unit live meters with a composite instrument: confirm in phase 5 that they
  see the summed output and nothing per layer is expected.
- Whether `enabled` on a layer is needed next to mute (the FX entry deliberately has none).
