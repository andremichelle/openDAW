# Monaco object-Event worker

- **status:** OPEN · **priority:** P3
- **occurrences:** 2 · **ids:** [642, 703]
- **assessment:** Worker load failure surfaced as Event. ErrorHandler filters some; these slipped.
- **action:** Extend Monaco event filtering in ErrorHandler.

[< back to index](error-triage.md)

## Reports

### Error: Uncaught [object Event]
- **occurrences:** 2 · **ids:** [642, 703] · **span:** 2026-01-22->2026-02-08 · **builds:** 2 · **browsers:** Chrome/CrOS, Chrome/Win
- **stack:**
  - `at ../../../../node_modules/monaco-editor/esm/vs/base/common/errors.js:11:16`
