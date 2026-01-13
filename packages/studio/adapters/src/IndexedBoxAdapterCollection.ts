import {
    assert,
    BinarySearch,
    clamp,
    Func,
    int,
    Listeners,
    Nullable,
    Option,
    SortedSet,
    Subscription,
    Terminable,
    UUID
} from "@moises-ai/lib-std"
import {Box, Field, Int32Field, PointerField} from "@moises-ai/lib-box"
import {Pointers} from "@moises-ai/studio-enums"
import {AdapterCollectionListener} from "./BoxAdapterCollection"
import {IndexComparator} from "./IndexComparator"
import {BoxAdapter} from "./BoxAdapter"

export interface IndexedBoxAdapter extends BoxAdapter {
    indexField: Int32Field
}

export interface IndexedAdapterCollectionListener<A extends IndexedBoxAdapter> extends AdapterCollectionListener<A> {
    onReorder(adapter: A): void
}

export class IndexedBoxAdapterCollection<A extends IndexedBoxAdapter, P extends Pointers> implements Terminable {
    static create<A extends IndexedBoxAdapter, P extends Pointers>(field: Field<P>,
                                                                   provider: Func<Box, A>,
                                                                   pointers: P): IndexedBoxAdapterCollection<A, P> {
        return new IndexedBoxAdapterCollection(field, provider, pointers)
    }

    readonly #field: Field<P>
    readonly #entries: SortedSet<UUID.Bytes, { adapter: A, subscription: Subscription }>
    readonly #listeners: Listeners<IndexedAdapterCollectionListener<A>>
    readonly #subscription: Subscription

    #sorted: Nullable<ReadonlyArray<A>> = null

    private constructor(field: Field<P>, provider: Func<Box, A>, pointers: P) {
        this.#field = field
        this.#entries = UUID.newSet(entry => entry.adapter.uuid)
        this.#listeners = new Listeners<IndexedAdapterCollectionListener<A>>()
        this.#subscription = field.pointerHub.catchupAndSubscribe({
            onAdded: (pointer: PointerField) => {
                this.#sorted = null
                const adapter: A = provider(pointer.box)
                const subscription = adapter.indexField.subscribe(() => {
                    this.#sorted = null
                    this.#listeners.proxy.onReorder(adapter)
                })
                const added = this.#entries.add({adapter, subscription})
                assert(added, `Could not add ${adapter}`)
                this.#listeners.proxy.onAdd(adapter)
            },
            onRemoved: (pointer: PointerField) => {
                this.#sorted = null
                const uuid = pointer.box.address.uuid
                const {adapter, subscription} = this.#entries.removeByKey(uuid)
                subscription.terminate()
                this.#listeners.proxy.onRemove(adapter)
            }
        }, pointers)
    }

    field(): Field<P> {return this.#field}

    subscribe(listener: IndexedAdapterCollectionListener<A>): Subscription {
        return this.#listeners.subscribe(listener)
    }

    catchupAndSubscribe(listener: IndexedAdapterCollectionListener<A>): Subscription {
        this.#entries.forEach(({adapter}) => listener.onAdd(adapter))
        return this.subscribe(listener)
    }

    getAdapterByIndex(index: int): Option<A> {
        const idx = BinarySearch.exactMapped(this.adapters(), index, IndexComparator, adapter => adapter.indexField.getValue())
        return idx === -1 ? Option.None : Option.wrap(this.adapters()[idx])
    }

    getAdapterById(uuid: UUID.Bytes): Option<A> {return this.#entries.opt(uuid).map(({adapter}) => adapter)}

    getMinFreeIndex(): int {
        const adapters = this.adapters()
        for (let index = 0; index < adapters.length; index++) {
            if (adapters[index].indexField.getValue() > index) {
                return index
            }
        }
        return adapters.length
    }

    adapters(): ReadonlyArray<A> {
        if (this.#sorted === null) {
            this.#sorted = this.#entries.values()
                .map(({adapter}) => adapter)
                .sort((a, b) => a.indexField.getValue() - b.indexField.getValue())
        }
        return this.#sorted
    }

    move(adapter: A, delta: int): void {
        this.moveIndex(adapter.indexField.getValue(), delta)
    }

    moveIndex(startIndex: int, delta: int): void {
        const adapters = this.adapters()
        const adapter = adapters[startIndex]
        if (delta < 0) {
            const newIndex = clamp(startIndex + delta, 0, adapters.length - 1)
            for (let index = newIndex; index < startIndex; index++) {
                adapters[index].indexField.setValue(index + 1)
            }
            adapter.indexField.setValue(newIndex)
        } else if (delta > 1) {
            const newIndex = clamp(startIndex + (delta - 1), 0, adapters.length - 1)
            for (let index = startIndex; index < newIndex; index++) {
                adapters[index + 1].indexField.setValue(index)
            }
            adapter.indexField.setValue(newIndex)
        } else {
            console.warn(`moveIndex had no effect: startIndex: ${startIndex}, delta: ${delta}`)
        }
    }

    size(): int {return this.#entries.size()}

    isEmpty(): boolean {return this.size() === 0}

    terminate(): void {
        this.#sorted = null
        this.#entries.forEach(({subscription}) => subscription.terminate())
        this.#entries.clear()
        this.#listeners.terminate()
        this.#subscription.terminate()
    }
}