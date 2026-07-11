# Multitarget MIDI/Automation (#89)

**Doability:** ⭐⭐☆☆☆ (2/5) — core data-model change, touches track/region binding, mixer, undo, and every UI that assumes one track = one target
**Type:** feature
**Scope:** large

## What is asked
"Idea: Multitarget midi/automation" — have one clip play multiple instruments or automate multiple values, possibly with a relative mapping between targets (e.g. one fader gesture nudges several parameters proportionally instead of identically). No acceptance criteria given, this is an open idea.

## Current behaviour / relevant code
A track binds to exactly one target today:
- `TrackBox` (`packages/studio/forge-boxes/src/schema/std/timeline/TrackBox.ts:11`) has a single mandatory pointer field `target: Pointers.Automation`, plus `type` (`TrackType`: Undefined/Notes/Audio/Value, `packages/studio/adapters/src/timeline/TrackType.ts`).
- `AudioUnitTracks.create(type, target, index)` (`packages/studio/adapters/src/audio-unit/AudioUnitTracks.ts:34-43`) creates one `TrackBox` per `(type, target)` pair. `controls(target)` (`:45-48`) looks up the track owning a given target vertex — a 1:1 assumption baked into the API.
- `TrackBoxAdapter` (`packages/studio/adapters/src/timeline/TrackBoxAdapter.ts:76,98,124,230`) resolves `box.target.targetVertex` in half a dozen places (labeling, automation binding, mixer routing) — all single-vertex.
- Regions/clips (`NoteRegionBox`, `ValueRegionBox`, `AudioRegionBox`, and the `NoteClipBox`/`ValueClipBox`/`AudioClipBox` siblings under `packages/studio/forge-boxes/src/schema/std/timeline/`) live inside one track's `regions`/`clips` pointer collection (`TrackBox` fields 3/4). A region has no notion of "target" of its own — it inherits whatever the parent track points to.
- For Notes tracks the target is an instrument device (note events flow track → device processor). For Value tracks the target is a specific automatable parameter field. There is no fan-out primitive anywhere in the box graph, adapters, or engine (TS or WASM) that lets one event stream drive N targets.

## Plan
Two different features are conflated under "multitarget" and should probably ship separately:

1. **One note clip driving multiple instruments** — would require either (a) a track referencing a list of instrument targets (change `target` from a single pointer to a `Pointers.Automation` collection, propagate note events to all), or (b) a "send track" / clone-region mechanism that duplicates note events to other tracks without duplicating the region data. (b) is far less invasive: closer to an existing "note echo/doubling" feature than a data-model change, and doesn't force every adapter to stop assuming one target.
2. **One automation curve driving multiple parameters (optionally scaled/relative)** — closer to what modulation already does (`ParameterAdapterSet`, `AutomatableParameter`) for LFOs/envelopes: those already support one modulation source feeding many bound parameters via pointer fan-in in the *other* direction. Consider whether "multitarget automation" is actually better modeled as an existing modulation-style source (envelope/LFO) written to several parameters, rather than changing what a `TrackBox`/region is.

If a true multitarget region is wanted: introduce a pointer collection on `TrackBox` (mirroring how `regions`/`clips` are already collections) or a new join-box between a region's automation events and N parameter targets, each with its own scale/offset (the "relative" behavior the issue mentions). Every consumer of `box.target.targetVertex` (`TrackBoxAdapter`, `AudioUnitTracks.controls`, mixer/automation wiring, the WASM engine's `audio_unit.rs` track-binding) needs to become target-plural.

## Risks / open questions
- No concrete spec exists (issue is a one-line idea). Needs a maintainer decision on which of the two shapes above (or both) is wanted before design work starts.
- Changing `TrackBox.target` from singular to plural is a box-schema/serialization change, touching migration code (`packages/studio/core/src/project/migration/`) for every existing project file.
- Must be mirrored in the WASM engine (`crates/`) per the frozen-contract rule — this is a "WASM CONTRACT" surface (track→target binding), not a cosmetic change.
- "Relative" automation (issue's parenthetical) implies per-target scale/offset/curve-shaping, which is a second design axis on top of plain fan-out — needs its own UI (how does a user set the relative ratio per target?).
- Given the vagueness and blast radius, recommend the maintainer scope this down to one concrete sub-feature (e.g. "one LFO/envelope modulating several parameters" if that's not already possible) before any implementation plan is written in detail.
