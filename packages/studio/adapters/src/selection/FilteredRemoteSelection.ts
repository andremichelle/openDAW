import {Bijective, int, isDefined, Listeners, Nullable, Predicate, SortedSet, Subscription, Terminable} from "@opendaw/lib-std"
import {Address, Addressable} from "@opendaw/lib-box"
import {UserInterfaceBox} from "@opendaw/studio-boxes"
import {SelectableVertex} from "./SelectableVertex"
import {RemoteSelections, RemoteSelectionListener} from "./RemoteSelections"

type ScopedEntry<T> = { selectable: Address, value: T, owners: int }

/**
 * Scoped, read only view over {@link RemoteSelections}, reusing the *same* predicate + mapping as the
 * matching local {@link FilteredSelection}. Scope is preserved: a remote note selection only ever
 * reaches the note scoped view, never the region renderer.
 *
 * The mapped value is resolved once on selection (while the box is attached) and cached, so a
 * deselection that arrives after the selectable box was deleted never re-resolves an adapter for an
 * already detached box. This mirrors {@link FilteredSelection}, which returns the stored value on
 * deselect rather than mapping again.
 */
export class FilteredRemoteSelection<T extends Addressable> implements Terminable {
    readonly #remote: RemoteSelections
    readonly #filter: Predicate<SelectableVertex>
    readonly #mapping: Bijective<T, SelectableVertex>
    readonly #listeners: Listeners<RemoteSelectionListener<T>>
    readonly #values: SortedSet<Address, ScopedEntry<T>> // cache keyed by selectable address
    readonly #subscription: Subscription

    constructor(remote: RemoteSelections,
                filter: Predicate<SelectableVertex>,
                mapping: Bijective<T, SelectableVertex>) {
        this.#remote = remote
        this.#filter = filter
        this.#mapping = mapping
        this.#listeners = new Listeners<RemoteSelectionListener<T>>()
        this.#values = Address.newSet(entry => entry.selectable)
        this.#subscription = this.#remote.catchupAndSubscribe({
            onSelected: (selectable: SelectableVertex, user: UserInterfaceBox) => {
                if (!this.#filter(selectable)) {return}
                const existing: Nullable<ScopedEntry<T>> = this.#values.getOrNull(selectable.address)
                if (isDefined(existing)) {
                    existing.owners++
                    this.#listeners.proxy.onSelected(existing.value, user)
                } else {
                    const value = this.#mapping.fy(selectable)
                    this.#values.add({selectable: selectable.address, value, owners: 1})
                    this.#listeners.proxy.onSelected(value, user)
                }
            },
            onDeselected: (selectable: SelectableVertex, user: UserInterfaceBox) => {
                const existing: Nullable<ScopedEntry<T>> = this.#values.getOrNull(selectable.address)
                if (!isDefined(existing)) {return}
                if (--existing.owners === 0) {this.#values.removeByKey(selectable.address)}
                this.#listeners.proxy.onDeselected(existing.value, user)
            }
        })
    }

    ownersOf(selectable: T): ReadonlyArray<UserInterfaceBox> {
        return this.#remote.ownersOf(this.#mapping.fx(selectable))
    }

    subscribe(listener: RemoteSelectionListener<T>): Subscription {return this.#listeners.subscribe(listener)}

    catchupAndSubscribe(listener: RemoteSelectionListener<T>): Subscription {
        this.#remote.forEach(({selectable, user}) => {
            const existing: Nullable<ScopedEntry<T>> = this.#values.getOrNull(selectable.address)
            if (isDefined(existing)) {listener.onSelected(existing.value, user)}
        })
        return this.subscribe(listener)
    }

    terminate(): void {this.#subscription.terminate()}
}
