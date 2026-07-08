# Ability to drag an effect/device from one track to another (#57)

**Doability:** ⭐⭐⭐☆☆ (3/5) — the drag-source side and the box-graph reparenting primitive both already exist; the missing piece is a cross-track drop target, plus an alt-drag-to-copy variant.
**Type:** feature
**Scope:** medium

## What is asked
Drag an effect device (e.g. a reverb) from one track's device chain onto another track, moving it there. Alt+drag should copy instead of move.

## Current behaviour / relevant code
Device drag-and-drop already exists, but only within the single, currently-open Device Panel:
- **Drag source:** `packages/app/studio/src/ui/devices/DeviceDragging.ts:9-45` — `DeviceDragging.install(...)` wraps any `midi-effect`/`audio-effect`/`instrument` device in `DragAndDrop.installSource(...)`, packaging the dragged device(s) as a `DragDevice` payload (`uuids`, from `collectDragUuids`, lines 47-57) that already supports multi-select drags of same-type devices within one chain.
- **Drop target:** `packages/app/studio/src/ui/devices/DevicePanelDragAndDrop.ts:21-149` — `DevicePanelDragAndDrop.install(...)` is the *only* registered drop target for `DragDevice` payloads. It resolves the target chain purely from `userEditingManager.audioUnit.get()` (line 32, 95) — i.e. whatever audio unit is currently shown in the Device Panel — and on drop with existing `uuids` (not a fresh device from the browser) calls:
  ```typescript
  const startIndices = uuids.map(...).map(box => box.index.getValue()).toSorted((a, b) => a - b)
  editing.modify(() => IndexedBox.moveIndices(field, startIndices, index))
  ```
  `IndexedBox.moveIndices` (`packages/lib/box/src/indexed-box.ts:52+`) only reorders boxes that already belong to the *same* field — it has no cross-field/cross-track semantics.
- **Existing cross-track reject:** `packages/app/studio/src/ui/timeline/tracks/audio-unit/headers/TrackHeader.tsx:116-139` installs a drop target on each track header, but explicitly rejects drags of existing devices:
  ```typescript
  drag: (_event, data) => (data.type === "midi-effect" || data.type === "audio-effect") && data.uuids === null,
  ```
  `data.uuids === null` is only true for a brand-new device dragged from the browse panel; an existing device being dragged from `DeviceDragging.ts` always sets `uuids` to a non-null array (line 19-21), so `TrackHeader`'s target currently refuses it outright — this is the exact gap the issue is asking to close.
- **Reparenting primitive already exists:** effect boxes point at their chain via a pointer field, reparented with `.host.refer(hostField)` (used pervasively in `packages/studio/core/src/EffectFactories.ts`, e.g. lines 49, 66, 83...). This is the same pattern `RegionMoveModifier.ts:184` uses to move a region to a different track (`adapter.box.regions.refer(targetTrack.box.regions)`), so cross-track device move can follow an identical shape: `effectBox.host.refer(targetField)` followed by re-indexing (e.g. `IndexedBox.insertOrder`/`removeOrder`, both already in `indexed-box.ts`).
- **Copy primitive already exists:** `packages/studio/core/src/ui/clipboard/types/DevicesClipboardHandler.ts` implements a full copy/paste handler for device selections (`copyableSelected`, `copy`/`paste`, lines ~174-196+), which is the natural thing to reuse for the alt-drag-to-copy variant instead of inventing new duplication logic.

## Plan
1. Extend `TrackHeader.tsx`'s drop target (and/or add an equivalent target on the mixer's channel strip, `ChannelStrip.tsx`, since devices are also visualised there) to accept `data.uuids !== null` in addition to the existing new-device case.
2. On drop with `uuids !== null` and no Alt held: for each dragged effect box, verify type compatibility (a `midi-effect` can only move into a track whose input accepts MIDI — reuse the same `deviceHost.inputAdapter.mapOr(input => input.accepts !== "midi", true)` guard already used in `DevicePanelDragAndDrop.ts:63`), then reparent via `effectBox.host.refer(targetTrack's audioEffects/midiEffects field)` and append/insert via `IndexedBox.insertOrder(targetField, dropIndex)`, all inside `editing.modify(...)`.
3. On drop with Alt held: instead of reparenting, duplicate the dragged device(s) into the target chain. Reuse the box-cloning logic already implemented for the clipboard's `copy`/`paste` pair in `DevicesClipboardHandler.ts` (call its underlying copy routine against the target field directly, or round-trip through `ClipboardManager`'s copy+paste if that is simpler and already transaction-safe) rather than writing a new device-cloning routine.
4. Update `DeviceDragging.ts`'s drag-start payload if needed so the alt-key state is available at drop time (drag events carry `altKey` on the native `DragEvent`, so this may already be accessible without payload changes — verify against how `RegionMoveModifier`/`ClipMoveModifier` read `ctrlKey`/`shiftKey` from `Dragging.Event` for the equivalent copy-vs-move distinction in region/clip dragging).
5. Add a visual insertion marker on the target track header/mixer strip during drag-over, mirroring `InsertMarker` already used in `DevicePanelDragAndDrop.ts:27,47-54`.

## Risks / open questions
- Devices dragged onto a track header currently have no visible "which position in the chain" affordance (unlike the Device Panel's `audioEffectsContainer`/`midiEffectsContainer`, which render `findInsertLocation` markers against visible device tiles) — dropping onto a collapsed track header may need a simpler "append to end of chain" behaviour rather than exact positional insert, which is a design simplification worth confirming.
- Whether the mixer's `ChannelStrip.tsx` should also become a drop target (so devices can be dragged there without opening the timeline) or whether track-header-only is sufficient for v1 is a scope question.
- Cross-track device moves are TS-only (Device Panel/box-graph editing, not runtime engine state) — no WASM engine changes anticipated, but the moved device's automation lanes (if any exist and are UI-editable) should be checked for correctness after `.host.refer(...)`.
