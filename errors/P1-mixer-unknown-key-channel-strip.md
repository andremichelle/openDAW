# Mixer Unknown-key channel-strip

- **status:** OPEN · **priority:** P1
- **occurrences:** 5 · **ids:** [924, 925, 926, 984, 985]
- **assessment:** SortedSet.get() (sorted-set.ts:128) misses inside Mixer.registerChannelStrip (Mixer.ts:64). 5x, recent.
- **action:** Find the by-uuid map queried before insert/after remove; getOrNull + guard. Reproduce add/remove audio-unit while mixer open.

[< back to index](error-triage.md)

## Reports

### Error: Unknown key: N,N,N,N,N,N,N,N,N,N,N,N,N,N,N,N
- **occurrences:** 5 · **ids:** [924, 925, 926, 984, 985] · **span:** 2026-04-20->2026-05-26 · **builds:** 2 · **browsers:** Chrome/Win, Edge/Win
- **stack:**
  - `at h (../../../lib/std/dist/lang.js:49:38)`
  - `at g (../../../lib/std/dist/lang.js:10:103 (panic))`
  - `at bA.get (main.c0e0fc12-8684-40d7-b16a-7b85315d495e.js:2:33246)`
  - `at Jq.registerChannelStrip (main.c0e0fc12-8684-40d7-b16a-7b85315d495e.js:90:23407)`
