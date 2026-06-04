# Option unwrap-failed

- **status:** OPEN · **priority:** P3
- **occurrences:** 2 · **ids:** [811, 950]
- **assessment:** Generic unwrap panics; need per-stack context.
- **action:** Pull stacks; replace with guarded handling.

[< back to index](error-triage.md)

## Reports

### Error: unwrap failed
- **occurrences:** 2 · **ids:** [811, 950] · **span:** 2026-03-14->2026-05-11 · **builds:** 2 · **browsers:** ?/macOS, Firefox/Win
- **stack:**
  - `h@../../../lib/std/dist/lang.js:49:48 (issue)`
  - `audioUnit@main.2cd353a9-64aa-4ec9-a7b0-4cfed46ac4ee.js:4:355046`
  - `@main.2cd353a9-64aa-4ec9-a7b0-4cfed46ac4ee.js:869:174846`
  - `@main.2cd353a9-64aa-4ec9-a7b0-4cfed46ac4ee.js:4:95595`
