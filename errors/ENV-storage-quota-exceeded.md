# Storage quota-exceeded

- **status:** FIXED (graceful handling) · **priority:** ENV
- **occurrences:** 5 · **ids:** [839, 951, 952, 953, 954]
- **assessment:** OPFS write exceeded browser quota / disk full (`OpfsWorker.write` truncate/write/flush). Environmental, unambiguous.
- **fix:** `ErrorHandler.#tryIgnore` now catches `DOMException` `QuotaExceededError` (tight name match, like the accepted `SecurityError`/`NotAllowedError` branch) and shows a "Storage Full" dialog + `preventDefault` instead of crashing.

[< back to index](error-triage.md)

## Reports

### QuotaExceededError: The operation failed because it would cause the application to exceed its storag
- **occurrences:** 4 · **ids:** [951, 952, 953, 954] · **span:** 2026-05-11->2026-05-12 · **builds:** 1 · **browsers:** Edge/Win

### QuotaExceededError: Failed to execute 'truncate' on 'FileSystemSyncAccessHandle': No space available
- **occurrences:** 1 · **ids:** [839] · **span:** 2026-03-18->2026-03-18 · **builds:** 1 · **browsers:** Edge/Win

## Investigation (root cause + recommended fix)

**Root cause:** Environmental — OPFS write exceeds the browser storage quota / disk is full. The throw originates in `OpfsWorker.write` at `packages/lib/fusion/src/opfs/OpfsWorker.ts:17-19` (`handle.truncate(data.length)` / `handle.write(...)` / `handle.flush()`); the `catch` at line 20 only logs and rethrows. The rejection propagates through callers (`ProjectProfile.#writeFiles` at `packages/studio/core/src/project/ProjectProfile.ts:241-242`, and `SampleStorage.save` at `packages/studio/core/src/samples/SampleStorage.ts:35-37`) to the global `unhandledrejection` handler, which crashes the app.

**Evidence:** id 839 logtail shows `MenuItem.trigger "Save As..."` then `QuotaExceededError ... 'truncate' ... No space available` -> `processError main`. ids 951-954 logtail show `save sample 'samples/v2/...'` and DAWproject `encode` immediately before `QuotaExceededError ... exceed its storage quota` -> `processError main`. All on Edge/Win, `isTrusted:true`, single build.

**Recommended fix:** Not a logic bug. The truncate/write/flush block in `OpfsWorker.ts:16-26` already has a try/finally; rethrow only after the caller can react. Best handled at the storage callers: wrap the `Promise.all` write batches in `ProjectProfile.#writeFiles` (`ProjectProfile.ts:240`) and `SampleStorage.save` (`SampleStorage.ts:34`) with `Promises.tryCatch` and on a `QuotaExceededError` surface a `Dialogs.info({headline: "Storage Full", message: "Your browser ran out of storage. Free up disk space or delete projects/samples, then try saving again."})` instead of letting it reject. Additionally add `QuotaExceededError` handling to `ErrorHandler#tryIgnore` (`packages/app/studio/src/errors/ErrorHandler.ts:96-145`) as a `DOMException` branch (like the existing `SecurityError` branch at :116) that shows the storage-full dialog and `preventDefault()`s, so any uncaught path degrades gracefully rather than crashing.
