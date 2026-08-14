# Local Resource Folders (Samples and Soundfonts)

> **Status:** Plan with dry runs against the code on branch `user-folder`. Nothing implemented.

## TL;DR

The local half of the resource browsers gets the folder tree the online half already has, plus the file manager behaviour of `admin.opendaw.studio`: right click instead of hover buttons, delete key, drag into folders, a "Move to" submenu, a trash that keeps the audio, and an Analyse button in the edit dialog.

Structure is stored as **one JSON file next to the items**, `samples/v2/structure.json` and `soundfont/structure.json`. It holds folder names and uuid membership only, never metadata. Anything on disk that the tree does not mention renders at the root, so an import needs no write and no hook, and a sample deleted behind the browser's back cannot leave a hole.

The renderer already draws folders (`ResourceFolderItem`), already flattens on search, and already handles the delete key for local items. The work is a small model layer, interaction on the folder row, and moving row actions into the context menu.

**Cost from the dry runs:** about 620 to 780 LOC across 13 files, 3 of them new. Two focused days for phases 1 to 4, half a day for the trash, half a day for the analyser.

**Decisions worth taking before the first line of code:**

1. Membership only, no manual order. Local items sort alphabetically inside every folder.
2. Trash keeps the audio. `trash.json` (cloud sync tombstones) is left alone and a new `trash` array lives in `structure.json`.
3. Folders are not selectable in v1. The delete key acts on samples only, folder delete is context menu only.
4. The edit dialog uses the tempo detector the studio already ships (`WasmBpmDetector`), not a port of the admin analyser.

---

## What already exists (dry run 0)

Read before designing anything, because roughly a third of the feature list turned out to be built already.

`packages/app/studio/src/ui/browse/ResourceBrowser.tsx`
Generic over `ResourceFolder<T>`. Renders folders recursively at line 96, flattens for search at line 112, keeps expansion state per path in `expandedKeys`, and reloads the whole list through one `Hotspot` updater. **Local is hardcoded flat at line 78**: `{name: "", folders: [], items: await config.fetchLocal()}`. That single expression is the seam the whole feature hangs off.

Line 144 to 150 already binds the delete key to `resourceSelection.deleteSelected()` for local items. So "delete sample by select then hit delete key" exists, it just deletes for good instead of trashing.

`ResourceFolderItem.tsx`
56 lines, presentational. Triangle, folder icon, name, count, expand toggle on click. No context menu, no drop target, no rename.

`ResourceFolder.ts`
22 lines. The type plus `flatten` and `countItems`. Enough as the render shape, not enough as an editable model (no parent link, no path).

`HTMLSelection.ts`
Line 59 already skips entries inside `.hidden`, so range selection across a collapsed folder is right today. Entries are found by `[data-selection]` anywhere below the container, so nesting samples one level deeper already works.

`Storage.ts` (`packages/studio/core/src/Storage.ts`)
46 lines. `list()` reads every subdirectory's `meta.json`. `deleteItem()` appends the uuid to `trash.json` and then deletes the directory. **That file is not a user facing trash**, it is the tombstone list `CloudBackupSamples`, `CloudBackupSoundfonts` and the other three backups read to know what must not be downloaded again. Reusing it for a soft trash would resurrect deleted samples on the next sync.

`SampleView.tsx` line 61 to 89 and `SoundfontView.tsx` line 38 to 59
The pencil and close icons that have to go. Both already carry a `ContextMenu.subscribe` block with two items, so the menu is a place to add to, not to build.

`SampleService.importFile` (`packages/studio/core/src/samples/SampleService.ts` line 40)
Already runs `bpmDetector.detect` on import and stores 0 for unknown. Nothing about import needs to change.

`MenuItem` (`packages/studio/core/src/ui/menu/MenuItems.ts` line 151)
Has `setRuntimeChildrenProcedure`, which is exactly what the admin "Move to" submenu is built on. The submenu can be ported nearly verbatim.

Admin reference files worth reading side by side while implementing:
`src/model/FolderNode.ts`, `src/model/IndexModel.ts`, `src/ui/ContextMenus.ts`, `src/ui/Actions.ts`, `src/api/BpmAnalyser.ts`, `src/ui/SampleEditor.tsx`.

---

## Design

### Where the structure lives

One file per storage root, a sibling of the item directories:

```
samples/v2/structure.json
soundfont/structure.json
```

```json
{
  "version": 1,
  "updatedAt": "2026-08-14T09:00:00Z",
  "folders": [
    {
      "name": "Drums",
      "folders": [{"name": "Kicks", "uuids": ["6b1f0f3a-..."]}],
      "uuids": ["c5d81f04-..."]
    }
  ],
  "trash": [{"uuid": "41e0b9c7-...", "path": "Drums/Kicks"}]
}
```

Only uuids. Names, bpm and duration keep coming from each item's own `meta.json`, so editing a sample cannot desynchronise the tree, and the file stays a few hundred bytes for a large library.

Rejected alternative: a `folder` field inside `meta.json`. Moving fifty samples would be fifty OPFS writes instead of one, empty folders would have nowhere to live, and the field would travel into the cloud catalogue where it means nothing.

### The root is implicit

`assemble(items)` walks the tree, places every uuid it finds, and drops every uuid the tree names that is not on disk. Everything left over renders at the root, in alphabetical order.

That gives three things for free:

Newly imported samples appear in the root, with no hook in `SampleService` and no write on import.

A sample deleted from another tab, by the zero-duration purge in `collectAllFiles`, or by a cloud restore, cannot leave a dangling row.

The feature degrades to today's behaviour when `structure.json` is missing, corrupt or from a future version.

### Order

Alphabetical everywhere on the local side. Structure carries membership, never position. Drag means "move into", never "insert at". The online browser keeps its authored order because its order comes from the published index, and nothing here touches that path.

### Trash

A trashed item stays on disk. `structure.json` records its uuid and the path it came from, the browser hides it from the tree and shows it in one pinned `Trash` row at the bottom of the local root. "Put Back" recreates the missing folders and restores it, exactly like `IndexModel.restore`. "Delete Forever" and "Empty Trash" call the existing `Storage.deleteItem`, which writes the tombstone and removes the directory.

Consequence to accept knowingly: a trashed sample is still on disk, so it still appears in `SampleStorage.list()`, which means the sample picker, `SampleService.collectAllFiles` and the cloud backup all still see it. Hiding it from those would mean threading the structure through core, which is the opposite of least intrusive. The trash is a browser view, not a storage state.

### Model layer

New file `packages/app/studio/src/ui/browse/LocalTree.ts`, app side, roughly the useful third of the admin `FolderNode` plus `IndexModel`:

```ts
export class LocalTree<T> {
    static load<T>(storage: Storage<...>, uuidOf: Func<T, UUID.String>): Promise<LocalTree<T>>
    assemble(items: ReadonlyArray<T>): ResourceFolder<T>   // + a Trash folder when non-empty
    createFolder(path: string, name: string): Promise<void>
    renameFolder(path: string, name: string): Promise<void>
    deleteFolder(path: string, mode: "dissolve" | "trash"): Promise<void>
    move(uuids: ReadonlyArray<UUID.String>, path: string): Promise<void>
    trash(uuids: ReadonlyArray<UUID.String>): Promise<void>
    restore(uuids: ReadonlyArray<UUID.String>): Promise<void>
    forget(uuids: ReadonlyArray<UUID.String>): Promise<void>
}
```

Every mutation persists and returns. The browser then calls the `refresh()` it already has, and the `Hotspot` redraws from disk. No observable, no undo stack. Undo is where a good part of the admin's complexity sits and none of the requested features need it.

Folders are addressed by path string, not by node reference, because the tree is rebuilt on every reload and `expandedKeys` is already keyed by path.

### What core learns

Two methods on `Storage`, about 25 LOC, so the app never has to know the OPFS path layout:

```ts
async loadStructure(): Promise<Optional<ResourceStructure>>
async saveStructure(structure: ResourceStructure): Promise<void>
```

`ResourceStructure` is declared next to them. Nothing else in core changes, and both storages inherit the pair.

---

## Feature by feature, with dry runs

### 1. Folders on the local side

`ResourceBrowserConfig<T>` gains two optional fields.

```ts
localTree?: (items: ReadonlyArray<T>) => Promise<LocalTree<T>>   // or the storage + uuid accessor
resolveEntryUuid?: (item: T) => UUID.String
```

`ResourceBrowser.tsx` line 78, the local branch, becomes a call to `LocalTree.load(...)` followed by `assemble(items)`, falling back to today's flat folder when the config has no tree. Roughly 20 changed lines there.

`SampleBrowser.tsx` and `SoundfontBrowser.tsx` each pass the storage and `item => item.uuid`, four lines each.

Dry run notes: `renderContent` at line 96 needs no change, it already recurses. `renderSearch` at line 112 needs no change, `flatten` already walks the assembled tree. Expansion keys already survive a reload. The `Trash` row participates in both because it is a normal folder in the assembled shape.

Cost: 60 to 80 LOC across 4 files, plus about 170 for `LocalTree.ts` and 25 in `Storage.ts`.

### 2. Right click replaces the row buttons

`SampleView.tsx`
Delete the whole `location === AssetLocation.Local && <div className="edit">` block, lines 61 to 89, and move the two actions into the existing `ContextMenu.subscribe` collector at line 36. The menu becomes: Create Audio Track(s), Preview, Edit Name and Bpm, Copy UUID, Move to, then Move to Trash or the Put Back and Delete Forever pair when the row sits in the trash.

`SoundfontView.tsx`
Same removal, lines 38 to 46 and 55 to 59. Its menu gains Move to, Rename, and the trash entries.

`SampleView.sass`
Drop the `> div.edit` rule, lines 11 to 29. `SoundfontView.sass` has the equivalent.

Selection rule, copied from admin `ContextMenus.targets`: a right click acts on the selection when the clicked row belongs to it, and on that row alone otherwise. About 6 lines, shared by both views.

Cost: 90 to 110 LOC net, mostly moved rather than written, in 4 files.

### 3. Delete key

Already wired at `ResourceBrowser.tsx` line 144. The only change is what it calls: `resourceSelection.trashSelected()` when a tree exists, `deleteSelected()` otherwise, and `deleteSelected()` unconditionally when the current view is the trash.

`ResourceSelection` grows `trashSelected()` and `restoreSelected()`. `SampleSelection` and `SoundfontSelection` implement both by delegating to the tree, which is 12 lines each.

The usage check in `SampleSelection.deleteSamples` (project, template and preset references, lines 67 to 118) stays exactly where it is and only runs on the irreversible path. Trashing is free and needs no confirmation, which is the point of having a trash.

Cost: 40 to 50 LOC in 4 files.

### 4. Drag into a folder

`ResourceFolderItem` gains an optional `interactions` prop carrying a menu provider and a drop handler. Only the local browser passes it, so the online tree is untouched.

`DragAndDrop.installTarget` on the folder header, accepting `type: "sample"` and `type: "soundfont"`. Both already exist in `AnyDragData` and both views are already drag sources, so no new drag type is needed. On drop, apply the admin rule: if the dragged item is in the selection, move the whole selection.

A second drop target on the browser's `entries` container means dropping in empty space moves to the root.

`ResourceFolderItem.sass` gains a `drag-over` rule, about 4 lines.

Dry run note: `installTarget` counts enter and leave, so nested folder rows do not flicker. The header's existing `onclick` toggle at line 48 and the drop handler do not conflict, a drop does not synthesise a click.

Cost: 70 to 90 LOC in 3 files.

### 5. Move to submenu

Port `ContextMenus.moveToItem` from admin. It builds the destination tree when the submenu opens, via `setRuntimeChildrenProcedure`, which the studio `MenuItem` supports at line 151. Root first, then the folders, with an "Into ..." entry for any folder that has children, and blocking of a folder into itself.

Written once in a new `packages/app/studio/src/ui/browse/ResourceMenus.ts` and used by both views.

Cost: 45 to 60 LOC, one new file.

### 6. New folder, rename, delete a folder

Context menu on the folder row and on the empty background: New Folder, Rename, Sort by Name (optional in v1), Delete.

Delete follows admin `Actions.remove`: an empty folder goes without asking, a folder holding samples asks "Move them up one level, or put them in the trash?", where Move Up is `dissolveFolder` and the other branch trashes the contents.

Names are made unique among siblings on create and on rename, since the path is the identity used by `expandedKeys`.

New file `packages/app/studio/src/ui/browse/FolderDialogs.tsx`, a name prompt modelled on `SampleDialogs.showNameAndBpmDialog` (there is no generic prompt in `Dialogs` today). About 45 LOC.

Cost: 90 to 110 LOC across 2 new files and 1 changed.

### 7. Newly imported samples appear in the root

Nothing to build. It follows from the implicit root, and there is a test for it in phase 5 below.

### 8. Bpm analyser in the edit dialog

`SampleDialogs.showEditSampleDialog` gains an Analyse button and the two correction buttons next to the tempo field, laid out as in the admin editor.

Analyse loads the audio with `SampleStorage.get().load(uuid)` and calls `service.sampleService.bpmDetector.detect(audioData, Progress.Empty)`. That is `WasmBpmDetector`, the same estimator the import path already uses, running in the core worker over `crates/stretch/src/tempo.rs`. It is not weaker than the admin analyser: spectral flux onsets, autocorrelation with harmonic summation, a log normal tempo prior, and a snap that makes a trimmed loop an exact number of bars.

Half and double time, the one thing detection genuinely cannot settle, are the two buttons beside the field, copied from the admin editor.

The one thing the admin dialog shows that this cannot is the match percentage. `TempoEstimate` in Rust carries `correlation` and `snapped_to_grid` (tempo.rs line 75), but the bridge narrows it to a bare number in `stretch-wasm.ts` line 9, `bpm-detection.ts` line 14, the `BpmProtocol` in `Workers.ts` line 86 and `WasmBpmDetector` line 16. Widening that to a struct is about 30 LOC across those four files plus the wasm export, and is worth doing only if the readout is wanted. Recommended: v1 reports the number and whether it snapped to the grid, and the widening is a follow up.

The dialog signature needs the service, so `SampleView` passes it in. `showEditSampleDialog` stays the only writer of name and bpm, and the `sampleManager.invalidate` call that follows it (SampleView line 77) stays as is.

Cost: 90 to 110 LOC in 2 files, plus an optional 30 for the confidence readout.

---

## Cost summary

| File | Kind | LOC |
|---|---|---|
| `ui/browse/LocalTree.ts` | new | 170 |
| `ui/browse/ResourceMenus.ts` | new | 60 |
| `ui/browse/FolderDialogs.tsx` | new | 45 |
| `ui/browse/ResourceBrowser.tsx` | change | 45 |
| `ui/browse/ResourceFolderItem.tsx` | change | 55 |
| `ui/browse/SampleView.tsx` | change | 60 |
| `ui/browse/SoundfontView.tsx` | change | 50 |
| `ui/browse/SampleSelection.ts` | change | 30 |
| `ui/browse/SoundfontSelection.ts` | change | 25 |
| `ui/browse/SampleDialogs.tsx` | change | 90 |
| `ui/browse/SampleBrowser.tsx`, `SoundfontBrowser.tsx`, `ResourceBrowserConfig.tsx` | change | 30 |
| `ui/browse/*.sass` | change | 20 |
| `studio/core/src/Storage.ts` | change | 25 |

Around 700 LOC, 3 new files, no new dependency, no schema change to any item's `meta.json`, no change to the online path.

---

## Phases

Each phase is checked in the browser before the next one starts. UI reworks that skip that end up in a stash.

**Phase 1, structure without interaction.**
`Storage.loadStructure` and `saveStructure`, `LocalTree`, the local branch of `ResourceBrowser`. Hand write a `structure.json` into OPFS and confirm the local browser draws it, that search still flattens, that expansion survives a reload, and that an unlisted sample shows at the root.

**Phase 2, right click and the delete key.**
Row buttons out, menu in, trash key path still hard delete at this point. Confirm the usage check still blocks deleting a sample a project depends on.

**Phase 3, moving.**
Move to submenu, then drag onto a folder row, then drop on the background for the root. Confirm a multi row selection moves as one.

**Phase 4, folder editing.**
New Folder, Rename, Delete with the dissolve or trash question, unique sibling names.

**Phase 5, trash.**
The pinned row, Put Back with folder recreation, Delete Forever, Empty Trash. Confirm `trash.json` still contains only the uuids that were really deleted, and that a cloud sync after a trash and restore round trip changes nothing.

**Phase 6, analyser.**
Analyse, half, double, in the edit dialog. Confirm the number reaches `meta.json` and that `sampleManager.invalidate` still makes the timeline pick it up.

---

## Risks and decisions

**`trash.json` is taken.**
It is the cloud tombstone list read by all five `CloudBackup*` classes. The soft trash must live in `structure.json`. Getting this wrong resurrects samples on the next sync, which is silent and hard to notice.

**Trashed items stay visible to everything except the browser.**
The picker, `collectAllFiles` and the cloud backup still see them. Stated above as accepted. If it turns out to be wrong, the fix is a filter in `SampleService.collectAllFiles`, not in `Storage.list`, because the backup genuinely should keep a trashed sample safe.

**Two tabs, one structure file.**
Last write wins, and `ProjectSignals.StorageUpdated` already triggers a reload at `ResourceBrowser.tsx` line 142. A move made in another tab reloads here. Two simultaneous moves lose one. Acceptable, worth a note rather than a lock.

**Folders are not selectable in v1.**
Keeps the delete key, `HTMLSelection` and `data-selection` untouched. The cost is that folder delete and rename are context menu only, which is what the feature list asks for anyway.

**Local order changes for existing users.**
Today the local list is in whatever order OPFS returns. It becomes alphabetical. That is a visible change on first run with no folders defined.

**Soundfonts have no edit dialog.**
Only the delete button exists today, so the soundfont browser gains folders, drag, move and trash, and no analyser. Rename is available through the folder dialog for folders, not for the soundfonts themselves, unless a rename entry is added later.

## Open questions

1. Should the trash be per storage (one for samples, one for soundfonts) or shared? Per storage is the cheap answer and matches where `structure.json` lives.
2. Does the trash row belong in the local root always, or only when it holds something? Admin shows it always, and always is easier to discover.
3. Should the cloud backup carry `structure.json` so folders follow a user across machines? It is one more file in `CloudBackupSamples`, roughly 20 LOC, and the merge rule for two divergent trees is the part that needs thought. Out of scope here.
4. Is the match percentage in the edit dialog worth widening the bpm bridge for?
