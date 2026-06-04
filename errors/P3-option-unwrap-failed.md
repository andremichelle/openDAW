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

**id 811 — region loop-duration drag. ROOT CAUSE NOT CONFIRMED — needs a reproduction (no fix shipped).**

A first plausible hypothesis ("the dragged region is deleted mid loop-duration drag, so `update()` reads a detached `#reference`") was **tested interactively and DISPROVEN**: using `RegionLoopDurationModifier` and deleting the region while dragging produces *no exception*. The corresponding `if (!this.#reference.box.isAttached()) return` guard was implemented and then reverted — it was a band-aid on a wrong theory.

**Verified facts only:**
- Stack: `Dragging update` → `RegionLoopDurationModifier.update` → `#dispatchChange` (`#c`) → its `forEach` lambda (`#c/<`) → `Option.unwrap()` with **no message** ("unwrap failed").
- `update()`'s only private call is `#dispatchChange()` (`RegionLoopDurationModifier.ts:163-166`): `this.#adapters.forEach(adapter => adapter.trackBoxAdapter.ifSome(track => track.regions.dispatchChange()))`.
- `TrackRegions.dispatchChange()` (`TrackRegions.ts:78`) is just `#changeNotifier.notify()`. So the unmessaged `.unwrap()` is in a **change-notifier subscriber's handler**, not in the modifier — the stack is collapsed/inlined.
- Logtail context: a prior `RegionContentStartModifier{delta:-2400}` + clip-resolver run left tiny/clipped regions (`d:240`, `d:960`); then the loop-duration drag started; then a region was deleted (`consumed by Regions` = Delete key); then the unwrap. The simple delete-mid-drag alone is NOT enough (disproven), so the specific content-start/clip state appears required.

**Next step (repro-first):** reproduce by recreating that exact sequence — overlapping/clipped tiny regions from a content-start resize, then a loop-duration drag, then delete — and bisect the `TrackRegions` change-notifier subscribers to find the one doing an unmessaged `.unwrap()`. Only then fix at that subscriber. Do not ship a fix before a repro or failing test confirms it.
