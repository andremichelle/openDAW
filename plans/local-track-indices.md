# Zero-based local track indices per device group

## Goal

Store `TrackBox.index` as a LOCAL index, restarting from 0 within each device group, instead of the current
ONE global sequence per audio-unit. This is plan step 6 of `plans/timeline-layout.md`, split out because it
is a stored box-format change requiring a migration.

Groups (the sort key `[unit.index, categoryRank, devicePath..., index]` from `TracksManager`):
- Instrument tracks (category 0): notes AND audio share this ONE group, indexed together 0,1,2… (mixed
  types — the one group holding more than one track type).
- MIDI-fx automation, instrument automation, audio-fx automation: each device's automations are their own
  0-based run.

Across groups the same index value recurs by design; within a group indices stay unique and contiguous.

## Is it worth it?

The DISPLAY is already identical today: the sort derives order from `[category, devicePath, localIndex]`,
using the global `index` only as an intra-group tiebreak. So local indices buy a cleaner stored format and a
simpler group-drag write, at the cost of a migration and group-scoped index bookkeeping. Recommendation:
do it only if the cleaner box semantics are wanted for their own sake; there is no functional display gain.

## The IndexedBoxAdapterCollection consequence

`box.tracks` is an `IndexedBoxAdapterCollection<TrackBoxAdapter>`. It does two jobs for tracks:
1. `adapters()` sorted by `index` — becomes MEANINGLESS with local indices (many index-0 collide; the sort
   within a collision is insertion order). `TracksManager` already computes the real order, so this sort is
   unused for display. → downgrade `box.tracks` to a plain `BoxAdapterCollection` (drop the `Indexed`).
2. Index bookkeeping — `getMinFreeIndex()` (assumes a global contiguous 0-based sequence) and the delete
   reindex. This does NOT vanish; it must become GROUP-SCOPED. It moves to a group-aware helper (TracksManager
   already resolves the groups via `trackOrderKey` / `deviceOrderKey`).

Net: not a free deletion — swap the global indexed collection for a plain collection plus per-group index
logic. The collection stays the membership/lifecycle container.

## Affected sites

- `AudioUnitTracks.create` (adapters): `box.index.setValue(index ?? this.#collection.getMinFreeIndex())` →
  per-group min-free-index (the group is decided by the track's type + target device).
- `AudioUnitTracks.delete` (adapters): the reindex loop compacts the WHOLE unit; scope it to the deleted
  track's group.
- `ProjectApi.#createTrack`: uses `IndexedBox.insertOrder` — must become group-scoped.
- Group-drag reorder (`AudioUnitsTimeline` track drop): today it permutes the group members' GLOBAL index
  values; with local indices it writes the local 0..n-1 directly — SIMPLER.
- Head-lane gating: already keyed on "first displayed lane" (`unitHead`), not `index === 0`, so UNAFFECTED.
- `getMinFreeIndex` callers elsewhere (e.g. the sample-drop track creation in `UnitLane`) must use the
  group-scoped variant.

## Migration

New `MigrateLocalTrackIndices` (mirrors `MigrateUndefinedTracks`): for each audio-unit, group its tracks by
the SAME resolution the sort uses (type → category, target device path), then within each group assign
0..n-1 in the current display order. Runs once on load; the enum / schema field type is unchanged (still
int32), only its SEMANTICS change, so old projects load and get renumbered. Guard: run after
`migrateUndefinedTracks` (which already compacts indexes) so the input is clean.

## Test plan

- Migration unit test: a unit with interleaved global indices across groups → each group 0-based, display
  order preserved.
- Create/delete within a group keeps the group 0..n-1; other groups untouched.
- Group-drag reorder writes local indices; cross-group drag still impossible (constrained to the group).
- Instrument group: notes + audio share 0,1,2… together.
- Browser: sort, dedup, tree guides, head duties unchanged.

## Phases

1. Migration + group-scoped create/delete/min-free-index helper. Green migration test.
2. Downgrade `box.tracks` to a plain collection; move index bookkeeping to the helper. All existing timeline
   tests green.
3. Group-drag writes local indices. Browser verify.
