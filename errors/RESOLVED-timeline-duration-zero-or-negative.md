# Timeline duration zero-or-negative

- **status:** RESOLVED · **priority:** RESOLVED
- **occurrences:** 1 · **ids:** [667]
- **assessment:** 'duration will zero or negative' no longer in source.
- **action:** Mark fixed=1.

[< back to index](error-triage.md)

## Reports

### Error: duration will zero or negative(N)
- **occurrences:** 1 · **ids:** [667] · **span:** 2026-01-29->2026-01-29 · **builds:** 1 · **browsers:** Chrome/Win
- **stack:**
  - `at h (../../../lib/std/dist/lang.js:49:38)`
  - `at n.clip (main.beb15c10-6f4e-4c78-954e-24a3e1de3eec.js:43:71792)`
  - `at main.beb15c10-6f4e-4c78-954e-24a3e1de3eec.js:53:20544`
  - `at Array.forEach (<anonymous>)`

## Investigation (root cause + recommended fix)

**Root cause:** The exact message "duration will zero or negative" is gone from source. The `clip` panic in `packages/studio/adapters/src/timeline/RegionEditing.ts:27-28` was reworded and split into two specific guards ("first/second part duration will **be** zero or negative").

**Evidence:** `grep -rni "zero or negative\|will zero"` matches only the reworded strings at `RegionEditing.ts:27-28`; the original wording no longer exists.

**Recommended fix:** Verify on a current build, then mark `fixed=1` on the server.
