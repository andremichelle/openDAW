# Storage transient-cached-state

- **status:** FIXED (no longer crashes; retry enhancement deferred) · **priority:** ENV
- **occurrences:** 2 · **ids:** [870, 981]
- **assessment:** Transient OPFS state — `InvalidStateError` (stale `FileSystemSyncAccessHandle`) / `UnknownError` (transient, e.g. OOM) from `OpfsWorker` write/read, propagated as unhandled rejections.
- **fix:** No longer crashes — covered by the cross-cutting non-fatal-rejection change in `ErrorHandler`. NOT globally ignore-listed (both names are generic DOMExceptions reachable from non-storage APIs, e.g. `InvalidStateError` from the AudioWorklet path).
- **deferred enhancement:** bounded single retry in `OpfsWorker.write`/`read` (re-resolve handle, retry once) on `InvalidStateError`/`UnknownError`; for a failed save, a "save failed, try again" notice would beat silent failure. Not required to avoid the crash.

[< back to index](error-triage.md)

## Reports

### InvalidStateError: [DOMException] An operation that depends on state cached in an interface object 
- **occurrences:** 1 · **ids:** [981] · **span:** 2026-05-25->2026-05-25 · **builds:** 1 · **browsers:** Chrome/Win

### UnknownError: [DOMException] The operation failed for an unknown transient reason (e.g. out of
- **occurrences:** 1 · **ids:** [870] · **span:** 2026-03-25->2026-03-25 · **builds:** 1 · **browsers:** ?/macOS

## Investigation (root cause + recommended fix)

**Root cause:** Environmental / transient. Both errors surface from OPFS access in `OpfsWorker` (`packages/lib/fusion/src/opfs/OpfsWorker.ts`) during a save. `UnknownError` ("transient reason e.g. out of memory") comes from the write path `truncate`/`write`/`flush` (`:17-19`) under memory/IO pressure. `InvalidStateError` ("state cached in an interface object had changed since read from disk") comes from a stale `FileSystemSyncAccessHandle` — the file backing an open handle changed underneath it (another tab/worker, or OPFS eviction) before `getSize`/`read`/`write` (`:17-19`, `:35-37`). Neither is a logic bug; both are browser/OS transient storage states.

**Evidence:** id 870 logtail: `MenuItem.trigger "Save"` then `UnknownError ... unknown transient reason (e.g. out of memory)` -> `processError`, `isTrusted:false`, macOS. id 981 logtail: DAWproject `encode` then `InvalidStateError ... state cached in an interface object ... changed since it was read from disk` -> `processError`, Chrome/Win. Single occurrence each, different builds/platforms — sporadic, not reproducible-by-code.

**Recommended fix:** Not a code bug; handle transiently. Since `OpfsWorker.write` already serializes per-path via `#acquireLock` (`:93-112`), the cleanest mitigation is a single bounded retry inside the worker `write`/`read` (`:12-43`) on `InvalidStateError`/`UnknownError` (re-resolve the handle and retry once) wrapped via `tryCatch`/`Promises.tryCatch`. For anything still uncaught, add a `DOMException` branch to `ErrorHandler#tryIgnore` (`packages/app/studio/src/errors/ErrorHandler.ts:96-145`, near the `SecurityError` branch at :116) matching `InvalidStateError`/`UnknownError` that `console.warn`s, shows a "Save failed, please try again" info dialog, and `preventDefault()`s so the transient state does not crash the session.
