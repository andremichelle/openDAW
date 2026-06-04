# Monaco factory null-deref

- **status:** OPEN · **priority:** P3
- **occurrences:** 1 · **ids:** [975]
- **assessment:** 'can't access property X, e is undefined' in monaco/factory.ts:19.
- **action:** Null-guard the editor/model access.

[< back to index](error-triage.md)

## Reports

### TypeError: can't access property "X", e is undefined
- **occurrences:** 1 · **ids:** [975] · **span:** 2026-05-20->2026-05-20 · **builds:** 1 · **browsers:** Firefox/Win
- **source:** `src/monaco/factory.ts:19`
- **stack:**
  - `n.create@src/monaco/factory.ts:19:25 (monaco)`
  - `success@src/ui/shadertoy/ShadertoyEditor.tsx:52:69`
  - `Hr/a/<@../../../lib/jsx/dist/std/Await.js:7:59 (success)`
