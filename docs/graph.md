# Box Graph Internals

## Transaction Model

`BoxEditing.modify()` wraps all box graph mutations in a transaction:

```
beginTransaction()
  modifier()          ← user code runs here (box creation, deletion, pointer changes)
endTransaction()      ← deferred pointer notifications fire here
validateRequirements()
mark()
notifier.notify()     ← BoxEditing subscribers notified (undo/redo state)
```

### Nested `modify()` calls

When `modify()` is called while `#modifying` is true or the graph is in a transaction,
it takes a shortcut path: it calls `this.#notifier.notify()` and then `modifier()` directly,
without starting a new transaction. The box operations run inside the existing outer transaction.

### Pointer Update Deferral

During a transaction, pointer changes (e.g., `pointer.refer(target)`, `pointer.defer()`)
are recorded in `#pointerTransactionState` but NOT applied immediately.

At `endTransaction()`, the deferred pointer changes are processed:

```typescript
this.#pointerTransactionState.values()
    .toSorted((a, b) => a.index - b.index)
    .forEach(({pointer, initial, final}) => {
        if (!initial.equals(final)) {
            initial.ifSome(address => findVertex(address)?.pointerHub.onRemoved(pointer))
            final.ifSome(address => findVertex(address)?.pointerHub.onAdded(pointer))
        }
    })
```

This means `pointerHub.onRemoved` / `onAdded` callbacks fire AFTER all mutations complete,
during `endTransaction()`. Code subscribed via `pointerHub.catchupAndSubscribe()` (e.g.,
`VertexSelection.#watch`) sees the changes only at this point.

After pointer processing, `#inTransaction` is set to false. Then `#finalizeTransactionObservers`
are executed (these can add more observers in a loop). Finally `onEndTransaction` fires.

## Box Deletion and Cascade

`box.delete()` computes dependencies via `graph.dependenciesOf(box)`:

1. Follows **outgoing** pointers to downstream targets
2. Follows **incoming** pointers that are `mandatory` to upstream boxes
3. Collects all dependent boxes and pointers recursively

Then:
- All collected pointers are deferred (`pointer.defer()`)
- All collected dependent boxes are unstaged (`box.unstage()`)
- The root box is unstaged

### Cascade Deletion via `Field.disconnect()`

When a box is unstaged, its fields call `disconnect()`. For target fields with incoming pointers:

```typescript
disconnect(): void {
    const incoming = this.pointerHub.incoming()
    incoming.forEach(pointer => {
        pointer.defer()
        if (pointer.mandatory || (this.pointerRules.mandatory && incoming.length === 1)) {
            pointer.box.delete()  // CASCADE: deletes the box that owns the mandatory pointer
        }
    })
}
```

**Key implication**: If Box A has a `mandatory` pointer to Box B, deleting Box B
will cascade-delete Box A within the same transaction.

### SelectionBox Cascade

`SelectionBox` has two mandatory pointers:
- `selection` → the user's selection field
- `selectable` → the selected vertex (e.g., a region box)

When a region box is deleted, `disconnect()` on the region's field finds the SelectionBox's
`selectable` pointer (which is mandatory) and cascade-deletes the SelectionBox.

At `endTransaction()`, the SelectionBox's `selection` pointer fires `onRemoved` on the
user's selection field, which triggers `VertexSelection.#watch.onRemoved`. This removes
the entry from `#entityMap` and `#selectableMap`, and notifies `onDeselected` listeners.

## VertexSelection and the `#watch` Mechanism

`VertexSelection.#watch(target)` subscribes to the user's selection field's `pointerHub`:

- **`onAdded`**: A new SelectionBox was created → adds entry to `#entityMap` and `#selectableMap`,
  notifies `onSelected` listeners
- **`onRemoved`**: A SelectionBox was deleted → removes entry from both maps,
  notifies `onDeselected` listeners (which propagates to `FilteredSelection`)

These callbacks fire during `endTransaction()`, NOT during `modifier()` execution.

## Timing of Side Effects

Within `BoxEditing.modify()`:

| Phase | `#modifying` | `inTransaction()` | Pointer notifications | `#selectableMap` updates |
|-------|-------------|-------------------|----------------------|------------------------|
| Before `beginTransaction()` | true | false | No | No |
| During `modifier()` | true | true | **Deferred** | No |
| During `endTransaction()` | true | transitions to false | **Firing** | **Yes** |
| After `endTransaction()` | true→false | false | Done | Done |
| `notifier.notify()` | false | false | Done | Done |

This means code running inside `modifier()` can safely iterate `#selectableMap`
because it won't change until `endTransaction()`. But code triggered BY `endTransaction()`
(via `onRemoved`/`onAdded` cascades, `finalizeTransactionObservers`, or `onEndTransaction`)
runs AFTER the map has been modified.

## Known Issue: Stale Deselection After Region Deletion

When a region is deleted by the ClipResolver (e.g., during content-start trimming with overlap
resolution), the cascade deletes the SelectionBox and cleans up `#selectableMap` at
`endTransaction()`. If a reactive observer later tries to `deselect` the same region
(e.g., from an animation frame callback), `#selectableMap.get()` throws "Unknown key"
because the entry was already removed.

Introduced by commit `608f0b48` ("prevent overlapping", Jan 26 2026) which added the
overlap resolver to `RegionContentStartModifier.approve()`.
