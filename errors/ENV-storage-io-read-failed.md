# Storage io-read-failed

- **status:** FIXED (graceful handling) · **priority:** ENV
- **occurrences:** 2 · **ids:** [697, 698]
- **assessment:** `NotReadableError` from OPFS `handle.read`/`getSize` — underlying disk/IO read failure (logtail also shows concurrent network failure → flaky machine). Environmental, unambiguous.
- **fix:** `ErrorHandler.#tryIgnore` now catches `DOMException` `NotReadableError` (tight name match) and shows a "Storage Error / temporary disk issue" dialog + `preventDefault` instead of crashing.

[< back to index](error-triage.md)

## Reports

### NotReadableError: [DOMException] The I/O read operation failed.
- **occurrences:** 2 · **ids:** [697, 698] · **span:** 2026-02-07->2026-02-07 · **builds:** 1 · **browsers:** ?/macOS

## Investigation (root cause + recommended fix)

**Root cause:** Environmental — the underlying disk I/O failed while reading an OPFS file. `NotReadableError` surfaces from `handle.read(buffer)` / `handle.getSize()` in `OpfsWorker.read` (`packages/lib/fusion/src/opfs/OpfsWorker.ts:35-37`); the worker has no try/catch on read so the rejection propagates to the read callers (e.g. `SampleStorage.load` at `packages/studio/core/src/samples/SampleStorage.ts:61-65`, project/recovery restore reads) and then to the global handler. This is a hardware/OS read failure, not a logic bug.

**Evidence:** Both ids on macOS, same build, same day. id 698 logtail: `restore {uuid...}` and `Import MIDI File...` activity, then `warn|Failed to send heartbeat: TypeError: Load failed` (network also failing) immediately before `NotReadableError` -> `processError` with `isTrusted:false`. The concurrent heartbeat failure plus `isTrusted:false` strongly indicates a flaky machine / failing disk or filesystem, i.e. environmental.

**Recommended fix:** Not a code bug. Wrap the OPFS read batch in `SampleStorage.load` (`SampleStorage.ts:61`) and the recovery/profile restore reads with `Promises.tryCatch`; on `NotReadableError` optionally retry once, then fall back to the "could not load sample/project, file may be corrupted" message rather than rejecting. Also add a `DOMException`/`NotReadableError` branch to `ErrorHandler#tryIgnore` (`packages/app/studio/src/errors/ErrorHandler.ts:96-145`, near the `SecurityError` branch at :116) that shows a "Storage read failed" info dialog and `preventDefault()`s so a transient disk read error does not hard-crash the app.
