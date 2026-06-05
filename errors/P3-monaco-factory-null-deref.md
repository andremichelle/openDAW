# Monaco factory null-deref

- **status:** OPEN (root cause located in `dynamicImportWithRetry`, mechanism unconfirmed, no repro) · **priority:** P3
- **occurrences:** 1 · **ids:** [975]
- **assessment:** `monaco` arrives `undefined` at `factory.ts:19` because `dynamicImportWithRetry`'s retry returns the scraped poisoned-URL namespace as success instead of the originally-requested module. Consumer null-guard rejected as band-aid.
- **action:** Reproduce a transitive monaco-setup chunk 404→recover; confirm which namespace the retry returns; fix the retry to re-resolve the original module and reject on missing exports.

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

**Deeper root cause (the real defect, mechanism UNCONFIRMED).** The bug is in `dynamicImportWithRetry` (`packages/app/studio/src/ui/components/dynamicImportWithRetry.ts:9-19`), not the consumer. On the retry path it does `import(\`${poisonedUrl}?t=${Date.now()}\`)` and returns *that* namespace as the success value. `poisonedUrl` is scraped from the failure message via `UrlPattern` (`:4,:16`) — i.e. the URL of whatever chunk failed to fetch. When the failed chunk is `monaco-setup` itself the re-import still exports `monaco`; but when the scraped URL is a transitive-dependency chunk (or a partially-resolved module), `guardedRetry` resolves *successfully* to a namespace that has no `monaco` export. `{monaco}` then destructures to `undefined` and flows into `MonacoFactory.create`. So the retry returns the wrong namespace as a success instead of rejecting.

**Why no fix shipped (band-aid rejected).** A consumer-side guard (`ShadertoyEditor.tsx:46`: `isAbsent(monaco) ? panic(...) : [monaco]`) was tried and reverted — it only masks the upstream retry returning a wrong namespace; every other `dynamicImportWithRetry` consumer would still be exposed. The correct fix belongs in `dynamicImportWithRetry`: the retry must re-resolve the *originally requested* module (return the namespace `staticImport()` would yield), not the scraped poisoned-dependency URL — and reject when the resolved namespace is missing expected exports. But the exact failing path (which URL Firefox scrapes; whether it is monaco-setup or a dependency; whether the namespace is partial vs wrong-module) is **not confirmed**: single occurrence (#975), Firefox/Win, transient CDN/chunk-load, not locally reproducible. Shipping a retry rewrite without a repro risks regressing the working retry path. **No code change shipped — needs a reproduction (force a transitive monaco-setup dependency chunk to 404 once, then recover) to confirm which namespace the retry returns before fixing.**
