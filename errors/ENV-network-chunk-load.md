# Network chunk-load

- **status:** ENV · **priority:** ENV
- **occurrences:** 2 · **ids:** [623, 810]
- **assessment:** Stale release / dynamic-import chunk failure.
- **action:** Reload prompt on chunk-load error.

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
