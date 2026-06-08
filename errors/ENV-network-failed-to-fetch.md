# Network failed-to-fetch

- **status:** FIXED (non-fatal via cross-cutting rejection fix) · **priority:** ENV
- **occurrences:** 4 · **ids:** [604, 624, 761, 813]
- **assessment:** Transient/environmental fetch failures (`TypeError: Failed to fetch` / `network error`), stackless, no first-party frame — background fetches (heartbeat already self-catches in `UserCounter`; FFmpeg core CDN download). All arrive as unhandled promise rejections.
- **fix:** Covered by the cross-cutting `ErrorHandler` change — unhandled rejections are now non-fatal (reported once, app stays alive). Deliberately did NOT add `"Failed to fetch"` to `IgnoredErrors` (too broad; would mask real first-party fetch failures); the non-fatal path stops the crash without that risk.

[< back to index](error-triage.md)

## Reports

### TypeError: Failed to fetch
- **occurrences:** 3 · **ids:** [604, 761, 813] · **span:** 2026-01-07->2026-03-15 · **builds:** 3 · **browsers:** Chrome/Win, Edge/Win

### TypeError: network error
- **occurrences:** 1 · **ids:** [624] · **span:** 2026-01-10->2026-01-10 · **builds:** 1 · **browsers:** Edge/Win

## Investigation (root cause + recommended fix)

**Root cause:** Transient/environmental network failure, no first-party frame in any stack (bare `TypeError: Failed to fetch` / `network error`). These are background fetches hitting a dropped connection: the heartbeat POST (`UserCounter.ts:19`, surfaced in 813/624 logtails as `Failed to send heartbeat: TypeError: Failed to fetch`) and the FFmpeg core CDN download (624 logtail `[FFmpeg] Downloading core files...`).

**Evidence:** All four reports are stackless `TypeError: Failed to fetch` / `network error`; logtails 813 and 624 show `warn|Failed to send heartbeat: TypeError: Failed to fetch` right before the report; `foreignOrigin:null`, `looksLikeExtension:false`. None point at a recoverable app fetch that should be retried (real retryable fetches already use `Promises.guardedRetry`).

**Recommended fix:** Add `"Failed to fetch"` and `"network error"` to `IgnoredErrors` in `packages/app/studio/src/errors/ErrorHandler.ts:11`. The PromiseRejectionEvent path at `ErrorHandler.ts:99` matches via `reasonMessage.includes(...)`, so both bare-`TypeError` rejections are suppressed with a `console.warn`. Optionally gate on `navigator.onLine === false` and show a transient offline indicator, but the ignore-list entry is the minimal correct fix.
