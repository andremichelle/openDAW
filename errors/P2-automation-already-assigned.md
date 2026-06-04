# Automation Already-assigned

- **status:** OPEN · **priority:** P2
- **occurrences:** 1 · **ids:** [915]
- **assessment:** AutomatableParameterFieldAdapter.ts:77 assert (trackBoxAdapter must be empty) - parameter assigned to two tracks.
- **action:** Guard double-assignment in automation-track creation path.

[< back to index](error-triage.md)

## Reports

### Error: Already assigned
- **occurrences:** 1 · **ids:** [915] · **span:** 2026-04-10->2026-04-10 · **builds:** 1 · **browsers:** Chrome/macOS
- **stack:**
  - `at h (../../../lib/std/dist/lang.js:49:38)`
  - `at nt (../../../lib/std/dist/lang.js:51:67 (panic))`
  - `at visitTrackBox (main.48b9ceed-59e0-471e-a603-f6ede1a45a2f.js:4:349184)`
  - `at $t (../../../lib/std/dist/lang.js:29:52)`
