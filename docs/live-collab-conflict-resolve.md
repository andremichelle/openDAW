# Live Collaboration Conflict Resolution

## Invariant

**The BoxGraph is always valid.** Every `endTransaction()` validates the affected boxes and rolls back the entire transaction if validation fails. There is no window where the graph is in an invalid state.

## Architecture

### Transaction Lifecycle

```
beginTransaction()
  ├─ records all updates in #transactionUpdates
  ├─ tracks affected UUIDs in GraphEdges.#affected
  │
  ├─ [operations: stageBox, unstageBox, pointer changes, primitive changes]
  │   └─ all fire updateListeners + immediateUpdateListeners immediately
  │
endTransaction()
  ├─ 1. Process deferred pointer updates (from box construction)
  ├─ 2. Validate affected boxes (tryValidateAffected)
  │     ├─ PASS → continue
  │     └─ FAIL → #rollback() → #finalizeTransaction() → throw
  ├─ 3. #finalizeTransaction()
  │     ├─ pointerHub.onAdded/onRemoved notifications
  │     ├─ finalization observers
  │     └─ onEndTransaction (transaction listeners)
```

### Rollback Mechanism

When validation fails in `endTransaction()`:

1. `#rollback()` applies all recorded updates in reverse via `update.inverse(this)`
   - Inverse operations fire through `updateListeners` and `immediateUpdateListeners` (UI controls see value restorations)
   - Inverse operations do NOT push to `#transactionUpdates` (`#rollingBack` flag suppresses this)
   - `#affected` is cleared after rollback (rollback edges are irrelevant)
   - `#pointerTransactionState` is cleared (no pointerHub notifications needed)
2. `#finalizeTransaction()` is called even on rollback
   - pointerHub notifications are naturally a no-op (state was cleared)
   - `onEndTransaction` fires so subscribers can clean up per-transaction state
3. Error is thrown to the caller

### abortTransaction()

For mid-transaction failures (e.g., YSync encounters a missing vertex):

1. `#rollback()` reverses all recorded updates
2. Clears deferred pointer updates
3. `#finalizeTransaction()` notifies subscribers of transaction end

## YSync Integration

### Receiving External Updates

```
observeDeep event arrives
  ├─ beginTransaction()
  ├─ tryCatch: process all Yjs events (#createBox, #updateValue, #deleteBox)
  │   ├─ any step can throw (missing vertex, missing box)
  │   └─ endTransaction() validates + may throw
  ├─ on failure:
  │   ├─ if still in transaction → abortTransaction()
  │   ├─ #rollbackTransaction(events) → broadcasts inverse to all peers
  │   └─ graph remains valid
  ├─ on success:
  │   └─ high-level conflict check → optional rollback to peers
```

### Strict Validation

- `#updateValue` throws if the target vertex does not exist (no silent ignoring)
- `#deleteBox` throws if the box does not exist (no silent ignoring)
- This ensures out-of-order updates (e.g., field update arrives before box creation) are rejected and rolled back to the network

### Sending Local Updates

YSync's `#setupOpenDAW` subscribes to `onEndTransaction` and `subscribeToAllUpdatesImmediate`:

- On successful transaction: collects updates and syncs to Yjs document
- On failed transaction (rollback): `onEndTransaction` still fires, `#ignoreUpdates` flag causes update array to be cleared without syncing

## Subscriber Behavior During Rollback

| Subscriber Type | Forward Events | Rollback Events | Post-Rollback State |
|---|---|---|---|
| `subscribeToAllUpdates` | All updates | Inverse updates fired | Sees net-zero (forward + inverse) |
| `subscribeToAllUpdatesImmediate` | All updates | Inverse updates fired | Sees net-zero |
| `pointerHub.subscribe` | Never (fires after validation) | Never | Clean — never saw the failed transaction |
| `subscribeTransaction.onEndTransaction` | Called | Called (after rollback) | Can clean up per-transaction state |
| `subscribeEndTransaction` (finalization) | Called | Called (after rollback) | Can clean up |
| `subscribeDeletion` | Called during unstageBox | Inverse restages → not called again | Deletion listeners may have fired; box is restored |

### Key Design Decisions

1. **Update listeners fire during rollback** — UI controls (knobs, sliders) bound to primitive values see the value change AND the restoration. This keeps displayed values in sync.

2. **pointerHub listeners do NOT fire during rollback** — they only fire after successful validation (in `#finalizeTransaction`). Since `#pointerTransactionState` is cleared by rollback, there are no notifications. Adapter collections never see the aborted changes.

3. **`onEndTransaction` fires on both success and rollback** — subscribers that accumulate per-transaction state (SyncLogWriter's subscription, YSync's update array) need the end signal to flush or clear. Without this, stale state leaks into the next transaction.

4. **`#transactionUpdates` is not written during rollback** — the `#rollingBack` flag prevents inverse operations from polluting the update log. This ensures the rollback is clean and doesn't create recursive rollback conditions.

## Dirty Tracking (Performance)

`GraphEdges.#affected` is a `UUID.newSet` (SortedSet with byte-level comparison) that tracks which box UUIDs were touched during a transaction via:

- `connect(source, target)` → adds source box UUID + target UUID
- `disconnect(source)` → adds source box UUID + old target UUID
- `watchVertex(vertex)` → adds vertex's box UUID

`tryValidateAffected()` only validates boxes in this set, not the entire graph. For a transaction touching 5 boxes in a graph of 2000+, this avoids scanning thousands of unrelated vertices.

The set is cleared inside `tryValidateAffected()` (on both success and failure) and inside `#rollback()` (to discard edges dirtied by inverse operations).

## Out-of-Order Scenarios

### Scenario: A creates box, B points to it, C receives B before A

1. C receives B's update (contains a pointer to A's box)
2. `#updateValue` or `#createBox` tries to resolve the pointer
3. If A's box doesn't exist yet → `#updateValue` throws ("Vertex does not exist")
4. Transaction is aborted, rolled back, and reversed into the network
5. When A's update arrives later, it succeeds. B's update may arrive again and succeed this time.

### Scenario: Peer removes pointer, orphaning a mandatory box

1. External update changes a pointer, leaving a mandatory box with zero incoming edges
2. `endTransaction()` → `tryValidateAffected()` detects the orphan
3. Transaction rolled back — pointer restored to previous value
4. Rollback propagated to network via `#rollbackTransaction(events)`
5. Graph remains valid

### Scenario: Local edit while external update is partially applied

This cannot happen. JavaScript is single-threaded. The external update processing (beginTransaction → process events → endTransaction) runs synchronously. No local edit can interleave.

## Undo/Redo in Live Rooms

History steps may become invalid when other participants modify the graph. Undo/redo handles this gracefully:

1. Each `Modification` in a history entry is applied in its own transaction
2. If a step's transaction fails validation (rolled back by BoxGraph), previously applied steps are re-applied in reverse to restore the graph
3. `RuntimeNotifier.info()` shows a dialog: "This history step is no longer valid due to changes from other participants."
4. `undo()`/`redo()` returns `false`, `#historyIndex` is restored

The history entry remains in the stack — it may become valid again if the conflicting participant undoes their changes.

## Deferred Pointer Notifications

Pointer updates during box construction are deferred. In `endTransaction()`:

1. Deferred updates are **prepared** (recorded in `#transactionUpdates`, pointer state tracked, vertex resolved) but NOT dispatched to subscribers
2. Validation runs against the full edge state
3. On failure: rollback reverses all updates (including deferred ones), pending notifications are discarded
4. On success: deferred notifications are dispatched to subscribers, then `#finalizeTransaction()` runs

This ensures subscribers never see notifications from a transaction that will be rolled back.

## Edge Cases

### subscribeDeletion Listeners During Rollback

`unstageBox()` fires deletion listeners AND removes them from the listener set. If a transaction deletes a box (triggering deletion listeners like `AudioUnitFreeze` or `TimelineFocus`) and then fails validation, the rollback recreates the box but the deletion listeners already fired and were removed.

In practice this is rare: a transaction would need to both delete a box AND create something invalid. `Box.delete()` cascades properly, so the deletion itself usually produces a valid state. The validation failure would need to come from a separate operation in the same transaction.

### Double Notification on subscribeVertexUpdates

`PointerField.subscribe()` uses `subscribeVertexUpdates` which pushes a one-shot observer to `#finalizeTransactionObservers`. During rollback, the dispatcher fires for both the forward and inverse updates, adding TWO observers. Both fire during `#finalizeTransaction()`, calling the subscriber twice with the same (restored) value. This is wasteful but correct — the subscriber sees the final correct state.

### Modifier Throws Before endTransaction

If the modifier callback inside `editing.modify()` throws (not a validation failure but a runtime error), `endTransaction()` is never reached. `editing.ts` detects this via `inTransaction()` and calls `abortTransaction()` to ensure the transaction is properly rolled back and closed.

## Production Review — Known Issues (for later fixes)

### P1 — YSync `#updates` accumulates stale entries during rollback within `#setupYjs`

When `endTransaction()` is called inside YSync's `#setupYjs` handler (line 129), `#ignoreUpdates` is set to `true` BEFORE `endTransaction()`. If `endTransaction()` rolls back internally, the inverse operations fire through `immediateUpdateListeners`, pushing to `#updates`. Then `#finalizeTransaction()` calls `onEndTransaction()`, and YSync's handler sees `#ignoreUpdates === true` → clears `#updates`. **This works correctly.**

However, if the failure path goes through `abortTransaction()` instead (mid-transaction failure at line 134-135), `#ignoreUpdates` is still `false` at that point (it was never set). `abortTransaction()` → `#finalizeTransaction()` → `onEndTransaction()` → YSync handler runs with `#ignoreUpdates === false` → tries to sync inverse updates to Yjs. **This would create garbage Yjs operations for boxes that don't exist.**

**Fix:** Set `this.#ignoreUpdates = true` before the `tryCatch` block, not inside it. Or set it in the failure handler before `abortTransaction()`.

### P1 — YSync `joinRoom` does not validate

`YSync.joinRoom()` (line 51-64) calls `boxGraph.beginTransaction()`, creates boxes from Yjs map, and calls `boxGraph.endTransaction()`. If the Yjs document has invalid state (orphaned mandatory boxes from a crash), the `endTransaction()` would throw. No error handling wraps this — the join would fail with an unhandled error.

**Fix:** Wrap in `tryCatch` and handle gracefully (e.g., reject the room join, notify user).

### P2 — SyncLogWriter creates stale subscription on rollback

`SyncLogWriter.#listen()` creates a temporary `subscribeToAllUpdatesImmediate` subscription in `onBeginTransaction`. On rollback, `onEndTransaction` fires (good) and terminates the subscription (good). But the `updates` array contains forward + inverse updates. A commit is created from this array (line 54). The commit contains net-zero changes but is still written to the sync log.

**Fix:** Check if the updates cancel out before creating a commit, or flag the `onEndTransaction` callback to distinguish success from rollback.

### P2 — `subscribeDeletion` listeners fire during rollback and are not restored

`unstageBox()` fires deletion listeners AND removes them (line 180). During rollback of a `NewUpdate`, `inverse()` calls `unstage()`, which fires and removes the deletion listeners. But the box existed before the transaction — the deletion listener was set up by the original owner. After rollback, the box is restored but the listener is gone.

Affected subscribers: `AudioUnitFreeze`, `TimelineFocus`.

Only occurs when a transaction both creates AND deletes boxes AND fails validation — extremely rare in practice.

### P2 — Double `subscribeVertexUpdates` notification after rollback

`PointerField.subscribe()` adds a one-shot finalization observer on each dispatcher event. During rollback, the dispatcher fires for both forward and inverse, adding two observers. `#finalizeTransaction()` fires both, calling the subscriber twice with the same (restored) value.

Harmless (subscriber sees correct final state) but wasteful.

### P3 — Dangling `targetVertex` cache (pre-existing)

When a pointer is set via `fromJSON`, `resolvedTo()` caches the vertex. If the target doesn't exist at resolution time, the cache is `None`. When the target arrives in a later transaction, the cache is NOT updated.

Inside transactions: live lookup via `findVertex()` — correct.
Outside transactions: stale cached `None` — incorrect.

This is pre-existing and unrelated to the rollback mechanism.

### P3 — Rollback storm potential

If peer A's update is repeatedly rejected by peer C, the Yjs rollback propagates back. If A re-sends and C rejects again, a rollback loop could occur.

Mitigation: Yjs state vectors should converge and deliver single `transact()` calls atomically. The P2P transport should preserve this.

### P3 — `Modification.inverse`/`forward` during undo recovery could theoretically fail

When undo fails at step N, recovery re-applies steps 0..N-1 via `completed.forward()`. These open new transactions with validation. If re-application also fails (graph was mutated by an external update between the undo steps — cannot happen in single-threaded JS, but worth noting), recovery itself would throw.

### P3 — `beginModification().revert()` silently swallows validation error

Line 279: `revert()` calls `endTransaction()` via `tryCatch` and ignores failure. If the in-progress modification created an invalid state, `endTransaction()` rolls it back (good). Then `revert()` tries to apply the inverse of the updates — but the graph was already rolled back by `endTransaction()`. The inverse would fail because the boxes don't exist. This is caught by the `result.status === "success"` check (line 281), so the inverse is skipped. **This works correctly but the intent is unclear — consider adding a comment.**

### P3 — `validateRequirements()` (full scan) is still used by `verifyPointers()`

The old full-scan `validateRequirements()` remains for `verifyPointers()` (development verification). The TODO comment about it being slow (line 142 of graph-edges.ts) still applies. Consider removing `validateRequirements()` entirely once dirty tracking is proven stable, or gating it behind a debug flag.
