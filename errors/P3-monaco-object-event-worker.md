# Monaco object-Event worker

- **status:** FIXED · **priority:** P3
- **occurrences:** 2 · **ids:** [642, 703]
- **assessment:** Monaco worker-load failure throws a raw `Event`; the main-thread fallback keeps the editor working, so the surfaced error is benign noise. The two `#tryIgnore` Monaco guards missed it: `MonacoPatterns` lacked the production chunk name, and `event.error instanceof Event` was false (`event.error` is null; the signal is `event.message === "Uncaught [object Event]"`).
- **fix:** `ErrorHandler.ts` — added `"editor.main"`/`"editor.worker"` to `MonacoPatterns` (matches the minified `[name].<uuid>.js` filename, vite.config:49-50), and added `event.message === "Uncaught [object Event]"` to the Monaco `ErrorEvent` ignore branch.

[< back to index](error-triage.md)

## Reports

### Error: Uncaught [object Event]
- **occurrences:** 2 · **ids:** [642, 703] · **span:** 2026-01-22->2026-02-08 · **builds:** 2 · **browsers:** Chrome/CrOS, Chrome/Win
- **stack:**
  - `at ../../../../node_modules/monaco-editor/esm/vs/base/common/errors.js:11:16`

## Investigation (root cause + recommended fix)

**Root cause:** Both reports are Monaco worker-load failures (logtail: `Could not create web worker(s). Falling back to loading web worker code in main thread`, `Monaco worker error (falling back to main thread): undefined`). Monaco throws a raw `Event` which the browser surfaces as a window `error` event whose `event.error` is **null** (message `"Uncaught [object Event]"`), so `ErrorInfo.extract` (`ErrorInfo.ts:58-64`) takes the filename branch. The two `#tryIgnore` Monaco guards both miss: (a) `event.error instanceof Event` is false because `event.error` is null, not an Event (`ErrorHandler.ts:85`); (b) `#looksLikeMonacoError(message, error?.stack, filename)` fails because `MonacoPatterns = ["monaco-editor", "vs/base/common/errors"]` (`ErrorHandler.ts:19`) does not contain the **production** chunk name. Vite emits the monaco chunk as `editor.main.<uuid>.js` (`vite.config.ts:49-50`, entry `editor.main`), so id 642's `filename` `editor.main.9bb3d7b5…js` matches no pattern. id 703 maps to `vs/base/common/errors.js` only in the source-mapped frame; at runtime the same minified `editor.main.<uuid>.js` filename is what `#tryIgnore` sees.

**Evidence:** id 642 stack `at .../editor.main.9bb3d7b5….js:2:2645`; id 703 logtail `Monaco worker error (falling back to main thread): undefined`. Both logtails end with the un-filtered `[ErrorHandler] {"scope":"main","error":"[object]",…}` then `processError`, proving `#tryIgnore` returned false.

**Recommended fix (environmental — handle via wider Monaco/Event filtering in `#tryIgnore`):** In `packages/app/studio/src/errors/ErrorHandler.ts`: (1) add the production chunk name to `MonacoPatterns`, e.g. `"editor.main"` (and/or `"editor.worker"`), so `#looksLikeMonacoError` matches the minified filename; (2) in the `ErrorEvent` branch (`ErrorHandler.ts:83-89`) also treat `event.message === "Uncaught [object Event]"` / a message starting with `"Uncaught [object "` as a benign worker event (the `event.error instanceof Event` check cannot fire when `event.error` is null). Both are graceful filters for an environment where web workers are unavailable; the main-thread fallback already keeps the editor working.
