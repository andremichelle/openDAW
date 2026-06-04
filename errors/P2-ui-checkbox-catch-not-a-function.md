# UI Checkbox catch-not-a-function

- **status:** OPEN · **priority:** P2
- **occurrences:** 2 · **ids:** [815, 816]
- **assessment:** Checkbox.tsx:21 calls .catch on a non-Promise (stack: MidiDevices.requestPermission memoizedRequest).
- **action:** Wrap value in Promise.resolve() or type-guard before .catch.

[< back to index](error-triage.md)

## Reports

### TypeError: l.catch is not a function. (In 'l.catch(p=>(l=null,p))', 'l.catch' is undefined)
- **occurrences:** 2 · **ids:** [815, 816] · **span:** 2026-03-16->2026-03-16 · **builds:** 1 · **browsers:** ?/macOS
- **source:** `src/ui/components/Checkbox.tsx:21`
- **stack:**
  - `@../../../lib/runtime/dist/promises.js:126:32 (error)`
  - `requestPermission@../../../studio/core/dist/midi/MidiDevices.js:52:86 (#memoizedRequest)`
  - `requestPermission@../../../studio/core/dist/midi/MidiDevices.js:66:4`
  - `setValue@../../../studio/core/dist/midi/MidiDevices.js:132:39`
