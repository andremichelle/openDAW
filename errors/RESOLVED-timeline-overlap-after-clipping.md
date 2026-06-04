# Timeline overlap-after-clipping

- **status:** RESOLVED · **priority:** RESOLVED
- **occurrences:** 5 · **ids:** [738, 740, 745, 748, 758]
- **assessment:** 'Overlapping detected after clipping' is gone from current source; validateTrack overlap branch is non-fatal. Verify on a current build, then mark fixed.
- **action:** Mark fixed=1; spot-check no recurrence.

[< back to index](error-triage.md)

## Reports

### Error: Overlapping detected after clipping
- **occurrences:** 5 · **ids:** [738, 740, 745, 748, 758] · **span:** 2026-02-14->2026-02-23 · **builds:** 4 · **browsers:** ?/macOS, Chrome/CrOS, Chrome/Win, Firefox/Win
- **stack:**
  - `at h (../../../lib/std/dist/lang.js:49:38)`
  - `at Go.validateTrack (main.78908086-47bc-4635-a6d3-e2b707d061fc.js:43:130980)`
  - `at Go.validateTracks (main.78908086-47bc-4635-a6d3-e2b707d061fc.js:43:130668)`
  - `at T1.apply (main.78908086-47bc-4635-a6d3-e2b707d061fc.js:43:138585)`

## Investigation (root cause + recommended fix)

**Root cause:** Message removed from source. The fatal `panic("Overlapping detected after clipping")` in `validateTrack` was replaced by a non-fatal `console.error("[validateTrack] OVERLAP", ...)` + early `return` at `packages/studio/core/src/ui/timeline/RegionClipResolver.ts:82-94`.

**Evidence:** `grep -rni` across `packages` (excluding node_modules/dist/test) finds no occurrence of "Overlapping detected after clipping". The overlap branch now logs and returns instead of throwing.

**Recommended fix:** Verify on a current build (perform clip/overlap edits, confirm no crash), then mark `fixed=1` on the server.
