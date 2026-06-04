# Monaco factory null-deref

- **status:** OPEN · **priority:** P3
- **occurrences:** 1 · **ids:** [975]
- **assessment:** 'can't access property X, e is undefined' in monaco/factory.ts:19.
- **action:** Null-guard the editor/model access.

[< back to index](error-triage.md)

## Reports

### TypeError: can't access property "X", e is undefined
- **occurrences:** 1 · **ids:** [975] · **span:** 2026-05-20->2026-05-20 · **builds:** 1 · **browsers:** Firefox/Win
- **source:** `src/monaco/factory.ts:19`
- **stack:**
  - `n.create@src/monaco/factory.ts:19:25 (monaco)`
  - `success@src/ui/shadertoy/ShadertoyEditor.tsx:52:69`
  - `Hr/a/<@../../../lib/jsx/dist/std/Await.js:7:59 (success)`

## Investigation (root cause + recommended fix)

**Root cause:** `monaco` is `undefined` at `packages/app/studio/src/monaco/factory.ts:19` (`monaco.Uri.parse`). It is not a deref inside `factory.ts` of an editor/model — `monaco` itself, the param destructured at `factory.ts:16`, arrives undefined. The caller `ShadertoyEditor.tsx:49-55` passes `monaco` obtained from `loadMonacoSetup().then(({monaco}) => monaco)` (`ShadertoyEditor.tsx:46`). The dynamic chunk import for `./monaco-setup` failed: logtail shows `retry after failure (online: true): TypeError: error loading dynamically imported module: .../main/releases/...`. `dynamicImportWithRetry` (`dynamicImportWithRetry.ts:9-19`) extracts a `poisonedUrl` and retries with a cache-busted URL; on a partially-resolved/failed module the resolved namespace lacks the `monaco` export, so `{monaco}` destructures to `undefined`, which then flows into `MonacoFactory.create`.

**Evidence:** Stack `n.create@factory.ts:19:25` → `success@ShadertoyEditor.tsx:52:69` → `Await.js success`; logtail `error loading dynamically imported module` immediately precedes the TypeError. `factory.ts:19` is `monaco.Uri.parse(uri)`; `monaco` is the first thing touched, ruling out the editor/model path (lines 20-26).

**Recommended fix:** Validate the dynamic-import result before constructing. In `ShadertoyEditor.tsx:46` map to `Option`/guard: if `monaco` (or `monaco.Uri`) `isAbsent`, route to the existing `failure`/`EditorLoadFailure` branch instead of calling `MonacoFactory.create`. Defensively, `dynamicImportWithRetry` should reject (not resolve) when the resolved module is missing expected exports so the `Await` failure path triggers. This is a transient CDN/chunk-load failure surfaced as a hard crash; the fix is graceful failure UI, not a silent null-guard inside `factory.ts`.
