# Robust Editing & Live Collaboration Conflict Resolution

## Problem Statement

Error 906: In a P2P live room, external Yjs updates can leave the BoxGraph in a temporarily inconsistent state (e.g., a mandatory box with no incoming edges). When the local user then performs any `editing.modify()`, the global `validateRequirements()` scan catches the externally-introduced violation and crashes.

## Root Cause

`validateRequirements()` in `GraphEdges` is a **global scan** — it checks every watched vertex, not just those affected by the current transaction. External P2P updates (via `YSync`) never call `validateRequirements()`, so inconsistencies accumulate silently until a local edit triggers the scan.

## Goal

**The BoxGraph should always be valid.** Invalid transactions should be rejected and rolled back. This applies to both local edits and external P2P updates.

## Design

### 1. Dirty Tracking in GraphEdges

Track which box UUIDs were affected during a transaction via a `UUID.newSet` (SortedSet with byte-level comparison — never use plain `Set<UUID.Bytes>`).

Populate from:
- `connect(source, target)` → source box UUID + target UUID
- `disconnect(source)` → source box UUID + old target UUID  
- `watchVertex(vertex)` → vertex's box UUID

Add `tryValidateAffected(): Option<Error>` that only validates boxes in the affected set. Clear the set after validation (inside the method, not externally).

Keep `validateRequirements()` for full-graph verification (`verifyPointers()`, development checks).

### 2. Transaction Validation & Rollback in BoxGraph

`endTransaction()` should:
1. Process deferred pointer updates (record them in `#transactionUpdates` BEFORE dispatching to subscribers)
2. Validate affected boxes via `tryValidateAffected()`
3. On failure: roll back all recorded updates via `update.inverse()`, then finalize
4. On success: dispatch deferred notifications, then finalize

**Rollback details:**
- Record all updates during a transaction in `#transactionUpdates` (skip recording during rollback via `#rollingBack` flag)
- Apply inverse updates in reverse order — these fire through `updateListeners` and `immediateUpdateListeners` so UI controls see value restorations
- Clear deferred pointer updates, affected set, pointer transaction state
- Deferred pointer notifications should NOT be dispatched to subscribers before validation passes

**`abortTransaction()`** for mid-transaction failures (e.g., YSync encounters missing vertex): same rollback + finalize.

**Validation only runs when `boxFactory` is installed** (production graphs). Test graphs without factories skip validation.

### 3. `onEndTransaction(rolledBack: boolean)`

Extend `TransactionListener.onEndTransaction` with a `rolledBack` parameter so subscribers know whether to sync/commit:

- **YSync `#setupOpenDAW`**: Skip Yjs sync when `rolledBack` is true (just clear `#updates`)
- **SyncLogWriter**: Skip commit when `rolledBack` is true (just clear updates + terminate subscription)
- **SyncSource**: Skip `sendUpdates` when `rolledBack` is true

This prevents the **re-entry problem**: rolled-back transactions must never sync to Yjs, because Yjs broadcasts trigger `observeDeep` which calls `beginTransaction()` — causing "Transaction already in progress" if we're still on the call stack.

### 4. YSync Strict Validation

In `#setupYjs`:
- Wrap entire event processing + `endTransaction()` in `tryCatch`
- On failure: set `#ignoreUpdates = true`, call `abortTransaction()` if still in transaction, reset `#ignoreUpdates`, call `#rollbackTransaction(events)` to propagate rollback to network
- `#updateValue` should throw on missing vertex (not silently ignore)
- `#deleteBox` should throw on missing box (not silently ignore)

### 5. Resilient Undo/Redo

`editing.undo()`/`redo()` should handle validation failures gracefully:
- Apply each `Modification` step individually with `tryCatch`
- On failure: re-apply previously successful steps in reverse to restore the graph
- Show `RuntimeNotifier.info()` dialog: "This history step is no longer valid due to changes from other participants."
- Return `false` (change `Editing` interface: `undo(): boolean`, `redo(): boolean`)
- History entry remains in the stack (may become valid again later)

### 6. Editing.ts Error Handling

`modify()` and `append()` should use `tryCatch` around `beginTransaction()` + modifier + `endTransaction()`. On failure, call `abortTransaction()` if still in transaction, then re-throw. This prevents dangling open transactions when the modifier itself throws.

## Critical Implementation Notes

### Re-entry Prevention

The **most dangerous issue** is re-entry via Yjs broadcast channel. When `onEndTransaction` fires and YSync syncs to Yjs, the Yjs broadcast can synchronously trigger `observeDeep` → `beginTransaction()` while still on the call stack. The `rolledBack` flag prevents this for failed transactions, but successful transactions also risk re-entry if the Yjs sync triggers an incoming update from another peer.

This needs careful testing with real Yjs/WebSocket connections, not just unit tests.

### Never Use `Write` to Rewrite Existing Files

Always use `Edit` with targeted `old_string`/`new_string` replacements. Using `Write` to overwrite entire files risks silently dropping existing methods.

### UUID.Bytes Requires SortedSet

Never use `Set<UUID.Bytes>` or `Map<UUID.Bytes, ...>`. `UUID.Bytes` is `Uint8Array` which uses reference equality. Always use `UUID.newSet()`.

### Never Use try/catch

Use `tryCatch()` from `@opendaw/lib-std` which returns `SuccessResult | FailureResult`.

### Use Option<T> not Optional<T>

For fallible return types, use `Option<T>` with `match`/`map`/`unwrap`, not `Optional<T>` (`T | undefined`).

## Subscriber Behavior During Rollback

| Subscriber Type | Forward Events | Rollback Events | Post-Rollback State |
|---|---|---|---|
| `subscribeToAllUpdates` | All updates | Inverse updates fired | Net-zero |
| `subscribeToAllUpdatesImmediate` | All updates | Inverse updates fired | Net-zero |
| `pointerHub.subscribe` | Only after validation | Never on rollback | Clean |
| `onEndTransaction` | Called with `false` | Called with `true` | Can distinguish |
| `subscribeDeletion` | Called during unstageBox | Inverse restages (not called) | May leak (rare) |

## Edge Cases to Address

- **`subscribeDeletion` listeners fire during forward, not restored on rollback** — only occurs when transaction both deletes AND creates something invalid (extremely rare)
- **Double `subscribeVertexUpdates` notification** — dispatcher fires for forward and inverse, adding two finalization observers. Harmless but wasteful.
- **Dangling `targetVertex` cache** (pre-existing) — pointer resolved to `None` when target doesn't exist at resolution time. Cache never updates when target arrives later. Inside transactions: live lookup works. Outside: stale cache.
- **Rollback storm potential** — peer A's update rejected by peer C, rollback propagates back, A re-sends, C rejects again. Mitigated by Yjs delivering single `transact()` atomically.

## Testing Strategy

Unit tests are necessary but insufficient. The re-entry and broadcast channel issues only manifest with real Yjs connections. Testing should include:

1. **Unit tests**: Transaction rollback, dirty tracking, subscriber state, undo/redo failure recovery
2. **Integration tests with Yjs**: Two `Y.Doc` instances connected via `Y.applyUpdate`, simulating P2P sync. Test out-of-order delivery, concurrent edits, rollback propagation.
3. **Manual testing**: Two browser tabs in a live room. Create/delete/undo operations crossing peers. Verify no "Transaction already in progress" errors, no UI freezes, no desync.
