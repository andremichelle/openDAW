# Valid Graph — Implementation Plan

## Goal

The BoxGraph must always be valid. Invalid transactions are rejected and fully reversed — including all callbacks already sent to subscribers.

## Lessons From Previous Attempt

The last implementation failed because:

1. **Re-entry via Yjs broadcast channel**: `onEndTransaction` → YSync syncs to Yjs → Yjs broadcasts → `observeDeep` → `beginTransaction()` while still on the call stack. This is the #1 killer. Any design that fires subscriber callbacks during rollback AND allows those callbacks to trigger Yjs sync will hit this.

2. **Too many changes at once**: BoxGraph, GraphEdges, editing.ts, YSync, SyncLogWriter, SyncSource, Editing interface, forge tests — all changed simultaneously. Impossible to verify.

3. **`Write` tool destroyed existing methods**: `toArrayBuffer`, `fromArrayBuffer`, `debugBoxes`, etc. were silently dropped.

## Design Principle

**Two-phase transaction: mutate silently, then notify.** During the mutation phase, NO subscriber callbacks fire. The graph is mutated, updates are recorded. At the end, the graph is validated. If invalid, mutations are reversed silently. Only after validation passes do callbacks fire. This eliminates re-entry because callbacks never run during a window where the graph could be invalid.

## Implementation — 4 Steps (in order)

### Step 1: Dirty Tracking in GraphEdges

**Files**: `graph-edges.ts` only.

Add `#affected: UUID.newSet<UUID.Bytes>(uuid => uuid)` that tracks which box UUIDs were touched.

- `connect(source, target)` → `#affected.add(source.address.uuid)`, `#affected.add(target.uuid)`
- `disconnect(source)` → `#affected.add(source.address.uuid)`, `#affected.add(target.uuid)`
- `watchVertex(vertex)` → `#affected.add(vertex.address.uuid)`

Add `tryValidateAffected(): Option<Error>` — validates only affected UUIDs, clears `#affected` at end (both success and failure paths).

Keep `validateRequirements()` unchanged for `verifyPointers()`.

**Test**: Unit tests for `tryValidateAffected` directly (create boxes via raw transactions without factory, validate specific UUIDs).

### Step 2: Two-Phase Transaction in BoxGraph

**Files**: `graph.ts` only. Use `Edit` tool exclusively.

Add to BoxGraph:
- `#transactionUpdates: Array<Update>` — recorded during mutation phase
- `#rollingBack: boolean` — suppresses recording during rollback AND communicates outcome to `onEndTransaction` (stays `true` through finalization, reset after)

**Mutation phase** (between `beginTransaction` and validation):
- `stageBox`, `unstageBox`, `onPrimitiveValueUpdate`, `onPointerAddressUpdated`: push to `#transactionUpdates` (skip when `#rollingBack`)
- All existing subscriber notifications (`updateListeners`, `immediateUpdateListeners`, dispatchers) remain unchanged — they fire during mutation as before

**Deferred pointer processing** in `endTransaction`:
- Process deferred pointer updates — record in `#transactionUpdates` BUT do NOT dispatch to `updateListeners`/dispatchers yet (buffer them in `#pendingDeferredNotifications`)

**Validation** (still in `endTransaction`, after deferred processing):
- Call `edges.tryValidateAffected()` (only when `boxFactory` is present)
- On success: dispatch buffered deferred notifications, then finalize
- On failure: `#rollback()` then finalize

**`#rollback()`**:
- Set `#rollingBack = true` (stays true through finalization)
- Apply `#transactionUpdates` in reverse via `update.inverse(this)` — this fires through existing listeners (UI controls see restorations)
- Clear: deferred updates, pending notifications, affected set, pointer state, transaction updates

**`#finalizeTransaction()`** (called on BOTH success and failure paths):
- Process `#pointerTransactionState` → `pointerHub.onAdded/onRemoved` (no-op after rollback since state was cleared)
- Set `#inTransaction = false`
- Execute finalization observers
- Call `onEndTransaction(this.#rollingBack)` — then set `#rollingBack = false`

**`abortTransaction()`** (for mid-transaction failures):
- `#rollback()`, clear deferred updates, `#finalizeTransaction()`

**`TransactionListener.onEndTransaction(rolledBack: boolean)`** — new signature.

**Critical**: `#inTransaction` is set to `false` BEFORE `onEndTransaction` fires. This means if a subscriber's callback synchronously triggers another transaction (via Yjs broadcast), `beginTransaction()` will succeed because the flag is already false.

**Test**: Create boxes with mandatory pointers, verify rollback restores graph. Verify `onEndTransaction` receives correct `rolledBack` flag. Verify graph is clean after rollback. Verify `#inTransaction` is false when `onEndTransaction` fires.

### Step 3: Update YSync, SyncLogWriter, SyncSource

**Files**: `YSync.ts`, `SyncLogWriter.ts`, `sync-source.ts`. Minimal changes.

**YSync `#setupYjs`**: Wrap event processing + `endTransaction()` in `tryCatch`. On failure: set `#ignoreUpdates = true`, call `abortTransaction()` if still in transaction, reset `#ignoreUpdates`, call `#rollbackTransaction(events)`.

**YSync `#setupOpenDAW`**: `onEndTransaction(rolledBack)` — when `rolledBack || #ignoreUpdates`, clear `#updates` and return (don't sync to Yjs).

**YSync `#updateValue`**: Throw on missing vertex (not silently ignore).

**YSync `#deleteBox`**: Throw on missing box (not silently ignore).

**SyncLogWriter**: `onEndTransaction(rolledBack)` — when `rolledBack`, terminate subscription and clear updates without creating commit.

**SyncSource**: `onEndTransaction(rolledBack)` — when `rolledBack`, clear updates without sending.

**Test**: Verify that a rolled-back transaction does NOT produce Yjs sync. Verify re-entry doesn't happen (onEndTransaction fires when `#inTransaction` is false).

### Step 4: Resilient Undo/Redo in Editing

**Files**: `editing.ts`, `lib-std/editing.ts` (interface change).

Change `Editing` interface: `undo(): boolean`, `redo(): boolean`.

`undo()`: Apply each `Modification.inverse()` in `tryCatch`. If a step fails (BoxGraph rolled it back), re-apply previous successful steps via `forward()` to restore, increment `#historyIndex` back, show `RuntimeNotifier.info()`, return `false`.

`redo()`: Same pattern with `forward()`/`inverse()` reversed.

`modify()` / `append()`: Wrap `beginTransaction` + modifier + `endTransaction` in `tryCatch`. On failure, call `abortTransaction()` if still in transaction, re-throw.

**Test**: Create mandatory box + pointer, externally orphan it via raw transaction, verify undo/redo returns false and graph is valid.

## Key Constraints

- **NEVER use `Write` tool on existing files** — always `Edit` with targeted replacements
- **NEVER use `Set<UUID.Bytes>`** — always `UUID.newSet`
- **NEVER use try/catch** — always `tryCatch` from lib-std
- **NEVER use `Optional<T>`** — always `Option<T>`
- Build and run ALL tests after each step before proceeding to the next
- Type-check with `--noEmit` after each step
- Rebuild dist after changing lib-box (downstream packages import from dist)

## Files Changed (Total)

1. `packages/lib/box/src/graph-edges.ts` — dirty tracking
2. `packages/lib/box/src/graph.ts` — two-phase transaction, rollback, abortTransaction
3. `packages/lib/std/src/editing.ts` — undo/redo return boolean
4. `packages/lib/box/src/editing.ts` — resilient undo/redo, tryCatch in modify/append
5. `packages/studio/core/src/ysync/YSync.ts` — strict validation, rollback handling
6. `packages/studio/core/src/sync-log/SyncLogWriter.ts` — rolledBack flag
7. `packages/lib/box/src/sync-source.ts` — rolledBack flag
8. `packages/lib/box/src/editing.test.ts` — new tests
9. `packages/lib/box-forge/test/forge.test.ts` — adapt to validation in endTransaction
