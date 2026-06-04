# Timeline overlap-after-clipping

- **status:** OPEN (was mislabeled RESOLVED) · **priority:** P2
- **occurrences:** 5 · **ids:** [738, 740, 745, 748, 758]
- **assessment:** NOT resolved — the crash was band-aided, not fixed. The underlying defect (the clip resolver leaves two regions overlapping on a track after clipping) still occurs; only the panic was removed, so it no longer reports.
- **action:** Reproduce the clip-resolver overlap (repro-first), fix at its root; or — consistent with the #998 decision — revert the softening so it keeps surfacing. Do NOT mark fixed=1.

[< back to index](error-triage.md)

## Reports

### Error: Overlapping detected after clipping
- **occurrences:** 5 · **ids:** [738, 740, 745, 748, 758] · **span:** 2026-02-14->2026-02-23 · **builds:** 4 · **browsers:** ?/macOS, Chrome/CrOS, Chrome/Win, Firefox/Win
- **stack:**
  - `at h (../../../lib/std/dist/lang.js:49:38)`
  - `at Go.validateTrack (main.78908086-47bc-4635-a6d3-e2b707d061fc.js:43:130980)`
  - `at Go.validateTracks (main.78908086-47bc-4635-a6d3-e2b707d061fc.js:43:130668)`
  - `at T1.apply (main.78908086-47bc-4635-a6d3-e2b707d061fc.js:43:138585)`

## Investigation (verified)

**This is a band-aid, not a fix.** Commit `d3343f0c5` ("adds logging") changed `validateTrack` from `return panic("Overlapping detected after clipping")` to `console.error("[validateTrack] OVERLAP", …)` + early `return` (`packages/studio/core/src/ui/timeline/RegionClipResolver.ts:82-94`). Verified via `git show d3343f0c5`. So the message is gone, but the **clip resolver still produces overlapping regions** — the invariant violation persists in the data, now silently (no panic → no report). This is the same softening pattern as #998 (`validateTrack` "duration must be positive"), which was reverted as a band-aid.

**Root cause (mechanism UNCONFIRMED):** some clip/overlap-resolution path (`RegionOverlapResolver.apply` → `RegionClipResolver`) leaves `prev.complete > next.position` after clipping. The old reports (build `78908086`) are from when it still panicked.

**Status:** not reproduced. Needs a reproduction of the clip op that leaves the overlap before any fix. No code change shipped (repro-first).
