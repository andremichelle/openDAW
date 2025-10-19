import {PointerField, PointerTypes} from "./pointer"
import {Vertex} from "./vertex"
import {int, Iterables, Listeners, Option, panic, SortedSet, Subscription} from "@opendaw/lib-std"
import {Address} from "./address"

export interface PointerListener {
    onAdd(pointer: PointerField): void
    onRemove(pointer: PointerField): void
}

export class PointerHub {
    static validate(pointer: PointerField, target: Vertex): Option<string> {
        if (pointer.address.equals(target.address)) {
            return Option.wrap(`PointerField cannot point to itself: ${pointer}`)
        }
        if (!target.pointerRules.accepts.some((type: PointerTypes): boolean => type === pointer.pointerType)) {
            const accepting = target.pointerRules.accepts.join(", ")
            return Option.wrap(`${String(pointer.pointerType)} does not satisfy any of the allowed types (${accepting}).`)
        }
        return Option.None
    }

    readonly #vertex: Vertex

    readonly #listeners: Listeners<PointerListener>

    constructor(vertex: Vertex) {
        this.#vertex = vertex

        this.#listeners = new Listeners<PointerListener>()
    }

    subscribe(listener: PointerListener, ...filter: ReadonlyArray<PointerTypes>): Subscription {
        return this.#addFilteredListener(this.#listeners, listener, filter)
    }

    catchupAndSubscribe(listener: PointerListener, ...filter: ReadonlyArray<PointerTypes>): Subscription {
        const added: SortedSet<Address, PointerField> = Address.newSet(pointer => pointer.address)
        added.addMany(this.filter(...filter))
        added.forEach(pointer => listener.onAdd(pointer))
        // This takes track of the listener notification state.
        // It is possible that the pointer has been added, but it has not been notified yet.
        // That would cause the listener.onAdd method to be invoked twice.
        return this.subscribe({
            onAdd: (pointer: PointerField) => {
                if (added.add(pointer)) {
                    listener.onAdd(pointer)
                }
            },
            onRemove: (pointer: PointerField) => {
                added.removeByKey(pointer.address)
                listener.onRemove(pointer)
            }
        }, ...filter)
    }

    filter<P extends PointerTypes>(...types: ReadonlyArray<P>): Array<PointerField<P>> {
        return (types.length === 0 ? this.incoming() : Iterables.filter(this.incoming().values(),
            (pointerField: PointerField) => types.some((type: P) =>
                type === pointerField.pointerType))) as Array<PointerField<P>>
    }

    size(): int {return this.incoming().length}
    isEmpty(): boolean {return this.size() === 0}
    nonEmpty(): boolean {return this.size() > 0}
    contains(pointer: PointerField): boolean {return this.incoming().some(incoming => pointer.address.equals(incoming.address))}
    incoming(): ReadonlyArray<PointerField> {return this.#vertex.graph.edges().incomingEdgesOf(this.#vertex)}

    onAdded(pointerField: PointerField): void {
        console.debug("onAdded", pointerField.box)
        const issue: Option<string> = PointerHub.validate(pointerField, this.#vertex)
        if (issue.nonEmpty()) {return panic(issue.unwrap())}
        this.#listeners.proxy.onAdd(pointerField)
    }

    onRemoved(pointerField: PointerField): void {
        console.debug("onRemoved", pointerField.box)
        this.#listeners.proxy.onRemove(pointerField)
    }

    toString(): string {
        return `{Pointers ${this.#vertex.address}, pointers: ${this.incoming().values()
            .map((pointerField: PointerField) => pointerField.toString())}}`
    }

    #addFilteredListener(listeners: Listeners<PointerListener>,
                         listener: PointerListener,
                         filter: ReadonlyArray<PointerTypes>): Subscription {
        return listeners.subscribe({
            onAdd: (pointer: PointerField) => {
                if (filter.length === 0 || filter.some((type: PointerTypes): boolean => type === pointer.pointerType)) {
                    listener.onAdd(pointer)
                }
            },
            onRemove: (pointer: PointerField) => {
                if (filter.length === 0 || filter.some((type: PointerTypes): boolean => type === pointer.pointerType)) {
                    listener.onRemove(pointer)
                }
            }
        })
    }
}