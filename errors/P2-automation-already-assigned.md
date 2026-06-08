# Automation Already-assigned

- **status:** FIXED (menu path) · **priority:** P2
- **occurrences:** 1 · **ids:** [915]
- **assessment:** `AutomatableParameterFieldAdapter.ts:77` asserts `#trackBoxAdapter.isEmpty()` "Already assigned" when a 2nd `TrackBox.target` (Pointers.Automation) edge reaches a parameter field. The "Create Automation" context menu (`automation.ts`) decided whether to offer creation at menu **build time** (`tracks.controls(field)` when the menu opens) but created the track at **click time without re-checking**, so a track created meanwhile (another open menu / a record / a stale click) led to a 2nd create → panic at commit.
- **fix:** `automation.ts` trigger now re-checks the authoritative `parameter.track` at execution time inside the transaction; bails if already assigned. Regression test `AutomationDoubleAssign.test.ts` (RED without guard → GREEN with it).

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

**Correction to the earlier theory (verified by test).** The earlier "stale cache within a transaction" framing was imprecise, and the proposed "move guard into `AudioUnitTracks.create()`" is wrong for two reasons:
- `create()` is shared by Notes/Audio tracks too, where **multiple** tracks per unit are legal (they target the audioUnitBox, not a parameter field). Deduping there would block legitimate 2nd audio/note tracks. The one-per-target invariant only holds for automation (Value) tracks.
- Pointer updates are **deferred to `endTransaction`** (`graph.ts:106-120` `#deferredPointerUpdates` → `#dispatchDeferredNotifications`). So *within* a transaction, neither `controls()` nor `parameter.track` nor the assert have fired yet — a guard reading them mid-transaction sees nothing. They all become authoritative only **after commit**. (Confirmed empirically in `AutomationDoubleAssign.test.ts`.)

Because the menu trigger runs as its own `editing.modify` (one transaction per click), the correct guard reads **prior-committed** state at the start of that transaction. The authoritative source is `parameter.track` (the field adapter's `#trackBoxAdapter`, the exact state the assert checks), not the `controls()` collection cache.

**Fix shipped:** `automation.ts` "Create Automation" trigger now does `if (parameter.track.nonEmpty()) {return}` before `tracks.create(...)`, inside the transaction. This closes the stale-menu race (decision made at build time, executed at click time).

**Symmetric fix — "Remove Automation".** Same stale-menu race in the other direction: the Remove item captured the track adapter at build time and the trigger did `tracks.delete(automation.unwrap())` at click time. If the track was removed meanwhile, `AudioUnitTracks.delete` panics `Cannot delete … Does not exist` (`AudioUnitTracks.ts:53`, `indexOf === -1`). Fixed to re-read the authoritative current track and no-op if gone: `parameter.track.ifSome(track => tracks.delete(track))`. Both directions covered by `AutomationDoubleAssign.test.ts` (4 tests: 2 panic repros + 2 idempotency/guard tests, each RED without its guard).

The deeper "two automation tracks for one field added inside a single transaction" case (paste/undo/collab replay) is not reachable from the menu and is out of scope here; if a future report shows it, capture the creating op with a low-noise diagnostic at `AutomatableParameterFieldAdapter.ts:77` (`new Error().stack` + box/field address) gated on the panic branch.
