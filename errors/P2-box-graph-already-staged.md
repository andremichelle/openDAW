# Box-graph already-staged

- **status:** OPEN (mechanism identified, NOT reproducible; deferred) · **priority:** P2
- **occurrences:** 2 · **ids:** [662, 903]
- **assessment:** `BoxGraph.stageBox` `#boxes.add` returns false inside `TransferUtils.copyBoxes` — a `createBox(name, uuid)` where `uuid = uuidMap.get(source).target` already exists in the target graph. For #903 the duplicated box is the source RootBox.
- **action:** Deferred — see 2026-06 update. A safe idempotent-staging guard exists but could not be validated against the real report (no faithful repro); not shipped.

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

## Investigation (root cause + recommended fix)

**Shared mechanism:** both panic in `BoxGraph.stageBox` (`graph.ts:139-140`) — `this.#boxes.add(box)` returns `false` because a box with that UUID is already in the target SortedSet. The stack `stageBox <- Box.create <- BoxGraph.createBox <- (arrow) <- Array.forEach <- (arrow) <- tryCatch(statement)` is the box-creation loop in `TransferUtils.copyBoxes` (`TransferUtils.ts:88-99`), the engine of "Extract AudioUnit Into New Project" / cross-project transfer.

**Root cause (662 — "Extract AudioUnit Into New Project"):** `TrackHeaderMenu.ts:102-107` builds a fresh `Project.new` (whose `ProjectSkeleton.empty` already stages a RootBox, AudioBus, output AudioUnit, Timeline, GrooveShuffleBox and a tempo `ValueEventCollectionBox` — `ProjectSkeleton.ts:42-83`), then runs `TransferAudioUnits.transfer` into that non-empty graph (`TransferAudioUnits.ts:33`). `copyBoxes` re-stages every entry of `dependenciesOf(audioUnit, {alwaysFollowMandatory, stopAtResources})` with `uuidMap.get(source).target` (`TransferUtils.ts:90-98`). `generateMap` assigns `target = source.address.uuid` for `resource:"preserved"` deps (`TransferUtils.ts:57`); the only dedupe is `existingPreservedUuids`, populated solely from `resource === "preserved"` boxes already present at copy start (`TransferUtils.ts:67-72, 94`). A dependency that is mandatory/`shared` (not `preserved`) but already resident in the freshly-built skeleton under the same UUID, or a preserved box reached via two paths, slips past that guard and is staged a second time -> `<box> already staged`. The panicking class `jp` is a non-RootBox dependency box.

**Root cause (903 — RootBox):** same `copyBoxes` loop; here the duplicated UUID is the source project's `RootBox`. The dependency walk follows incoming/outgoing mandatory edges and can surface the source `RootBox` (RootBox is not `preserved`, `RootBox.ts:4-...`, so it is never registered in `existingPreservedUuids`). When its UUID is not remapped by `generateMap` (which only maps the AudioUnit `collection`/`output` *targets*, not the RootBox box UUID — `TransferUtils.ts:37-59`) it is staged into a graph that already owns a RootBox of a different identity, but the SortedSet rejects the second add of that specific UUID. Log for 903 shows region-move activity then the `forEach` createBox panic with `RootBox <uuid> already staged`.

**Evidence:** 662 log: `Extract AudioUnit Into New Project` -> `New Project created` -> `Project was created` -> panic; 903 stack identical shape (`stageBox <- create <- createBox <- forEach <- tryCatch`). Both are single-occurrence, different builds.

**Recommended fix:** in `TransferUtils.copyBoxes`, make staging idempotent against the target graph for ALL resources, not just `preserved`: before `targetBoxGraph.createBox(..., uuid, ...)` check `targetBoxGraph.findBox(uuid).nonEmpty()` and skip (the box already exists and should be shared/remapped). Additionally, `generateMap` must never leave a structural/singleton box (RootBox, primary AudioBus, output AudioUnit) mapped to its source UUID when the target already has its own — these should be remapped to the target skeleton's mandatory-box UUIDs or excluded from `dependencies` up front (extend the `excludeBox` predicate passed to `dependenciesOf` in `TransferAudioUnits.ts:23-30` / `TransferUtils.ts:145-148` to drop RootBox and the skeleton singletons). Do NOT soften the assert.
- Because the exact offending dependency box is not pinned from a single report, add a low-noise diagnostic at `graph.ts:139` gated on `added === false`: capture `new Error().stack`, `box.name`, `box.address.toString()`, and whether the resident box is the same object reference, so the next occurrence names the duplicated class and the staging call site exactly.

## Update (2026-06) — could not reproduce; speculative fix reverted

Tried to ship the idempotent-staging guard (`if (targetBoxGraph.findBox(uuid).nonEmpty()) return` in `copyBoxes`, generalising the existing `existingPreservedUuids` skip) with a regression test, and **reverted it** because the collision could not be faithfully reproduced:
- **Structural singletons do not enter `dependencies` from a well-formed graph.** `dependenciesOf` only follows an outgoing edge when the *target field* is a mandatory pointer target (`graph.ts` trace: `targetVertex.pointerRules.mandatory`). RootBox/primary-bus receiving fields (`audioUnits`, bus `input`) are NOT mandatory targets, so they are never pulled in. The existing `copies to target graph in cross-project scenario` test confirms a normal cross-project transfer does not collide. So #903 needs a malformed/migrated source graph (its logtail showed region-move activity) that I cannot construct.
- A synthetic test that *forces* the source RootBox into `deps` does not reproduce the exact collision: `generateMap`'s `addMany` keeps both the collection-mapping entry (source-root→target-root) and the deps entry (source-root→fresh) for the same key, so the RootBox resolves to a fresh uuid (an extra RootBox), not the target's uuid (the collision). Not faithful.

The guard is safe and correct (it only skips when the target already owns the mapped uuid), but per repro-first it was not shipped without a valid reproduction. Recommend the `graph.ts:139` `added===false` diagnostic instead, to pin the offending box + dependency-walk path on the next occurrence, then fix at source (likely a migration leaving a structural box reachable via an unexpected mandatory edge).

**Tangential finds (both fixed; `TransferAudioUnits.test.ts` now 18/18 green):**
1. `createAudioRegion` helper did not set the now-mandatory `AudioRegionBox.events`, so 5 region tests failed at source creation with "events requires an edge". Fixed the helper (`box.events.refer(ValueEventCollectionBox.create(...).owners)`).
2. **Real `reorderAudioUnits` bug.** Its no-`insertIndex` branch placed copies via `existing.findIndex(order > maxOrder)` on an array sorted by *index*. The primary Output unit has the highest order (3) but can hold a low index, so `findIndex` returned its position and the copy was inserted before it — an ordering-inconsistent result (an instrument landing ahead of the Output unit). Fixed by sorting `existing` by `AudioUnitOrdering` before placement. Production-safe (no-op when Output is already last, which `AudioUnitFactory` always maintains); only the test's manual setup exposed it. Updated the 3 index-test expectations to the correct instruments-before-Output values.

(Separately, `studio/adapters` `EnginePreferences.test.ts` has 2 pre-existing failures, unrelated to transfer.)
