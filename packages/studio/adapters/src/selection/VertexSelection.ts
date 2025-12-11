import {
    asInstanceOf,
    assert,
    Bijective,
    int,
    Listeners,
    Option,
    Predicate,
    Selection,
    SelectionListener,
    SortedSet,
    Subscription,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {Address, Addressable, BoxEditing, BoxGraph, Field, PointerField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {SelectionBox} from "@opendaw/studio-boxes"
import {SelectableVertex} from "./SelectableVertex"
import {SelectionEntry} from "./SelectionEntry"
import {FilteredSelection} from "./FilteredSelection"

/**
 * Represents the main selection management within a document.
 * This class maintains selections for different users, with each user having their own unique selection.
 */
export class VertexSelection implements Selection<SelectableVertex> {
    readonly #lifeTime: Terminator
    readonly #entityMap: SortedSet<UUID.Bytes, SelectionEntry> // sorted on entity
    readonly #selectableMap: SortedSet<Address, SelectionEntry> // sorted on selectable
    readonly #listeners: Listeners<SelectionListener<SelectableVertex>>

    #target: Option<Field> = Option.None

    constructor(readonly editing: BoxEditing, readonly boxGraph: BoxGraph) {
        this.#lifeTime = new Terminator()
        this.#entityMap = UUID.newSet(entry => entry.box.address.uuid)
        this.#selectableMap = Address.newSet(entry => entry.selectable.address)
        this.#listeners = new Listeners<SelectionListener<SelectableVertex>>()
    }

    switch(target: Field<Pointers.Selection>): this {
        this.release()
        console.debug(`VertexSelection.switch(${target.address.toString()})`)
        this.#target = Option.wrap(target)
        this.#lifeTime.own(this.#watch(target))
        return this
    }

    release(): void {
        if (this.#target.isEmpty()) {return}
        this.#target = Option.None
        this.#lifeTime.terminate()
        this.#selectableMap.forEach(entry => this.#listeners.proxy.onDeselected(entry.selectable))
        this.#selectableMap.clear()
        this.#entityMap.clear()
    }

    // TODO Make selection local
    createFilteredSelection<T extends Addressable>(affiliate: Predicate<SelectableVertex>,
                                                   map: Bijective<T, SelectableVertex>): FilteredSelection<T> {
        return new FilteredSelection<T>(this, affiliate, map)
    }

    select(...selectables: ReadonlyArray<SelectableVertex>): void {
        if (this.#target.isEmpty()) {
            console.debug(`Cannot select without a user`)
            return
        }
        if (selectables.length === 0) {return}
        this.editing.modify(() => {
            const selection = this.#target.unwrap()
            for (const selectable of selectables) {
                if (!this.#selectableMap.hasKey(selectable.address)) {
                    SelectionBox.create(this.boxGraph, UUID.generate(), box => {
                        box.selectable.refer(selectable)
                        box.selection.refer(selection)
                    })
                }
            }
        }, false)
    }

    deselect(...selectables: ReadonlyArray<SelectableVertex>): void {
        if (this.#target.isEmpty()) {
            console.debug(`Cannot deselect without a user`)
            return
        }
        if (selectables.length === 0) {return}
        this.editing.modify(() => selectables
            .forEach(selectable => this.#selectableMap.get(selectable.address).box.delete()), false)
    }

    deselectAll(): void {
        this.deselect(...this.#selectableMap.values().map(entry => entry.selectable))
    }

    distance(inventory: Iterable<SelectableVertex>): ReadonlyArray<SelectableVertex> {
        const excludes: Array<SelectableVertex> = []
        for (const selectable of inventory) {
            if (!this.#selectableMap.hasKey(selectable.address)) {excludes.push(selectable)}
        }
        return excludes
    }

    isEmpty(): boolean {return this.#selectableMap.size() === 0}
    nonEmpty(): boolean {return this.#selectableMap.size() > 0}

    count(): int {return this.#selectableMap.size()}

    isSelected(selectable: SelectableVertex): boolean {return this.#selectableMap.hasKey(selectable.address)}

    selected(): ReadonlyArray<SelectableVertex> {return this.#selectableMap.values().map(entry => entry.selectable)}

    subscribe(listener: SelectionListener<SelectableVertex>): Subscription {return this.#listeners.subscribe(listener)}

    catchupAndSubscribe(listener: SelectionListener<SelectableVertex>): Subscription {
        this.selected().forEach(element => listener.onSelected(element))
        return this.#listeners.subscribe(listener)
    }

    #watch(target: Field): Subscription {
        return target.pointerHub.catchupAndSubscribe({
            onAdded: (pointer: PointerField) => {
                const box = asInstanceOf(pointer.box, SelectionBox)
                assert(box.isAttached(), "SelectionBox is not attached")
                const selectable = box.selectable.targetVertex
                    .unwrap(() => `SelectionBox has no target (${box.selectable.targetAddress.unwrapOrUndefined()
                        ?.toString() ?? "No address"})`) as SelectableVertex
                const entry: SelectionEntry = {box, selectable}
                this.#listeners.proxy.onSelected(selectable)
                assert(this.#entityMap.add(entry), "Could not add to entityMap")
                assert(this.#selectableMap.add(entry), "Could not add to selectableMap")
            },
            onRemoved: (pointer: PointerField) => {
                const box = asInstanceOf(pointer.box, SelectionBox)
                const entry = this.#entityMap.removeByKey(box.address.uuid)
                assert(entry.box === box, "Broken selection")
                const selectable: SelectableVertex = entry.selectable
                this.#listeners.proxy.onDeselected(selectable)
                this.#selectableMap.removeByKey(selectable.address)
            }
        }, Pointers.Selection)
    }
}