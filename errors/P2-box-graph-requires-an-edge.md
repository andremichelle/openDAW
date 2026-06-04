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

## Investigation (root cause + recommended fix)

**Root cause (820 — record-audio swap):** `RecordAudio.onSaved` creates a new `AudioFileBox` keyed by the saved sample UUID and re-points the old box's incoming pointers to it (`RecordAudio.ts:150-161`). `AudioFileBox` is a box-level mandatory target (`forge-boxes/.../AudioFileBox.ts:18` `pointerRules.mandatory:true`). The guard at `RecordAudio.ts:135-140` collects `oldFileBox.pointerHub.incoming()`, but for a Box vertex `incomingEdgesOf` returns ALL pointers on the box including those targeting the `transient-markers` field (`graph-edges.ts:93-96`, `pointer-hub.ts:67`). So when the old box has transient-marker pointers but its box-level `AudioFile`/region pointer is already detached, `incomingPointers.length` is non-zero, the early-return at L137 is skipped, `newFileBox` is created (L150), only transient pointers are moved (L155/159), and no `AudioFile` edge ever lands on the new box. At `endTransaction` (`graph.ts:114`) `tryValidateAffected` (`graph-edges.ts:118-123`) panics: `Target <newFileBox> requires an edge`.

**Evidence:** log tail order: `importSample 'Recording'` -> `save sample 'samples/v2/2b580f94...'` (the `onSaved` UUID) -> `warn Wt 2b580f94...` -> `requires an edge`. The panicking UUID equals the *saved* sample UUID, i.e. the freshly-created `newFileBox`, not the old box. Box-level mandatory + `pointerHub.incoming()` aggregating the transient-markers field is the mismatch.

**Root cause (983 — audio-units paste):** `AudioUnitsClipboardHandler.paste` -> `pasteNewAudioUnit` deserializes via `ClipboardUtils.deserializeBoxes` (`AudioUnitsClipboardHandler.ts:181`, `ClipboardUtils.ts:80-95`). The pasted set (log: `ValueRegionBox, ValueEventBox, ValueEventCollectionBox...`) contains a `ValueEventCollectionBox` (`resource:"shared"`) whose field 2 `owners` is `mandatory:true` (`ValueEventCollectionBox.ts:10-14`). Its required incoming pointer comes from `ValueRegionBox.events` (`ValueRegionBox.ts:11`). `deserializeBoxes` remaps internal pointers via `uuidMap` and otherwise falls back to `options.mapPointer`, which for `pasteNewAudioUnit` only handles AudioUnits/AudioOutput/MIDIDevice and returns `Option.None` otherwise (`AudioUnitsClipboardHandler.ts:185-197`). If the owning `ValueRegionBox` (or its `events` edge) is excluded/not in the copied set while the shared collection box is, the collection's `owners` field is left empty -> `{ValueEventCollectionBox:owners (target) UUID/2 requires an edge` at `endTransaction`.

**Evidence:** message `Pointer {Wt:Ce (target) 4f73fe09.../2 requires an edge` (field key `/2` == `owners`); stack `tryValidateAffected -> endTransaction -> editing.modify(tryCatch) -> AudioUnitsClipboardHandler.paste -> ClipboardManager`; copy/paste log lists `ValueEventCollectionBox` and `ValueRegionBox`.

**Recommended fix:**
- 820: in `RecordAudio.onSaved`, split the box-level incoming pointers from the `transient-markers` field pointers. Use `oldFileBox.transientMarkers.pointerHub.incoming()` for transients and the *box-level-only* incoming (excluding field-targeted pointers) for the `length === 0` short-circuit and for `pointer.refer(newFileBox)`. Concretely: derive `incomingPointers` from `oldFileBox.pointerHub.incoming()` filtered to `pointer.targetAddress.isBox()`, so the early `delete()` fires when there is no real consumer, and the new box is never committed unwired.
- 983: the copy/dependency walk must keep mandatory `owners`/consumer edges. Either (a) ensure `dependenciesOf` for the copied audio-unit always pulls the `ValueRegionBox` that owns any included shared `ValueEventCollectionBox`, or (b) in `pasteNewAudioUnit.mapPointer`, drop boxes whose mandatory incoming edge cannot be satisfied rather than committing them. A blanket mapPointer fallback is not safe.
- Both are still single-occurrence with no local repro; if a fix cannot be landed with confidence, add low-noise diagnostics in `graph-edges.ts:122-123` capturing `new Error().stack` plus the offending box name/UUID and the addresses of its expected-but-missing incoming pointer types, gated only on the panic branch, so the next report names the exact op and field.
