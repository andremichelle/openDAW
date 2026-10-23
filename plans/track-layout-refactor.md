# Shared flat track layout

## Purpose and design

Timeline and mixer now consume one immutable channel layout instead of independently reconstructing order,
visibility and nesting from graph queries and nested DOM containers. The UI behavior remains the reference
for this architecture change.

`AudioUnitLayout` computes canonical channel order, visible rows, parent/ancestor relationships, depth,
indentation and visible group boundaries. `Project.audioUnitLayout` owns and publishes the snapshot once
per layout-changing transaction. Volume, mute and effect-parameter edits do not rebuild the layout.

`TrackListLayout` expands those channels into a pure, flat timeline projection. It handles content lanes,
automation, synthetic group/bus lanes, hidden Output and the modulator tail. Boundaries map from channel
indices onto actual lane rows. The timeline mounts lanes as siblings; unit backgrounds and group rails
are separate spans. Header padding and guides consume computed offsets. Mixer strips, selection ranges,
drag targets and timeline hit testing follow the same shared order.

## Placement behavior

- A new group replaces the first selected sibling's position. Its children retain their visible order,
  regardless of click order. Cross-folder selections still use the closest common ancestor.
- Saved indices order folders and other channels; Output alone stays last. Explicit drag positions and
  duplicate blocks no longer snap back to bus/instrument/FX sections. New FX creation retains its default slot.
- Creating an instrument from the browser or Add instrument inserts after the selected track, within the
  same parent group. A multiple selection inserts after its last visible selected root. Selecting a group
  inserts after its complete subtree. Repeated additions advance selection to the new channel.
- Browser insertion uses active editing only before an explicit track selection exists. Cleared/deleted
  selection falls back to normal creation placement. Explicit drag/drop and low-level creation retain
  their existing APIs.

## Audio and persistence scope

The layout refactor changes no box schema or DSP/WASM processing implementation. Group membership, collapse,
routing and effects continue to use the existing grouping model. The original grouping feature separately
extends the saved box schema and matching Rust registry; this refactor adds no further schema fields.

A newly inserted grouped instrument receives its destination during construction through
`InstrumentOptions.destination`. Repointing a newly constructed channel later in the same transaction can
leave its resolved route inconsistent with its saved pointer. The regression checks both membership and
the resolved group bus, plus serialization and undo/redo. Existing channels preserve custom-output behavior.

## Verification

Codex assisted this refactor and its validation. Current checks passed:

- Core: 787 tests / 79 files; adapters: 363 / 30; Studio: 93 / 25.
- Real WASM grouping audio: 2 tests. Production source/preview builds and Studio types pass.
- New tests cover immutable nested snapshots, collapse/undo, one publication per transaction, parameter-only
  edits, pure lane projection, hidden Output, automation/modulators, exact group placement, reversed
  selection, FX-only groups and selection-aware insertion/routing.
- Local browser: an 80-folder project plus a nested subgroup; flat sibling lanes and childless background
  spans, fold/unfold, highlighting, drag out/back in, duplication/undo, mixer fold, clip creation, folded
  overview, immediate repaint, resizing and save/reopen.
- Hosted browser: fresh grouping and insertion examples, mixer order and output routing, and save/reopen.

These are source, regression, UI and persistence checks. No new quantified performance result, subjective
listening assessment or full native-DAW parity is claimed. The earlier performance measurements remain
historical evidence in `track-groups.md`.

## Comparison and rollback

- Refactored demo: https://d3vptcx5s0ph2g.cloudfront.net/
- Original behavior/appearance reference: https://d2194sm5auuuqe.cloudfront.net/
- Current refactored build: `f954e9ef-4593-4c71-973a-352823731e7b`.
- Original demo build: `1efc199a-bc44-4479-bcb4-dfdfe771f00d`.
- Pre-refactor official source: `b4bf236ab6275414f35617a288b1f5976844be5d`.
- Pre-refactor deployed source: `b4848a8a2d9b9cfca0aef9285403ff3d9b4dac0f`.
- Pushed rollback tags: `track-groups-before-layout-refactor-2026-10-22` and
  `track-groups-preview-before-layout-refactor-2026-10-22`.

The original demo remains unchanged. Preview-only stock-asset proxy and WASM cache configuration remain
outside the upstream PR source. The refactor updates the existing PR #496.
