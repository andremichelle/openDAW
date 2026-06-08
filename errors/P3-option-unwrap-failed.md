# Option unwrap-failed

- **status:** OPEN (both root causes unconfirmed; deferred) · **priority:** P3
- **occurrences:** 2 · **ids:** [811, 950]
- **assessment:** Two generic `Option.unwrap()` panics ("unwrap failed", no message). #811 region loop-duration drag — disproven hypothesis, no repro. #950 "Copy AudioUnit" — earlier theory DISPROVEN (see below), unreproducible race, bare-unwrap not locatable in code.
- **action:** Deferred — revisit on recurrence. Do NOT mark `fixed=1`.

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

**id 950 — "Copy AudioUnit" menu. EARLIER THEORY DISPROVEN — root cause not located; deferred (no fix).**

The earlier claim (the outer `.unwrap()` at `TrackHeaderMenu.ts:81` returns `None`) is **wrong**. Traced the whole Copy path (2026-06):
- `editing.modify(modifier, false)` returns `Option.wrap(result.value)` / `Option.wrap(modifier())` (`editing.ts:173,199`). `TransferAudioUnits.transfer` always returns a (non-empty) array, so `modify` always yields `Some` — the outer `.unwrap()` at `:81` **cannot** be the None-unwrap.
- Every bare `.unwrap()` reachable from Copy is either `.filter`-guarded (`TransferUtils.ts:41` `output.targetAddress`), only in the `deleteSource` branch (`TransferAudioUnits.ts:40`, not used by Copy), or carries a message (`"Target AudioUnit has not been copied"`, `TrackBoxAdapter.audioUnit` `"track has no audioUnit"`). None produce a bare "unwrap failed".
- Line 82 (`userEditingManager.audioUnit.edit(copies[0].editing)`): `audioUnit` is a plain field getter, `.editing` is a `Field` getter, `UserEditing.edit` has no unwrap.
- `git`: the `false).unwrap()` line is unchanged since 2025-12-17 (report 2026-05-11), so not a since-fixed build.

Conclusion: single occurrence, logtail shows concurrent `external updates from 'Unknown Origin'` (collab/race); the bare unwrap is not locatable from code + minified stack and not reproducible. Per repo policy (no stack-theory band-aids), **no behavioral fix shipped**. Deferred; revisit if it recurs with a clearer signal (a message-bearing unwrap or a non-minified frame). Considered options if it recurs: graceful tryCatch+notice on the trigger, or a menu-trigger error boundary.

**id 811 — region loop-duration drag. ROOT CAUSE NOT CONFIRMED — needs a reproduction (no fix shipped).**

A first plausible hypothesis ("the dragged region is deleted mid loop-duration drag, so `update()` reads a detached `#reference`") was **tested interactively and DISPROVEN**: using `RegionLoopDurationModifier` and deleting the region while dragging produces *no exception*. The corresponding `if (!this.#reference.box.isAttached()) return` guard was implemented and then reverted — it was a band-aid on a wrong theory.

**Verified facts only:**
- Stack: `Dragging update` → `RegionLoopDurationModifier.update` → `#dispatchChange` (`#c`) → its `forEach` lambda (`#c/<`) → `Option.unwrap()` with **no message** ("unwrap failed").
- `update()`'s only private call is `#dispatchChange()` (`RegionLoopDurationModifier.ts:163-166`): `this.#adapters.forEach(adapter => adapter.trackBoxAdapter.ifSome(track => track.regions.dispatchChange()))`.
- `TrackRegions.dispatchChange()` (`TrackRegions.ts:78`) is just `#changeNotifier.notify()`. So the unmessaged `.unwrap()` is in a **change-notifier subscriber's handler**, not in the modifier — the stack is collapsed/inlined.
- Logtail context: a prior `RegionContentStartModifier{delta:-2400}` + clip-resolver run left tiny/clipped regions (`d:240`, `d:960`); then the loop-duration drag started; then a region was deleted (`consumed by Regions` = Delete key); then the unwrap. The simple delete-mid-drag alone is NOT enough (disproven), so the specific content-start/clip state appears required.

**Next step (repro-first):** reproduce by recreating that exact sequence — overlapping/clipped tiny regions from a content-start resize, then a loop-duration drag, then delete — and bisect the `TrackRegions` change-notifier subscribers to find the one doing an unmessaged `.unwrap()`. Only then fix at that subscriber. Do not ship a fix before a repro or failing test confirms it.
