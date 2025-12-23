import {
    Bijective,
    int,
    Listeners,
    Predicate,
    Selection,
    SelectionListener,
    SortedSet,
    Subscription,
    Terminable
} from "@opendaw/lib-std"
import {Address, Addressable} from "@opendaw/lib-box"
import {VertexSelection} from "./VertexSelection"
import {SelectableVertex} from "./SelectableVertex"

export class FilteredSelection<T extends Addressable> implements Selection<T>, Terminable {
    readonly #selection: VertexSelection
    readonly #filter: Predicate<SelectableVertex>
    readonly #mapping: Bijective<T, SelectableVertex>
    readonly #set: SortedSet<Address, T>
    readonly #listeners: Listeners<SelectionListener<T>>
    readonly #subscription: Subscription

    constructor(selection: VertexSelection,
                filter: Predicate<SelectableVertex>,
                mapping: Bijective<T, SelectableVertex>) {
        this.#selection = selection
        this.#filter = filter
        this.#mapping = mapping

        this.#set = Address.newSet(({address}) => address)
        this.#listeners = new Listeners<SelectionListener<T>>()

        this.#selection.selected()
            .filter(element => this.#filter(element))
            .forEach(element => this.#set.add(this.#mapping.fy(element)))
        this.#subscription = this.#selection.catchupAndSubscribe({
            onSelected: (element: SelectableVertex) => {
                if (this.#filter(element)) {
                    const value = this.#mapping.fy(element)
                    this.#set.add(value)
                    this.#listeners.proxy.onSelected(value)
                }
            },
            onDeselected: (element: SelectableVertex) => {
                if (this.#set.hasKey(element.address)) {
                    this.#listeners.proxy.onDeselected(this.#set.removeByKey(element.address))
                }
            }
        })
    }

    terminate(): void {this.#subscription.terminate()}

    select(...selectables: Array<T>): void {
        this.#selection.select(...selectables.map(selectable => this.#mapping.fx(selectable)))
    }

    deselect(...selectables: Array<T>): void {
        this.#selection.deselect(...selectables.map(selectable => this.#mapping.fx(selectable)))
    }

    deselectAll(): void {
        this.#selection.deselect(...(this.#set.values().map(selectable => this.#mapping.fx(selectable))))
    }

    distance(inventory: ReadonlyArray<T>): ReadonlyArray<T> {
        return this.#selection.distance(inventory.map(selectable =>
            this.#mapping.fx(selectable))).map(item => this.#mapping.fy(item))
    }

    isEmpty(): boolean {return this.#set.size() === 0}
    nonEmpty(): boolean {return this.#set.size() > 0}

    count(): int {return this.#set.size()}

    isSelected(selectable: T): boolean { return this.#set.hasKey(selectable.address)}

    selected(): ReadonlyArray<T> {return this.#set.values()}

    subscribe(listener: SelectionListener<T>): Terminable {
        return this.#listeners.subscribe(listener)
    }

    catchupAndSubscribe(listener: SelectionListener<T>): Subscription {
        this.#set.forEach(selectable => listener.onSelected(selectable))
        return this.subscribe(listener)
    }
}