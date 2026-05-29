# Live Room Selections: Seeing Other Users' Selections

## Goal

In a live room, show what **other** users have selected (regions, devices, etc.) as per user
coloured overlays. Painting must be able to ask, synchronously, "who else selects this
vertex?"

## Background (one paragraph)

A selection is a `SelectionBox` in the graph: `selectable` (field 2) points at the selected
vertex, `selection` (field 1) points at the owning `UserInterfaceBox.selection` field. These
boxes already replicate to every client via `YSync` (ephemeral only excludes them from
clipboard/transfer, not sync). The local `VertexSelection` deliberately watches a **single**
user's `selection` field (`Project.follow` calls `selection.switch(box.selection)`), so
`selection` / `regionSelection` / `deviceSelection` only ever contain the followed user.
Other users' boxes sit in the graph, unobserved.

## Does this replace the current observation?

**No.** `VertexSelection` and the `FilteredSelection` views stay exactly as they are: they
drive local editing and answer "what do *I* have selected". We add a **separate, read only
index** of every *other* user's selections. The two never merge (a vertex can be selected by
N users at once, which the single entry `VertexSelection` model cannot represent).

## Mirror the local two layer design

Local selection is `VertexSelection` (raw, over vertices) plus `FilteredSelection<T>` views
(`regionSelection`, `deviceSelection`) scoped by a predicate + bijective mapping. The remote
side mirrors this exactly, so **scope is preserved**: a remote *note* selection only ever
reaches the note scoped remote view, never the region renderer.

**Raw store: `RemoteSelections`** in `packages/studio/adapters/src/selection/`, owned by
`Project`. Watches every *other* user, maintains one index.

```typescript
class RemoteSelections implements Terminable {
    ownersOf(vertex: SelectableVertex): ReadonlyArray<UserInterfaceBox>   // O(log n), paint-safe
    createFilteredSelection<T>(filter: Predicate<SelectableVertex>,
                               mapping: Bijective<T, SelectableVertex>): FilteredRemoteSelection<T>
}
```

Internally a `SortedSet<Address, {selectable, owners}>` keyed by selectable address, where
`owners` is a small `UserInterfaceBox` set (one vertex, many users).

**Scoped view: `FilteredRemoteSelection<T>`**, reusing the *same* predicate + mapping as the
matching local `FilteredSelection<T>`. Its listener carries the user; its change events are
scoped to that view only.

```typescript
interface RemoteSelectionListener<T> {
    onSelected(selectable: T, user: UserInterfaceBox): void
    onDeselected(selectable: T, user: UserInterfaceBox): void
}
class FilteredRemoteSelection<T extends Addressable> implements Terminable {
    ownersOf(selectable: T): ReadonlyArray<UserInterfaceBox>          // O(log n), paint-safe
    catchupAndSubscribe(listener: RemoteSelectionListener<T>): Subscription   // scoped events only
}
```

`Project` exposes `remoteRegionSelection`, `remoteDeviceSelection`, ... built from the same
predicates/mappings as the existing local ones.

### How the raw store stays current (two level watch)

Level 2 is `VertexSelection.#watch` run once per remote user instead of once for the
followed user.

**Level 1, users join/leave.** Watch `RootBox.users.pointerHub` (filter `Pointers.User`).
The incoming pointers are each `UserInterfaceBox.root`, so `pointer.box` is the
`UserInterfaceBox`.
- `onAdded`: if it is the followed user, skip; otherwise start a level 2 watcher.
- `onRemoved`: tear down that user's level 2 watcher and evict all their index entries
  (notify `onDeselected`).

**Level 2, one user's selections.** For each watched user, watch
`userBox.selection.pointerHub` (filter `Pointers.Selection`). The incoming pointers are each
`SelectionBox.selection`, so `pointer.box` is the `SelectionBox` (same as
`VertexSelection.ts:126`).
- `onAdded`: `box = pointer.box`; `selectable = box.selectable.targetVertex`; add
  `(selectable, user)` to the index; notify.
- `onRemoved`: evict `(selectable, user)`; notify.

`catchupAndSubscribe` at both levels means a late joiner immediately sees every user and,
per user, every existing `SelectionBox`. One subscription per user (a handful), never per
selectable. Each `FilteredRemoteSelection` filters this `(selectable, user)` stream by its
predicate, so only matching changes propagate.

### Cleanup details (both mirror `VertexSelection`)

1. **Reliable removal.** On `onRemoved` the `SelectionBox.selectable` target may already be
   detached, so the selectable cannot be re-resolved. Each level 2 watcher keeps
   `SortedSet<UUID, {selectable}>` keyed by `SelectionBox` UUID (like
   `VertexSelection.#entityMap`, `VertexSelection.ts:139`) to know what to evict.
2. **User-leave teardown.** Terminating a level 2 subscription does not replay `onRemoved`
   for its live pointers. On leave, iterate the tracked boxes, evict each from the index,
   fire `onDeselected`, then terminate.

## Following is dynamic (required, this is SDK)

`Project.follow` switches the followed user at runtime, and the studio relies on this: the
previously followed user becomes a **remote** user and must immediately appear in
`RemoteSelections`, while the newly followed user must immediately drop out of it (the local
`FilteredSelection` renders it instead). This must be supported from the start, not bolted on.

To react, the followed user is exposed as an observable on `VertexSelection` (the followed
box is `#target.box`), backed by a `MutableObservableOption<UserInterfaceBox>` that `switch()`
`wrap`s and `release()` `clear`s:

```typescript
// VertexSelection
get user(): ObservableOption<UserInterfaceBox>   // current followed user; subscribable
```

`RemoteSelections` does `user.catchupAndSubscribe(...)` and on change reconciles only the two
affected users:
- the user **no longer followed**: start a level 2 watcher for it (catch up indexes its
  existing `SelectionBox` objects, so they appear as remote at once),
- the **now followed** user: tear down its level 2 watcher and evict its entries (notify
  `onDeselected`), since the local `FilteredSelection` now owns it.

With no followed user (after `release()`), every user is remote.

## Painting

The region view subscribes to its **scoped** remote selection only, so a remote note or
device selection never invalidates it. The event carries the exact selectable, so it can
invalidate just that region rather than the whole layer:

```typescript
remoteRegionSelection.catchupAndSubscribe({
    onSelected: (region, _user) => invalidate(region),
    onDeselected: (region, _user) => invalidate(region)
})
```

Inside the paint pass, colour each region from `remoteRegionSelection.ownersOf(adapter)`
(O(log n)). The local outline still comes from `regionSelection`; `ownersOf` excludes the
followed user, so no double draw.

## Files

| File | Change |
|------|--------|
| `packages/studio/adapters/src/selection/RemoteSelections.ts` (new) | Raw store: per user `pointerHub` watchers, the index, `ownersOf`, `createFilteredSelection`. |
| `packages/studio/adapters/src/selection/FilteredRemoteSelection.ts` (new) | Scoped view: `RemoteSelectionListener<T>`, scoped `catchupAndSubscribe`, scoped `ownersOf`. |
| `packages/studio/adapters/src/selection/VertexSelection.ts` | Expose the followed user as an observable (`MutableObservableOption<UserInterfaceBox>` wrapped in `switch()`, cleared in `release()`) so `RemoteSelections` can react to `follow` changes. |
| `packages/studio/core/src/project/Project.ts` | Own `RemoteSelections`; expose `remoteRegionSelection` / `remoteDeviceSelection` (same predicates/mappings as the local ones). |
| Region renderers / `DeviceEditor.tsx` | Subscribe to the scoped remote selection; read `ownersOf` during paint. |

No `SelectionBox` / `UserInterfaceBox` schema changes.

## Open items

- **Stale selections.** `YService.ts:73` already flags that a departed user's
  `UserInterfaceBox` (and its `SelectionBox` objects) is not cleaned up. Until that is
  handled, level 1 `onRemoved` only fires when the box is actually removed from the graph,
  so a crashed client's selections could linger. Separate work item.
- Multiple owners on one vertex: segmented outline vs stacked outlines vs count badge.
