# Live Collaboration: Deterministic Reconciliation (Plan)

## Problem

Yjs is a Map/sequence CRDT. It guarantees every client converges on the same **document**, but it has no
notion of the box graph's referential invariants (a pointer must resolve, an exclusive target accepts at most
one incoming pointer, a mandatory pointer may not dangle, no cycles). Two edits that are each locally valid can
therefore merge into a document that is illegal for the graph.

The previous inbound handler (`YSync.#setupYjs`) applied a remote batch and, on the resulting
`endTransaction()` validation failure, **reverted the whole batch locally while keeping the doc**. Two flaws:

1. **Over-broad.** One bad edge discards every unrelated New/Update/Delete in that batch.
2. **Non-deterministic.** Each client reverts to a *different* local state, so the peers **silently fork** — a
   live room where participants edit different projects, with no "next legitimate operation" to auto-heal it.

The `YSyncCollab.test.ts` exclusive-target test reproduces the fork (peer A keeps `ref1→target`, peer B keeps
`ref2→target`, checksums differ).

## Key idea

You cannot teach Yjs the constraints — they live one layer above it. Instead, repair the illegal state with a
function that is **pure in the converged document**:

> Every client sees the same document `D`. If the local graph is `G = f(D)` where `f` applies everything and
> then repairs violations using only data present on every client (box uuids, field addresses — never
> wall-clock time or arrival order), then all clients compute the same `G`. Convergence is restored.

The old failure path is impure (it falls back to per-client local state). The fix is to make the failure path
pure: repair from `D`, never from local history.

## Prototype (implemented)

- **`ysync/Reconcile.ts` — `deterministicReconcile(boxGraph)`**: repairs constraint violations in-place, to a
  fixpoint, ordered by uuid/address. Implemented rule: **exclusive-target overflow** → keep the lowest-addressed
  incoming pointer, drop the rest (a mandatory pointer that must drop deletes its owning box instead of
  dangling).
- **`ysync/YSync.ts`**:
  - Inbound: when the verbatim apply throws a constraint violation, abort, then **re-apply the batch, run
    `deterministicReconcile`, and commit**. Runs only on the failure path, so valid batches pay nothing.
  - `joinRoom`: reconciles before validating, so a late joiner reading an over-specified document lands on the
    same graph instead of rejecting the whole snapshot.

### Tests (`ysync/YSyncCollab.test.ts`)

Two/three/four-peer harness driving real Yjs docs (offline divergence → reconnect → merge), convergence checked
via `BoxGraph.checksum()`. Covers: independent concurrent edits, same-field LWW, delete-vs-update, pointer
retarget, deleting a pointer's target, delete-delete, long offline divergence, exclusive-target convergence +
late joiner, deterministic lowest-addressed survivor, many refs racing (one peer per ref), mandatory
drop-owner, mixed valid+violating batch preserving the valid edit, no false-positive reconcile, idempotent
re-delivery, and a **12-seed randomised multi-peer fuzz** asserting all peers and a late joiner converge with no
exclusive overflow.

## Known limitation (the reason this is a prototype, not the fix)

The reconcile's repair edits are **suppressed from the Yjs doc** (`#ignoreUpdates`). Each peer re-derives the
same repair from the doc, so live peers converge — but the **document stays over-specified** (it still contains
the dropped edges). This is sound only while exclusive attachments are **append-only**:

- If an exclusive **survivor is later detached**, live peers drop that target to empty (they already suppressed
  the losers), while a fresh `joinRoom` re-derives the next-lowest loser from the doc → **live peers diverge
  from the joiner**.

The fuzz respects this boundary (never detaches an exclusive survivor) and documents it inline.

## Productionization roadmap

1. **Publish the repair (make the doc legal).** Add a tolerant box-graph apply mode (deferred validation): apply
   the remote batch even though it is temporarily invalid, run `deterministicReconcile`, then validate, all in a
   **non-suppressed** transaction so the repair (e.g. `ref2 → empty`) flows back into Yjs. The document becomes
   legal, `graph == reconcile(doc)` holds as an invariant, and the survivor-detach divergence disappears.
   Concurrent identical repairs from multiple peers merge idempotently.
2. **Remaining constraint rules** in `deterministicReconcile` (same skeleton, each with a deterministic rule):
   - dangling non-mandatory pointer → clear it;
   - dangling mandatory pointer → delete the owning box (cascade to a fixpoint);
   - mandatory target with no incoming → deterministic policy (delete target / synthesize? — decide);
   - pointer cycles → break the edge from the higher-uuid source.
3. **Affected-scoping.** On conflict the prototype scans all boxes; scope to the affected targets using the
   `GraphEdges.#affected` set the graph already tracks.
4. **Granular reject fallback.** Even before full reconcile lands, apply the valid updates in a batch and drop
   only the offending edge, instead of discarding the whole transaction.

## Files

- `packages/studio/core/src/ysync/Reconcile.ts` (new)
- `packages/studio/core/src/ysync/YSync.ts` (inbound reconcile fallback + `joinRoom` reconcile + `#applyEvents`)
- `packages/studio/core/src/ysync/YSyncCollab.test.ts` (multi-peer convergence + fuzz)
