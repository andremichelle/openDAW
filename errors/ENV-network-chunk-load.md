# Network chunk-load

- **status:** FIXED (infra-mitigated, stale reports) · **priority:** ENV
- **occurrences:** 2 · **ids:** [623, 810]
- **assessment:** Stale-release dynamic-import chunk 404. Mitigated by infra: released builds now persist >=24h (so a session's chunks survive), plus the boot BUILD_UUID check (`Dialogs.cache()`) and the 5s `checkUpdates` poll (`UpdateMessage` banner) in `boot.ts`. No recurrence since 2026-03-14 (~3 months); last reports predate the 24h retention. No runtime ErrorHandler change shipped (a per-message handler was prototyped then reverted as unnecessary for this now-rare tail).

[< back to index](error-triage.md)

## Reports

### TypeError: Failed to fetch dynamically imported module: https://opendaw.studio/main/release
- **occurrences:** 1 · **ids:** [810] · **span:** 2026-03-14->2026-03-14 · **builds:** 1 · **browsers:** Chrome/macOS

### Error: Failed after N retries: TypeError: Failed to fetch dynamically imported module: 
- **occurrences:** 1 · **ids:** [623] · **span:** 2026-01-10->2026-01-10 · **builds:** 1 · **browsers:** Chrome/Win
- **source:** `src/service/Mixdowns.ts:182`
- **stack:**
  - `at l (../../../lib/runtime/dist/promises.js:70:22)`
  - `at async a (src/service/Mixdowns.ts:182:31)`
  - `at async t (src/service/Mixdowns.ts:99:23)`
  - `at async src/service/StudioService.ts:202:16`

## Investigation (root cause + recommended fix)

**Root cause:** Stale-release / environmental chunk fetch. The release-pinned URLs (`.../releases/<uuid>/typescript.<uuid>.js`, `FFmpegWorker.<uuid>.js`) 404 once a new deploy replaces that release directory, or fail on a flaky connection. 810 is a one-shot `import()` (Monaco/typescript worker) with no retry wrapper. 623 went through `dynamicImportWithRetry` (`ui/components/dynamicImportWithRetry.ts`) which retried 60x cache-busting the URL (`?t=Date.now()`) and still failed, then threw `Failed after 60 retries`.

**Evidence:** 623 logtail is `retry after failure (online: true)` x60 then the throw; its stack is `Mixdowns.ts:182` (`Promises.guardedRetry(() => ... FFmpegWorker)`) -> `Mixdowns.ts:99/loadFFmepg` -> `StudioService.ts:202 exportMixdown`. 810 has no retry frames. `online:true` confirms the network was up, so the cause is the missing chunk (stale deploy), not offline.

**Recommended fix:** On a `Failed to fetch dynamically imported module` / `Failed after N retries` rejection, show a "A new version is available, reload to continue" prompt that calls `location.reload()` (cache-busted) rather than the generic crash dialog. Wire this into `ErrorHandler.#tryIgnore` (`ErrorHandler.ts`): match `reasonMessage.includes("Failed to fetch dynamically imported module")` and offer a `Dialogs.approve` reload instead of `preventDefault`-and-swallow, since a bare ignore would leave the user with a non-functional feature.
