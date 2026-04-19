# Device Copy & Paste — Carrying Automation

> **Status**: PARTIALLY IMPLEMENTED. The reported crash and the core
> "automation travels with the device" behaviour are fixed in
> `DevicesClipboardHandler.ts`. Copy now uses `stopAtResources: true`
> and includes `ValueEventCollectionBox`; paste no longer excludes
> `TrackBox` when the payload has no instrument, always maps
> `Pointers.TrackCollection`, and reindexes tracks on the target
> `AudioUnit`. The automation's `TrackBox.target` is remapped automatically
> because the source device's UUID is in the clipboard — no separate
> field-path encoding was needed. Open items below (collision handling,
> automation for effects copied alongside an instrument, Case C orphan
> risk) remain as follow-ups.
>
> **Prerequisite**: Builds on `copy-and-paste.md` (resource property,
> `stopAtResources`, `ClipboardUtils`) and the current
> `DevicesClipboardHandler` in
> `packages/studio/core/src/ui/clipboard/types/DevicesClipboardHandler.ts`.

## Problem

Copying an audio effect whose parameters are automated and pasting it onto
an existing device on another track throws:

```
Pointer {Or:Ae (events) <uuid>/1 requires an edge.
  at GraphEdges.tryValidateAffected
  at BoxGraph.endTransaction
  at BoxEditing.modify
  at DevicesClipboardHandler.paste
```

The pointer at `<uuid>/1` is `ValueEventBox.events` (field key 1,
`Pointers.ValueEvents`, mandatory).

**The bug in one sentence:** the copy includes the `ValueRegionBox`es and
`ValueEventBox`es belonging to the device's automation but drops the
`ValueEventCollectionBox` they depend on, so the pasted events have no
valid target for their mandatory `events` / `owners` pointers. The fix is
to include `ValueEventCollectionBox` in the payload — but only that
collection, not the *other* regions that also reference it.

### Reproduction

1. Track A (e.g. Kick) has an audio effect (e.g. Revamp).
2. Create an automation lane on Track A targeting any Revamp parameter
   and add **at least one** value event (a value region with events).
3. Select the Revamp device and Copy.
4. On Track B (e.g. Rumble) select an existing audio effect (e.g. Delay).
5. Paste → exception.

Empty automation tracks (no `ValueRegionBox`) do **not** trigger the crash
because the mandatory `events` pointer on `ValueEventBox` is the one that
fails validation. Without events, there is nothing to paste that requires
the missing `ValueEventCollectionBox`.

### Why it happens

`DevicesClipboardHandler.copyDevices`
(`packages/studio/core/src/ui/clipboard/types/DevicesClipboardHandler.ts`,
lines 118-134):

- `ownedChildren` picks up the automation `TrackBox` because
  `TrackBox.target` is a mandatory incoming edge on a parameter field of
  the device. `TrackBox` has no `resource`, so it passes the
  `!isDefined(pointer.box.resource)` filter.
- `mandatoryDeps` via `boxGraph.dependenciesOf(..., alwaysFollowMandatory: true)`
  then traces `TrackBox.regions` ← `ValueRegionBox.regions`, and
  `ValueRegionBox.events` → `ValueEventCollectionBox.owners` ←
  `ValueEventBox.events`.
- The final `.filter(dep => !isDefined(dep.resource))` drops
  `ValueEventCollectionBox` because it is declared `resource: "shared"`
  in `ValueEventCollectionBox.ts`.

Clipboard payload ends up as:
`RevampDeviceBox, TrackBox, ValueRegionBox×2, ValueEventBox×3` — matching
the production log.

`DevicesClipboardHandler.paste` (lines 245-278, `replaceInstrument = false`
in the effect-on-effect case):

- `excludeBox: box => !replaceInstrument && (isInstrumentDeviceBox || isInstanceOf(box, TrackBox))`
  drops only the `TrackBox`. `ValueRegionBox` and `ValueEventBox` are
  still deserialised.
- `mapPointer` only handles `InstrumentHost`, `MIDIEffectHost`,
  `AudioEffectHost`, `TrackCollection`, `Automation` and `MIDIDevice`.
  It does **not** handle `Pointers.ValueEvents` or
  `Pointers.ValueEventCollection` / `Pointers.RegionCollection`.
- Mandatory pointers on the pasted `ValueEventBox.events` and
  `ValueRegionBox.{regions,events}` therefore land with `Option.None` as
  their target address → `endTransaction` validation panics.

The validator hits `ValueEventBox.events` first because field key `1` is
scanned before field key `2` on `ValueRegionBox`, but any of the three
mandatory pointers would fail the same way.

## Desired behaviour

The user expectation, as discussed, is: **automation travels with the
device**. Copying Revamp-with-automation and pasting onto another track's
effect chain should produce Revamp on the new chain **and** an automation
lane on that track's `AudioUnit` targeting the equivalent parameter on the
pasted device.

This is richer than the current "drop the track content on paste" short
cut and replaces it.

### Semantics we want

| Source condition                         | Paste result                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Device with no automation                | Device inserted at paste index. Unchanged from today.                                            |
| Device with empty automation track       | Device inserted. **New** automation track created on the target `AudioUnit` targeting the pasted device's equivalent parameter. |
| Device with automation + regions/events  | Device inserted. New automation track + pasted `ValueRegionBox`es and `ValueEventBox`es, plus a fresh `ValueEventCollectionBox` per region.                     |
| Multiple devices, some automated         | Each device inserted in order. Each automation track produced and wired to the correct pasted device's parameter.                                                                                            |

Parameter identity: `TrackBox.target` in the source points to a specific
field on the source device (e.g. `mid-bell.frequency`). The pasted device
has the same schema, so the equivalent target is the field with the same
field-key path on the pasted device. The copy format has to record enough
to resolve this on paste.

Edge cases to decide:

- **Target parameter already has an automation track on the destination
  `AudioUnit`.** Options: (a) reject this device's automation (keep
  existing), (b) append additional `ValueRegionBox`es to the existing
  track and drop the cloned track, (c) replace. Recommend **(b)** — it
  matches the user's "just insert the effect" mental model and avoids
  two tracks pointing at the same parameter (which the `Automation`
  pointer exclusivity rule may forbid; needs to be verified against
  `TrackBox.target` pointer rules before implementation).
- **Paste into the same project.** Same rules apply; UUID remapping
  already handled by `ClipboardUtils.deserializeBoxes` (internal UUIDs
  are regenerated; `"preserved"` resources keep theirs).
- **Replace-instrument path (`replaceInstrument = true`).** Today this
  already remaps `Pointers.Automation` and `Pointers.TrackCollection`.
  The new logic should not regress it; ideally the two paths converge
  on one helper.

## Implementation sketch

Only in `DevicesClipboardHandler.ts` — no graph-level changes needed.

### Copy side

1. Keep `TrackBox`, `ValueRegionBox`, `ValueEventBox` in the payload as
   today.
2. **Include the `ValueEventCollectionBox` reached via the automation
   chain, and stop there.** This is the bug. The current
   `.filter(dep => !isDefined(dep.resource))` at line 127 drops the
   collection box because its schema declares `resource: "shared"`.
   We need the collection in the payload, but we must not keep chasing
   dependencies past it.

   **Scope rule (no special cases):** the copy set is whatever the
   dependency traversal from the copied devices reaches *with
   `stopAtResources: true`*. Anything that belongs to a copied device
   — its automation tracks, the regions on those tracks, the event
   collections those regions own, the events in those collections —
   comes along automatically. Anything that sits behind a shared
   resource boundary (including mirrored regions on unrelated tracks
   that just happen to share a `ValueEventCollectionBox`) does not.

   The right primitive is the resource-stopping traversal already
   described in `copy-and-paste.md` Phase 3.1:
   `dependenciesOf(..., { alwaysFollowMandatory: true, stopAtResources: true })`.
   The `"shared"` branch at
   `packages/lib/box/src/graph.ts:365-381` already does the right
   thing here:

   - `ValueEventCollectionBox.events` has
     `pointerRules.mandatory: false` → children side → `ValueEventBox`es
     pointing at this field are traced in.
   - `ValueEventCollectionBox.owners` has
     `pointerRules.mandatory: true` → ownership side → incoming
     edges to `owners` are not traced, so regions that only reach the
     collection by mirroring from outside the copy scope are excluded.

   Minimum change: in `DevicesClipboardHandler.copyDevices` switch the
   `mandatoryDeps` collection to pass `stopAtResources: true` and drop
   the `.filter(dep => !isDefined(dep.resource))` so the collection
   box stays in the result. Mirror the same change in the `preserved`
   gathering pass and in the `trackContent` gathering pass (lines
   144-151) so all three agree on the resource semantics.

   Test to add: a device with two tracks whose regions mirror one
   shared `ValueEventCollectionBox`, and a third, unrelated track on
   a different device whose region mirrors the *same* collection.
   Copying the device must yield the two related regions in the
   payload, the unrelated region must not appear, and the shared
   `ValueEventCollectionBox` must appear exactly once.

3. Encode, per source `TrackBox`, the field-key path from the source
   device's root to the automated field. Store this in the metadata
   block next to the existing `DeviceMetadata` so paste can rebuild
   `TrackBox.target`. Either:
   - record `{ deviceUuid, fieldPath }` per track and map
     `deviceUuid → pastedDevice` during paste, or
   - rely on the existing `Pointers.Automation` mapping and let
     `mapPointer` resolve `TrackBox.target` by walking the fresh device
     via the recorded `fieldPath`.

### Paste side

1. Drop the current `excludeBox` of `TrackBox` — track boxes are now
   always pasted when automation is present.
2. Extend `mapPointer` to handle:
   - `Pointers.TrackCollection` → `host.audioUnitBoxAdapter().tracksField.address`
     (already handled when `replaceInstrument`; unconditional now).
   - `Pointers.Automation` → resolved to the **pasted** device's field
     (look up remapped UUID in `uuidMap`, then follow the recorded
     `fieldPath`). `Option.None` → abort that track (the device was
     skipped, so its automation has nowhere to go).
   - `Pointers.ValueEventCollection` and `Pointers.ValueEvents` →
     remapped internally via `uuidMap` once
     `ValueEventCollectionBox` is in the payload (step 2 above fixes this
     automatically; no extra `mapPointer` branch needed).
3. After paste, reindex tracks on the target `AudioUnit` the same way
   the instrument-replace branch already does (lines 290-297).
4. If "append to existing automation track" is chosen for the
   collision case, detect an existing `TrackBox` on the target
   `AudioUnit` whose `target` resolves to the same pasted-device field,
   and rewrite the `ValueRegionBox.regions` pointers of the clipboard
   boxes to that existing track before commit; skip creating the
   cloned `TrackBox`.

### Failure fallback

If `mapPointer` cannot resolve a `TrackBox.target` (e.g. field path no
longer exists on the schema), drop the track and its dependent boxes
**before** commit rather than letting a mandatory-pointer panic reach
`endTransaction`. A pre-commit pass over the deserialised boxes that
deletes any `TrackBox` with an empty `target` (and cascades into its
regions/events) is the safest form.

## Tests to add

Extend `DevicesClipboardHandler.test.ts`:

- `paste audio effects` → `"pastes effect with automation onto a
  different track without throwing"` — the direct regression for the
  bug in this document. Build a source project with
  `addAudioEffect + addAutomationTrack + addValueRegion`, copy just the
  effect, paste onto an effect chain of a different target `AudioUnit`,
  assert no throw and that the target `AudioUnit` gains an automation
  `TrackBox` whose `target` resolves to the pasted effect's parameter.
- `"empty automation track is preserved"` — source has an automation
  track but no `ValueRegionBox`. After paste the target has an empty
  automation track bound to the pasted device's parameter.
- `"automation collision appends regions to existing track"`
  (only if (b) is chosen in the collision discussion above).
- `"pasted events are wired to their own ValueEventCollectionBox"` —
  asserts no dangling `ValueEvents` pointers after commit.

## Out of scope

- Cross-project paste via the system clipboard — follow the same rules
  but needs the clipboard envelope work from `copy-and-paste.md`.
- Carrying automation for **MIDI** effects; same principle should apply
  once the audio-effect path is green.
- Changing the graph-level `dependenciesOf` / resource model. The fix
  lives entirely in `DevicesClipboardHandler`.

## Related files

- `packages/studio/core/src/ui/clipboard/types/DevicesClipboardHandler.ts`
- `packages/studio/core/src/ui/clipboard/ClipboardUtils.ts`
- `packages/studio/core/src/ui/clipboard/types/DevicesClipboardHandler.test.ts`
- `packages/studio/forge-boxes/src/schema/std/timeline/ValueEventBox.ts`
- `packages/studio/forge-boxes/src/schema/std/timeline/ValueRegionBox.ts`
- `packages/studio/forge-boxes/src/schema/std/timeline/ValueEventCollectionBox.ts`
- `packages/studio/forge-boxes/src/schema/std/timeline/TrackBox.ts`
- `packages/lib/box/src/graph-edges.ts` (validator that currently fires)
