# Storage file-not-found

- **status:** FIXED (no longer crashes; UX enhancement deferred) · **priority:** ENV
- **occurrences:** 4 · **ids:** [631, 766, 971, 974]
- **assessment:** OPFS entry vanished (eviction / other tab / never written) → `NotFoundError` from `OpfsWorker.#resolveFile`, propagated as an unhandled rejection from `SampleStorage.load`/`loadMeta`.
- **fix:** No longer crashes — covered by the cross-cutting non-fatal-rejection change in `ErrorHandler`. NOT globally ignore-listed (`NotFoundError` also arises from non-storage DOM ops, so a blanket branch could mask real bugs).
- **deferred enhancement:** wrap `SampleStorage.load`/`loadMeta` (`SampleStorage.ts:53,61-65`) in `Promises.tryCatch`; on `NotFoundError` treat the sample as missing (online re-fetch / "sample not found" path) instead of failing silently. Not required to avoid the crash.

[< back to index](error-triage.md)

## Reports

### NotFoundError: [DOMException] A requested file or directory could not be found at the time an o
- **occurrences:** 4 · **ids:** [631, 766, 971, 974] · **span:** 2026-01-16->2026-05-19 · **builds:** 4 · **browsers:** Chrome/Linux, Chrome/Win, Edge/Win

## Investigation (root cause + recommended fix)

**Root cause:** Environmental — an OPFS entry vanished (cleared by the browser under storage pressure, removed in another tab, or never finished writing). `NotFoundError` is thrown from `folder.getFileHandle(...)` / `getDirectoryHandle(...)` inside `OpfsWorker.#resolveFile` / `#resolveFolder` (`packages/lib/fusion/src/opfs/OpfsWorker.ts:114-126`), reached via `OpfsWorker.read` (`:30-43`). The read callers that do NOT wrap in `Promises.tryCatch` propagate it unhandled — e.g. `SampleStorage.load`/`loadMeta` (`packages/studio/core/src/samples/SampleStorage.ts:53,62-64`), which is what the instrument-replace / track flows in these logtails trigger.

**Evidence:** id 766 logtail: repeated `Replace instrument ... with ...` then `NotFoundError ... file or directory could not be found` -> `processError`. id 974: `RegionDurationModifier` edits then `NotFoundError`. id 971: `createAudioUnit type: instrument` then `NotFoundError`. id 631: `Delete` menu then `NotFoundError`. Spread across 4 builds and Chrome/Edge — consistent with environmental cache eviction, not a single regression.

**Recommended fix:** Mostly environmental, but partly a robustness gap: reads of files we expect to exist should not crash. Wrap the sample reads in `SampleStorage.load`/`loadMeta` (`SampleStorage.ts:53,61-65`) with `Promises.tryCatch` and, on `NotFoundError`, treat the sample as missing (trigger the existing online re-fetch / "sample not found" path) instead of rejecting. For the benign cases, add a `DOMException`/`NotFoundError` branch to `ErrorHandler#tryIgnore` (`packages/app/studio/src/errors/ErrorHandler.ts:96-145`, alongside the `SecurityError` branch at :116) that `console.warn`s and `preventDefault()`s rather than crashing the app, since a single missing OPFS entry should never take down the session.
