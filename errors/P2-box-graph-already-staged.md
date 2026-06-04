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

## Investigation (root cause + recommended fix)

**Shared mechanism:** both panic in `BoxGraph.stageBox` (`graph.ts:139-140`) — `this.#boxes.add(box)` returns `false` because a box with that UUID is already in the target SortedSet. The stack `stageBox <- Box.create <- BoxGraph.createBox <- (arrow) <- Array.forEach <- (arrow) <- tryCatch(statement)` is the box-creation loop in `TransferUtils.copyBoxes` (`TransferUtils.ts:88-99`), the engine of "Extract AudioUnit Into New Project" / cross-project transfer.

**Root cause (662 — "Extract AudioUnit Into New Project"):** `TrackHeaderMenu.ts:102-107` builds a fresh `Project.new` (whose `ProjectSkeleton.empty` already stages a RootBox, AudioBus, output AudioUnit, Timeline, GrooveShuffleBox and a tempo `ValueEventCollectionBox` — `ProjectSkeleton.ts:42-83`), then runs `TransferAudioUnits.transfer` into that non-empty graph (`TransferAudioUnits.ts:33`). `copyBoxes` re-stages every entry of `dependenciesOf(audioUnit, {alwaysFollowMandatory, stopAtResources})` with `uuidMap.get(source).target` (`TransferUtils.ts:90-98`). `generateMap` assigns `target = source.address.uuid` for `resource:"preserved"` deps (`TransferUtils.ts:57`); the only dedupe is `existingPreservedUuids`, populated solely from `resource === "preserved"` boxes already present at copy start (`TransferUtils.ts:67-72, 94`). A dependency that is mandatory/`shared` (not `preserved`) but already resident in the freshly-built skeleton under the same UUID, or a preserved box reached via two paths, slips past that guard and is staged a second time -> `<box> already staged`. The panicking class `jp` is a non-RootBox dependency box.

**Root cause (903 — RootBox):** same `copyBoxes` loop; here the duplicated UUID is the source project's `RootBox`. The dependency walk follows incoming/outgoing mandatory edges and can surface the source `RootBox` (RootBox is not `preserved`, `RootBox.ts:4-...`, so it is never registered in `existingPreservedUuids`). When its UUID is not remapped by `generateMap` (which only maps the AudioUnit `collection`/`output` *targets*, not the RootBox box UUID — `TransferUtils.ts:37-59`) it is staged into a graph that already owns a RootBox of a different identity, but the SortedSet rejects the second add of that specific UUID. Log for 903 shows region-move activity then the `forEach` createBox panic with `RootBox <uuid> already staged`.

**Evidence:** 662 log: `Extract AudioUnit Into New Project` -> `New Project created` -> `Project was created` -> panic; 903 stack identical shape (`stageBox <- create <- createBox <- forEach <- tryCatch`). Both are single-occurrence, different builds.

**Recommended fix:** in `TransferUtils.copyBoxes`, make staging idempotent against the target graph for ALL resources, not just `preserved`: before `targetBoxGraph.createBox(..., uuid, ...)` check `targetBoxGraph.findBox(uuid).nonEmpty()` and skip (the box already exists and should be shared/remapped). Additionally, `generateMap` must never leave a structural/singleton box (RootBox, primary AudioBus, output AudioUnit) mapped to its source UUID when the target already has its own — these should be remapped to the target skeleton's mandatory-box UUIDs or excluded from `dependencies` up front (extend the `excludeBox` predicate passed to `dependenciesOf` in `TransferAudioUnits.ts:23-30` / `TransferUtils.ts:145-148` to drop RootBox and the skeleton singletons). Do NOT soften the assert.
- Because the exact offending dependency box is not pinned from a single report, add a low-noise diagnostic at `graph.ts:139` gated on `added === false`: capture `new Error().stack`, `box.name`, `box.address.toString()`, and whether the resident box is the same object reference, so the next occurrence names the duplicated class and the staging call site exactly.
