# Undo/abort rollback — "Could not find PointerField"

- **status:** FIXED (code + regression tests; deploy pending) · **priority:** P2
- **occurrences:** 1 · **ids:** [1014]
- **assessment:** Confirmed and reproduced deterministically. `BoxGraph.#rollback` replayed the **raw, un-optimized** transaction updates in reverse, with deferred pointer updates appended at the **end** of the list — out of chronological order. Two failure modes follow: (1) the reverse replay inverts a pointer update of a box that is already unstaged (or was never staged) → the exact production panic `Could not find PointerField at <uuid>/2` thrown inside `abortTransaction`; (2) inverting a mid-transaction `defer()` re-connects an edge on a phantom box right before `NewUpdate.inverse` unstages it → `has outgoing edges` panic (found while writing the regression test).
- **fix:** `packages/lib/box/src/graph.ts` — see below. Regression tests in `packages/lib/box/src/editing.test.ts` ("transaction abort integrity"). Do NOT mark fixed=1 until deployed.

[< back to index](error-triage.md)

## Reports

### Error: Error: Could not find PointerField at 5a4c87c0-d06b-41c0-826b-52d948d4f368/2
- **occurrences:** 1 · **ids:** [1014] · **span:** 2026-06-14 · **builds:** 1 (986f4064) · **browsers:** Chrome/Win
- **stack (source-mapped):** `unwrap → PointerUpdate.field → PointerUpdate.inverse → #rollback → BoxGraph.abortTransaction → BoxEditing.undo` — triggered by the undo shortcut (second undo within 400ms; session shows heavy `[openDAW] updates` cross-tab sync traffic).

## Root cause (confirmed by reproduction)

Pointer fields set **during box construction** are deferred (`#deferredPointerUpdates`) and only merged into `#transactionUpdates` at `endTransaction` — appended at the end, after e.g. the `DeleteUpdate` of the same box. When a transaction aborts instead (`abortTransaction` → `#rollback`), the same end-append happened (graph.ts) and the reverse replay processed the deferred pointer update FIRST — after its box had already been deleted within the transaction → `findVertex(...).unwrap("Could not find PointerField …")`.

Reproduction (now a regression test): inside one `editing.modify`, create a box whose pointer is set in its constructor, delete it, then throw. The old code panics with the exact production error during `abortTransaction`.

## Fix (packages/lib/box)

1. `#rollback` replays `optimizeUpdates(...)` — the same phantom-collapse the undo path already uses (`editing.test.ts:230` precedent). Phantom create+delete pairs net to nothing; replaying them raw is what resurrected edges / hit missing vertices. `optimizeUpdates` moved from `editing.ts` to `updates.ts` (import cycle), re-exported for API compatibility.
2. `#rollback` skips field updates whose vertex cannot be resolved (nothing to invert — e.g. graph diverged through an external participant, which is what `BoxEditing.undo`'s abort branch exists for).
3. `stageBox` resets `#constructingBox` and purges the never-staged box's deferred pointer updates, outgoing edges and watch registrations when a constructor throws (previously the flag stayed `true` — poisoning every subsequent box creation — and the phantom updates leaked into the rollback replay). New `GraphEdges.forgetVerticesOf` supports this without the edge-assertions of `unwatchVerticesOf`.
4. `abortTransaction` resolves (`resolvedTo`) deferred pointer updates of boxes **recreated during rollback** instead of discarding them — see [[P2-device-delete-no-device-host]] for the state this used to leave behind.

## Regression tests

`editing.test.ts` › "transaction abort integrity":
- "rollback survives a box with deferred pointer created and deleted in the aborted transaction" (#1014 signature)
- "recovers when a box constructor throws mid-transaction"
- "restores deleted boxes with resolved pointers when a transaction aborts" (#1015/#1020 state)
