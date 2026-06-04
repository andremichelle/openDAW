# Box-graph already-staged

- **status:** OPEN · **priority:** P2
- **occurrences:** 2 · **ids:** [662, 903]
- **assessment:** graph.ts:140 assert; box staged twice (load/import/collab race or duplicate UUID).
- **action:** Reproduce import/restore; dedupe staging / guard re-add.

[< back to index](error-triage.md)

## Reports

### Error: RootBox UUID already staged
- **occurrences:** 1 · **ids:** [903] · **span:** 2026-03-31->2026-03-31 · **builds:** 1 · **browsers:** Chrome/macOS
- **stack:**
  - `at h (../../../lib/std/dist/lang.js:49:38)`
  - `at nt (../../../lib/std/dist/lang.js:51:67 (panic))`
  - `at uc.stageBox (main.4529bd8f-147f-4173-acde-89a69905ffba.js:4:99923)`
  - `at Sa.create (main.4529bd8f-147f-4173-acde-89a69905ffba.js:4:109994)`

### Error: jp UUID already staged
- **occurrences:** 1 · **ids:** [662] · **span:** 2026-01-27->2026-01-27 · **builds:** 1 · **browsers:** Edge/Win
- **stack:**
  - `at h (../../../lib/std/dist/lang.js:49:38)`
  - `at st (../../../lib/std/dist/lang.js:51:67 (panic))`
  - `at bp.stageBox (main.beb15c10-6f4e-4c78-954e-24a3e1de3eec.js:4:92124)`
  - `at jp.create (main.beb15c10-6f4e-4c78-954e-24a3e1de3eec.js:4:101077)`
