# Box-graph requires-an-edge

- **status:** OPEN · **priority:** P2
- **occurrences:** 2 · **ids:** [820, 983]
- **assessment:** graph-edges.ts mandatory-pointer panic during a graph op (commit with unwired mandatory pointer).
- **action:** Identify the op (paste/import/create); wire mandatory edge or validate before endTransaction.

[< back to index](error-triage.md)

## Reports

### Error: Pointer {Wt:Ce (target) UUID/N requires an edge.
- **occurrences:** 1 · **ids:** [983] · **span:** 2026-05-25->2026-05-25 · **builds:** 1 · **browsers:** Chrome/Win
- **stack:**
  - `at tj.tryValidateAffected (../../../lib/box/dist/graph-edges.js:101:43)`
  - `at na.endTransaction (../../../lib/box/dist/graph.js:60:24)`
  - `at ../../../lib/box/dist/editing.js:172:24`
  - `at at (VideoOverlay.c0e0fc12-8684-40d7-b16a-7b85315d495e.js:1:1493)`

### Error: Target Wt UUID requires an edge.
- **occurrences:** 1 · **ids:** [820] · **span:** 2026-03-17->2026-03-17 · **builds:** 1 · **browsers:** Edge/Win
- **stack:**
  - `at h (../../../lib/std/dist/lang.js:49:38)`
  - `at main.879b1d06-6455-4576-a16d-09c07818d1fa.js:4:93645`
  - `at Array.forEach (<anonymous>)`
  - `at g_.forEach (main.879b1d06-6455-4576-a16d-09c07818d1fa.js:2:32983)`
