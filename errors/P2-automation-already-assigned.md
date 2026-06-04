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

## Investigation (root cause + recommended fix)

**Root cause:** A second `TrackBox` whose `target` refers to a parameter field that already has an automation track gets added to the graph, so the field's pointerHub fires `onAdded` twice and the assert at `AutomatableParameterFieldAdapter.ts:77` panics. The duplicate-guard is NOT in the track-creating function. `AudioUnitTracks.create()` (`packages/studio/adapters/src/audio-unit/AudioUnitTracks.ts:34-43`) unconditionally does `box.target.refer(target)`. Dedup lives only in the two callers (`app/studio/src/ui/menu/automation.ts:14` and `studio/core/src/capture/RecordAutomation.ts:48`), and both check `tracks.controls(field)`, which queries the *cached* `IndexedBoxAdapterCollection` (`AudioUnitTracks.ts:45-48`) rather than the authoritative `field.pointerHub`. Any path that bypasses those callers, or runs while the cached collection is stale within a transaction (the logtail shows the panic firing during `RegionLoopDurationModifier`/clip ops, not during a "Create Automation" click), creates a second track for the same field.

**Evidence:** `assert(this.#trackBoxAdapter.isEmpty(), "Already assigned")` at `AutomatableParameterFieldAdapter.ts:77` inside `pointerHub.catchupAndSubscribe.onAdded` → `visitTrackBox`. `controls()` reads `this.#collection.adapters().find(...)` (`AudioUnitTracks.ts:46-47`), a cache that is not guaranteed current inside the editing transaction, while the assert reads the live pointerHub.

**Recommended fix:** Move the guard *into* `AudioUnitTracks.create()` and make it authoritative: before `box.target.refer(target)`, bail (return the existing track) if the live `field.pointerHub.filter(Pointers.Automation)` already has an incoming TrackBox, instead of relying on the cached `controls()` collection. This closes the bypass and the stale-cache window for all callers. If a reproduction is still needed, add a low-noise diagnostic at the `create` call logging `target.address` + existing pointerHub edge count when a second referrer is detected, to confirm whether the second track comes from paste/undo/record vs. the menu path.
