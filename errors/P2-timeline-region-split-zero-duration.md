# Timeline region-split zero/negative duration

- **status:** OPEN (was mislabeled RESOLVED) · **priority:** P2
- **occurrences:** 1 · **ids:** [667]
- **assessment:** NOT resolved — only **reworded**. `RegionEditing.ts:27-28` still `panic(...)`, now "first/second part duration will be zero or negative". A region split that yields a <=0-duration part still crashes. Same 0-duration family as #933/#982/#998 ([[P1-timeline-duration-family]]).
- **action:** Reproduce a split landing at/near a region boundary that yields a <=0-duration part; fix the split math/guard at the source. Do NOT mark fixed=1.

[< back to index](error-triage.md)

## Reports

### Error: duration will zero or negative(N)
- **occurrences:** 1 · **ids:** [667] · **span:** 2026-01-29->2026-01-29 · **builds:** 1 · **browsers:** Chrome/Win
- **stack:**
  - `at h (../../../lib/std/dist/lang.js:49:38)`
  - `at n.clip (main.beb15c10-6f4e-4c78-954e-24a3e1de3eec.js:43:71792)`
  - `at main.beb15c10-6f4e-4c78-954e-24a3e1de3eec.js:53:20544`
  - `at Array.forEach (<anonymous>)`

## Investigation (verified)

**Only reworded — still crashes.** `RegionEditing.clip` (`packages/studio/adapters/src/timeline/RegionEditing.ts`) splits a region and panics when a resulting part has non-positive duration:
```
if (begin - position <= 0) {return panic(`first part duration will be zero or negative(${begin - position})`)}
if (complete - end <= 0) {return panic(`second part duration will be zero or negative(${complete - end})`)}
```
The original #667 wording ("duration will zero or negative") is gone, but the panic remains (lines 27-28). So the split that produces a degenerate part still crashes.

**Root cause (mechanism UNCONFIRMED):** a clip/separate task creates a split where `begin <= position` or `complete <= end` (cut at/outside the region edge). Likely related to the broader 0-duration family.

**Status:** not reproduced. Needs a reproduction (a split at a region boundary) before any fix. No code change shipped (repro-first).
