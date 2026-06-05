# File-picker not-allowed

- **status:** FIXED (graceful handling) · **priority:** ENV
- **occurrences:** 1 · **ids:** [814]
- **assessment:** `showOpenFilePicker` blocked (`NotAllowedError` - not allowed / outside a user gesture). Environmental; benign.
- **fix:** `ErrorHandler.#tryIgnore` PromiseRejectionEvent branch now treats `DOMException` `NotAllowedError` as benign alongside the existing `SecurityError` (warn + `preventDefault` + brief info dialog) instead of crashing. Optional follow-up (not shipped): invoke `FileApi.open` synchronously inside the click handler on the "Load Preset..." path so transient activation survives.

[< back to index](error-triage.md)

## Reports

### NotAllowedError: [DOMException] Failed to execute 'showOpenFilePicker' on 'Window': The request i
- **occurrences:** 1 · **ids:** [814] · **span:** 2026-03-16->2026-03-16 · **builds:** 1 · **browsers:** Edge/Win

## Investigation (root cause + recommended fix)

**Root cause:** Environmental user-gesture restriction. `window.showOpenFilePicker` requires transient activation; the browser raised `NotAllowedError` because the call was not tied to a live user gesture (gesture consumed, or call deferred behind an `await`/menu animation). Logtail shows it followed `MenuItem.trigger: "Load Preset..."`, i.e. a menu action whose handler may run after the activation window closed.

**Evidence:** 814 stack is a bare `NotAllowedError: Failed to execute 'showOpenFilePicker' ... not allowed by the user agent or the platform in the current context`. Call sites: `packages/lib/dom/src/files.ts:50` (`FileApi.open`, the generic path used by Load Preset / Audio Files), `service/SyncLogService.ts:26`, gated by `service/DebugMenu.ts:24`. `files.ts:50` already wraps the picker in `Promises.tryCatch`, so the rejection surfaces to whatever caller did not handle it.

**Recommended fix:** Two-fold. (1) Ensure the "Load Preset..." invocation path calls `FileApi.open` synchronously inside the click handler (no `await` before it) so transient activation survives. (2) Treat `NotAllowedError` as benign at the boundary: in `ErrorHandler.#tryIgnore` (`ErrorHandler.ts:96` PromiseRejectionEvent branch), add `reason instanceof DOMException && reason.name === "NotAllowedError"` alongside the existing `SecurityError` handling (`ErrorHandler.ts:116`), `console.warn` + `event.preventDefault()` (optionally a brief "Allow file access and try again" info dialog) instead of the crash dialog.
