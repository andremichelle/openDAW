# Storage page: everything in OPFS, its size and who uses it

Extension of [#453](https://github.com/andremichelle/openDAW/issues/453) ("see size of stored samples"). A subpage
`/storage` lists every project and every asset stored in this browser's OPFS, shows its size, which projects use
each asset, and lets the user delete projects and assets. The scan runs in a worker behind a progress dialog.

## What the page shows

1. **Total usage** at the top:
   - the sum of all scanned files
   - `navigator.storage.estimate()` (usage / quota) next to it, since the browser counts more than our files
2. **The disclaimer**, always visible, above the lists:
   > This only covers the storage of this browser (OPFS). It knows nothing about your projects anywhere else:
   > backups, exported bundles (.odb), project files on disk, the cloud or other browsers. An asset listed as
   > unused here may still be needed by any of those. Delete with care.
3. **Projects**, each with:
   - name, cover thumbnail, total size (project.od + meta + cover)
   - the assets it uses, with their sizes
4. **Assets**, grouped by kind, each with:
   - name and size, formatted as B / KB / MB / GB
   - the projects, templates and presets that use it (or an "unused" badge)
   - a preview for samples (play / stop, reusing `SamplePlayback`)
5. **Templates, presets, scripts, inference models, NAM packs**, each as its own section with name, size and
   delete. Templates and presets also appear as owners on the assets they use.
6. **Other**: anything under the OPFS root that no known kind claims, shown with path and size only, never
   deletable. Expected content:
   - `.backup`, the crash recovery copy of the last session (never deletable, it is what a crash restores from)
   - `samples/v1`, legacy samples from before `samples/v2`. The cleanup that removed it was dropped in
     `8f76a2f93` (2026-01-05), so a browser that skipped that window may still hold it
   - folders written by another app on the same origin (`opendaw.studio`), which share this OPFS
   - folders of future versions this build does not know yet
   A deletable "Other" could wipe the recovery copy or another app's data, and the page cannot tell what is safe.

## OPFS inventory (current layout)

| Kind | Folder | Files | Name from | Referenced by |
|---|---|---|---|---|
| Project | `projects/v1/<uuid>` | `project.od`, `meta.json`, `image.bin` | `meta.json` name | n/a |
| Template | `templates/v1/<uuid>` | same as project | `meta.json` name | n/a |
| Sample | `samples/v2/<uuid>` | `audio.wav`, `peaks.bin`, `meta.json` | `meta.json` name | `AudioFileBox` uuid |
| Soundfont | `soundfont/<uuid>` | `soundfont.sf2`, `meta.json` | `meta.json` name | `SoundfontFileBox` uuid |
| WebCLAP bundle | `wclap/<sha256>` | `bundle.tar.gz`, meta | plugin label if resolvable, else id | `WclapDeviceBox` / `WclapInstrumentBox` `url` = `opfs:<sha256>` |
| User preset | `presets/user` | one file per preset + `index.json` | index entry name | uses samples / soundfonts itself |
| Script | `scripts/v1/<uuid>` | script files | script meta | n/a |
| Inference model | `inference/models` | model files | file name | n/a |
| NAM pack (Tone3000) | `tone3000/<toneId>` | models + `pack.json` | `pack.json` name | NeuralAmp device model reference (confirm in phase 1) |
| Recovery | `.backup` | crash recovery | n/a | n/a |

Bookkeeping files (`trash.json`, `tombstones.json`, `index.json`) count into the total but are never listed or
deletable on their own.

Any other root is found by the generic walk and lands in **Other** until it gets a row.

### Phase 1 result (2026-10-12, localhost dev OPFS, 134 files, 485 MB, no unreadable files)

| Root | Files | Size | Matches the table |
|---|---|---|---|
| `wclap` | 42 (21 bundles × 2) | 356 MB | yes, no `tombstones.json` yet |
| `soundfont` | 6 (3 × 2) | 67 MB | yes |
| `samples/v2` | 69 (23 × 3) | 50 MB | yes, no `trash.json` yet |
| `inference/models` | 2 | 12 MB | yes |
| `projects/v1` | 13 | 1.2 MB | yes |
| `presets/user` | 2 | 52 kB | yes |

- Not present in this OPFS, so still unverified: `templates/v1`, `scripts/v1`, `tone3000`, `.backup`, `samples/v1`.
- WebCLAP bundles dominate (73 %). Several share the exact size (4 × 46 MB, 4 × 28 MB, 3 × 12 MB), which looks
  like the same plugin imported in several builds, each under its own sha256. Usage per bundle is the most
  valuable column of the page.
- The walk only sees the OPFS of its origin: localhost and `opendaw.studio` are separate storages.

## Worker: `StorageInspector` channel

The scan runs in its own worker (`app/studio/src/storage/storage-worker.ts`), created by `StorageInspector` for one
walk or scan and terminated after. Decoding needs every box class, which grew the shared core worker from 35 KB to
1.16 MB when tried there, a cost every user would pay at boot. Vite bundles the storage worker as a separate chunk
that loads only when the page asks for it.

Implemented in phase 2:
- `lib-fusion/src/opfs/StorageWalk.ts`: the walk (path + size per file, unreadable files listed apart)
- `studio-adapters/src/storage/StorageScan.ts`: classify, decode, join, names from each kind's meta
- `studio-adapters/src/storage/StorageInspectorProtocol.ts`: `scan(walkProgress, scanProgress)`

```ts
// lib-fusion or studio-adapters (shared by main and worker)
export interface StorageInspectorProtocol {
    scan(progress: Procedure<StorageScan.Progress>): Promise<StorageScan.Report>
}
export namespace StorageScan {
    export type Progress = { phase: "walk" | "projects" | "templates" | "presets", done: int, total: int }
    export type File = { path: string, size: int }
    export type Asset = { kind: AssetKind, id: string, name: string, size: int, folder: string, usedBy: ReadonlyArray<Owner> }
    export type Owner = { kind: "project" | "template" | "preset", id: string, name: string }
    export type Project = { kind: "project" | "template", id: string, name: string, size: int, assets: ReadonlyArray<string> }
    export type Report = { total: int, projects: ReadonlyArray<Project>, assets: ReadonlyArray<Asset>, other: ReadonlyArray<File>, failures: ReadonlyArray<string> }
}
```

The scan runs in three steps:

1. **Walk.**
   - Recursive `FileSystemDirectoryHandle` walk from the root.
   - `getFile().size` per file, files only, no reads.
   - This alone yields the total and every folder's size.
2. **Decode.**
   - For each project and template, read `project.od` and decode it into a throwaway `BoxGraph`.
   - Collect:
     - `AudioFileBox` and `SoundfontFileBox` uuids
     - `opfs:` urls of WebCLAP device boxes
   - Presets the same way, reusing the header check from `PresetStorage.listUsedAssets`.
   - A project that fails to decode goes into `failures`, and the scan goes on.
3. **Join.** Map every referenced id onto the walked asset folders.
   - Referenced but missing in OPFS: shown on the project as "missing" (useful by itself).
   - Present but referenced by nobody: "unused".

`Communicator` supports a progress callback, as `SamplePeakProtocol.generateAsync` already does, so the main
thread feeds a `DefaultObservableValue<unitValue>` into `RuntimeNotifier.progress({headline, progress, cancel})`.

Cancel needs a design decision. `Communicator` has no abort, so the first version drops the result and terminates
the dialog. If scans prove long, a cancel flag checked between projects can follow.

### Why a new channel and not the existing helpers

- **The existing helpers decode on the main thread.** `ProjectStorage.listUsedAssets`, `TemplateStorage.listUsedAssets`
  and `PresetStorage.listUsedAssets` do it once per asset kind, so a full report would decode every project three
  times and block the UI.
- **The new scan does it once.** It decodes every project a single time and collects all kinds together.
- **The old helpers stay untouched** (nothing must break). The sample and soundfont delete checks keep using them.
  Moving them onto the new scan is a later, separate change.

## Deletion

Everything goes through the existing storage APIs, never a raw `Opfs.delete`, so trash lists and tombstones stay
correct for cloud sync:

| Kind | Call |
|---|---|
| Project | `ProjectStorage.deleteProject` |
| Template | template delete in `TemplateStorage` |
| Sample | `SampleStorage.get().deleteItem` |
| Soundfont | `SoundfontStorage.get().deleteItem` |
| WebCLAP | `WclapStorage.remove` (writes the tombstone) |
| Preset | `PresetStorage.remove` |
| Script | `ScriptStorage` delete |
| Inference model | `ModelStore` delete (check it exists, else add one there) |
| NAM pack | the Tone3000 pack delete in `NamTone3000.ts` (move it to core if it is UI only) |

Safety rules:

1. **Every delete asks first** (`RuntimeNotifier.approve`). The prompt lists who uses the item and repeats the
   disclaimer line.
2. **An asset still in use** by a project, template or preset needs a second, explicit confirmation naming those
   users. The page does NOT block it the way `SampleSelection.deleteItems` does, because cleaning up is the purpose
   of this page.
3. **The open project is protected.**
   - Deleting it is refused.
   - Its assets count as used even before it is saved. The page adds the live `boxGraph` references on the main
     thread, as `SampleSelection.deleteItems` does.
4. **Projects and their assets** (multi-select):
   - "Delete project and its unused assets" deletes the project.
   - It then deletes only the assets that no other owner uses after that.
5. **After a delete:**
   - The report updates locally. Size and usage are recomputed from the in-memory report, with no rescan.
   - A "Rescan" button stays available.
6. **Cloud samples** (meta `origin`) are marked as "can be downloaded again" so deleting them reads as safe.

## UI

- `app/studio/src/ui/pages/StoragePage.tsx` + `.sass`, route `{path: "/storage", factory: StoragePage}` in `App.tsx`.
- **Entry points:**
  - a "Storage" item in the main menu directly below "Preferences" (`service/StudioMenu.ts`), navigating to
    `/storage`
  - a size line in the samples browser footer, which is the original #453 request, linking to the page
- **Layout:** tabs "Projects", "Assets", "Templates", "Presets", "Scripts", "Models", "Other". The Assets tab has
  kind filters. Every list sorts by size by default (largest first), or by name or by usage.
- **Sizes:** one formatter, `Bytes.format(n)` → `"812 B"`, `"14.2 KB"`, `"3.1 MB"`, `"1.27 GB"`. It uses base 1024 and
  one decimal from KB on. Check `lib-std` first for an existing one.
- **Sample preview:**
  - `SamplePlayback` from the service, toggled by a play button per row.
  - Only one sample plays at a time, the same as the browser.
  - Playback stops when the page is left.
- Styling follows the existing pages (`PreferencesPage`, `ErrorsPage`), with no new colours.

## Phases

Each phase has a checkpoint.

1. **Walk + inventory.**
   - Worker channel with the walk only, plus a debug dump of the tree and sizes.
   - Check: the table above matches a real OPFS. Fix the table.
2. **Decode + join.**
   - Full `Report`.
   - Tests:
     - fake OPFS (`FakeFiles.test-helper`) with two projects sharing a sample
     - one unused soundfont
     - one `opfs:` WebCLAP
     - one undecodable project
     - one missing asset
3. **Page, read only.** Total, disclaimer, projects, assets, sizes, progress dialog. Browser check by you.
4. **Preview.** Sample play / stop.
5. **Deletion.** All kinds through the storage APIs, with the approval rules and the open-project guard.
   - Tests for "project and its unused assets", which must keep assets shared with another project.
6. **#453 hook.** Size line in the samples browser linking to `/storage`.

## Decisions

1. Templates, presets, scripts, inference models and NAM packs get their own deletable sections.
2. **Other** is shown with path and size only, never deletable (proposed, not yet confirmed).
3. Route `/storage`, linked in the main menu directly below "Preferences".
