# Preset Folders

> **Status:** Plan + dry-run cost analysis. Not started.

## TL;DR

**Cost (from dry run against actual code):** ~750-900 LOC across ~10 files. ~2 focused days for v1, plus half a day of polish.

**Shape:** Folders are sibling records to presets in the existing flat OPFS layout. Index format becomes `{version: 2, presets, folders}` with backward-compat for the bare-array shape. Folders scope to one device row or one compound section (Racks / Stash). v1 is single-level, user-presets-only, no manual ordering, alphabetical sort.

**New file:** `FolderItem.tsx` (mirrors `CompoundItem`'s shape).
**Heaviest change:** `PresetStorage.ts` gains the v2 migration, folder observable, and 5 new methods.
**New drag type:** `DragPresetMove` (PresetItem becomes a drag source so presets can be moved between folders).

**Top risks worth deciding on before starting:**
1. Whether folders survive `rebuildIndex` (recommend: store as separate `folders.json`, costs one extra OPFS read on boot).
2. `PresetStorage.observable()` shape change: keep presets-only and add `folders()`, or move to a struct? Audit consumers first.
3. Folder-delete default UX: prompt-on-non-empty vs always-prompt vs always-move-out.
4. `CloudBackupPresets` (the post-v1 cloud sync from the existing preset plan) must include folders when it lands. Track the dependency.

**Open before scaffolding:** see [Open questions](#open-questions) at the bottom.

## Goal

Let users group their saved presets into named folders. Folders live alongside preset files in the existing `presets/user/` storage (no nested OPFS directories), are scoped to the device row or compound section they belong to, and behave identically to the existing collapsible rows in `PresetBrowser`.

Concrete user stories:

- Right-click a device row (e.g. Vaporisateur) → **New Folder…** → name it "Bass Leads".
- Drag a saved preset onto a folder row → preset moves into the folder.
- Drag a preset out of a folder onto the parent device row → preset becomes ungrouped again.
- Right-click a folder → Rename / Delete (with handling for non-empty folders).
- Search auto-expands folders that contain matches; folders with no matches hide.

Out of scope for v1: nested folders, manual ordering, folders for stock presets, folders surviving `rebuildIndex`.

---

## Design

### Folder placement

Folders are scoped one of two ways:

- **Per stock-device row** (e.g. folders under Vaporisateur). Folder's `category` matches the device's category, `device` matches the device key.
- **Per compound section** (Racks under Instruments, Stash under Audio Effects, Stash under MIDI Effects). Folder's `category` is one of `audio-unit` / `audio-effect-chain` / `midi-effect-chain`; `device` is `null`.

A folder cannot move between scopes (a folder under Vaporisateur stays under Vaporisateur). A preset can only live in a folder whose scope matches its category+device.

### One level of nesting

Folders contain only presets, not other folders. v1 gets no `parentFolderId`. The schema reserves the field as `null` for forward compat without unlocking the feature.

### Stock presets stay flat

Folders contain only user presets. Stock presets render as today, ungrouped. Reason: stock metadata is read-only and per-UUID; assigning a folder to a stock preset would need a separate `userFolderAssignments` map and complicates index merging. Defer.

### Schema

Add `folderId` to the common preset metadata:

```ts
// PresetMeta.ts
type PresetCommon = {
    uuid: UUID.String
    name: string
    description: string
    created: number
    modified: number
    hasTimeline?: boolean
    folderId?: UUID.String   // NEW: undefined means "ungrouped"
}
```

New `PresetFolder` type:

```ts
export type PresetFolder = {
    uuid: UUID.String
    name: string
    category: PresetCategory                       // matches the scope's category
    device: string | null                          // device key for stock-device folders, null for compound folders
    parentFolderId: UUID.String | null             // reserved; always null in v1
    created: number
    modified: number
}
```

### Index file format

Today `presets/user/index.json` is a bare `ReadonlyArray<PresetMeta>`. Bump to a wrapped object:

```json
{
  "version": 2,
  "presets": [...],
  "folders": [...]
}
```

`parseIndex` accepts both shapes:
- Array → treat as v1, normalize to `{version: 2, presets: array, folders: []}` on next write.
- Object with `version: 2` → use as-is.
- Anything else → trigger `rebuildIndex` (same behaviour as today's failure path).

Backward compat is one-way: once v2 is written, v1 readers can't parse it. That matches the existing pattern (no version gate today either).

### Storage operations

Add to `PresetStorage`:

```ts
export const folders = (): ObservableValue<ReadonlyArray<PresetFolder>>
export const createFolder = async (folder: Omit<PresetFolder, "uuid" | "created" | "modified">) => Promise<PresetFolder>
export const renameFolder = async (uuid: UUID.Bytes, name: string) => Promise<void>
export const deleteFolder = async (uuid: UUID.Bytes, mode: "move-out" | "delete-contents") => Promise<void>
export const movePresetToFolder = async (presetUuid: UUID.Bytes, folderId: UUID.Bytes | null) => Promise<void>
```

`deleteFolder("move-out")` clears `folderId` on every preset that referenced the folder, then removes the folder record. `deleteFolder("delete-contents")` removes the presets first, then the folder. UI defaults to `move-out`.

`movePresetToFolder` validates that the target folder's `category`+`device` match the preset's. Rejects otherwise.

Cache shape changes from `cache: DefaultObservableValue<ReadonlyArray<PresetMeta>>` to two separate observables (presets and folders), or one struct observable. Two separate keeps existing subscribers minimally affected.

### UI: tree shape

Today's tree:

```
Category (h1)
  DeviceItem (header + presetList)
  DeviceItem
  ...
  CompoundItem (header + presetList)
```

New tree:

```
Category (h1)
  DeviceItem
    header
    body
      FolderItem    ← new, one per folder belonging to this device
        header
        presetList
      FolderItem
      ...           ← then ungrouped presets:
      PresetItem
      PresetItem
      ...
  ...
  CompoundItem
    header
    body
      FolderItem    ← compound-scoped folders
      ...
      PresetItem    ← ungrouped compound presets
      ...
```

`FolderItem` is structurally close to `CompoundItem`: triangle, label, count, collapsible body, drop target on the header, right-click menu for Rename/Delete.

### Drag and drop additions

Today `PresetItem` is not a drag source. Make it one:

```ts
type DragPresetMove = {
    type: "preset-move"
    uuid: UUID.String
    sourceFolderId: UUID.String | null
}
```

Drop targets that accept `preset-move`:
- `FolderItem.header` whose folder matches the preset's category+device → moves preset into folder.
- `DeviceItem.header` / `CompoundItem.header` matching the preset's category+device → moves preset out of any folder (`folderId = null`).

The existing save-from-project drags (`DragDevice`) remain untouched. Folder rows accept those too — saving a single matching effect onto a folder row creates the preset directly inside the folder.

### Right-click menus

- **DeviceItem header context menu:** "New Folder…" → opens text-input dialog → `createFolder`.
- **CompoundItem header context menu:** same.
- **FolderItem header context menu:** "Rename…" → text input → `renameFolder`. "Delete" → if empty, immediate; if non-empty, confirm "Delete N presets?" / "Move N presets out of folder?" / "Cancel".
- **PresetItem context menu** already exists (Edit / Delete). Extend with "Move to…" submenu listing existing folders in the same scope, plus "Remove from folder" when applicable.

### Filter / search interaction

Current behaviour: search auto-expands matching device rows; clearing reverts to stored expansion state.

Folder additions:
- A folder is visible iff at least one of its presets matches the filter.
- A matching folder auto-expands its parent device/compound row AND itself.
- Empty folders (no presets) always render when no filter is active; hide under filter.

### Persisted expansion keys

Today: `expandedKeys: Set<string>` keyed by `device:{categoryKey}:{deviceKey}` and `compound:{categoryKey}:{compoundCategory}`. Add `folder:{categoryKey}:{deviceKey | "compound"}:{folderUuid}`.

---

## Dry run (cost & risk analysis)

Walking the implementation file by file against the actual code in
`packages/studio/core/src/presets/PresetStorage.ts`,
`packages/studio/core/src/presets/PresetMeta.ts`,
`packages/app/studio/src/ui/browse/PresetBrowser.tsx`,
`packages/app/studio/src/ui/browse/DeviceItem.tsx`,
`packages/app/studio/src/ui/browse/CompoundItem.tsx`,
`packages/app/studio/src/ui/browse/PresetItem.tsx`,
`packages/app/studio/src/ui/browse/LibraryActions.ts`.

### Surface (what changes, where, roughly how much)

| File | Change | LOC delta (est.) |
|---|---|---|
| `PresetMeta.ts` | Add `folderId?` to `PresetCommon`. New `PresetFolder` type. | +20 |
| `PresetStorage.ts` (~195 LOC today) | New v2 index shape + `parseIndex` migration. New folder observable + 4 folder methods + `movePresetToFolder`. `cache.setValue` callsites updated. `rebuildIndex` writes `folders: []`. | +180 |
| `PresetBrowser.tsx` (~260 LOC today) | Subscribe to `PresetStorage.folders()`. Pass scoped folder list into each `DeviceItem` / `CompoundItem`. Filter logic considers folders. | +50 |
| `DeviceItem.tsx` (~140 LOC today) | Accept `folders` prop. Render `FolderItem`s before ungrouped presets. Add context-menu trigger for "New Folder…". | +60 |
| `CompoundItem.tsx` (~115 LOC today) | Same as DeviceItem. | +60 |
| New `FolderItem.tsx` + `.sass` | Mirror of `CompoundItem` structure. Header, presetList, drop target, context menu. | +180 |
| `PresetItem.tsx` (~80 LOC today) | Become drag source for `preset-move`. Add "Move to…" submenu in existing context menu. | +50 |
| `AnyDragData.ts` | Add `DragPresetMove`. | +10 |
| `LibraryActions.ts` (~530 LOC today) | New methods: `createFolder`, `renameFolder`, `deleteFolder`, `movePresetToFolder`. Save methods optionally accept `folderId`. | +100 |
| `PresetDialogs.tsx` (~240 LOC today) | New folder name input dialog. | +50 |
| **Total** | | **~750–900 LOC** across ~10 files |

Time estimate at the user's pace based on the recent preset-system work shipped: **~2 focused days for v1**, plus ~half a day of polish (filter UX, empty folder rendering, drag-feedback edge cases, error states).

### Issues / risks caught during the dry run

**1. `cache` shape coupling.**
`PresetStorage.cache` is exposed via `observable()` and consumed by `PresetBrowser.tsx:61` (`const userIndex = PresetStorage.observable()`) and re-exported through `@opendaw/studio-core`. Two patterns to pick from:
- Keep the existing observable as `presets`-only and add a sibling `folders()` observable. Less churn, more subscribers.
- Switch to a single struct observable `{presets, folders}`. Slightly cleaner but every consumer needs to destructure. Audit consumers first.

The first is safer given there might be other callsites I haven't found. Audit cost: a few greps before committing.

**2. Index migration races on first write.**
A v1-shape file gets read into an in-memory v2 cache; the next save writes back v2. If two tabs of the studio are open and the older one writes during the migration, we get last-write-wins. Same window already exists for any concurrent writer, so the folder feature doesn't worsen the race, but it's worth a one-line comment in `parseIndex` so the migration intent is clear.

**3. `rebuildIndex` doesn't reconstruct folders.**
The recovery path scans `*.odp` binaries to recover preset metadata. Folders have no binary representation, so a corrupted index loses every folder. Three mitigations:
- Accept the loss. The recovery path runs only on first boot or after corruption.
- Snapshot folders separately (`folders.json` next to `index.json`) so they survive an `index.json` rebuild. Adds one extra OPFS read on boot but is essentially free.
- Embed each preset's `folderId` plus a per-preset folder-name string into the binary, so rebuild can also reconstruct folder records.

I'd ship with mitigation 2 (separate `folders.json`). Cheap, robust, surfaces the trade-off cleanly. Adds one OPFS read per boot.

**4. Stock-preset folder constraint.**
Stock presets cannot live in user folders in v1. UI must not let users drop a stock preset onto a folder row. The drop predicate in `FolderItem` needs to inspect the dragged preset's `source` and reject `"stock"`. Easy to forget; surface it explicitly in the design.

**5. Preset-move drag conflicts with rename.**
Today `PresetItem` is not a drag source, so the row's click handler is purely "apply preset" (or open menu). Adding a drag source means we have to keep the apply-on-click behaviour intact while introducing a drag threshold. The existing `DragAndDrop.installSource` infrastructure handles this (it triggers on movement, not on click), but we should confirm the click path doesn't get swallowed when the user starts dragging and releases on the same row.

**6. Cloud backup ordering.**
Per the existing `preset-device-browser.md` plan, `CloudBackupPresets` is "to think about" — not yet built. When it lands, it must replicate folders too. Cheapest: include the v2 index format on the remote side as well, diff folders by `uuid` with `modified` as the conflict key (same pattern as presets). Note this dependency in the v1 plan so it's not lost.

**7. Folder constraints during preset save.**
Today's save dialog (`PresetDialogs.showSavePresetDialog`) returns `{name, description}`. The drag-to-save flow already routes by drop target, so saving into a folder is implicit ("the user dropped onto a folder row"). No dialog change needed for save. The only new dialog is "New Folder…".

**8. Search auto-expansion edge cases.**
The current code (`PresetBrowser.tsx:204-208` and `:233`) decides device-row visibility by combining "device name matches query" OR "≥1 preset matches". With folders, a folder match should also keep its parent device row visible AND auto-expand both the device row and the folder. That's three levels of conditional auto-expand instead of two; ensure the predicate composition stays readable.

**9. Drag-from-project save into a folder.**
The existing flow is: drag a device from the project panel onto a stock-device row in the library → save preset under that device. Extending this to folders means folder rows must also accept `DragDevice` payloads (matching category+device) and save the resulting preset with `folderId` pre-set. This is a separate code path from the preset-move drag and should be wired explicitly.

**10. Empty folder UX.**
A user-created folder with no presets renders as a triangle + name + "(0)" or similar. Decide:
- Show triangle and let user click into an empty body.
- Hide triangle and show "(empty)" hint inline.
- Auto-delete empty folders after some grace period.
None are blocking; the first is least surprising.

**11. Folder name uniqueness.**
Folders aren't paths. Allow duplicate names within the same scope (the user can sort it out). Names are display labels only; identity is `uuid`.

**12. Sort order.**
Folders rendered before ungrouped presets, sorted by name ascending. Same for presets within a folder. No manual reorder in v1.

**13. `listUsedAssets` unchanged.**
The asset-scanner walks `*.odp` binaries directly, ignoring metadata. No folder change needed.

**14. Effect-chain compounds.**
"Stash" sections have `device: null` folders. Make sure the schema validation in `movePresetToFolder` correctly compares `null === null` rather than treating `null` as "no constraint."

### What's not surfaced by the dry run

The places I did *not* audit deeply that could still bite:

- `PresetApplication.ts` (preset apply path) — likely unchanged but I didn't read it line by line.
- `TimelineDragAndDrop.ts:86` (mentioned in `preset-device-browser.md` as a source-gated load path) — folders are orthogonal to source, but if there's any preset-list rendering happening there, it might need folder awareness.
- The `rebuildIndex` path's interaction with `loadTrashedIds` / `saveTrashedIds`. If trashed IDs collide with folder UUIDs the trash file should treat folders separately. Likely fine since trash holds preset UUIDs and folder UUIDs are distinct, but worth a re-read.
- Tests. The repo has tests for some core modules but I didn't check whether `PresetStorage` has a test file. Adding folder coverage there is a small but separate task.

---

## Open questions

1. **Index file: one file or two?** Single `index.json` with `{presets, folders}` (atomic update) versus `index.json` + `folders.json` (rebuild-resilient). Recommendation: two files, gives free folder durability through `rebuildIndex`.

2. **Folder delete default:** "Move contents out" or prompt every time? Prompt is safer; "move out" is faster. Recommendation: prompt only when contents exist; immediate when empty.

3. **Stock-preset folders later?** If yes, plan a `userFolderAssignments` map keyed by stock UUID. Defer until a user actually asks for it.

4. **Drag a folder itself?** v1 = no. If we ship folder-reordering later, the same `DragPresetMove`-style infrastructure applies, with `type: "folder-move"` and a different drop predicate.

5. **Cloud backup:** when `CloudBackupPresets` lands, does the same `lock.json` cycle handle folders, or does it warrant its own catalog file? Probably the same.

---

## Suggested order of execution (when picked up)

1. **Schema + storage.** `PresetMeta`, `PresetStorage` v2 index, migration in `parseIndex`, folder observable + CRUD methods. Ship as a code-only change; UI still ignores folders.
2. **`FolderItem` component** with header, body, drop target. Render placeholder under DeviceItem/CompoundItem so the tree shape is correct even if no folders exist.
3. **Right-click "New Folder…"** on device/compound headers. User can now create empty folders.
4. **Preset-move drag source** on `PresetItem`. Folder header accepts drop. Move-out drop on parent device/compound.
5. **Folder context menu**: Rename, Delete-with-confirmation.
6. **Search & filter integration** (auto-expand folders with matches; hide empty folders during filter).
7. **Drag-from-project save into folder** (folder header accepts `DragDevice`).
8. **Cloud backup awareness** when `CloudBackupPresets` is implemented (separate plan).
