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

## Investigation (root cause + recommended fix)

Two distinct call sites share the generic `Option.unwrap()` panic (`option.js:39`, `lang.js:49`).

**id 950 — "Copy AudioUnit" menu.** Root cause: `packages/app/studio/src/ui/timeline/tracks/audio-unit/headers/TrackHeaderMenu.ts:77-82`. The trigger does `editing.modify(() => TransferAudioUnits.transfer(...), false).unwrap()`. The stack `audioUnit@…355046` (trigger lambda) → `at@lang.js:90` (the `tryCatch` in `Editing.modify`, `editing.ts:181-186`) → `modify@…95553` → `trigger`. `Editing.modify` returns `Option.wrap(modifier())` (`editing.ts:199`); since `TransferAudioUnits.transfer` (`TransferAudioUnits.ts:20-45`) always returns an array, the only way `modify` yields `None` is the early branch `editing.ts:171-173` returning `Option.wrap(modifier())` while already `#modifying`/in a transaction — or `transfer` itself panics on its own inner unwraps (`TransferAudioUnits.ts:37` `"Target AudioUnit has not been copied"`, `:40`). The outer `.unwrap()` at `TrackHeaderMenu.ts:81` has no message, hence the bare "unwrap failed". Evidence: logtail `MenuItem.trigger: {"label":"Copy AudioUnit",…}` immediately before the panic, plus a burst of `external updates from 'Unknown Origin'` (concurrent/collab edits) that can race the copy. Recommended fix: replace `.unwrap()` at `TrackHeaderMenu.ts:81` with `match`/`ifSome` (no-op + user notice on `None`), and tighten `TransferAudioUnits.transfer` to validate `uuidMap.get(...).target` / `collection.targetVertex` before `.unwrap()` so a missing target produces a guarded result rather than a hard panic.

**id 811 — region loop-duration drag.** Root cause: `RegionLoopDurationModifier.update` (`packages/app/studio/src/ui/timeline/tracks/audio-unit/regions/RegionLoopDurationModifier.ts:100-105`). Stack: `n.attach/<` (Dragging) → `update@…149262` (TracksManager process `update`, `TracksManager.ts:90`) → `update@…207963` (`RegionLoopDurationModifier.update`) → `#c`/`#c/<` (a private method/`.getValue()` path that unwraps). The drag holds a stale `this.#reference` adapter; the logtail shows `TimelineFocus: region deleted` plus repeated `external updates` mid-gesture, so the referenced region's box is deleted while the drag is live. `update` reads `this.#reference` getters (`position/complete/loopOffset/loopDuration` → `box.<field>.getValue()`) **unconditionally**, whereas `approve()` already guards via `box.isAttached()` (`RegionLoopDurationModifier.ts:119`). Accessing a detached box field panics with "unwrap failed". Recommended fix: guard `update` the same way `approve` does — bail early when `!this.#reference.box.isAttached()` (or filter `#adapters` to attached boxes before reading), and have `TracksManager.startRegionModifier`'s `update` arrow (`TracksManager.ts:90`) skip when the modifier's reference is no longer attached. Needs reproduction to pin the exact unwrapping getter; diagnostic: log `this.#reference.box.isAttached()` and the field address at the top of `update`.
