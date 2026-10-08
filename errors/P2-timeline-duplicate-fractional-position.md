# Timeline duplicate — fractional position truncated into the source region

- **status:** FIXED (code + regression tests; deploy pending) · **priority:** P2
- **occurrences:** 1 · **ids:** [1164]
- **assessment:** Confirmed by reproduction. Switching an audio region to Timestretch makes it musical with a fractional float32 duration (converted from seconds; here 2880.04345703125). `ProjectApi.duplicateRegion` placed the copy at `region.complete` (2880.0434) and built the overlap mask from that value, so the source (ending exactly there) was not clipped. But `AudioRegionBox.position` is **Int32**: the copy was stored at 2880, overlapping the source by 0.0434 ppqn — far beyond `boundaryTolerance` (~0.001), and musical regions are not covered by the `endsAtSuccessor` exemption. The next `validateTrack` panicked. The `findFreeSpace` branch and a fractional explicit `position` had the same flaw.
- **fix:** `packages/studio/core/src/project/ProjectApi.ts` `duplicateRegion` rounds the copy position UP (`Math.ceil`) before masking and creating, in both branches — the same rule `RegionClipResolver` already applies to its trims (#287). Regression tests in `packages/studio/core/src/project/Region1164DuplicateFractional.test.ts` (exact 1164 geometry; clip / push-existing / keep-existing, findFreeSpace, explicit position). Do NOT mark fixed=1 until deployed.

[< back to index](error-triage.md)

## Reports

### Error: regions overlap: prev.complete(2880.04345703125) > next.position(2880)
- **occurrences:** 1 · **ids:** [1164 (Chrome/Win)] · **date:** 2026-10-07 · **build:** 7de1aec4
- **stack:**
  - `RegionClipResolver.validateTrack`
  - `← ProjectApi.duplicateRegion`
  - `← BoxEditing.modify ← MenuItem.trigger ("Duplicate", RegionContextMenu.ts)`
- **context (log):** Pitch → Timestretch on an audio region, then three Duplicates with region moves between tracks; the third Duplicate crashed. `regions-overlap` dump: musical audio regions at 0 / 2880 (the copy) / 9600, each of duration 2880.04345703125.

## Notes

- Other callers writing a computed (possibly fractional) ppqn into an Int32 `position` may truncate the same way; this fix covers `duplicateRegion` only.
