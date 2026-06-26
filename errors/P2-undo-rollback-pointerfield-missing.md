# Undo/abort rollback — "Could not find PointerField"

- **status:** OPEN (related fix exists for the optimized-undo path; the abort/rollback path is still exposed) · **priority:** P2
- **occurrences:** 1 · **ids:** [1014]
- **assessment:** During `undo()`, a re-applied modification fails inside `endTransaction`, so `undo` calls `abortTransaction → #rollback`, which replays the transaction's raw updates in reverse via `update.inverse()`. A `PointerUpdate.inverse` calls `field(graph)` → `findVertex(address).unwrap("Could not find PointerField at <uuid>/2")` for a field whose box/field is no longer present at that moment → panic.
- **action (proposed):** Make the **rollback path** tolerate updates whose target vertex is absent (the field's box was created+deleted within the same transaction), the same way the normal undo path was hardened. Do NOT mark fixed until shipped + tested.

[< back to index](error-triage.md)

## Reports

### Error: Error: Could not find PointerField at 5a4c87c0-d06b-41c0-826b-52d948d4f368/2
- **occurrences:** 1 · **ids:** [1014] · **span:** 2026-06-14 · **builds:** 1 (986f4064, an older build) · **browsers:** Chrome/Win
- **stack (source-mapped):**
  - `at h (lib/std/lang.js:49 (panic))`
  - `at Option.unwrap (lib/std/option.js:39 (panic))`
  - `at PointerUpdate.field (lib/box/src/updates.ts:160-162)` → `findVertex(address).unwrap(() =>` `Could not find PointerField at …`)
  - `at PointerUpdate.inverse (updates.ts:157)`
  - `at #rollback (graph.ts:296-308)`
  - `at BoxGraph.abortTransaction (graph.ts:97-102)`
  - `at BoxEditing.undo (editing.ts:116-136)`
  - triggered via `runIfProject` → global key → `dispatchGlobalKey("keydown")` (the undo shortcut)

## Investigation (root mechanism)

**The undo path's abort branch is the exposed one.** `BoxEditing.undo` (`editing.ts:116-136`):
```ts
for (const step of reversed) {
    const result = tryCatch(() => step.inverse(this.#graph))   // Modification.inverse: begin/inverse/endTransaction
    if (result.status === "failure") {
        if (this.#graph.inTransaction()) {this.#graph.abortTransaction()}   // ← rollback re-inverses raw updates
        ...
    }
}
```
`Modification.inverse` (`editing.ts:52-56`) wraps the inverse updates in `beginTransaction/endTransaction`. If `endTransaction` throws **while still in transaction** (e.g. a deferred-pointer prep or a notification during finalize), control returns to `undo`'s catch, `inTransaction()` is still `true`, and `abortTransaction()` runs `#rollback` (`graph.ts:296-308`):
```ts
const updates = this.#transactionUpdates.splice(0)
for (let i = updates.length - 1; i >= 0; i--) {updates[i].inverse(this)}   // ← raw replay, NOT optimizeUpdates
```
`PointerUpdate.inverse` → `field(graph)` → `findVertex(this.#address).unwrap("Could not find PointerField at <uuid>/2")`. The `/2` is field index 2 inside box `5a4c87c0-…`. If that box (or that specific pointer field) is not present in the graph at replay time, the unwrap panics and there is no recovery — the transaction is half-rolled-back.

**Why the field can be missing:** the rollback replays *every* raw `transactionUpdate`, including pairs where a box was created and deleted within the same logical step. The normal `undo` path avoids this via `optimizeUpdates` (which collapses such phantom pairs) — see the existing regression test `packages/lib/box/src/editing.test.ts:230` ("should handle box with pointer created and deleted in same transaction … without 'Could not find PointerField' error"). That fix covers **optimized undo**, but `#rollback` runs the **un-optimized** update list, so the same class of phantom update can still hit a missing vertex during an abort.

**Single occurrence, old build (986f4064).** Low frequency, but it leaves the document graph in a partially-rolled-back state, so it is a correctness/integrity bug (P2), not mere noise.

## Recommended fix (no band-aid)

- In the rollback replay, an update whose target vertex is absent is a no-op by definition (there is nothing to invert). Make `#rollback` skip updates whose vertex cannot be resolved — i.e. resolve via a non-panicking lookup and continue — OR run rollback over the **optimized** update list so phantom create+delete pairs are collapsed before replay (matching the normal undo path). Prefer whichever keeps a single source of truth for "what counts as a phantom update."
- Verify the surviving rollback still restores a consistent graph (no orphaned edges) after skipping absent-vertex inverses.

## Regression test

Mirror `editing.test.ts:230` but force the **abort/rollback** branch: construct a step whose `inverse` throws inside `endTransaction` while a created+deleted-in-same-transaction pointer field is on the update list, then assert `undo()` neither throws "Could not find PointerField" nor leaves a partially-rolled-back graph.
