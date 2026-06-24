# Composite unification: fold Playfield into the cell-based composite

Status: planned, to do soon. Backward compatible (deprecate, never strip; migrate on load).

## Why

We shipped TWO ways a composite child gets its fx chains:

1. Playfield, direct: the slot box IS the instrument and self-hosts its chains through device-declared
   field-key exports (`midi_effects_field()` / `audio_effects_field()`), stored in `DeviceReg`, plumbed
   through two extra `device_register` args + JS, and folded by `build_instrument`.
2. Generic, cell: a `CompositeCellBox` carries the chains, read from fixed keys, folded by `build_cell`.

The cell mechanism subsumes the device-declared one. Collapsing to cells deletes the two device exports, the
two `DeviceReg` fields, the two `device_register` args + JS, and `build_instrument` itself, leaving one
builder. Playfield becomes a `CompositeDeviceBox` of cells, each cell wrapping a playfield-slot instrument. The
render path is unchanged, cells are a build-time structure only.

## Target architecture

- One composite box type, `CompositeDeviceBox`, hosts `CompositeCellBox` cells.
- A cell wraps ONE instrument plus its own midi / audio fx chains, and carries an `index` for its position in
  the composite. Fixed cell keys: composite 1, instrument 2, midi-effects 3, audio-effects 4, index 5.
- Routing (note index, plus the choke exclude flag) is read from the instrument INSIDE each cell. The slot
  keeps observing its OWN index for self-filtering, exactly as today. Instruments with no such fields (Vapo,
  Nano) get the full broadcast and play everything.
- One engine builder, `build_cell`. `build_instrument` and the device-declared-chain machinery are removed.

## Cell display index

Each child needs a position, for the UI (which pad / channel sits where) and for a deterministic engine sort
(stable rebuilds, plus the "first child wins" tie-break when two share a note). That index belongs on the CELL,
not on the instrument: an instrument used alone in a normal unit has no composite position, so adding the field
to every instrument box would pollute all of them with a value that is meaningless outside a composite (the
"-1 / 0 when alone" awkwardness). The cell is the composite-specific container, so it is the natural home and
the instrument schemas stay clean.

So `CompositeCellBox` carries `index` (int32, key 5). The composite sorts its cells by this index, which is
SEPARATE from a slot instrument's note-routing index (field 15, on the instrument, read for the choke and
observed by the slot for self-filtering). The two are conflated in the current single `index_key`; cells split
them cleanly: cell index = position in the composite, instrument index = which note it plays.

This applies to the ALREADY-shipped `CompositeCellBox` too, which currently sorts by insertion order (the
composite observes its cells with `index_key` 0). Adding the field is independent of the Playfield fold and can
land first.

## Key decision: where routing config lives

Once everything is a `CompositeDeviceBox`, the box type can no longer say "drum machine vs bundle", so routing
(index / exclude for the choke) has to come from somewhere else. Two options:

- A. Device-declared routing (recommended, matches the one-box-type goal). The slot exports `index_field()` and
  `exclude_field()` (it already owns field 15 and observes it). The composite reads these from the instrument's
  `DeviceReg`. Routing emerges from the instruments, `PlayfieldDeviceBox` disappears. This TRADES the removed
  device-declared chains for a smaller device-declared routing, conceptually cleaner: chains are a container
  property, routing is an instrument property.
- B. Thin spec variant. Keep `PlayfieldDeviceBox` as a registered composite spec (`indexKey:15, excludeKey:42`
  plus the cell keys), with `CompositeDeviceBox` as `0, 0, cells`. Both run through `build_cell`. Less UI churn,
  but `PlayfieldDeviceBox` survives as a near-trivial entry.

Pick A for the clean end state. B is the lower-risk fallback.

## Schema, deprecate and never strip

The `deprecated` marker (`@opendaw/lib-box-forge`) keeps a field deserializable in TS while the Rust registry
EXCLUDES deprecated fields (`rust-registry.ts` filters them), so the engine simply stops decoding them. That is
exactly the behaviour we want: old projects still parse, the engine reads chains / routing from the new place.

- `PlayfieldSampleBox` stays the slot instrument's box type (the `device_playfield_slot` plugin binds to it):
  - deprecate `midi-effects` (12) and `audio-effects` (13); chains live on the cell now.
  - add a `host` (InstrumentHost) field so the slot attaches to `cell.instrument`; deprecate the `device`
    (10, Sample) attach.
  - keep `file`, `index`, `exclude`, `gate`, `pitch`, `sample-start`, `sample-end`, `attack`, `release`,
    `polyphone`, `mute`, `solo`.
- `PlayfieldDeviceBox`: under A, deprecate the whole box (kept only for deserialization + migration, no new
  instances). Under B, keep it as the thin spec host.
- Regenerate the boxes + Rust `registry.rs`, then regenerate the `test-files/all-boxes.od` fixture
  (`npm run generate-all-boxes` in studio/adapters), or the `all_boxes_fixture` golden test fails on the count.

## Migration (ProjectMigration)

Add `migratePlayfieldDeviceBox` to the 2nd pass of `ProjectMigration` (it ADDS boxes, so it must run on a
`boxGraph.boxes().slice()` copy, like the existing migrators). Per `PlayfieldDeviceBox`:

1. Create a `CompositeDeviceBox`; move every pointer that targets the old box (the unit's instrument host) onto
   it with `oldBox.<field>.pointerHub.incoming().forEach(pointer => pointer.refer(newField))`, the same move
   pattern `migrateVaporisateurDeviceBox` uses.
2. For each `PlayfieldSampleBox` in `.samples`:
   - create a `CompositeCellBox`; `cell.composite.refer(newComposite.cells)`.
   - re-point the slot to the cell: `slot.host.refer(cell.instrument)` (the deprecated `device` attach drops).
   - move the chains: `slot.midiEffects` incoming pointers to `cell.midiEffects`, `slot.audioEffects` to
     `cell.audioEffects`.
3. Delete the `PlayfieldDeviceBox`.

Version-gate it like the other migrators (a box / project version bump), so it runs once.

## Engine changes

- Delete `build_instrument` and its device-declared chain reads; `build_cell` is the only child builder.
- `build_composite` sorts its cells by the cell `index` (key 5), not insertion order, so the UI order and the
  engine order agree and stay stable across rebuilds.
- `build_cell` resolves the cell's instrument, reads that instrument's routing (index / exclude) via A
  (its `DeviceReg`) or B (the spec), computes the choke group, and wires `Source` / `SlotRoute` plus the cell's
  midi / audio chains through `build_cluster`.
- Remove `DeviceReg.{midi,audio}_effects_field`, the two `device_register` args, the JS plumbing, and the
  slot's `midi_effects_field()` / `audio_effects_field()` exports. Under A, ADD `index_field()` /
  `exclude_field()` exports to the slot (smaller surface).
- `CompositeBinding` is unchanged (children + chains observations).
- Mute / solo (still queued) drops in naturally here as a per-cell gain on the sum, read from the slot's
  `mute` / `solo`, evaluated continuously (the deviation already agreed in `playfield-composite.md`).

## UI (the expensive, separable pass)

The Playfield editor builds `CompositeDeviceBox` + `CompositeCellBox`-wrapped slots instead of
`PlayfieldDeviceBox` + `PlayfieldSampleBox`. The drum-pad UX (per-pad note index, choke, mute / solo) maps onto
cells and their slot instruments. This is the bulk of the work and is independent of the engine collapse.

## Build order

1. Engine: collapse to `build_cell`, settle decision A vs B. Net-negative LOC; Playfield keeps working through
   cells the whole time (temporary spec or exports bridge it).
2. Schema: add the slot `host` field, deprecate the slot chains + `device` attach (and `PlayfieldDeviceBox`
   under A). Regenerate boxes + registry + the `all-boxes.od` fixture.
3. Migration: `migratePlayfieldDeviceBox`, tested against `public/projects/playfield.od`.
4. UI: rewire the Playfield editor.

## Open questions

- A vs B (one box type with device-declared routing, vs a thin `PlayfieldDeviceBox` spec).
- Whether swapping the slot's `device` (Sample) attach for a `host` (InstrumentHost) attach migrates cleanly,
  or a fresh slot-instrument box type is cleaner than evolving `PlayfieldSampleBox`.
- Confirm the choke still reads index / exclude from the slot now nested one level inside a cell (it does, same
  field keys, the composite just resolves the cell's instrument first).