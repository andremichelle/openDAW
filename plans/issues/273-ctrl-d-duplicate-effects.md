# Ctrl+D for audio effects (#273)

**Doability:** ⭐⭐⭐⭐☆ (4/5) — the shortcut is already bound and a full device copy/paste implementation exists; the fix is redirecting the handler to duplicate the *selected devices*, not the whole audio unit.
**Type:** feature
**Scope:** small

## What is asked
Add Ctrl+D to duplicate the selected effect(s) within a device chain, in place, next to the original(s).

## Current behaviour / relevant code
Ctrl+D is already a registered global shortcut, but it does something different from what this issue asks for. `packages/app/studio/src/ui/shortcuts/GlobalShortcuts.ts:93-96`:
```typescript
"copy-device": {
    shortcut: Shortcut.of(Key.KeyD, {ctrl}),
    description: "Duplicate selected device"
},
```
Its handler, `packages/app/studio/src/service/StudioShortcutManager.ts:149-158`:
```typescript
gc.register(gs["copy-device"].shortcut, () => service.runIfProject(
    ({editing, boxAdapters, userEditingManager, skeleton}) => userEditingManager.audioUnit.get()
        .ifSome(({box}) => {
            const deviceHost: DeviceHost = boxAdapters.adapterFor(box, Devices.isHost)
            const audioUnitBoxAdapter = deviceHost.audioUnitBoxAdapter()
            if (audioUnitBoxAdapter.isOutput) {return}
            const copies = editing.modify(() => TransferAudioUnits
                .transfer([audioUnitBoxAdapter.box], skeleton), false).unwrap("copyUnit")
            Option.wrap(copies.at(0)).ifSome(copy => userEditingManager.audioUnit.edit(copy.editing))
        })))
```
Despite the description "Duplicate selected device," this duplicates the entire audio unit / track currently open in the Device Panel (`TransferAudioUnits.transfer`), ignoring `project.deviceSelection` entirely. There is no existing binding that duplicates individual devices inside a chain — this is the actual gap in #273.

The building block to do it properly already exists: `packages/studio/core/src/ui/clipboard/types/DevicesClipboardHandler.ts` implements a full `DevicesClipboard` module with:
```typescript
canCopy: (): boolean => getEnabled() && copyableSelected().length > 0,
copy: copyDevices,
paste: (entry: ClipboardEntry): void => { ... }
```
operating against `context.selection: FilteredSelection<DeviceBoxAdapter>` (i.e. `project.deviceSelection`, wired in `packages/studio/core/src/project/Project.ts:145,189`). This is precisely the selection Ctrl+D should duplicate. `project.api` also already has a `duplicateRegion`/`duplicateNotes` precedent (`packages/studio/core/src/project/ProjectApi.ts:279`, `:445`) for "select something → make an adjacent copy → select the copy," which is the shape a `duplicateSelectedDevices` should follow.

## Plan
1. Add a `duplicateSelectedDevices` operation (either as a new `ProjectApi` method mirroring `duplicateRegion`/`duplicateNotes`, or by driving `DevicesClipboard`'s existing `copyDevices` + its paste routine back-to-back against the same chain at the position immediately after the originals) that:
   - reads `project.deviceSelection.selected()`,
   - no-ops if empty,
   - clones each selected device box into the same chain, immediately after the last selected index (reusing `copyDevices`'s box-cloning logic rather than re-implementing it),
   - re-selects the new copies in `project.deviceSelection` (mirrors `duplicateRegion`'s "select the duplicate" behaviour).
2. Change the `"copy-device"` shortcut handler in `StudioShortcutManager.ts:149-158` to prefer per-device duplication when `project.deviceSelection` is non-empty, falling back to the existing whole-audio-unit duplication only when no individual device is selected. This preserves the current Ctrl+D behaviour for the "duplicate the whole track" use case while adding the requested per-effect duplication.
3. Update the shortcut's description string if its behaviour now branches, so the shortcuts/help UI accurately reflects both modes.
4. No new drag-and-drop or dialog work needed — this is purely an editing-command change.

## Risks / open questions
- Reusing `copyDevices` directly (rather than round-tripping through the OS/in-memory clipboard) needs checking: `DevicesClipboardHandler.ts`'s `copy`/`paste` pair may serialize through `ClipboardEntry`/`ByteArrayOutput` (see `encodeMetadata`/`decodeMetadata`, lines 55-73) as a generic mechanism for the system clipboard; an in-place duplicate should ideally reuse the underlying box-cloning routine directly rather than paying the serialize/deserialize round trip, if that's easy to extract.
- Deciding the fallback rule (per-device duplicate vs. whole-unit duplicate) when *some* devices are selected but the user's intent is ambiguous (e.g. an instrument is selected alongside effects) needs a small product decision — likely: if `deviceSelection` contains only effect devices, duplicate those; otherwise fall back to the existing whole-audio-unit behaviour.
