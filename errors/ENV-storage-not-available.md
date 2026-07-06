# Worker OPFS — "Storage not available"

- **status:** OPEN (ENV; needs graceful path in worker) · **priority:** ENV
- **occurrences:** 1 · **ids:** [1024]
- **assessment:** `navigator.storage.getDirectory()` rejected inside `workers-main` (OPFS worker `#getRoot`), rethrown as `Error("Storage not available")`. UA is Safari/macOS (Version/26.5.2) — Safari denies OPFS in private browsing / restricted contexts. Environmental, but the worker-side throw propagates as a crash report instead of the storage-unavailable UX the main thread already has (cf. the earlier "Storage not available" report #1012 handled on the main thread).
- **action:** when it recurs or when touching the OPFS worker anyway: surface the unavailability as a typed, expected failure to the main thread so the existing storage-unavailable dialog handles it, instead of an unhandled worker error.

[< back to index](error-triage.md)

## Reports

### Error: Storage not available
- **occurrences:** 1 · **ids:** [1024] · **span:** 2026-07-04 · **builds:** 1 (169f7f25) · **browsers:** Safari/macOS
- **stack:** `workers-main.js` OPFS module — `getDirectory()` rejection → `throw new Error("Storage not available")`
