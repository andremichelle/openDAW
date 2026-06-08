# Generic unhandledrejection

- **status:** FIXED (rejections no longer fatal) · **priority:** ENV
- **occurrences:** 2 · **ids:** [807, 809]
- **assessment:** Synthetic injected events: `isTrusted:false`, no `reason`, empty stack, `foreignOrigin:null` — not first-party, nothing to extract. But the deeper bug was the failure MODE, not the diagnosis: `processError` made EVERY non-ignored error fatal (`AnimationFrame.terminate()` + recovery dialog), so any unhandled rejection — even a reason-less one — killed the whole app.
- **fix:** `ErrorHandler.processError` now treats `PromiseRejectionEvent` as NON-fatal: an async task failed but the render loop is intact, so it `preventDefault`s, reports once for visibility, and keeps the session alive (no terminate, no fatal dialog). Synchronous `error` events stay fatal (possible corrupted state). This is the root fix behind the whole rejection-as-crash class (storage, network, monaco, etc. are defence-in-depth on top). Did NOT ignore-list the opaque `"unhandledrejection"` string (too broad).

[< back to index](error-triage.md)

## Reports

### UnknownError: unhandledrejection
- **occurrences:** 2 · **ids:** [807, 809] · **span:** 2026-03-12->2026-03-14 · **builds:** 2 · **browsers:** ?/macOS

## Investigation (root cause + recommended fix)

**Root cause:** Environmental, opaque. A promise rejected with a non-Error reason (so `ErrorInfo.extract` fell back to `name:"UnknownError", message:"unhandledrejection"`). No stack and no first-party frame are recoverable. The logtails show a normal boot then `start AudioWorklet` / `AudioContext resumed (running)`; `isTrusted:false` indicates a synthetic/dispatched event, consistent with a browser-internal or injected rejection rather than our code.

**Evidence:** Both reports: empty `stack`, `message:"unhandledrejection"`, `name:"UnknownError"`, `foreignOrigin:null`, `looksLikeExtension:false`, `isTrusted:false`. 807 logtail ends at `AudioContext resumed (running)`, 809 right after `Booted in 581ms`. Nothing first-party in either tail.

**Recommended fix:** Primary: improve diagnostics rather than suppress blindly. In `ErrorInfo.extract` / the report payload, when a `PromiseRejectionEvent.reason` is a non-Error, capture `String(reason)` (and `reason?.constructor?.name`) instead of collapsing to `"unhandledrejection"`, so future occurrences carry real context. If, with richer context, these stay non-first-party, add an `IgnoredErrors`/`ThirdPartyAppPatterns` entry in `ErrorHandler.ts:11`. Until then, do NOT ignore-list the opaque `"unhandledrejection"` string, it is too broad and could mask real first-party rejections.
