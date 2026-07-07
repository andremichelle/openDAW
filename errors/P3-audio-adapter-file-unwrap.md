# Audio region/clip adapter — "Cannot access file." unwrap

- **status:** OPEN (needs logs/repro) · **priority:** P3
- **occurrences:** 1 · **ids:** [1021]
- **assessment:** `AudioRegionBoxAdapter.get file` (or the identical `AudioClipBoxAdapter.get file`, both `#fileAdapter.unwrap("Cannot access file.")`) was read while the region's `AudioFileBox` pointer was unresolved. The stack goes through a notifier subscription in the app layer (`main.js:879` chunk), i.e. a subscriber accessed `.file` during a state where the file adapter option was empty — plausibly mid-transaction (deletion/undo of the file box) or a load race.
- **action:** needs the session log (only the stack was captured usefully) or a repro. Candidate hardening once the accessor is confirmed: subscribers should use the optional accessor instead of the panicking getter — but find the state that empties `#fileAdapter` first; no blind guards.

[< back to index](error-triage.md)

## Reports

### Error: Cannot access file.
- **occurrences:** 1 · **ids:** [1021] · **span:** 2026-07-03 · **builds:** 1 (169f7f25) · **browsers:** Firefox/Win
- **stack (source-mapped):**
  - `unwrap("Cannot access file.") ← get file (adapters chunk)`
  - `← subscription callback (app chunk 879:190044) ← notifier notify`
