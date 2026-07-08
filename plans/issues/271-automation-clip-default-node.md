# New automation clip default node (#271)

**Doability:** ⭐⭐⭐⭐☆ (4/5) — clear gap, self-contained fix in one factory method plus a neighbor lookup.
**Type:** feature, ux
**Scope:** small-medium

## What is asked
A newly created automation (value) clip should start with one node instead of empty content:
- Empty track / first clip → node at the parameter's current/default dial value.
- Placed before an existing clip with a ramp → inherit that clip's **start** value.
- Placed after an existing clip → inherit that clip's **end** value.

## Current behaviour / relevant code
`packages/studio/core/src/project/ProjectApi.ts:338-352`:
```ts
createValueClip(trackBox: TrackBox, clipIndex: int, {name, hue}: ClipRegionOptions = {}): ValueClipBox {
    const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
    return ValueClipBox.create(boxGraph, UUID.generate(), box => {
        ...
        box.events.refer(events.owners)   // no event ever created — collection starts empty
        box.clips.refer(trackBox.clips)
    })
}
```
No `ValueEventBox` is ever created — the clip starts fully empty. The region equivalent (`createTrackRegion`'s `TrackType.Value` case, `ProjectApi.ts:398-410`) has the same gap.

Building blocks already available:
- Neighbor clips: `trackBox.clips` is index-ordered; adjacent clip adapters can be found via the same `IndexedBoxAdapterCollection`/`getAdapterByIndex(index)` pattern used elsewhere (e.g. `ClipsArea.tsx:106`, `ClipCapturing.ts:25`).
- A clip's value at a position (needed for "start"/"end" of the neighbor): `ValueClipBoxAdapter.valueAt(position, fallback)`, `packages/studio/adapters/src/timeline/clip/ValueClipBoxAdapter.ts:67-70`. Start = `valueAt(0, fallback)`; end = `valueAt(duration, fallback)` (or read the last event's value directly via `optCollection`).
- The track's bound parameter (for the "empty track" fallback): `TrackBoxAdapter.target` (`packages/studio/adapters/src/timeline/TrackBoxAdapter.ts:159`, a `PointerField<Pointers.Automation>`) resolves to an address; `project.parameterFieldAdapters.get(address)` returns the `AutomatableParameterFieldAdapter`, whose `.getUnitValue()` or `.anchor` gives the current/default value — this exact lookup is already done in `packages/app/studio/src/ui/timeline/editors/value/ParameterValueEditing.ts:44-49`.
- Event creation pattern to mirror: `ValueEventEditing.createOrMoveEvent` / `collection.createEvent({position, index, value, interpolation})`, `packages/app/studio/src/ui/timeline/editors/value/ValueEventEditing.ts:25-46` (UI-side; `ProjectApi` should call the box/adapter API directly rather than importing UI code).

## Plan
1. In `ProjectApi.createValueClip`, after creating `events`, look up the track's clip collection at `clipIndex - 1` (preceding) and `clipIndex + 1` (following, if any already exist at that exact adjacent index — clips are typically appended, so "following" may rarely apply, but check per the ask).
2. Resolve the seed value:
   - If a preceding clip's content exists, take its last value (end value) via its `ValueClipBoxAdapter.optCollection`.
   - Else if a following clip exists, take its first value (start value).
   - Else resolve the track's bound parameter via `project.parameterFieldAdapters.get(trackBox.target.targetAddress)` and use its current unit value (or `.anchor` if unset).
3. Create a single `ValueEventBox` at position 0 with that resolved value and `index: 0`, referring it into the newly created `events` collection (mirror `collection.createEvent(...)` semantics from the adapter layer, or call the box constructor directly since `ProjectApi` operates on boxes, not adapters).
4. Apply the same logic to `createTrackRegion`'s `TrackType.Value` case (`ProjectApi.ts:398-410`) for consistency between clips and regions.
5. Add a unit test creating clips in sequence (empty track, then before/after existing content) and asserting the seeded value in each case.

## Risks / open questions
- "Before an existing ramp clip" — need to clarify whether this means the immediately preceding clip by index, or the nearest clip earlier in playback time if clips can have gaps; the simplest correct interpretation is index-adjacency within the same track's clip collection.
- `ProjectApi` holds a full `Project` reference (`ProjectApi.ts:103-105`, `this.#project`), so `boxAdapters`/`parameterFieldAdapters`/clip adapters are all reachable directly — no architectural blocker to implementing this inside `ProjectApi.createValueClip`.
