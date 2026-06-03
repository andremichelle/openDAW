import {
    Arrays,
    asInstanceOf,
    Bijective,
    isDefined,
    Listeners,
    Nullable,
    ObservableOption,
    Option,
    Predicate,
    Procedure,
    SortedSet,
    Subscription,
    Terminable,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {Addressable, Address, PointerField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {RootBox, SelectionBox, UserInterfaceBox} from "@opendaw/studio-boxes"
import {SelectableVertex} from "./SelectableVertex"
import {SelectionEntry} from "./SelectionEntry"
import {FilteredRemoteSelection} from "./FilteredRemoteSelection"

export interface RemoteSelectionListener<T> {
    onSelected(selectable: T, user: UserInterfaceBox): void
    onDeselected(selectable: T, user: UserInterfaceBox): void
}

type RemoteEntry = { selectable: SelectableVertex, owners: SortedSet<UUID.Bytes, UserInterfaceBox> }
type ActiveWatcher = { user: UserInterfaceBox, terminable: Terminable }

/**
 * Read only index of every *other* user's selections in a live room.
 *
 * Mirrors {@link VertexSelection}'s two layer watch, but once per remote user instead of once for
 * the followed user, and indexes `(selectable, user)` pairs so that painting can ask synchronously
 * who else selects a vertex. The followed user is excluded (the local {@link FilteredSelection}
 * renders it), so with a single user the index stays empty and {@link ownersOf} is a miss against an
 * empty set.
 */
export class RemoteSelections implements Terminable {
    readonly #terminator: Terminator
    readonly #rootBox: RootBox
    readonly #index: SortedSet<Address, RemoteEntry> // sorted on selectable address
    readonly #knownUsers: SortedSet<UUID.Bytes, UserInterfaceBox> // every user currently in the graph
    readonly #watchers: SortedSet<UUID.Bytes, ActiveWatcher> // one per *watched* (remote) user
    readonly #listeners: Listeners<RemoteSelectionListener<SelectableVertex>>

    #followed: Option<UserInterfaceBox> = Option.None

    constructor(rootBox: RootBox, followed: ObservableOption<UserInterfaceBox>) {
        this.#terminator = new Terminator()
        this.#rootBox = rootBox
        this.#index = Address.newSet(entry => entry.selectable.address)
        this.#knownUsers = UUID.newSet(user => user.address.uuid)
        this.#watchers = UUID.newSet(watcher => watcher.user.address.uuid)
        this.#listeners = new Listeners<RemoteSelectionListener<SelectableVertex>>()
        this.#terminator.own(this.#rootBox.users.pointerHub.catchupAndSubscribe({
            onAdded: (pointer: PointerField) => {
                const user = asInstanceOf(pointer.box, UserInterfaceBox)
                this.#knownUsers.add(user)
                this.#syncUser(user)
            },
            onRemoved: (pointer: PointerField) => {
                const user = asInstanceOf(pointer.box, UserInterfaceBox)
                this.#knownUsers.removeByKey(user.address.uuid)
                this.#syncUser(user)
            }
        }, Pointers.User))
        this.#terminator.own(followed.catchupAndSubscribe(option => this.#updateFollowed(option)))
    }

    ownersOf(vertex: SelectableVertex): ReadonlyArray<UserInterfaceBox> {
        const entry: Nullable<RemoteEntry> = this.#index.getOrNull(vertex.address)
        return isDefined(entry) ? entry.owners.values() : Arrays.empty()
    }

    forEach(procedure: Procedure<{selectable: SelectableVertex, user: UserInterfaceBox}>): void {
        this.#index.forEach(entry => entry.owners
            .forEach(user => procedure({selectable: entry.selectable, user})))
    }

    subscribe(listener: RemoteSelectionListener<SelectableVertex>): Subscription {
        return this.#listeners.subscribe(listener)
    }

    catchupAndSubscribe(listener: RemoteSelectionListener<SelectableVertex>): Subscription {
        this.forEach(({selectable, user}) => listener.onSelected(selectable, user))
        return this.subscribe(listener)
    }

    createFilteredSelection<T extends Addressable>(filter: Predicate<SelectableVertex>,
                                                   mapping: Bijective<T, SelectableVertex>): FilteredRemoteSelection<T> {
        return new FilteredRemoteSelection<T>(this, filter, mapping)
    }

    terminate(): void {
        this.#watchers.forEach(watcher => watcher.terminable.terminate())
        this.#watchers.clear()
        this.#knownUsers.clear()
        this.#index.clear()
        this.#terminator.terminate()
    }

    #updateFollowed(current: Option<UserInterfaceBox>): void {
        const previous = this.#followed
        this.#followed = current.isEmpty() ? Option.None : Option.wrap(current.unwrap())
        previous.ifSome(user => this.#syncUser(user))
        this.#followed.ifSome(user => {if (!previous.contains(user)) {this.#syncUser(user)}})
    }

    #syncUser(user: UserInterfaceBox): void {
        const shouldWatch = this.#knownUsers.hasKey(user.address.uuid) && !this.#followed.contains(user)
        const watching = this.#watchers.hasKey(user.address.uuid)
        if (shouldWatch === watching) {return}
        if (shouldWatch) {
            this.#watchers.add({user, terminable: this.#watchUser(user)})
        } else {
            this.#watchers.removeByKey(user.address.uuid).terminable.terminate()
        }
    }

    #watchUser(user: UserInterfaceBox): Terminable {
        const boxMap: SortedSet<UUID.Bytes, SelectionEntry> = UUID.newSet(entry => entry.box.address.uuid)
        const subscription = user.selection.pointerHub.catchupAndSubscribe({
            onAdded: (pointer: PointerField) => {
                // Read only overlay over a *remote* user's boxes: a dangling or concurrently deleted
                // selectable must be skipped, never panic, or the whole YSync transaction is rejected.
                const box = asInstanceOf(pointer.box, SelectionBox)
                box.selectable.targetVertex.ifSome(vertex => {
                    const selectable = vertex as SelectableVertex
                    if (boxMap.add({box, selectable})) {this.#addOwner(selectable, user)}
                })
            },
            onRemoved: (pointer: PointerField) => {
                const box = asInstanceOf(pointer.box, SelectionBox)
                const entry: Nullable<SelectionEntry> = boxMap.removeByKeyIfExist(box.address.uuid)
                if (isDefined(entry)) {this.#removeOwner(entry.selectable, user)}
            }
        }, Pointers.Selection)
        return {
            terminate: () => {
                subscription.terminate()
                boxMap.forEach(entry => this.#removeOwner(entry.selectable, user))
                boxMap.clear()
            }
        }
    }

    #addOwner(selectable: SelectableVertex, user: UserInterfaceBox): void {
        const entry: RemoteEntry = this.#index.getOrNull(selectable.address) ?? this.#createEntry(selectable)
        entry.owners.add(user)
        this.#listeners.proxy.onSelected(selectable, user)
    }

    #removeOwner(selectable: SelectableVertex, user: UserInterfaceBox): void {
        const entry: Nullable<RemoteEntry> = this.#index.getOrNull(selectable.address)
        if (!isDefined(entry)) {return}
        entry.owners.removeByKey(user.address.uuid)
        if (entry.owners.size() === 0) {this.#index.removeByKey(selectable.address)}
        this.#listeners.proxy.onDeselected(selectable, user)
    }

    #createEntry(selectable: SelectableVertex): RemoteEntry {
        const created: RemoteEntry = {selectable, owners: UUID.newSet(owner => owner.address.uuid)}
        this.#index.add(created)
        return created
    }
}
