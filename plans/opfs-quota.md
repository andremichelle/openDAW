# OPFS Quota

A full disk must never fail a project load, and an SDK host must be able to make room and retry.
Triggered by Riffle's report (20 Nov 2026, SDK 0.0.188, studio-core 0.3.4): a sample fetched fine
ended in error because its OPFS cache write failed, the project did not open, and the customer
deleted a healthy stack that the host had labelled "Corrupted".

Status: waiting for Riffle's final decision. Implementation starts after that, on `main`
(worktree `openDAW-main`), then merged into `next-release` by hand (Sample bits replaced
`#fetchFromApi` with `#fetchAndStore` and `save` with `store` there).

## The chain

```
loader → SampleStorage.save / SoundfontStorage.save / project / preset save
       → OpfsQuota.retry
       → Workers.Opfs.write
       → OpfsWorker
```

`OpfsQuota` is part of the chain. `AssetCache` is not: it is a tool the host calls, from `/storage`,
from the Storage Full dialog, or from inside its own quota handler.

## 1. OpfsWorker

1. A short write is a quota failure. `handle.write()` returns the bytes written. With some room left
   it writes what fits and does not throw (8 MB into 2 MB free returned 2,093,056). When the count is
   less than the data, throw a `DOMException` named `QuotaExceededError`.
2. Before throwing (short write or a thrown write), truncate the file to 0, flush and close it. A half
   written file holds the disk at zero, and a file created in that window breaks Chrome's index for
   the origin (store wiped or browser exits, measured by Riffle).
3. The error stays a `DOMException`. A custom error class would arrive on the main thread as a plain
   `Error` without its name. Test that the name survives the worker boundary.
4. `removeHandle` removes `meta.json` first inside a folder, so a half removed folder fails to load
   instead of loading an empty file.

## 2. OpfsQuota (studio-core, next to Workers.ts)

```ts
OpfsQuota.install(handler: (event: OpfsQuota.Exceeded) => Promise<boolean>): Terminable
OpfsQuota.retry<T>(path, operation, rollback): Promise<T>
// Exceeded = { path: string, error: DOMException }
```

1. Each logical save wraps itself in `OpfsQuota.retry`: `SampleStorage.save`, `SoundfontStorage.save`,
   `Storage.updateMeta`, project saves, preset saves. A plain `Workers.Opfs.write` is not retried.
2. On a quota error: run the save's `rollback` (remove what it wrote), call the handler, and if it
   answers `true` run the WHOLE save once more. Retrying only the failed file could leave `audio.wav`
   cut short while the save reports success.
3. Not a quota error, no handler installed, handler answers `false`, or the retry fails: the original
   error goes to the caller. The studio does not crash, every caller handles it (section 4).
4. Saves failing together share one call of the handler.
5. One handler. Open: does a second `install` replace the first or panic?
6. No automatic eviction. Only the host decides what is deleted.

Riffle's use (Option A): `OpfsQuota.install(async () => (await makeRoomInCache()) > 0)`

## 3. Storage saves

1. `SampleStorage.save` and `SoundfontStorage.save` write their files in sequence, `meta.json` last.
   A `meta.json` that parses then means a whole entry by design.
2. Saves never overlap: one queue shared by sample and soundfont saves (six overlapping saves at 2 MB
   free crashed Chrome in every run).
3. A failed save removes its folder before it rethrows (the `rollback` of section 2).
4. `#readOrRegeneratePeaks` rewrites peaks best effort, a failed rewrite does not fail the load.

## 4. Callers when the error comes through

1. Downloaded sample (`GlobalSampleLoaderManager.#fetchFromApi`) or soundfont
   (`DefaultSoundfontLoader.#fetch`): keep it in memory, `setLoaded`, log a warning. The project
   opens and plays, the asset downloads again next time. Riffle's top priority.
2. Import (`SampleService.importFile`) and recording (`RecordingWorklet.#finalize`): the Storage Full
   dialog (section 6). No "keep for this session", it would not survive a reload. Replaces the
   current "Storage Unavailable" notice of `RecordingWorklet`.
3. Project or preset save: the existing "could not save" error.

## 5. Errors a host can tell apart

1. `GraphValidationError` (lib-box) for the three checks in `graph-edges.ts` ("requires an edge",
   "is exclusive but has N incoming pointers"). A host says "corrupted" only on this error.
2. Optional `cause` on the `error` state of `SampleLoaderState` and `SoundfontLoaderState`
   (additive, SDK consumers unaffected). `getAudioData` rejects with that cause attached.
3. `getOpfsRoot` keeps the original error (`InvalidStateError`) as cause.

## 6. AssetCache (studio-core)

The host's tool to free space. Never part of the request chain.

1. `AssetCache.scan(...)`: decodes every project, template and preset in OPFS, as `/storage` does
   today (`StorageScan` moves from the app into studio-core, the studio's worker imports it).
   Result: total bytes, freeable bytes, each asset with kind, id, name, size, stored date
   (`File.lastModified` of its audio file, read by `StorageWalk`), in use or not.
2. Freeable = on the host's cached list (re-downloadable) AND used by no stored project, template or
   preset AND held by no loaded project (loader reference counts, covers an open unsaved project).
   - openDAW: the cached list is the library catalog (`FactoryCatalog`). Cloud backup imports and
     recordings are NOT cached, a project load never fetches from the backup.
   - Riffle: stores no projects in OPFS, so only open boards hold assets. Their cached list: open.
3. `AssetCache.clear(assets)`: list required, no default. Removes only those, skipping anything not
   freeable, reports removed and skipped. Removes `meta.json` first. Never writes `trash.json`, so
   the cloud backup is never affected (`deleteItem` must not be used).
4. `AssetCache.clearAll(exclude)`: everything freeable except `exclude`. `exclude` required, `[]` on
   purpose.
5. Dropped: `clearOlderThan`. Age cannot tell a stale cache entry from a failed upload (Riffle).

## 7. Studio

1. Storage Full dialog, run with the scan's numbers before it opens:

   **Storage Full**
   'Kick 01.wav' could not be saved because the browser storage is full.
   openDAW can delete 214 library samples and 3 soundfonts (1.2 GB) that none of your projects,
   templates or presets use. They download again from the openDAW library if you ever need them.
   Your own imports and recordings are never deleted.
   Buttons: Delete & Retry, Cancel.

   - Delete & Retry: `AssetCache.clearAll([])`, then save again. Fails again: the dialog comes back.
   - Nothing freeable: says so, links to `/storage`, only Cancel.
   - Cancel: drops the import, or removes the recording and its region.
2. `/storage` page uses `AssetCache` (scan and the new Free Cache action next to Delete Unused).
3. Footer item, label "Storage", value like "1.46GB", red above 2 GB, click opens `/storage`.
   Measured by walking OPFS (`StorageWalk`), not `estimate().usage`, which reports 0 MB after a
   restart for files written through sync access handles (Riffle, item 4). Updates at boot, every
   60 s and when leaving `/storage`. Fixed min width, no layout jump.

## 8. Order

1. OpfsWorker (section 1)
2. Storage saves and callers (sections 3, 4.1)
3. Distinguishable errors (section 5)
4. OpfsQuota (section 2)
5. AssetCache (section 6)
6. Storage Full dialog (section 7.1, 4.2)
7. `/storage` page (section 7.2)
8. Footer (section 7.3)
9. Tests with every step. Riffle tests a build on their full-disk rig.

## Open

1. Riffle's final decision (reply sent: Option A, `AssetCache.clear(assets)` offered as optional).
2. Riffle's cached list, or everything.
3. Can Riffle's OPFS be cleared completely once all uploads are done? (They answered: almost, no
   server copy and open boards stay.)
4. Second `OpfsQuota.install`: replace or panic.
5. `getDirectory()` rejecting with `InvalidStateError` (storage gone until restart): own event, or out
   of scope.

## Riffle item 4, for the record

Chrome 153: removing a sync handle written file with a plain `removeEntry` or after
`createWritable()` drives `estimate().usage` negative (shown as 4 GB minus the shortfall, adds up
across sessions). Only emptying through a sync access handle (our #527 fix) leaves it alone. Even so,
after a restart the figure leaves out everything written through sync access handles.
